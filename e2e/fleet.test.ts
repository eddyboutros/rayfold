import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bounded, Signal } from "./wait.ts";

/**
 * Rayfold servers as separate processes over one real Postgres: what instances behind a load balancer are. Nothing
 * here runs without a database to point at, so the suites are skipped unless DATABASE_URL is set; CI provides one.
 *
 * The second suite puts a TypeScript server and a JVM server in the same fleet, which is what holds the two runtimes
 * to one wire format for the shared stores: the idempotency records they replay for each other, and the relay
 * notifications they send each other. It needs the JVM member built (see the CI job); without it, it is skipped.
 */
const url = process.env["DATABASE_URL"];
const KEY = "0123456789abcdef";
const JVM_LIB = fileURLToPath(new URL("./fleet/jvm/build/install/fleet-member/lib", import.meta.url));
const jvmBuilt = existsSync(JVM_LIB);

interface Member {
  name: string;
  base: string;
  child: ChildProcess;
  exited: Promise<number | null>;
}

/** The members a suite started, so it stops exactly those. */
class Cluster {
  readonly members: Member[] = [];

  async start(name: string, port: number, runtime: "ts" | "jvm" = "ts"): Promise<Member> {
    const [command, args] =
      runtime === "ts"
        ? [process.execPath, [createRequire(import.meta.url).resolve("tsx/cli"), fileURLToPath(new URL("./fleet/server.ts", import.meta.url))]]
        : ["java", ["-cp", join(JVM_LIB, "*"), "dev.rayfold.fleet.ServerKt"]];
    const child = spawn(command!, args as string[], {
      env: { ...process.env, DATABASE_URL: url, PORT: String(port), NAME: name },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const lines = new Signal<string>();
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) lines.push(line.trim());
    });
    // a member that dies while starting (a port in use, a database that refuses it) says so now, rather than at the bound
    const listening = lines.until((ls) => ls.some((l) => l.includes("listening")), `${name} starting`, 60_000);
    await Promise.race([listening, exited.then((code) => Promise.reject(new Error(`${name} exited with ${code} before it was listening`)))]);
    const member = { name, base: `http://127.0.0.1:${port}`, child, exited };
    this.members.push(member);
    return member;
  }

  async stopAll(): Promise<void> {
    for (const m of this.members) if (m.child.exitCode === null) m.child.kill(process.platform === "win32" ? undefined : "SIGTERM");
    await Promise.all(this.members.map((m) => m.exited));
  }
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

/** The application's tables, as a deploy would have migrated them before any server started. */
async function freshDatabase(pool: pg.Pool): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS fleet_books, fleet_runs, rayfold_idempotency, rayfold_relay");
  await pool.query("CREATE TABLE fleet_books (id text PRIMARY KEY, stock int NOT NULL)");
  await pool.query("CREATE TABLE fleet_runs (id bigserial PRIMARY KEY, server text NOT NULL, book text NOT NULL)");
  await pool.query("INSERT INTO fleet_books (id, stock) VALUES ('b1', 3)");
}

const liveBook = { op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true };
const runsOf = async (pool: pg.Pool): Promise<string[]> => (await pool.query<{ server: string }>("SELECT server FROM fleet_runs ORDER BY id")).rows.map((r) => r.server);

describe.skipIf(!url)("two servers, two processes, one Postgres", () => {
  const cluster = new Cluster();
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await freshDatabase(pool);
    await Promise.all([cluster.start("a", 4701), cluster.start("b", 4702)]);
    for (const m of cluster.members) expect((await fetch(`${m.base}/rayfold/ready`)).status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await cluster.stopAll();
    await pool.end();
  });

  it("a keyed command sent to both servers at once runs once, and both answer with its result", async () => {
    const [a, b] = cluster.members;
    const [fromA, fromB] = await Promise.all([restock(a!.base, KEY), restock(b!.base, KEY)]);
    const answers = [await frames(fromA), await frames(fromB)];
    for (const [frame] of answers) expect(frame).toMatchObject({ id: 1, ok: { $type: "Book", id: "b1", stock: 4 } });
    expect(answers.filter(([frame]) => (frame as { meta?: { replay?: boolean } }).meta?.replay)).toHaveLength(1);
    expect(await runsOf(pool)).toHaveLength(1); // one server ran it; the other replayed its answer
  }, 20_000);

  it("a live query and a stream open on one server hear a command run on the other, through NOTIFY", async () => {
    const [a, b] = cluster.members;
    const live = await stream(b!.base, liveBook);
    const updates = await stream(b!.base, { op: "stockUpdates", args: { bookIds: ["b1"] } });
    await live.atLeast(1, "b's live query answering");
    expect(live.items[0]).toMatchObject({ id: 1, data: { id: "b1", stock: 4 } });

    expect((await frames(await restock(a!.base, KEY + "2")))[0]).toMatchObject({ ok: { stock: 5 } });
    await live.atLeast(2, "b's live query hearing a's change");
    await updates.atLeast(1, "b's stream hearing a's event");
    expect(live.items[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 5 } }] });
    expect(updates.items[0]).toEqual({ id: 1, item: { bookId: "b1", stock: 5 } });
  }, 20_000);

  // SIGTERM on Windows is a plain kill, so the graceful path can only be shown where the signal is delivered
  it.skipIf(process.platform === "win32")("stopping one server ends its live queries with a retryable error and leaves the other serving", async () => {
    const [a, b] = cluster.members;
    const live = await stream(a!.base, liveBook);
    await live.atLeast(1, "a's live query answering");

    a!.child.kill("SIGTERM");
    await live.atLeast(2, "a ending the live query as it shuts down");
    expect(live.items[1]).toEqual({ id: 1, error: { code: "unavailable", message: "The server is shutting down" }, fin: true });
    expect(await bounded(a!.exited, "a exiting", 15_000)).toBe(0);

    expect((await fetch(`${b!.base}/rayfold/ready`)).status).toBe(200);
    expect((await frames(await restock(b!.base, KEY + "3")))[0]).toMatchObject({ ok: { stock: 6 } });
  }, 30_000);
});

describe.skipIf(!url || !jvmBuilt)("a TypeScript server and a JVM server in one fleet", () => {
  const cluster = new Cluster();
  let pool: pg.Pool;
  let node: Member;
  let jvm: Member;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await freshDatabase(pool);
    [node, jvm] = await Promise.all([cluster.start("node", 4703), cluster.start("jvm", 4704, "jvm")]);
    for (const m of cluster.members) expect((await fetch(`${m.base}/rayfold/ready`)).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await cluster.stopAll();
    await pool.end();
  });

  it("the JVM server replays the record the TypeScript server wrote, and never runs the command again", async () => {
    expect((await frames(await restock(node.base, KEY)))[0]).toMatchObject({ ok: { $type: "Book", id: "b1", stock: 4 } });
    const replayed = (await frames(await restock(jvm.base, KEY)))[0];
    expect(replayed).toMatchObject({ id: 1, ok: { $type: "Book", id: "b1", stock: 4 }, meta: { replay: true } });
    expect(await runsOf(pool)).toEqual(["node"]);
  }, 30_000);

  it("and the other way: the TypeScript server replays what the JVM server wrote", async () => {
    expect((await frames(await restock(jvm.base, KEY + "2")))[0]).toMatchObject({ ok: { stock: 5 } });
    const replayed = (await frames(await restock(node.base, KEY + "2")))[0];
    expect(replayed).toMatchObject({ ok: { stock: 5 }, meta: { replay: true } });
    expect(await runsOf(pool)).toEqual(["node", "jvm"]);
  }, 30_000);

  it("a live query on the JVM server hears a command run on the TypeScript one, and a stream hears its event", async () => {
    const live = await stream(jvm.base, liveBook);
    const updates = await stream(jvm.base, { op: "stockUpdates", args: { bookIds: ["b1"] } });
    await live.atLeast(1, "the JVM server's live query answering");
    expect(live.items[0]).toMatchObject({ id: 1, data: { id: "b1", stock: 5 } });

    expect((await frames(await restock(node.base, KEY + "3")))[0]).toMatchObject({ ok: { stock: 6 } });
    await live.atLeast(2, "the JVM server hearing the TypeScript server's change");
    await updates.atLeast(1, "the JVM server hearing the TypeScript server's event");
    expect(live.items[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 6 } }] });
    expect(updates.items[0]).toEqual({ id: 1, item: { bookId: "b1", stock: 6 } });
  }, 30_000);

  it("and the other way: a live query on the TypeScript server hears a command run on the JVM one", async () => {
    const live = await stream(node.base, liveBook);
    await live.atLeast(1, "the TypeScript server's live query answering");
    expect(live.items[0]).toMatchObject({ id: 1, data: { id: "b1", stock: 6 } });

    expect((await frames(await restock(jvm.base, KEY + "4")))[0]).toMatchObject({ ok: { stock: 7 } });
    await live.atLeast(2, "the TypeScript server hearing the JVM server's change");
    expect(live.items[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 7 } }] });
  }, 30_000);
});
