import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bounded, Signal } from "./wait.ts";

/**
 * Two Rayfold servers as two processes over one real Postgres: what two instances behind a load balancer are. Nothing
 * here runs without a database to point at, so the suite is skipped unless DATABASE_URL is set; CI provides one.
 */
const url = process.env["DATABASE_URL"];
const KEY = "0123456789abcdef";
const PORTS = { a: 4701, b: 4702 };

interface Member {
  name: string;
  base: string;
  child: ChildProcess;
  exited: Promise<number | null>;
}

const members: Member[] = [];
let pool: pg.Pool;

async function start(name: string, port: number): Promise<Member> {
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const script = fileURLToPath(new URL("./fleet/server.ts", import.meta.url));
  const child = spawn(process.execPath, [tsx, script], {
    env: { ...process.env, DATABASE_URL: url, PORT: String(port), NAME: name },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const lines = new Signal<string>();
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) lines.push(line.trim());
  });
  await lines.until((ls) => ls.some((l) => l.includes("listening")), `${name} starting`, 30_000);
  const member = { name, base: `http://127.0.0.1:${port}`, child, exited };
  members.push(member);
  return member;
}

const post = (base: string, body: unknown) => fetch(`${base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json" }, body: JSON.stringify(body) });
const restock = (base: string, key: string, qty = 1) => post(base, { ops: [{ id: 1, op: "restock", args: { id: "b1", qty }, key }] });
const frames = async (res: Response): Promise<Array<Record<string, unknown>>> => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

/** Opens a streaming response and records its frames as they arrive. */
async function stream(base: string, op: Record<string, unknown>): Promise<Signal<Record<string, unknown>>> {
  const res = await post(base, { ops: [{ id: 1, ...op }] });
  const out = new Signal<Record<string, unknown>>();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at: number;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (line) out.push(JSON.parse(line));
        }
      }
    } catch {
      // the server it was open on went away, which the tests make happen; every frame before that is recorded
    }
  })();
  return out;
}

describe.skipIf(!url)("two servers, two processes, one Postgres", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query("DROP TABLE IF EXISTS fleet_books, fleet_runs, rayfold_idempotency, rayfold_relay");
    // the application's tables, migrated before the servers start; the stores' tables are theirs to create at boot
    await pool.query("CREATE TABLE fleet_books (id text PRIMARY KEY, stock int NOT NULL)");
    await pool.query("CREATE TABLE fleet_runs (id bigserial PRIMARY KEY, server text NOT NULL, book text NOT NULL)");
    await pool.query("INSERT INTO fleet_books (id, stock) VALUES ('b1', 3)");
    await Promise.all([start("a", PORTS.a), start("b", PORTS.b)]);
    for (const m of members) expect((await fetch(`${m.base}/rayfold/ready`)).status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    for (const m of members) if (m.child.exitCode === null) m.child.kill(process.platform === "win32" ? undefined : "SIGTERM");
    await Promise.all(members.map((m) => m.exited));
    await pool.end();
  });

  it("a keyed command sent to both servers at once runs once, and both answer with its result", async () => {
    const [a, b] = members;
    const [fromA, fromB] = await Promise.all([restock(a!.base, KEY), restock(b!.base, KEY)]);
    const answers = [await frames(fromA), await frames(fromB)];
    for (const [frame] of answers) expect(frame).toMatchObject({ id: 1, ok: { $type: "Book", id: "b1", stock: 4 } });
    const replays = answers.filter(([frame]) => (frame as { meta?: { replay?: boolean } }).meta?.replay);
    expect(replays).toHaveLength(1);
    const runs = await pool.query<{ server: string }>("SELECT server FROM fleet_runs WHERE book = 'b1'");
    expect(runs.rows).toHaveLength(1);
    expect(["a", "b"]).toContain(runs.rows[0]?.server);
  }, 20_000);

  it("a live query and a stream open on one server hear a command run on the other, through NOTIFY", async () => {
    const [a, b] = members;
    const live = await stream(b!.base, { op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true });
    const updates = await stream(b!.base, { op: "stockUpdates", args: { bookIds: ["b1"] } });
    await live.atLeast(1, "b's live query answering");
    expect(live.items[0]).toMatchObject({ id: 1, data: { id: "b1", stock: 4 } });

    const answered = await frames(await restock(a!.base, KEY + "2"));
    expect(answered[0]).toMatchObject({ ok: { stock: 5 } });
    await live.atLeast(2, "b's live query hearing a's change");
    await updates.atLeast(1, "b's stream hearing a's event");
    expect(live.items[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 5 } }] });
    expect(updates.items[0]).toEqual({ id: 1, item: { bookId: "b1", stock: 5 } });
  }, 20_000);

  // SIGTERM on Windows is a plain kill, so the graceful path can only be shown where the signal is delivered
  it.skipIf(process.platform === "win32")("stopping one server ends its live queries with a retryable error and leaves the other serving", async () => {
    const [a, b] = members;
    const live = await stream(a!.base, { op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true });
    await live.atLeast(1, "a's live query answering");

    a!.child.kill("SIGTERM");
    await live.atLeast(2, "a ending the live query as it shuts down");
    expect(live.items[1]).toEqual({ id: 1, error: { code: "unavailable", message: "The server is shutting down" }, fin: true });
    expect(await bounded(a!.exited, "a exiting", 15_000)).toBe(0);

    expect((await fetch(`${b!.base}/rayfold/ready`)).status).toBe(200);
    expect((await frames(await restock(b!.base, KEY + "3")))[0]).toMatchObject({ ok: { stock: 6 } });
  }, 30_000);
});
