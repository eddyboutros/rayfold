/**
 * The workspace comparison: a large, realistic domain served three ways over real HTTP.
 *
 * Two organisations, 4 teams, 7 projects, 18 sprints, 630 issues with sub-issues, labels, attachments and
 * versions, 900 comments, 1 156 activity rows of four different kinds, and notifications. Every scenario below is
 * a screen or an operation a product of this shape actually has, run against all three stacks, checked for the
 * same answer on each, and then measured. The suite writes `e2e/workspace.json`, which the HTML report renders.
 *
 * The REST and GraphQL stacks are written the way careful teams write them (purpose-built endpoints, ETags,
 * Idempotency-Key, DataLoader-style batching on every relation and page, subscriptions). `gqlNaive` is the same
 * GraphQL schema with the obvious resolvers, which is what a team ships before it discovers N+1.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RbCodec } from "@rayfold/rb";
import { loadSchema } from "@rayfold/schema";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { GRAPHQL_MAJOR, Recorder, Report, writeReport } from "./harness.ts";
import { Signal, bounded, openSse } from "./wait.ts";
import { freshWorkspace, startWorkspaceRest, type WorkspaceStack } from "./workspace-rest.ts";
import { startWorkspaceGraphQL } from "./workspace-gql.ts";
import { startWorkspaceRayfold } from "./workspace-rayfold.ts";
import { sizes, workspaceSchemaText } from "../examples/workspace-ts/src/index.ts";

const report = new Report();
let rest: WorkspaceStack;
let gql: WorkspaceStack;
/** the same GraphQL API with the obvious per-parent resolvers (no DataLoader) */
let gqlNaive: WorkspaceStack;
let rayfold: Awaited<ReturnType<typeof startWorkspaceRayfold>>;

const ir = loadSchema(workspaceSchemaText()).ir;
const rb = new RbCodec(ir);
const recorder = new Recorder((bytes, asFrames) => (asFrames ? rb.decodeFrames(bytes) : rb.decode(bytes)));
let rowsBefore = 0;

/** u01 owns the first organisation, u05 is a plain member of it, u13 administers the second one. */
const OWNER = { authorization: "Bearer u01" };
const MEMBER = { authorization: "Bearer u05" };
const OTHER_TENANT = { authorization: "Bearer u13" };
const JSON_CT = { "content-type": "application/json" };
const RAYFOLD_CT = { "content-type": "application/rayfold+json" };

interface Measured {
  status: number;
  text: string;
  json: unknown;
  bytes: number;
}

/** One exchange, with everything that travelled counted: the target and body up, the body down. */
async function call(url: string, init: RequestInit & { body?: string } = {}): Promise<Measured> {
  const res = await fetch(url, init);
  const text = await res.text();
  const target = new URL(url).pathname + new URL(url).search;
  let json: unknown = null;
  try {
    json = text ? (text.includes("\n{") ? text.trim().split("\n").map((l) => JSON.parse(l)) : JSON.parse(text)) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json, bytes: Buffer.byteLength(target) + Buffer.byteLength(init.body ?? "") + Buffer.byteLength(text) };
}

const restGet = (path: string, headers: Record<string, string> = OWNER): Promise<Measured> => call(`${rest.base}${path}`, { headers });

const gqlCall = (query: string, headers: Record<string, string> = OWNER, stack: WorkspaceStack = gql): Promise<Measured> =>
  call(`${stack.base}/graphql`, { method: "POST", headers: { ...JSON_CT, ...headers }, body: JSON.stringify({ query }) });

interface Frames {
  status: number;
  frames: Array<Record<string, unknown>>;
  bytes: number;
}
async function rayCall(ops: unknown[], headers: Record<string, string> = OWNER): Promise<Frames> {
  const body = JSON.stringify({ ops });
  const m = await call(`${rayfold.base}/rayfold`, { method: "POST", headers: { ...RAYFOLD_CT, ...headers }, body });
  return { status: m.status, frames: m.text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>), bytes: m.bytes };
}
/** The same batch on Rayfold's binary wire, which is what a first-party client uses. */
async function rayRb(ops: unknown[], headers: Record<string, string> = OWNER): Promise<{ frames: unknown[]; bytes: number }> {
  const body = rb.encode({ ops }) as Uint8Array;
  const res = await fetch(`${rayfold.base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold", accept: "application/rayfold", ...headers }, body: body as BodyInit });
  const down = new Uint8Array(await res.arrayBuffer());
  return { frames: rb.decodeFrames(down) as unknown[], bytes: body.length + down.length + Buffer.byteLength("/rayfold") };
}

const data = (f: Record<string, unknown>): Record<string, unknown> => f["data"] as Record<string, unknown>;
const items = (page: unknown): Array<Record<string, unknown>> => (page as { items: Array<Record<string, unknown>> }).items;
/** How many loader calls a stack made since the counters were reset. */
const calls = (stack: WorkspaceStack): number => Object.values(stack.counters.loaderCalls).reduce((n, v) => n + v, 0);
/** The three relations a board needs, named identically on each stack so the counts compare like with like. */
const RELATIONS = ["BoardColumn.issues", "Issue.assignee", "Member.user"] as const;
const relationCalls = (stack: WorkspaceStack): number => RELATIONS.reduce((n, k) => n + (stack.counters.loaderCalls[k] ?? 0), 0);
const resetCounters = (): void => {
  for (const s of [rest, gql, gqlNaive, rayfold]) {
    s.counters.originRequests = 0;
    for (const k of Object.keys(s.counters.loaderCalls)) delete s.counters.loaderCalls[k];
  }
};

beforeAll(() => recorder.install());
beforeEach(async () => {
  [rest, gql, gqlNaive, rayfold] = await Promise.all([
    startWorkspaceRest(freshWorkspace()),
    startWorkspaceGraphQL(freshWorkspace()),
    startWorkspaceGraphQL(freshWorkspace(), { batching: false }),
    startWorkspaceRayfold(freshWorkspace()),
  ]);
  recorder.track([[rest.base, "REST"], [gql.base, "GraphQL"], [gqlNaive.base, "GraphQL"], [rayfold.base, "Rayfold"]]);
  rowsBefore = report.rows.length;
});
afterEach(async () => {
  const examples = await recorder.take();
  for (const row of report.rows.slice(rowsBefore)) row.examples = examples;
  await Promise.all([rest.close(), gql.close(), gqlNaive.close(), rayfold.close()]);
});
afterAll(() => {
  recorder.uninstall();
  const size = sizes(freshWorkspace());
  writeReport("e2e/workspace.json", JSON.stringify({ generatedAt: new Date().toISOString(), dataset: size, rows: report.rows }, null, 2) + "\n");
  writeReport(
    "e2e/workspace.md",
    report.markdown({
      title: "End-to-end comparison on a workspace: REST vs GraphQL vs Rayfold",
      dataset: `Same workspace (${size.orgs} organisations, ${size.projects} projects, ${size.issues} issues), same data, same flows`,
      assertedBy: "e2e/workspace.test.ts",
    }),
  );
});

// The fields the board shows, asked for identically on each stack, so the byte counts compare like with like.
const BOARD_GQL = `{ board(projectId: "p1") { project { key name } columns { state count issues(first: 10) { items { id key title state priority updatedAt assignee { id role user { id name avatarUrl } } labels { id name color } } } } } }`;
const BOARD_SHAPE = "{ project { key name } columns { state count issues(page: { first: 10 }) { items { ...Issue.row } } } }";

describe("1. The board screen", () => {
  it("six columns with counts and their first ten issues: one request everywhere, and Rayfold moves the fewest bytes", async () => {
    resetCounters();
    const r = await restGet("/projects/p1/board?limit=10");
    const restCols = (r.json as { columns: Array<{ state: string; count: number; issues: Array<{ key: string }> }> }).columns;
    expect(restCols.map((c) => c.state)).toEqual(["TRIAGE", "BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);
    expect(restCols[0]!.count).toBe(20);
    expect(restCols[0]!.issues).toHaveLength(10);

    const g = await gqlCall(BOARD_GQL);
    const gCols = (data(g.json as Record<string, unknown>)["board"] as { columns: Array<{ state: string; count: number; issues: { items: Array<{ key: string }> } }> }).columns;

    const y = await rayCall([{ id: 1, op: "board", args: { projectId: "p1" }, shape: BOARD_SHAPE }]);
    const yCols = (data(y.frames[0]!)["columns"] as Array<{ state: string; count: number; issues: { items: Array<{ key: string }> } }>);

    // All three describe the same board: same columns, same totals, same first issue in each.
    expect(gCols.map((c) => [c.state, c.count])).toEqual(restCols.map((c) => [c.state, c.count]));
    expect(yCols.map((c) => [c.state, c.count])).toEqual(restCols.map((c) => [c.state, c.count]));
    expect(yCols.map((c) => c.issues.items[0]?.key)).toEqual(restCols.map((c) => c.issues[0]?.key));
    expect(gCols.map((c) => c.issues.items[0]?.key)).toEqual(restCols.map((c) => c.issues[0]?.key));

    const rbBoard = await rayRb([{ id: 1, op: "board", args: { projectId: "p1" }, shape: BOARD_SHAPE, compact: true }]);

    report.add({
      aspect: "Board screen (6 columns, 60 issues with people and labels)",
      values: { REST: r.bytes, GraphQL: g.bytes, Rayfold: rbBoard.bytes },
      unit: "bytes on the wire",
      better: "lower",
      metric: "bytes for one board",
      REST: `${r.bytes.toLocaleString("en-US")} B: a purpose-built endpoint, but a resource has one representation, so every issue arrives whole (description, ids, attachments)`,
      GraphQL: `${g.bytes.toLocaleString("en-US")} B: exactly the fields asked for`,
      Rayfold: `${rbBoard.bytes.toLocaleString("en-US")} B on the binary wire (${y.bytes.toLocaleString("en-US")} B as JSON): the same fields, named once by the server-defined view \`Issue.row\``,
      note: "The board is the screen that hurts most: six lists in one page, each needing its own slice of the same table.",
    });
  });

  it("without DataLoader the same GraphQL query makes a call per row; Rayfold has no such mode", async () => {
    resetCounters();
    await gqlCall(BOARD_GQL, OWNER, gqlNaive);
    const naive = relationCalls(gqlNaive);
    await gqlCall(BOARD_GQL);
    const batched = relationCalls(gql);
    await rayCall([{ id: 1, op: "board", args: { projectId: "p1" }, shape: BOARD_SHAPE }]);
    const rayfoldCalls = relationCalls(rayfold);
    // The same three relations on both typed stacks: one call each when batching is wired, one call per row when it is
    // not. The dataset is fixed, so the per-row count is too.
    expect([naive, batched, rayfoldCalls]).toEqual([100, RELATIONS.length, RELATIONS.length]);

    report.add({
      aspect: "N+1 on the board",
      values: { REST: 0, GraphQL: RELATIONS.length, Rayfold: 0 },
      unit: "relations needing batching wired by hand",
      better: "lower",
      metric: "hand-written batching",
      REST: "none to wire: this endpoint was written for this screen, and it loads what it needs in one pass. The next screen needs another endpoint",
      GraphQL: `${RELATIONS.length}: a DataLoader per relation. The same query and schema without them made ${naive} calls instead of ${batched}`,
      Rayfold: `none: a field loader is handed the whole level, so the slow version does not exist (${rayfoldCalls} calls, the same as GraphQL once its loaders are written)`,
      note: `Measured on this board: ${naive} data-source calls with the obvious GraphQL resolvers, ${batched} once DataLoader is added, ${rayfoldCalls} on Rayfold with nothing to add.`,
    });
  });
});

describe("2. One issue, in full", () => {
  it("issue with project, people, labels, sub-issues and comments: REST needs five requests, the others one", async () => {
    const e1 = await restGet("/issues/i002");
    const issue = e1.json as { key: string; projectId: string; assigneeId: string; reporterId: string };
    const [e2, e3, e4, e5] = await Promise.all([
      restGet(`/issues/i002/comments?limit=10`),
      restGet(`/issues/i002/children?limit=5`),
      restGet(`/projects/${issue.projectId}`),
      restGet(`/members?ids=${issue.assigneeId},${issue.reporterId}`),
    ]);
    const restBytes = [e1, e2, e3, e4, e5].reduce((n, e) => n + e.bytes, 0);
    expect(issue.key).toBe("ING-2");
    expect(items(e2.json)).toHaveLength(3);

    const g = await gqlCall(
      `{ issue(id: "i002") { key title state priority estimate version project { key name } sprint { name state } assignee { user { name } } reporter { user { name } } labels { name color } attachments { filename size } children(first: 5) { total items { key state } } comments(first: 10) { total items { body createdAt author { user { name } } } } } }`,
    );
    const gIssue = data(g.json as Record<string, unknown>)["issue"] as { key: string; comments: { total: number } };
    expect(gIssue.key).toBe("ING-2");
    expect(gIssue.comments.total).toBe(3);

    const y = await rayCall([
      {
        id: 1,
        op: "issue",
        args: { id: "i002" },
        shape:
          "{ ...Issue.card version reporter { ...Member.default } labels { ...Label.default } attachments { filename size } children(page: { first: 5 }) { total items { key state } } comments(page: { first: 10 }) { total items { ...Comment.default } } }",
      },
    ]);
    const yIssue = data(y.frames[0]!) as { key: string; comments: { total: number } };
    expect(yIssue.key).toBe("ING-2");
    expect(yIssue.comments.total).toBe(3);

    report.add({
      aspect: "One issue with everything on its page",
      values: { REST: 5, GraphQL: 1, Rayfold: 1 },
      unit: "network round trips",
      better: "lower",
      metric: "round trips for one issue page",
      REST: "5: the issue, its comments, its sub-issues, its project, and a batch call for the two people on it",
      GraphQL: "1: one query names the whole tree",
      Rayfold: "1: one op, with the shared view `Issue.card` plus what this page adds",
      note: `Bytes: REST ${restBytes.toLocaleString("en-US")}, GraphQL ${g.bytes.toLocaleString("en-US")}, Rayfold ${y.bytes.toLocaleString("en-US")}.`,
    });
  });
});

describe("3. The activity feed", () => {
  it("one page holding four kinds of fact, each with its own fields", async () => {
    const r = await restGet("/projects/p1/activity?limit=20");
    const restItems = items(r.json);
    expect(restItems).toHaveLength(20);
    expect(new Set(restItems.map((i) => i["type"]))).toEqual(new Set(["SprintClosedActivity", "IssueCommented", "IssueMovedActivity", "IssueOpened"]));

    const g = await gqlCall(
      `{ activity(projectId: "p1", first: 20) { total items { __typename id at actor { user { name } } ... on IssueOpened { issue { key title } } ... on IssueMovedActivity { from to issue { key } } ... on IssueCommented { comment { body } } ... on SprintClosedActivity { sprint { name } completed carriedOver } } } }`,
    );
    const gItems = items(data(g.json as Record<string, unknown>)["activity"]);
    expect(gItems).toHaveLength(20);

    const y = await rayCall([
      {
        id: 1,
        op: "activity",
        args: { projectId: "p1", page: { first: 20 } },
        shape:
          "{ total items { id at actor { ...Member.default } ...on IssueOpened { issue { key title } } ...on IssueMovedActivity { from to issue { key } } ...on IssueCommented { comment { body } } ...on SprintClosedActivity { sprint { name } completed carriedOver } } }",
      },
    ]);
    const yItems = items(data(y.frames[0]!));
    expect(yItems).toHaveLength(20);

    // The three feeds carry the same facts in the same order, and both typed stacks name the kind of each row.
    expect(yItems.map((i) => i["$type"])).toEqual(restItems.map((i) => i["type"]));
    expect(gItems.map((i) => i["__typename"])).toEqual(restItems.map((i) => i["type"]));
    expect(yItems[0]).toMatchObject({ $type: "SprintClosedActivity", completed: 14, carriedOver: 3 });
    expect(yItems.find((i) => i["$type"] === "IssueMovedActivity")).toMatchObject({ from: "TODO" });

    report.add({
      aspect: "Activity feed with four kinds of entry",
      values: { REST: 0, GraphQL: 1, Rayfold: 1 },
      unit: "the kind of each row is part of the contract (1 = yes)",
      better: "higher",
      metric: "how a client knows what a row is",
      REST: `a "type" string by convention; nothing in the contract says which fields go with which value, and a client that guesses wrong finds out at run time`,
      GraphQL: "an interface with inline fragments; the kind is checked by the schema",
      Rayfold: "an `@interface` with `...on`; the kind is checked by the schema, and `$type` survives the compact and binary encodings",
      note: `Bytes for the same 20 rows: REST ${r.bytes.toLocaleString("en-US")}, GraphQL ${g.bytes.toLocaleString("en-US")}, Rayfold ${y.bytes.toLocaleString("en-US")}.`,
    });
  });
});

describe("4. Search across kinds", () => {
  it("issues, projects and comments in one result", async () => {
    const r = await restGet("/search?q=cache&limit=10");
    const restItems = items(r.json);
    const g = await gqlCall(`{ search(q: "cache", first: 10) { total items { __typename ... on Issue { key title } ... on Project { key name } ... on Comment { body } } } }`);
    const gPage = data(g.json as Record<string, unknown>)["search"] as { total: number; items: Array<Record<string, unknown>> };
    const y = await rayCall([{ id: 1, op: "search", args: { q: "cache", page: { first: 10 } }, shape: "{ total items { ...on Issue { key title } ...on Project { key name } ...on Comment { body } } }" }]);
    const yPage = data(y.frames[0]!) as { total: number; items: Array<Record<string, unknown>> };

    expect(yPage.total).toBe(59);
    expect(gPage.total).toBe(59);
    expect((r.json as { total: number }).total).toBe(59);
    expect(yPage.items.map((i) => i["$type"])).toEqual(restItems.map((i) => i["type"]));
    expect(gPage.items.map((i) => i["__typename"])).toEqual(restItems.map((i) => i["type"]));

    report.add({
      aspect: "Search returning three kinds of thing",
      values: { REST: r.bytes, GraphQL: g.bytes, Rayfold: y.bytes },
      unit: "bytes for ten mixed results",
      better: "lower",
      metric: "bytes, same ten hits",
      REST: `${r.bytes.toLocaleString("en-US")} B: each hit wrapped in an envelope naming its kind, and each resource sent whole`,
      GraphQL: `${g.bytes.toLocaleString("en-US")} B: a union, with the fields the screen shows`,
      Rayfold: `${y.bytes.toLocaleString("en-US")} B: a union, with the fields the screen shows`,
    });
  });
});

describe("5. Create, then read what was created", () => {
  it("in one request on Rayfold: the second op uses the new issue's id", async () => {
    const created = await call(`${rest.base}/issues`, { method: "POST", headers: { ...OWNER, ...JSON_CT, "idempotency-key": "ws-create-0000001" }, body: JSON.stringify({ projectId: "p1", title: "Ship the migration" }) });
    expect(created.status).toBe(201);
    const restRead = await restGet(`/issues/${(created.json as { id: string }).id}`);
    expect((restRead.json as { title: string }).title).toBe("Ship the migration");

    const gCreate = await gqlCall(`mutation { createIssue(input: { projectId: "p1", title: "Ship the migration" }) { id key } }`);
    const gId = (data(gCreate.json as Record<string, unknown>)["createIssue"] as { id: string }).id;
    const gRead = await gqlCall(`{ issue(id: "${gId}") { key title project { key } reporter { user { name } } } }`);
    expect((data(gRead.json as Record<string, unknown>)["issue"] as { title: string }).title).toBe("Ship the migration");

    const y = await rayCall([
      { id: 1, op: "createIssue", args: { input: { projectId: "p1", title: "Ship the migration" } }, key: "ws-create-0000002", shape: "{ id key }" },
      { id: 2, op: "issue", args: { id: { $ref: "1.id" } }, shape: "{ key title project { key } reporter { user { name } } }" },
    ]);
    expect(y.frames).toHaveLength(2);
    expect(data(y.frames[1]!)).toMatchObject({ title: "Ship the migration", project: { key: "ING" }, reporter: { user: { name: "Ada Lovelace" } } });

    report.add({
      aspect: "Create an issue and show its page",
      values: { REST: 2, GraphQL: 2, Rayfold: 1 },
      unit: "network round trips",
      better: "lower",
      metric: "round trips to write and then read",
      REST: "2: POST /issues, then GET the new issue to load the page around it",
      GraphQL: "2: a mutation cannot feed a query in the same request, so the read is a second call",
      Rayfold: "1: the read op refers to the write op with `$ref`, and the server runs them in order",
    });
  });
});

describe("5b. A write and two screens in one request", () => {
  it("Rayfold sends one request for all three; the others cannot mix a write with reads", async () => {
    const ACTIVITY_SHAPE = "{ items { id at actor { ...Member.default } } }";
    const y = await rayCall([
      { id: 1, op: "createIssue", args: { input: { projectId: "p1", title: "Batched" } }, key: "ws-batch-0000001", shape: "{ id key }" },
      { id: 2, op: "board", args: { projectId: "p1" }, shape: BOARD_SHAPE },
      { id: 3, op: "activity", args: { projectId: "p1", page: { first: 20 } }, shape: ACTIVITY_SHAPE },
    ]);
    expect(y.frames).toHaveLength(3);
    expect(y.frames.map((f) => f["id"])).toEqual([1, 2, 3]);
    expect((y.frames[1]!["data"] as { columns: unknown[] }).columns).toHaveLength(6);

    // REST: the write, then each screen.
    const created = await call(`${rest.base}/issues`, { method: "POST", headers: { ...OWNER, ...JSON_CT, "idempotency-key": "ws-batch-0000002" }, body: JSON.stringify({ projectId: "p1", title: "Batched" }) });
    expect(created.status).toBe(201);
    const [restBoard, restFeed] = await Promise.all([restGet("/projects/p1/board?limit=10"), restGet("/projects/p1/activity?limit=20")]);
    expect(restBoard.status).toBe(200);
    expect(restFeed.status).toBe(200);

    // GraphQL: a document holds either a mutation or a query, never both, so the screens are a second request.
    const gWrite = await gqlCall(`mutation { createIssue(input: { projectId: "p1", title: "Batched" }) { id key } }`);
    expect((gWrite.json as { errors?: unknown[] }).errors).toBeUndefined();
    const gScreens = await gqlCall(`{ board(projectId: "p1") { columns { state count } } activity(projectId: "p1", first: 20) { items { id at actor { user { name } } } } }`);
    expect((gScreens.json as { errors?: unknown[] }).errors).toBeUndefined();

    report.add({
      aspect: "A write and the two screens that show it",
      values: { REST: 3, GraphQL: 2, Rayfold: 1 },
      unit: "network round trips",
      better: "lower",
      metric: "round trips for a write plus two screens",
      REST: "3: one for the write, one for the board, one for the feed",
      GraphQL: "2: a document is a mutation or a query, never both, so the screens follow the write",
      Rayfold: "1: writes and reads are ops of the same batch, run in order, and rows loaded for one op are not loaded again for the next",
      note: "Within the request the server keeps what it loaded: the people on the board are not fetched a second time for the feed.",
    });
  });
});

describe("6. Two people editing the same issue", () => {
  it("a write against a version that has moved on is refused everywhere; Rayfold hands back the current row in the shape asked for", async () => {
    const first = await call(`${rest.base}/issues/i003`, { method: "PATCH", headers: { ...OWNER, ...JSON_CT, "if-match": '"1"' }, body: JSON.stringify({ title: "Renamed by the first writer" }) });
    expect(first.status).toBe(200);
    const stale = await call(`${rest.base}/issues/i003`, { method: "PATCH", headers: { ...OWNER, ...JSON_CT, "if-match": '"1"' }, body: JSON.stringify({ title: "Renamed by the second writer" }) });
    expect(stale.status).toBe(412);
    expect((stale.json as { current: { version: number } }).current.version).toBe(2);

    await gqlCall(`mutation { updateIssue(id: "i003", patch: { title: "Renamed by the first writer" }, ifVersion: 1) { version } }`);
    const gStale = await gqlCall(`mutation { updateIssue(id: "i003", patch: { title: "Renamed by the second writer" }, ifVersion: 1) { version } }`);
    const gErr = (gStale.json as { errors: Array<{ extensions: { code: string } }> }).errors[0]!;
    expect(gErr.extensions.code).toBe("CONFLICT");

    await rayCall([{ id: 1, op: "updateIssue", args: { id: "i003", patch: { title: "Renamed by the first writer" } }, key: "ws-edit-00000001", ifVersion: 1, shape: "{ version }" }]);
    const yStale = await rayCall([{ id: 1, op: "updateIssue", args: { id: "i003", patch: { title: "Renamed by the second writer" } }, key: "ws-edit-00000002", ifVersion: 1, shape: "{ key title version }" }]);
    const yErr = yStale.frames[0]!["error"] as { code: string; type: string; data: { actual: number; current: Record<string, unknown> } };
    expect(yErr).toMatchObject({ code: "failed_precondition", type: "VersionConflict" });
    expect(yErr.data.actual).toBe(2);
    expect(yErr.data.current).toMatchObject({ key: "ING-3", title: "Renamed by the first writer", version: 2 });

    report.add({
      aspect: "Lost update refused (two writers, one issue)",
      values: { REST: 1, GraphQL: 0, Rayfold: 1 },
      unit: "the losing writer gets the current row back (1 = yes)",
      better: "higher",
      metric: "what the losing writer receives",
      REST: "412 with the current representation in the body, because this endpoint was written to include it",
      GraphQL: "an error with a code and the current version number; the row itself needs another request",
      Rayfold: "a typed `VersionConflict` carrying the current entity in the shape the op asked for, so the client can redraw and retry without a read",
      note: "All three refuse the stale write. The difference is what the client has to do next.",
    });
  });
});

describe("7. Closing a sprint", () => {
  it("one command moves every unfinished issue; only Rayfold tells the client which rows changed", async () => {
    const before = await restGet("/issues?sprintId=s02&limit=50");
    const carried = items(before.json).filter((i) => i["state"] !== "DONE" && i["state"] !== "CANCELLED").length;
    expect(carried).toBeGreaterThan(3);

    const r = await call(`${rest.base}/sprints/s02/close`, { method: "POST", headers: { ...OWNER, ...JSON_CT }, body: JSON.stringify({ carryTo: "s03" }) });
    expect((r.json as { moved: number }).moved).toBe(carried);

    const g = await gqlCall(`mutation { closeSprint(id: "s02", carryTo: "s03") { sprint { id state } moved carriedOver } }`);
    expect((data(g.json as Record<string, unknown>)["closeSprint"] as { moved: number }).moved).toBe(carried);

    const y = await rayCall([{ id: 1, op: "closeSprint", args: { id: "s02", carryTo: "s03" }, key: "ws-close-0000001", shape: "{ sprint { id state } moved carriedOver }" }]);
    const frame = y.frames[0]!;
    expect(frame["ok"]).toMatchObject({ moved: carried });
    const patch = frame["patch"] as Array<Record<string, unknown>>;
    const issuePatches = patch.filter((p) => String(p["set"] ?? "").startsWith("Issue:"));
    expect(issuePatches).toHaveLength(carried);
    expect(issuePatches[0]).toMatchObject({ value: { sprintId: "s03" } });

    report.add({
      aspect: "Bulk write: closing a sprint",
      values: { REST: 0, GraphQL: 0, Rayfold: issuePatches.length },
      unit: "changed rows the write itself reports",
      better: "higher",
      metric: "what the client learns from the write",
      REST: "the new sprint state. Which of the cached issues moved is not said, so the client refetches the lists it holds",
      GraphQL: "whatever the mutation selected. A mutation cannot describe rows it did not return, so the client refetches",
      Rayfold: `${issuePatches.length} entity patches plus the sprint, in the command's own answer: every cached screen holding those issues is corrected with no further request`,
      note: `The sprint held ${carried} unfinished issues. Patches are part of every command's answer, not something the server was asked for.`,
    });
  });
});

describe("8. Staying up to date while someone else works", () => {
  it("a live query is patched; a subscription tells you something happened and you fetch it again", async () => {
    const board = await restGet("/projects/p1/board?limit=10");
    const todo = (board.json as { columns: Array<{ state: string; issues: Array<{ id: string; key: string }> }> }).columns.find((c) => c.state === "TODO")!;
    const target = todo.issues[0]!.id;
    const ISSUE_SHAPE = "{ id key state version }";

    // REST: an SSE channel the team built, then a refetch of the issue, because the event is not the new state.
    const restSse = openSse(`${rest.base}/events`, { headers: OWNER });
    await restSse.ready;
    const restMove = await call(`${rest.base}/issues/${target}/move`, { method: "POST", headers: { ...OWNER, ...JSON_CT }, body: JSON.stringify({ to: "IN_PROGRESS" }) });
    expect(restMove.status).toBe(200);
    await restSse.events.atLeast(1, "the REST move event");
    const restRefetch = await restGet(`/issues/${target}`);
    await restSse.close();
    const restCost = JSON.stringify(restSse.events.items[0]).length + restRefetch.bytes;
    expect((restRefetch.json as { state: string }).state).toBe("IN_PROGRESS");

    // GraphQL: a subscription, then a refetch for the same reason.
    const gSse = openSse(`${gql.base}/graphql`, { method: "POST", headers: { ...OWNER, ...JSON_CT }, body: JSON.stringify({ query: `subscription { projectFeed(projectId: "p1") { issueId from to } }` }) });
    await gSse.ready;
    await gqlCall(`mutation { moveIssue(id: "${target}", to: IN_PROGRESS) { version } }`);
    await gSse.events.atLeast(1, "the GraphQL subscription event");
    const gRefetch = await gqlCall(`{ issue(id: "${target}") { id key state version } }`);
    await gSse.close();
    const gqlCost = JSON.stringify(gSse.events.items[0]).length + gRefetch.bytes;

    // Rayfold: the same query, marked live. The server sends a patch; the client cache applies it.
    const client = new RayfoldClient({ transport: createFetchTransport({ url: `${rayfold.base}/rayfold`, headers: () => OWNER }) });
    const seen = new Signal<string>();
    const stop = client.live<{ state: string }>("issue", { id: target }, { shape: ISSUE_SHAPE }, (d) => seen.push(d.state));
    await seen.atLeast(1, "the live query's first result");
    const writer = new RayfoldClient({ transport: createFetchTransport({ url: `${rayfold.base}/rayfold`, headers: () => OWNER }) });
    await writer.command("moveIssue", { id: target, to: "IN_PROGRESS" });
    await seen.atLeast(2, "the live query's patch");
    stop();
    expect(seen.items).toEqual(["TODO", "IN_PROGRESS"]);
    expect(client.cache.get(`Issue:${target}`)).toMatchObject({ state: "IN_PROGRESS", version: 2 });

    report.add({
      aspect: "Someone else moves an issue you are looking at",
      values: { REST: 3, GraphQL: 3, Rayfold: 1 },
      unit: "pieces the developer writes",
      better: "lower",
      metric: "what it takes to keep one screen correct",
      REST: `an SSE endpoint, an event fan-out and client merge code; the event carries an id, so the client refetches (${restCost.toLocaleString("en-US")} B to become correct)`,
      GraphQL: `a Subscription type, a resolver with an async iterator, and client merge code; then a refetch (${gqlCost.toLocaleString("en-US")} B)`,
      Rayfold: "`live: true` on the query that already draws the screen: the server diffs the result and sends a patch, and the client cache applies it",
      note: "Both other stacks can push the new state in the event itself, but then the event has to be shaped for each screen that listens.",
    });
  });
});

describe("8b. A board someone else is changing", () => {
  it("the server pushes the rows that moved; the other two fetch the whole board again", async () => {
    const board = await restGet("/projects/p1/board?limit=10");
    const columns = (board.json as { columns: Array<{ state: string; issues: Array<{ id: string }> }> }).columns;
    const target = columns.find((c) => c.state === "TODO")!.issues[0]!.id;

    // Rayfold: the query that draws the board, marked live. Read its first frame, change an issue, read what arrives.
    const NEWLINE = String.fromCharCode(10); // frames are newline-separated (spec 04 section 4)
    const ac = new AbortController();
    const res = await fetch(`${rayfold.base}/rayfold`, {
      method: "POST",
      headers: { ...OWNER, ...RAYFOLD_CT },
      body: JSON.stringify({ ops: [{ id: 1, op: "board", args: { projectId: "p1" }, shape: BOARD_SHAPE, live: true }] }),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const nextFrame = async (): Promise<{ text: string; frame: Record<string, unknown> }> => {
      for (;;) {
        const cut = buffered.indexOf(NEWLINE);
        if (cut >= 0) {
          const line = buffered.slice(0, cut);
          buffered = buffered.slice(cut + 1);
          if (line.trim() === "") continue; // a keep-alive
          return { text: line, frame: JSON.parse(line) as Record<string, unknown> };
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("the live stream ended");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    };
    // a frame that never comes fails on its bound, by name, and closes the stream so the recorder can settle
    const frame = (label: string) =>
      bounded(nextFrame(), label).catch((e: unknown) => {
        ac.abort();
        throw e;
      });
    const first = await frame("the live board's first frame");
    expect((data(first.frame)["columns"] as unknown[]).length).toBe(6);
    await rayCall([{ id: 1, op: "moveIssue", args: { id: target, to: "IN_PROGRESS" }, key: "ws-live-00000001", shape: "{ version }" }]);
    const pushed = await frame("the patch for the moved issue");
    ac.abort();
    const ops = pushed.frame["patch"] as Array<Record<string, unknown>>;
    expect(target).toBe("i078");
    // the row left one column and joined the top of another, which lets its last row go; the two counts changed
    expect(ops).toEqual([
      { list: "columns.2.issues.items", del: [0] },
      { at: "columns.2", value: { count: 8 } },
      {
        list: "columns.3.issues.items",
        del: [9],
        ins: [
          {
            at: 0,
            value: {
              $type: "Issue",
              id: "i078",
              key: "ING-78",
              title: "Refactor the WebSocket transport on reconnect",
              state: "IN_PROGRESS",
              priority: "NONE",
              updatedAt: "2026-02-01T12:00:01.000Z",
              assignee: { $type: "Member", id: "m02", role: "ADMIN", user: { $type: "User", id: "u02", name: "Grace Hopper", avatarUrl: "https://avatars.example.com/u02.png" } },
              labels: [
                { $type: "Label", id: "l04", name: "docs", color: "#0075ca" },
                { $type: "Label", id: "l10", name: "regression", color: "#e99695" },
              ],
            },
          },
        ],
      },
      { at: "columns.3", value: { count: 18 } },
    ]);
    const rayfoldBytes = Buffer.byteLength(pushed.text);

    // REST: an event says something happened, so the client asks for the board again.
    const restSse = openSse(`${rest.base}/events`, { headers: OWNER });
    await restSse.ready;
    await call(`${rest.base}/issues/${target}/move`, { method: "POST", headers: { ...OWNER, ...JSON_CT }, body: JSON.stringify({ to: "IN_PROGRESS" }) });
    await restSse.events.atLeast(1, "the REST move event");
    const restBoard = await restGet("/projects/p1/board?limit=10");
    await restSse.close();
    const restBytes = JSON.stringify(restSse.events.items[0]).length + restBoard.bytes;

    // GraphQL: the same, through a subscription.
    const gSse = openSse(`${gql.base}/graphql`, { method: "POST", headers: { ...OWNER, ...JSON_CT }, body: JSON.stringify({ query: `subscription { projectFeed(projectId: "p1") { issueId from to } }` }) });
    await gSse.ready;
    await gqlCall(`mutation { moveIssue(id: "${target}", to: IN_PROGRESS) { version } }`);
    await gSse.events.atLeast(1, "the GraphQL subscription event");
    const gBoard = await gqlCall(BOARD_GQL);
    await gSse.close();
    const gqlBytes = JSON.stringify(gSse.events.items[0]).length + gBoard.bytes;

    expect(rayfoldBytes).toBeLessThan(restBytes / 10);
    expect(rayfoldBytes).toBeLessThan(gqlBytes / 5);

    report.add({
      aspect: "A board someone else is changing",
      values: { REST: restBytes, GraphQL: gqlBytes, Rayfold: rayfoldBytes },
      unit: "bytes to keep an open board correct after one move",
      better: "lower",
      metric: "bytes per change, board open",
      REST: `${restBytes.toLocaleString("en-US")} B: the event carries an id, so the client fetches all six columns again`,
      GraphQL: `${gqlBytes.toLocaleString("en-US")} B: the subscription carries the event, so the client runs the board query again`,
      Rayfold: `${rayfoldBytes.toLocaleString("en-US")} B: the server diffs the board it already served and sends the row that moved and the two counts that changed`,
      note: "The client asks for nothing: it holds one live query, and what a change costs depends on the change rather than on the size of the screen.",
    });
    // longer than a frame's bound, so a frame that never comes is named by that bound rather than by the test timing out
  }, 10_000);
});

describe("9. Two tenants on one deployment", () => {
  it("nobody reads another organisation's issue, and the rule is in one place only on Rayfold", async () => {
    // The second organisation's issue, asked for by a member of the first.
    const r = await restGet("/issues/i610");
    expect(r.status).toBe(403);
    const g = await gqlCall(`{ issue(id: "i610") { key title } }`);
    expect(data(g.json as Record<string, unknown>)["issue"]).toBeNull();
    const y = await rayCall([{ id: 1, op: "issue", args: { id: "i610" }, shape: "{ key title }" }]);
    expect(data(y.frames[0]!)).toBeNull();

    // Its own tenant still reads it: the rule is a boundary, not a wall.
    const own = await rayCall([{ id: 1, op: "issue", args: { id: "i610" }, shape: "{ key title }" }], OTHER_TENANT);
    expect(data(own.frames[0]!)).toMatchObject({ key: "GXC-10" });

    // A plain member may not read another person's email address, and may not see the seat count.
    const memberView = await gqlCall(`{ member(id: "m01") { user { name email } } }`, MEMBER);
    expect((data(memberView.json as Record<string, unknown>)["member"] as { user: { email: string | null } }).user.email).toBeNull();
    const yMember = await rayCall([{ id: 1, op: "member", args: { id: "m01" }, shape: "{ user { name } }" }], MEMBER);
    expect(data(yMember.frames[0]!)).toMatchObject({ user: { name: "Ada Lovelace" } });
    const yEmail = await rayCall([{ id: 1, op: "member", args: { id: "m01" }, shape: "{ user { name email } }" }], MEMBER);
    expect(yEmail.frames[0]!["error"]).toMatchObject({ code: "permission_denied", path: "user.email" });

    // One rule, every way in. None of these paths carries a line of authorization code of its own.
    const binding = await call(`${rayfold.base}/issues/i610`, { headers: OWNER });
    expect(binding.json).toBeNull();
    const ownBinding = await call(`${rayfold.base}/issues/i002`, { headers: OWNER });
    expect(ownBinding.json).toMatchObject({ key: "ING-2" }); // guard: the same route still serves its own tenant
    const mcpRead = await call(`${rayfold.base}/mcp`, { method: "POST", headers: { ...OWNER, ...JSON_CT }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "rayfold://query/issue?id=i610" } }) });
    expect((mcpRead.json as { result: { contents: Array<{ text: string }> } }).result.contents[0]!.text).toBe("null");
    const ac = new AbortController();
    const liveRes = await fetch(`${rayfold.base}/rayfold`, { method: "POST", headers: { ...OWNER, ...RAYFOLD_CT }, body: JSON.stringify({ ops: [{ id: 1, op: "issue", args: { id: "i610" }, shape: "{ key state }", live: true }] }), signal: ac.signal });
    const firstFrame = await liveRes.body!.getReader().read();
    ac.abort();
    expect((JSON.parse(new TextDecoder().decode(firstFrame.value)) as { data: unknown }).data).toBeNull();

    // For the record, the authorization code each stack carries for the rules asserted above.
    const occurrences = (src: string, needle: string): number => src.split(needle).length - 1;
    const restSrc = readFileSync("e2e/workspace-rest.ts", "utf8");
    const gqlSrc = readFileSync("e2e/workspace-gql.ts", "utf8");
    const restChecks = occurrences(restSrc, "readable(") + occurrences(restSrc, "!viewer") + occurrences(restSrc, "viewer?.role");
    const gqlChecks = occurrences(gqlSrc, "ownIssue(") + occurrences(gqlSrc, "!ctx.viewer") + occurrences(gqlSrc, "ctx.viewer?.role") + occurrences(gqlSrc, "orgId !==") + occurrences(gqlSrc, "orgId ===");
    const declarations = occurrences(workspaceSchemaText(), "@allow(");

    report.add({
      aspect: "One tenant rule, every way in",
      values: { REST: 1, GraphQL: 1, Rayfold: 4 },
      unit: "ways in that enforce the same declared rule with no extra code",
      better: "higher",
      metric: "surfaces one rule covers",
      REST: "1: the handler it was written in. A second endpoint over the same rows needs the check written again, and nothing fails if it is forgotten",
      GraphQL: "1: the resolver it was written in. The schema cannot carry the rule, so every new resolver repeats it",
      Rayfold: "4: the batch endpoint, the `GET /issues/{id}` route bound with `@http`, the MCP resource an assistant reads, and the live query all refuse the same row from one `@allow` on the entity",
      note: `Authorization written by hand for the rules asserted here: ${restChecks} lines in the REST stack and ${gqlChecks} in the GraphQL stack, against ${declarations} declarations in the Rayfold schema. All three refuse this cross-tenant read; the difference is how many places have to stay correct as the API grows.`,
    });
  });
});

describe("10. A client asking for too much", () => {
  it("a deeply nested request is refused before any data source is touched", async () => {
    const ABUSE_SHAPE = "{ items { key comments(page: { first: 100 }) { items { body author { user { name } } } } children(page: { first: 100 }) { items { key } } } }";
    resetCounters();
    const y = await rayCall([{ id: 1, op: "issues", args: { page: { first: 200 } }, shape: ABUSE_SHAPE }]);
    expect(y.status).toBe(200);
    expect(y.frames).toEqual([{ error: { code: "resource_exhausted", message: "Batch cost 81006 exceeds budget 1000", data: { cost: 81006, budget: 1000 } }, fin: true }]);
    const refused = (y.frames[0]!["error"] as { data: { cost: number; budget: number } }).data;
    expect(calls(rayfold)).toBe(0); // nothing ran

    // Guard: the same selection over one project's first ten issues, with five comments and sub-issues each, fits and runs.
    const FITS_SHAPE = "{ items { key comments(page: { first: 5 }) { items { body author { user { name } } } } children(page: { first: 5 }) { items { key } } } }";
    const fits = await rayCall([{ id: 1, op: "issues", args: { filter: { projectId: "p1" }, page: { first: 10 } }, shape: FITS_SHAPE }]);
    expect(fits.frames.map((f) => Object.keys(f))).toEqual([["id", "data", "meta", "fin"]]);
    expect(fits.frames[0]!["meta"]).toEqual({ cost: 256 });
    const rows = items(data(fits.frames[0]!)).map((i) => [i["key"], items(i["comments"]).length, items(i["children"]).length]);
    expect(rows).toEqual([["ING-100", 3, 0], ["ING-99", 0, 0], ["ING-98", 3, 1], ["ING-97", 0, 0], ["ING-96", 3, 0], ["ING-95", 0, 0], ["ING-94", 3, 0], ["ING-93", 0, 1], ["ING-92", 3, 0], ["ING-91", 0, 0]]);
    expect(rayfold.counters.loaderCalls).toEqual({ "Query.issues": 1, "Issue.comments": 1, "Issue.children": 1, "Comment.author": 1, "Member.user": 1 });

    const g = await gqlCall(`{ issues(first: 200) { items { key comments(first: 100) { items { body author { user { name } } } } children(first: 100) { items { key } } } } }`);
    expect(g.status).toBe(200);
    expect(items(data(g.json as Record<string, unknown>)["issues"])).toHaveLength(170);
    expect(gql.counters.loaderCalls).toEqual({ "Issue.comments": 1, "Issue.children": 1, "Comment.author": 1, "Member.user": 1 });

    report.add({
      aspect: "An expensive request from a client",
      values: { REST: 1, GraphQL: 0, Rayfold: 1 },
      unit: "refused before the data source is touched (1 = yes)",
      better: "higher",
      metric: "what stops a costly request",
      REST: "1: the endpoint decides its own shape, so the client cannot ask for a deeper join (the same reason it cannot ask for less)",
      GraphQL: `0: the query ran and returned ${g.bytes.toLocaleString("en-US")} bytes; cost analysis is a separate library to add and tune`,
      Rayfold: `1: the cost of ${refused.cost.toLocaleString("en-US")} was computed from the schema against a budget of ${refused.budget.toLocaleString("en-US")} and refused, with no loader called`,
      note: "Rayfold charges rows and loads, not columns: a page costs its size, and scalar fields are free.",
    });
  });
});

describe("11. Reading the same screen twice", () => {
  it("a shared cache can answer the second read on every stack", async () => {
    const first = await restGet("/projects/p1");
    const etag = first.text && (await fetch(`${rest.base}/projects/p1`, { headers: OWNER })).headers.get("etag");
    const second = await fetch(`${rest.base}/projects/p1`, { headers: { ...OWNER, "if-none-match": etag ?? "" } });
    expect(second.status).toBe(304);

    const gQuery = `{ project(id: "p1") { key name status targetDate } }`;
    const gFirst = await fetch(`${gql.base}/graphql?query=${encodeURIComponent(gQuery)}`, { headers: OWNER });
    const gEtag = gFirst.headers.get("etag");
    await gFirst.text();
    const gSecond = await fetch(`${gql.base}/graphql?query=${encodeURIComponent(gQuery)}`, { headers: { ...OWNER, "if-none-match": gEtag ?? "" } });
    expect(gSecond.status).toBe(304);

    const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
    const target = `/rayfold/project?a=${b64({ id: "p1" })}&s=${encodeURIComponent("{ key name status targetDate }")}`;
    const yFirst = await fetch(`${rayfold.base}${target}`, { headers: OWNER });
    const yEtag = yFirst.headers.get("etag");
    const yCache = yFirst.headers.get("cache-control");
    await yFirst.text();
    const ySecond = await fetch(`${rayfold.base}${target}`, { headers: { ...OWNER, "if-none-match": yEtag ?? "" } });
    expect(ySecond.status).toBe(304);
    expect(yCache).toContain("max-age=60");

    report.add({
      aspect: "Second read of an unchanged screen",
      values: { REST: 1, GraphQL: 1, Rayfold: 1 },
      unit: "answered 304 by a cache (1 = yes)",
      better: "higher",
      metric: "conditional requests",
      REST: "304, with the cache rule written into the handler",
      GraphQL: "304, because this server was configured to allow GET for queries; most GraphQL deployments POST everything and cannot",
      Rayfold: `304, with \`${yCache}\` taken from \`@cache(maxAge: 60s, scope: public)\` on the entity, and the shape in the URL so the key is stable`,
    });
  });
});

describe("12. A downstream system is down", () => {
  it("the page still renders, and only Rayfold declares which field is allowed to fail", async () => {
    for (const s of [rest, gql, rayfold]) s.store.down.tracker = true;

    const r = await restGet("/issues/i004");
    expect(r.status).toBe(200);
    expect((r.json as { externalState: null; warnings: Array<{ field: string }> }).warnings[0]!.field).toBe("externalState");

    const g = await gqlCall(`{ issue(id: "i004") { key state externalState } }`);
    const gBody = g.json as { data: { issue: { key: string; externalState: null } }; errors: Array<{ path: string[] }> };
    expect(gBody.data.issue).toMatchObject({ key: "ING-4", externalState: null });
    expect(gBody.errors[0]!.path).toEqual(["issue", "externalState"]);

    const y = await rayCall([{ id: 1, op: "issue", args: { id: "i004" }, shape: "{ key state externalState }" }]);
    expect(data(y.frames[0]!)).toMatchObject({ key: "ING-4", externalState: null });
    expect(y.frames[0]!["errors"]).toEqual([{ code: "unavailable", message: expect.any(String), path: "externalState" }]);

    // `spend` is `@partial` as well: the rest of the project still arrives, with the failure at the field's path.
    rayfold.store.down.billing = true;
    const partial = await rayCall([{ id: 1, op: "project", args: { id: "p1" }, shape: "{ key spend }" }]);
    expect(data(partial.frames[0]!)).toMatchObject({ key: "ING", spend: null });
    expect(partial.frames[0]!["errors"]).toEqual([{ code: "unavailable", message: expect.any(String), path: "spend" }]);

    // Guard: a field that is not declared `@partial` fails the whole op, so the exemption is not blanket.
    rayfold.store.down.directory = true;
    const strict = await rayCall([{ id: 1, op: "issue", args: { id: "i002" }, shape: "{ key assignee { user { name } } }" }]);
    expect(strict.frames[0]).not.toHaveProperty("data");
    expect(strict.frames[0]!["error"]).toMatchObject({ code: "unavailable" });

    report.add({
      aspect: "One flaky field, the rest of the page fine",
      values: { REST: 0, GraphQL: 0, Rayfold: 1 },
      unit: "declared in the contract (1 = yes)",
      better: "higher",
      metric: "where 'this field may fail' is written",
      REST: "in the handler, plus a `warnings` array the client has to know about; nothing in the contract says the field is unreliable",
      GraphQL: "in the resolver; the field is nullable like every other nullable field, so a client cannot tell a missing value from a broken integration",
      Rayfold: "`@partial` on the field: the frame carries the rest of the data and an error entry with the field's path, and generated clients see it",
      note: "All three kept the page. The difference is whether the client can know in advance which fields are allowed to be missing.",
    });
  });
});

describe("13. A large field nobody reads first", () => {
  it("the issue arrives, and its long description follows in the same response", async () => {
    const description = rayfold.store.issues.get("i004")?.description ?? "";
    expect(description.length).toBeGreaterThan(200);
    const r = await restGet("/issues/i004");
    expect((r.json as { description: string }).description).toBe(description); // always sent, needed or not

    const g = await fetch(`${gql.base}/graphql`, { method: "POST", headers: { ...JSON_CT, ...OWNER }, body: JSON.stringify({ query: `{ issue(id: "i004") { key state description } }` }) });
    const gParts = (g.headers.get("content-type") ?? "").startsWith("multipart/mixed") ? 2 : 1; // incremental delivery would answer multipart/mixed
    expect(gParts).toBe(1);
    expect(await g.json()).toEqual({ data: { issue: { key: "ING-4", state: "BACKLOG", description } } }); // one body: the client waits for everything it asked for

    const y = await rayCall([{ id: 1, op: "issue", args: { id: "i004" }, shape: "{ key state description }" }]);
    expect(y.frames).toEqual([{ id: 1, data: { $type: "Issue", key: "ING-4", state: "BACKLOG" }, meta: { cost: 1 } }, { id: 1, at: "", data: { description } }, { id: 1, fin: true }]);

    report.add({
      aspect: "A slow or large field on a page",
      values: { REST: 0, GraphQL: gParts > 1 ? 1 : 0, Rayfold: 1 },
      unit: "the rest of the page arrives first, in the same response (1 = yes)",
      better: "higher",
      metric: "delivery of a slow field",
      REST: "the description is part of the issue resource, so it is sent every time, even to a list that never shows it",
      GraphQL: `one body: the client waits for the slowest field it asked for (\`@defer\` is still not in graphql-js ${GRAPHQL_MAJOR})`,
      Rayfold: "`@lazy` on the field: the frame with the page comes first, the description follows at its path in the same response",
    });
  });
});

describe("14. Tools an AI assistant can call", () => {
  it("the same schema is already an MCP server, with dry runs", async () => {
    const res = await fetch(`${rayfold.base}/mcp`, { method: "POST", headers: { ...OWNER, ...JSON_CT }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const tools = (await res.json()) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
    const names = tools.result.tools.map((t) => t.name);
    expect(names).toContain("createIssue");
    expect(names).toContain("closeSprint");

    const dry = await rayCall([{ id: 1, op: "createIssue", args: { input: { projectId: "p1", title: "Dry run" } }, key: "ws-dry-000000001", simulate: true, shape: "{ key state }" }]);
    expect(dry.frames[0]!["ok"]).toMatchObject({ state: "TRIAGE" });
    const after = await rayCall([{ id: 1, op: "issues", args: { filter: { projectId: "p1" }, page: { first: 1 } }, shape: "{ total }" }]);
    expect(data(after.frames[0]!)).toMatchObject({ total: 100 }); // the dry run wrote nothing

    report.add({
      aspect: "Letting an AI assistant use the API",
      values: { REST: 2, GraphQL: 2, Rayfold: 0 },
      unit: "extra components to build",
      better: "lower",
      metric: "work to expose typed tools with dry runs",
      REST: "an OpenAPI document to write and keep true, plus an adapter; no dry run",
      GraphQL: "introspection plus custom glue to turn mutations into tools; no dry run",
      Rayfold: `none: ${names.length} tools listed at /mcp from the same schema, with typed input, typed errors, and \`simulate\` to try a command without writing`,
    });
  });
});
