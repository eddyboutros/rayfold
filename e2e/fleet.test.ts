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
// CI builds the JVM member and sets this, so a build whose output moved fails the job instead of quietly skipping the
// one suite that holds the two runtimes together. Locally the suite is skipped until you build it (see the guide).
if (process.env["FLEET_JVM"] === "1" && !url) throw new Error("the JVM fleet member was required (FLEET_JVM=1) but DATABASE_URL is not set, so every fleet suite would be skipped");
if (process.env["FLEET_JVM"] === "1" && !jvmBuilt) throw new Error(`the JVM fleet member was required but is not built: ${JVM_LIB} does not exist`);

interface Member {
  name: string;
  base: string;
  child: ChildProcess;
  exited: Promise<number | null>;
  /** Everything it has printed, so a member that will not stop can be asked what it was doing. */
  output: Signal<string>;
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
    const lines = new Signal<string>();
    const member = { name, base: `http://127.0.0.1:${port}`, child, exited: Promise.resolve<number | null>(null), output: lines };
    // recorded before it is listening, so a member that started while another failed is still stopped afterwards
    this.members.push(member);
    // `error` is how a missing `java` arrives, and `exit` never follows it: without both, a start that cannot happen
    // waits out the bound and then takes the worker down with an unhandled event
    const failed = new Promise<never>((_resolve, reject) => child.on("error", (e) => reject(new Error(`${name} could not start: ${e.message}`))));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    member.exited = Promise.race([exited, failed.catch(() => null)]);
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) lines.push(line.trim());
    });
    // a member that dies while starting (a port in use, a database that refuses it) says so now, rather than at the bound
    const listening = lines.until((ls) => ls.some((l) => l.includes("listening")), `${name} starting`, 60_000);
    await Promise.race([listening, failed, exited.then((code) => Promise.reject(new Error(`${name} exited with ${code} before it was listening`)))]);
    return member;
  }

  async stopAll(): Promise<void> {
    for (const m of this.members) {
      if (m.child.exitCode !== null) continue;
      // SIGTERM is what a platform sends and what the members drain on. Windows has no such signal, and a JVM there
      // outlives child.kill() often enough to hold its port against the next run, so it is taken down by pid.
      if (process.platform === "win32" && m.child.pid) spawn("taskkill", ["/pid", String(m.child.pid), "/f", "/t"], { stdio: "ignore" });
      else m.child.kill("SIGTERM");
    }
    // bounded: a member whose shutdown stalls fails the run with its name instead of hanging it
    await Promise.all(this.members.map((m) => stop(m)));
  }
}

/**
 * Waits for one member to go, and says what it was doing when it does not.
 *
 * A server that will not stop is a defect in a product that promises clean drains, so this still fails — but the
 * bare "no signal within 20000 ms" it used to fail with told the next person nothing. A JVM prints a full thread
 * dump on SIGQUIT, and that dump names the thread and the line the shutdown is stuck on.
 */
async function stop(m: Member): Promise<void> {
  try {
    await bounded(m.exited, `${m.name} exiting`, 20_000);
  } catch (e) {
    const dump = await threadDump(m);
    m.child.kill("SIGKILL"); // it is not going on its own, and the next run needs the port
    throw new Error(`${m.name} did not exit within 20s of SIGTERM${dump}`, { cause: e });
  }
}

/** A JVM's own answer to "what are you waiting for": SIGQUIT prints every thread and its stack to stdout. */
async function threadDump(m: Member): Promise<string> {
  if (process.platform === "win32" || !m.child.pid) return "";
  const before = m.output.items.length;
  try {
    process.kill(m.child.pid, "SIGQUIT");
  } catch {
    return "";
  }
  // the dump arrives on stdout in one burst; a bounded wait for its last line, then whatever came
  await m.output.until((items) => items.slice(before).some((l) => l.includes("VM Thread") || l.includes("JNI global")), "thread dump", 4_000).catch(() => undefined);
  const dump = m.output.items.slice(before);
  if (!dump.length) return "";
  // the threads this project owns, with what each is blocked on: the rest of a dump is JVM housekeeping
  const ours = dump.filter((l, i) => l.includes("dev.rayfold") || l.startsWith('"') || (l.includes("java.lang.Thread.State") && dump[i - 1]?.startsWith('"')));
  return `\n${(ours.length ? ours : dump).slice(0, 60).join("\n")}`;
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

/**
 * Opens the stockUpdates stream on `m` and waits for the member to say it subscribed, so a command sent after this is
 * one the stream is there to hear.
 */
async function stockUpdates(m: Member): Promise<Signal<Record<string, unknown>>> {
  const subscribed = (lines: string[]) => lines.filter((l) => l === `${m.name} stream subscribed`).length;
  const before = subscribed(m.output.items);
  const updates = await stream(m.base, { op: "stockUpdates", args: { bookIds: ["b1"] } });
  await m.output.until((lines) => subscribed(lines) > before, `${m.name}'s stream subscribing`);
  return updates;
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
/** The stock as the database holds it now, so a test counts from where the tests before it left it. */
const stockOf = async (pool: pg.Pool): Promise<number> => (await pool.query<{ stock: number }>("SELECT stock FROM fleet_books WHERE id = 'b1'")).rows[0]!.stock;

describe.skipIf(!url)("two servers, two processes, one Postgres", () => {
  const cluster = new Cluster();
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await freshDatabase(pool);
    await Promise.all([cluster.start("a", 4701), cluster.start("b", 4702)]);
    for (const m of cluster.members) expect((await fetch(`${m.base}/rayfold/ready`)).status).toBe(200);
  }, 90_000);

  // longer than stopAll's own 20s bound, so a member that stalls is named by that bound instead of the hook timing
  // out first and reporting nothing useful
  afterAll(async () => {
    await cluster.stopAll();
    await pool.end();
  }, 40_000);

  it("a keyed command sent to both servers at once runs once, and both answer with its result", async () => {
    const [a, b] = cluster.members;
    const [stock, runs] = [await stockOf(pool), (await runsOf(pool)).length];
    const [fromA, fromB] = await Promise.all([restock(a!.base, KEY), restock(b!.base, KEY)]);
    const answers = [await frames(fromA), await frames(fromB)];
    for (const [frame] of answers) expect(frame).toMatchObject({ id: 1, ok: { $type: "Book", id: "b1", stock: stock + 1 } });
    expect(answers.filter(([frame]) => (frame as { meta?: { replay?: boolean } }).meta?.replay)).toHaveLength(1);
    expect((await runsOf(pool)).length).toBe(runs + 1); // one server ran it; the other replayed its answer
  }, 20_000);

  it("a live query and a stream open on one server hear a command run on the other, through NOTIFY", async () => {
    const [a, b] = cluster.members;
    const live = await stream(b!.base, liveBook);
    const updates = await stockUpdates(b!);
    await live.atLeast(1, "b's live query answering");
    const before = (live.items[0] as { data: { stock: number } }).data.stock;
    expect(live.items[0]).toMatchObject({ id: 1, data: { id: "b1", stock: await stockOf(pool) } });

    expect((await frames(await restock(a!.base, KEY + "2")))[0]).toMatchObject({ ok: { stock: before + 1 } });
    await live.atLeast(2, "b's live query hearing a's change");
    await updates.atLeast(1, "b's stream hearing a's event");
    expect(live.items[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: before + 1 } }] });
    expect(updates.items[0]).toEqual({ id: 1, item: { bookId: "b1", stock: before + 1 } });
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
    const stock = await stockOf(pool);
    expect((await frames(await restock(b!.base, KEY + "3")))[0]).toMatchObject({ ok: { stock: stock + 1 } });
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

  // longer than stopAll's own 20s bound, so a member that stalls is named by that bound instead of the hook timing
  // out first and reporting nothing useful
  afterAll(async () => {
    await cluster.stopAll();
    await pool.end();
  }, 40_000);

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

  it("a keyed command sent to both runtimes at once runs on one of them, and the other replays its answer", async () => {
    // the sequential tests above always meet a finished record; this is the contended path, where one runtime reads
    // the other's claim while it is still in flight and has to wait for it
    const before = (await runsOf(pool)).length;
    const [fromNode, fromJvm] = await Promise.all([restock(node.base, KEY + "x"), restock(jvm.base, KEY + "x")]);
    const answers = [await frames(fromNode), await frames(fromJvm)];
    const stock = (a: Array<Record<string, unknown>>) => (a[0] as { ok?: { stock?: number } }).ok?.stock;
    expect(stock(answers[0]!)).toBe(stock(answers[1]!));
    expect(answers.filter(([f]) => (f as { meta?: { replay?: boolean } }).meta?.replay)).toHaveLength(1);
    const ran = (await runsOf(pool)).slice(before);
    expect(ran).toHaveLength(1); // whichever ran it, it ran once
    expect(["node", "jvm"]).toContain(ran[0]);
  }, 30_000);

  it("a live query on the JVM server hears a command run on the TypeScript one, and a stream hears its event", async () => {
    const live = await stream(jvm.base, liveBook);
    const updates = await stockUpdates(jvm);
    await live.atLeast(1, "the JVM server's live query answering");
    // taken from what the query answered rather than counted from the tests before it, so the order they run in is theirs
    const before = ((live.items[0] as { data: { stock: number } }).data).stock;

    expect((await frames(await restock(node.base, KEY + "3")))[0]).toMatchObject({ ok: { stock: before + 1 } });
    await live.atLeast(2, "the JVM server hearing the TypeScript server's change");
    await updates.atLeast(1, "the JVM server hearing the TypeScript server's event");
    expect(live.items[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: before + 1 } }] });
    expect(updates.items[0]).toEqual({ id: 1, item: { bookId: "b1", stock: before + 1 } });
  }, 30_000);

  it("and the other way: a live query on the TypeScript server hears a command run on the JVM one", async () => {
    const live = await stream(node.base, liveBook);
    await live.atLeast(1, "the TypeScript server's live query answering");
    const before = ((live.items[0] as { data: { stock: number } }).data).stock;

    expect((await frames(await restock(jvm.base, KEY + "4")))[0]).toMatchObject({ ok: { stock: before + 1 } });
    await live.atLeast(2, "the TypeScript server hearing the JVM server's change");
    expect(live.items[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: before + 1 } }] });
  }, 30_000);
});
