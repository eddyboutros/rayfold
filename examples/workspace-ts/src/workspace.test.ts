/**
 * The workspace's own reads and writes, through the real server: every assertion is checked against the raw rows of
 * the store, never against the lists and indexes the resolvers read, so an index that drifts from its rows fails here.
 * The e2e comparison runs the same reads on three stacks that share these lists, so it cannot see such a drift.
 */
import { RayfoldClient, RayfoldClientError, createLocalTransport } from "@rayfold/client";
import { collect } from "@rayfold/client/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_STATES, createWorkspace, sizes, type IssueRow, type IssueState, type Store, type Viewer, type Workspace } from "./index.ts";

let ws: Workspace;
let store: Store;

beforeEach(() => {
  ws = createWorkspace();
  store = ws.store;
});

/** Who a user is in the workspace, as the e2e stacks read it from a bearer token. */
function viewer(userId: string): Viewer {
  const member = [...store.members.values()].find((m) => m.userId === userId);
  if (!member) throw new Error(`no member for ${userId}`);
  return { id: userId, orgId: member.orgId, role: member.role, memberId: member.id };
}
const as = (userId: string) => new RayfoldClient({ transport: createLocalTransport(ws.server, () => viewer(userId)) });
/** u01 owns o1, u02 administers it, u03 is a member, u13 administers o2. */
const owner = () => as("u01");

type Page<T> = { items: T[]; cursor: string | null; hasMore: boolean; total: number };
type Ref = { id: string };

/** The oracle: issue ids matching `test`, newest first, read from the rows and not from any index. */
const rows = (test: (i: IssueRow) => boolean): string[] =>
  [...store.issues.values()]
    .filter(test)
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
    .map((i) => i.id);

async function failure(p: Promise<unknown>): Promise<RayfoldClientError> {
  const e = await p.then(
    () => new Error("expected the call to fail"),
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(RayfoldClientError);
  return e as RayfoldClientError;
}

const ids = async (filter: Record<string, unknown> | null, page: Record<string, unknown> = { first: 1000 }) =>
  owner().query<Page<Ref>>("issues", { filter, page }, { shape: "{ items { id } cursor hasMore total }" });

describe("the seed", () => {
  it("is the same data set on every run, with both tenants", () => {
    expect(sizes(store)).toEqual({ orgs: 2, users: 18, teams: 4, projects: 7, sprints: 18, issues: 630, comments: 900, activity: 1156, notifications: 25 });
    expect(sizes(createWorkspace().store)).toEqual(sizes(store));
    expect([...store.issues.values()].filter((i) => i.orgId === "o2")).toHaveLength(30);
    // what u01 finds waiting: 25 notifications, every fourth one already read
    expect([...store.notifications.values()].map((n) => n.readAt !== null)).toEqual(Array.from({ length: 25 }, (_, n) => (n + 1) % 4 === 0));
  });

  it("every index list holds exactly the rows it names, newest first", () => {
    const check = (map: Map<string, string[]>, key: (i: IssueRow) => string | null) => {
      const keys = new Set([...store.issues.values()].map(key).filter((k): k is string => k !== null));
      expect([...map.keys()].sort()).toEqual([...keys].sort());
      for (const k of keys) expect(map.get(k), k).toEqual(rows((i) => key(i) === k));
    };
    check(store.index.issuesByProject, (i) => i.projectId);
    check(store.index.issuesByColumn, (i) => `${i.projectId}|${i.state}`);
    check(store.index.issuesBySprint, (i) => i.sprintId);
    check(store.index.issuesByAssignee, (i) => i.assigneeId);
    // a sub-issue never has sub-issues of its own
    for (const i of store.issues.values()) if (i.parentId) expect(store.issues.get(i.parentId)?.parentId, i.id).toBeNull();
    expect([...store.issues.values()].filter((i) => i.parentId).length).toBeGreaterThan(20);
  });

  it("the feed is ordered by when things happened, newest first", () => {
    for (const [projectId, list] of store.index.activityByProject) {
      const expected = [...store.activity.values()]
        .filter((a) => a.projectId === projectId)
        .sort((x, y) => (x.at === y.at ? (x.id < y.id ? 1 : -1) : x.at < y.at ? 1 : -1))
        .map((a) => a.id);
      expect(list, projectId).toEqual(expected);
    }
  });
});

describe("issues: every filter, read off its index or scanned, answers what the rows say", () => {
  const cases: Array<[string, Record<string, unknown>, (i: IssueRow) => boolean]> = [
    ["project", { projectId: "p1" }, (i) => i.projectId === "p1"],
    ["project and state (a board column)", { projectId: "p2", state: "IN_PROGRESS" }, (i) => i.projectId === "p2" && i.state === "IN_PROGRESS"],
    ["sprint", { sprintId: "s02" }, (i) => i.sprintId === "s02"],
    ["assignee", { assigneeId: "m04" }, (i) => i.assigneeId === "m04"],
    ["project and priority", { projectId: "p3", priority: "HIGH" }, (i) => i.projectId === "p3" && i.priority === "HIGH"],
    ["project, state and priority", { projectId: "p1", state: "DONE", priority: "LOW" }, (i) => i.projectId === "p1" && i.state === "DONE" && i.priority === "LOW"],
    ["sprint and state", { sprintId: "s05", state: "DONE" }, (i) => i.sprintId === "s05" && i.state === "DONE"],
    ["assignee and priority", { assigneeId: "m03", priority: "URGENT" }, (i) => i.assigneeId === "m03" && i.priority === "URGENT"],
    ["project and assignee", { projectId: "p1", assigneeId: "m05" }, (i) => i.projectId === "p1" && i.assigneeId === "m05"],
    ["project and sprint", { projectId: "p2", sprintId: "s05" }, (i) => i.projectId === "p2" && i.sprintId === "s05"],
    ["label", { labelId: "l03" }, (i) => i.orgId === "o1" && i.labelIds.includes("l03")],
    ["title, in any case", { titleContains: "UNDER LOAD" }, (i) => i.title.toLowerCase().includes("under load")],
    ["priority and label", { priority: "URGENT", labelId: "l02" }, (i) => i.priority === "URGENT" && i.labelIds.includes("l02")],
    ["a null field is no filter", { projectId: "p4", state: null }, (i) => i.projectId === "p4"],
  ];
  for (const [what, filter, test] of cases) {
    it(what, async () => {
      const expected = rows(test);
      expect(expected.length, "the case selects something").toBeGreaterThan(0);
      const page = await ids(filter);
      expect(page.items.map((i) => i.id)).toEqual(expected);
      expect(page.total).toBe(expected.length);
    });
  }

  it("no filter lists every issue newest first, which is the second organisation's for its admin", async () => {
    const page = await as("u13").query<Page<Ref>>("issues", { filter: null, page: { first: 5 } }, { shape: "{ items { id } total }" });
    expect(page).toEqual({ items: ["i630", "i629", "i628", "i627", "i626"].map((id) => ({ $type: "Issue", id })), total: 630 });
    expect(rows(() => true).slice(0, 5)).toEqual(["i630", "i629", "i628", "i627", "i626"]);
  });

  it("pages by cursor without a gap or a repeat, and by offset; an unknown cursor is an empty page", async () => {
    const expected = rows((i) => i.projectId === "p1");
    const walked: string[] = [];
    const seen: Array<[number, string | null, boolean]> = [];
    let after: string | null = null;
    do {
      const page: Page<Ref> = await ids({ projectId: "p1" }, after ? { first: 30, after } : { first: 30 });
      walked.push(...page.items.map((i) => i.id));
      seen.push([page.items.length, page.cursor, page.hasMore]);
      after = page.hasMore ? page.cursor : null;
    } while (after);
    expect(walked).toEqual(expected);
    expect(seen).toEqual([
      [30, expected[29]!, true],
      [30, expected[59]!, true],
      [30, expected[89]!, true],
      [10, expected[99]!, false],
    ]);
    // exactly a page short of the end: nothing more
    expect(await ids({ projectId: "p1" }, { first: 10, after: expected[89] })).toEqual({ items: expected.slice(90).map((id) => ({ $type: "Issue", id })), cursor: expected[99], hasMore: false, total: 100 });
    expect(await ids({ projectId: "p1" }, { first: 3, offset: 4 })).toEqual({ items: expected.slice(4, 7).map((id) => ({ $type: "Issue", id })), cursor: expected[6], hasMore: true, total: 100 });
    expect(await ids({ projectId: "p1" }, { first: 3, after: "i999" })).toEqual({ items: [], cursor: null, hasMore: false, total: 100 });
  });
});

describe("the board", () => {
  it("has a column per board state with its count and first page, from the rows", async () => {
    type Board = { project: { id: string }; columns: Array<{ state: IssueState; count: number; issues: Page<Ref> }> };
    const board = await owner().query<Board>("board", { projectId: "p1" }, { shape: "{ project { id } columns { state count issues(page: { first: 3 }) { items { id } total } } }" });
    expect(board.project.id).toBe("p1");
    expect(board.columns.map((c) => [c.state, c.count, c.issues.total, c.issues.items.map((i) => i.id)])).toEqual(
      BOARD_STATES.map((state) => {
        const col = rows((i) => i.projectId === "p1" && i.state === state);
        return [state, col.length, col.length, col.slice(0, 3)];
      }),
    );
    const missing = await failure(owner().query("board", { projectId: "nope" }, { shape: "{ columns { count } }" }));
    expect([missing.code, missing.message]).toEqual(["not_found", "Project nope not found"]);
  });
});

describe("search", () => {
  type Hit = { $type: string; id: string };
  const search = (who: string, q: string) => as(who).query<Page<Hit>>("search", { q, page: { first: 200 } }, { shape: "{ items { ... on Issue { id } ... on Project { id } ... on Comment { id } } total }" });

  it("finds issues by title or key, projects by name or key, and comments by body: issues, then projects, then comments", async () => {
    const hits = await search("u01", "ING-1");
    // ING-1, ING-10..ING-19 and ING-100, newest first; then the project whose key is ING
    expect(hits.items).toEqual([
      ...rows((i) => i.orgId === "o1" && (i.key.toLowerCase().includes("ing-1") || i.title.toLowerCase().includes("ing-1"))).map((id) => ({ $type: "Issue", id })),
    ]);
    expect(hits.items).toHaveLength(12);
    expect((await search("u01", "realtime")).items).toEqual([{ $type: "Project", id: "p2" }]);
    expect((await search("u01", "mig")).items).toEqual([...rows((i) => i.key.startsWith("MIG-")).map((id) => ({ $type: "Issue", id })), { $type: "Project", id: "p5" }]);
    const staging = [...store.comments.values()].filter((c) => c.body.toLowerCase().includes("staging cluster")).map((c) => ({ $type: "Comment", id: c.id }));
    expect(staging).toHaveLength(300);
    expect(await search("u01", "STAGING CLUSTER")).toEqual({ items: staging.slice(0, 200), total: 300 });
  });

  it("finds only the searcher's own organisation; guard: the other organisation finds its own", async () => {
    expect((await search("u01", "GXC")).items).toEqual([]);
    const theirs = await search("u13", "GXC");
    expect(theirs.items).toEqual([...rows((i) => i.orgId === "o2").map((id) => ({ $type: "Issue", id })), { $type: "Project", id: "p7" }]);
    expect((await search("u13", "staging")).items).toEqual([]);
  });
});

describe("the activity feed and its kinds", () => {
  it("one page of four kinds, newest first, each with the fields of its kind", async () => {
    type A = { $type: string; id: string; at: string; actor: Ref; issue?: Ref; from?: string; to?: string; comment?: Ref; sprint?: Ref; completed?: number; carriedOver?: number };
    const shape = "{ items { id at actor { id } ... on IssueOpened { issue { id } } ... on IssueMovedActivity { issue { id } from to } ... on IssueCommented { comment { id } } ... on SprintClosedActivity { sprint { id } completed carriedOver } } cursor hasMore total }";
    const page: Page<A> = { items: [], cursor: null, hasMore: true, total: 0 };
    for (let n = 0; page.hasMore && n < 10; n++) {
      const next: Page<A> = await owner().query<Page<A>>("activity", { projectId: "p3", page: page.cursor ? { first: 100, after: page.cursor } : { first: 100 } }, { shape });
      Object.assign(page, { cursor: next.cursor, hasMore: next.hasMore, total: next.total, items: [...page.items, ...next.items] });
    }
    expect(page.hasMore).toBe(false);
    const expected = [...store.activity.values()].filter((a) => a.projectId === "p3").sort((x, y) => (x.at === y.at ? (x.id < y.id ? 1 : -1) : x.at < y.at ? 1 : -1));
    expect(page.total).toBe(expected.length);
    expect(page.items.map((a) => a.id)).toEqual(expected.map((a) => a.id));
    for (const [n, a] of page.items.entries()) {
      const row = expected[n]!;
      const ref = (id: string | null) => (id === null ? null : { $type: undefined, id });
      expect(a.$type).toBe(row.$type);
      expect(a.actor.id).toBe(row.actorId);
      if (row.$type === "IssueOpened") expect(a.issue?.id).toBe(row.issueId);
      if (row.$type === "IssueMovedActivity") expect([a.issue?.id, a.from, a.to]).toEqual([row.issueId, row.from, row.to]);
      if (row.$type === "IssueCommented") expect(a.comment?.id).toBe(ref(row.commentId)?.id);
      if (row.$type === "SprintClosedActivity") expect([a.sprint?.id, a.completed, a.carriedOver]).toEqual([row.sprintId, 14, 3]);
    }
    expect(new Set(page.items.map((a) => a.$type))).toEqual(new Set(["IssueOpened", "IssueMovedActivity", "IssueCommented", "SprintClosedActivity"]));
  });
});

describe("the fields that load a level at once", () => {
  it("a project's team, lead, labels, spend, sprints, issues and summary", async () => {
    type P = { team: Ref; lead: Ref | null; labels: Ref[]; spend: string | null; sprints: Page<Ref>; issues: Page<Ref>; summary: string };
    const shape = "{ id team { id } lead { id } labels { id } spend sprints { items { id } } issues(page: { first: 2 }) { items { id } total } summary }";
    const [p1, p6] = await Promise.all(["p1", "p6"].map((id) => owner().query<P>("project", { id }, { shape })));
    const p1Issues = rows((i) => i.projectId === "p1");
    const all = [...store.issues.values()].filter((i) => i.projectId === "p1");
    const points = all.reduce((n, i) => n + (i.estimate ?? 0), 0);
    expect(p1).toMatchObject({
      team: { id: "t1" },
      lead: { id: "m01" },
      labels: [{ id: "l01" }, { id: "l02" }, { id: "l03" }, { id: "l04" }],
      spend: "1274.00",
      sprints: { items: [{ id: "s01" }, { id: "s02" }, { id: "s03" }] },
      issues: { items: p1Issues.slice(0, 2).map((id) => ({ id })), total: 100 },
      summary: `Ingest pipeline: ${all.filter((i) => i.state === "DONE").length} of 100 issues done, ${points} points planned.`,
    });
    // a planned project has nothing spent yet, and its lead is the sixth member
    expect(p6).toMatchObject({ lead: { id: "m06" }, spend: null });
  });

  it("an issue's parent and children, comments in the order written, and its people", async () => {
    const child = [...store.issues.values()].find((i) => i.parentId !== null)!;
    const parentId = child.parentId!;
    type I = { parent: Ref | null; children: Page<Ref>; comments: Page<{ id: string; author: Ref }>; reporter: Ref; assignee: Ref | null; sprint: Ref | null; project: Ref; labels: Ref[] };
    const shape = "{ id parent { id } children { items { id } total } comments(page: { first: 50 }) { items { id author { id } } } reporter { id } assignee { id } sprint { id } project { id } labels { id } }";
    const parent = await owner().query<I>("issue", { id: parentId }, { shape });
    const p = store.issues.get(parentId)!;
    const kids = [...store.issues.values()].filter((i) => i.parentId === parentId).map((i) => i.id);
    expect(parent.parent).toBeNull();
    expect(parent.children).toMatchObject({ items: kids.map((id) => ({ id })), total: kids.length });
    const comments = [...store.comments.values()].filter((c) => c.issueId === parentId);
    expect(parent.comments.items.map((c) => [c.id, c.author.id])).toEqual(comments.map((c) => [c.id, c.authorId]));
    expect([parent.reporter.id, parent.assignee?.id ?? null, parent.sprint?.id ?? null, parent.project.id, parent.labels.map((l) => l.id)]).toEqual([p.reporterId, p.assigneeId, p.sprintId, p.projectId, p.labelIds]);
    expect((await owner().query<I>("issue", { id: child.id }, { shape })).parent).toMatchObject({ id: parentId });
  });

  it("a member's assigned issues, a team's members and projects, an organisation's teams", async () => {
    const member = await owner().query<{ assigned: Page<Ref>; user: { id: string; email: string } }>("member", { id: "m04" }, { shape: "{ assigned(page: { first: 500 }) { items { id } total } user { id email } }" });
    expect(member.assigned.items.map((i) => i.id)).toEqual(rows((i) => i.assigneeId === "m04"));
    expect(member.user).toMatchObject({ id: "u04", email: "katherine.johnson@acme.example" });
    const team = await owner().query<{ members: Page<Ref>; projects: Page<Ref> }>("team", { id: "t2" }, { shape: "{ members { items { id } } projects { items { id } } }" });
    expect(team.members.items.map((m) => m.id)).toEqual(["m06", "m07", "m08", "m09"]);
    expect(team.projects.items.map((p) => p.id)).toEqual(["p3", "p4"]);
    const org = await owner().query<{ teams: Page<Ref>; seats: number }>("org", { slug: "acme" }, { shape: "{ seats teams { items { id } } }" });
    expect(org).toMatchObject({ seats: 50, teams: { items: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] } });
  });

  it("a sprint's project and issues", async () => {
    const sprint = await owner().query<{ project: Ref; issues: Page<Ref> }>("sprint", { id: "s05" }, { shape: "{ project { id } issues(page: { first: 100 }) { items { id } } }" });
    expect(sprint.project.id).toBe("p2");
    expect(sprint.issues.items.map((i) => i.id)).toEqual(rows((i) => i.sprintId === "s05"));
  });

  it("a notification's issue, for its recipient only", async () => {
    const page = await owner().query<Page<{ id: string; issue: Ref; readAt: string | null }>>("notifications", { page: { first: 50 } }, { shape: "{ items { id readAt issue { id } } total }" });
    expect(page.items.map((n) => [n.id, n.issue.id, n.readAt])).toEqual([...store.notifications.values()].map((n) => [n.id, n.issueId, n.readAt]));
    expect(page.total).toBe(25);
    expect((await as("u03").query<Page<Ref>>("notifications", {}, { shape: "{ total }" })).total).toBe(0);
  });
});

describe("downstream systems that are down", () => {
  it("billing and the tracker fail only their own field; the directory fails the op; guard: up, all three answer", async () => {
    const shape = { shape: "{ id spend }" };
    expect(await owner().query("project", { id: "p1" }, shape)).toMatchObject({ spend: "1274.00" });
    expect(await owner().query("issue", { id: "i007" }, { shape: "{ id externalState }" })).toMatchObject({ externalState: "SYNCED" });
    expect(await owner().query("member", { id: "m02" }, { shape: "{ user { name } }" })).toMatchObject({ user: { name: "Grace Hopper" } });

    store.down = { billing: true, tracker: true, directory: true };
    const frames = await ws.server.collect(
      {
        ops: [
          { id: 1, op: "project", args: { id: "p1" }, shape: "{ id spend }" },
          { id: 2, op: "issue", args: { id: "i007" }, shape: "{ id externalState }" },
          { id: 3, op: "member", args: { id: "m02" }, shape: "{ user { name } }" },
        ],
      },
      { viewer: viewer("u01") },
    );
    const byId = (id: number) => frames.filter((f) => "id" in f && f.id === id);
    expect(byId(1)).toMatchObject([{ data: { id: "p1", spend: null }, errors: [{ code: "unavailable", path: "spend" }] }]);
    expect(byId(2)).toMatchObject([{ data: { id: "i007", externalState: null }, errors: [{ code: "unavailable", path: "externalState" }] }]);
    expect(byId(3)).toMatchObject([{ error: { code: "unavailable", message: "The directory service is not answering" } }]);
  });
});

describe("commands", () => {
  const ISSUE = "{ id key state version assignee { id } sprint { id } }";
  const input = (extra: Record<string, unknown> = {}) => ({ input: { projectId: "p2", title: "A new issue", labelIds: ["l01"], ...extra } });

  it("createIssue opens it in TRIAGE, at the front of every list it belongs to; a dry run creates nothing", async () => {
    const before = store.nextId;
    const dry = await owner().command<{ id: string; key: string }>("createIssue", input({ assigneeId: "m03" }), { shape: ISSUE, simulate: true });
    expect(dry).toMatchObject({ id: `i${before}`, key: "RT-101", state: "TRIAGE" });
    expect([store.nextId, store.issues.has(dry.id), store.index.issuesByProject.get("p2")!.length]).toEqual([before, false, 100]);

    const made = await owner().command<{ id: string; key: string }>("createIssue", input({ assigneeId: "m03" }), { shape: ISSUE });
    expect(made).toEqual({ $type: "Issue", id: `i${before}`, key: "RT-101", state: "TRIAGE", version: 1, assignee: { $type: "Member", id: "m03" }, sprint: null });
    expect(store.nextId).toBe(before + 1);
    expect(store.issues.get(made.id)).toMatchObject({ reporterId: "m01", orgId: "o1", projectId: "p2", labelIds: ["l01"], createdAt: "2026-02-01T12:00:01.000Z" });
    expect(store.index.issuesByProject.get("p2")![0]).toBe(made.id);
    expect(store.index.issuesByColumn.get("p2|TRIAGE")![0]).toBe(made.id);
    expect(store.index.issuesByAssignee.get("m03")![0]).toBe(made.id);
    expect((await ids({ projectId: "p2" }, { first: 1 })).items).toEqual([{ $type: "Issue", id: made.id }]);
    // a client holding the project's list is told it changed, so its next cached read goes to the server
    const holder = owner();
    const list = { filter: { projectId: "p2" }, page: { first: 1 } };
    await holder.query("issues", list, { shape: "{ items { id } }" });
    const second = await holder.command<{ id: string }>("createIssue", input(), { shape: "{ id }" });
    expect(await holder.query("issues", list, { shape: "{ items { id } }", policy: "cache" })).toEqual({ items: [{ $type: "Issue", id: second.id }] });
    // the next one is numbered after it
    expect((await owner().command<{ key: string }>("createIssue", input(), { shape: "{ key }" })).key).toBe("RT-103");
  });

  it("createIssue under a parent lists it among the parent's children; a sub-issue cannot be a parent; another tenant's project is refused", async () => {
    const parent = [...store.issues.values()].find((i) => i.projectId === "p2" && !i.parentId)!;
    const child = await owner().command<{ id: string }>("createIssue", input({ parentId: parent.id }), { shape: "{ id parent { id } }" });
    expect(child).toMatchObject({ parent: { id: parent.id } });
    expect(store.index.issuesByParent.get(parent.id)![0]).toBe(child.id);

    const subIssue = [...store.issues.values()].find((i) => i.parentId)!;
    const deeper = await failure(owner().command("createIssue", input({ parentId: subIssue.id })));
    expect([deeper.type, deeper.data]).toEqual(["Forbidden", { reason: "A sub-issue cannot have sub-issues" }]);
    const foreign = await failure(owner().command("createIssue", { input: { projectId: "p7", title: "Not mine" } }));
    expect([foreign.type, foreign.data]).toEqual(["Forbidden", { reason: "Not a member of that organisation" }]);
    const missing = await failure(owner().command("createIssue", { input: { projectId: "p99", title: "Nowhere" } }));
    expect([missing.type, missing.data]).toEqual(["NotFound", { what: "Project", id: "p99" }]);
    expect(store.issues.size).toBe(631);
  });

  it("moveIssue follows the workflow: the issue changes column, a watcher hears it from the patch, and the feed of its project only", async () => {
    const todo = store.index.issuesByColumn.get("p1|TODO")!.at(-1)!;
    const issue = store.issues.get(todo)!;
    const c = owner();
    const watched = collect<{ state: string; version: number }>((next, fail) => c.watch("issue", { id: todo }, { shape: "{ id state version }" }, next, fail));
    expect(await watched.next("the issue")).toMatchObject({ state: "TODO", version: 1 });

    const subscribed = new Promise<void>((resolve) => {
      const on = ws.server.events.on.bind(ws.server.events);
      vi.spyOn(ws.server.events, "on").mockImplementation((name, fn) => {
        const off = on(name, fn);
        if (name === "IssueMoved") resolve();
        return off;
      });
    });
    const feed = collect<{ issueId: string; from: string; to: string }>((_next, _fail, signal) => owner().stream("projectFeed", { projectId: "p1" }, { signal }));
    await subscribed;
    // a move in another project is not this feed's
    const elsewhere = store.index.issuesByColumn.get("p2|TODO")!.at(-1)!;
    await owner().command("moveIssue", { id: elsewhere, to: "IN_PROGRESS" });

    // the answer carries only the id: what the watcher sees comes from the command's patch
    const moved = await c.command<{ id: string }>("moveIssue", { id: todo, to: "IN_PROGRESS" }, { shape: "{ id }" });
    expect(moved).toEqual({ $type: "Issue", id: todo });
    expect(await watched.next("the move")).toMatchObject({ state: "IN_PROGRESS", version: 2 });
    expect(await feed.next("the move in p1")).toMatchObject({ issueId: todo, from: "TODO", to: "IN_PROGRESS" });
    feed.stop();
    watched.stop();
    expect(store.index.issuesByColumn.get("p1|TODO")).not.toContain(todo);
    expect(store.index.issuesByColumn.get("p1|IN_PROGRESS")![0]).toBe(todo);
    expect(store.issues.get(todo)).toMatchObject({ state: "IN_PROGRESS", version: 2, createdAt: issue.createdAt });

    const same = await failure(owner().command("moveIssue", { id: todo, to: "IN_PROGRESS" }));
    expect([same.type, same.data]).toEqual(["InvalidTransition", { from: "IN_PROGRESS", to: "IN_PROGRESS" }]);
    const skip = await failure(owner().command("moveIssue", { id: todo, to: "DONE" }));
    expect([skip.type, skip.data]).toEqual(["InvalidTransition", { from: "IN_PROGRESS", to: "DONE" }]);
    // a dry run reports the move and makes none
    expect(await owner().command("moveIssue", { id: todo, to: "IN_REVIEW" }, { shape: "{ state version }", simulate: true })).toMatchObject({ state: "IN_REVIEW", version: 3 });
    expect(store.issues.get(todo)).toMatchObject({ state: "IN_PROGRESS", version: 2 });
    expect(store.index.issuesByColumn.get("p1|IN_PROGRESS")![0]).toBe(todo);
  });

  it("updateIssue changes what it is sent and moves the issue between assignees' lists; a stale version is refused", async () => {
    const id = store.index.issuesByAssignee.get("m04")![0]!;
    const updated = await owner().command<{ version: number }>("updateIssue", { id, patch: { assigneeId: "m05", estimate: 8 } }, { shape: "{ id version estimate assignee { id } }", ifVersion: 1 });
    expect(updated).toMatchObject({ version: 2, estimate: 8, assignee: { id: "m05" } });
    expect(store.index.issuesByAssignee.get("m04")).not.toContain(id);
    expect(store.index.issuesByAssignee.get("m05")![0]).toBe(id);
    expect(store.index.issuesByAssignee.get("m05")!.filter((x) => x === id)).toHaveLength(1);

    const stale = await failure(owner().command("updateIssue", { id, patch: { title: "Lost" } }, { ifVersion: 1 }));
    expect([stale.code, stale.type]).toEqual(["failed_precondition", "VersionConflict"]);
    expect(store.issues.get(id)!.title).not.toBe("Lost");
    // a dry run changes nothing
    await owner().command("updateIssue", { id, patch: { title: "Dry" } }, { simulate: true });
    expect(store.issues.get(id)).toMatchObject({ version: 2, estimate: 8 });
    expect(store.issues.get(id)!.title).not.toBe("Dry");
    // guard: the same field, unconditionally, lands
    await owner().command("updateIssue", { id, patch: { title: "Kept" } });
    expect(store.issues.get(id)).toMatchObject({ title: "Kept", version: 3, assigneeId: "m05" });
  });

  it("assignIssue moves the issue to the new assignee's list, unassigns, and refuses another tenant's member", async () => {
    const id = store.index.issuesByAssignee.get("m06")![0]!;
    const c = owner();
    expect(await c.command("assignIssue", { id, memberId: "m07" }, { shape: "{ version assignee { id } }" })).toMatchObject({ version: 2, assignee: { id: "m07" } });
    expect([store.index.issuesByAssignee.get("m06")!.includes(id), store.index.issuesByAssignee.get("m07")![0]]).toEqual([false, id]);
    expect(await c.command("assignIssue", { id, memberId: null }, { shape: "{ version assignee { id } }" })).toMatchObject({ version: 3, assignee: null });
    expect(store.index.issuesByAssignee.get("m07")).not.toContain(id);
    expect(store.issues.get(id)!.assigneeId).toBeNull();

    const foreign = await failure(c.command("assignIssue", { id, memberId: "m14" }));
    expect(foreign.type).toBe("Forbidden");
    const missing = await failure(c.command("assignIssue", { id, memberId: "m99" }));
    expect([missing.type, missing.data]).toEqual(["NotFound", { what: "Member", id: "m99" }]);
    expect(store.issues.get(id)).toMatchObject({ assigneeId: null, version: 3 });
    // the cache of the client that assigned it holds the version the command's patch carried
    expect(c.cache.get(`Issue:${id}`)).toMatchObject({ version: 3 });
  });

  it("comments: added last, deleted by their author or an admin, refused to anyone else", async () => {
    const issueId = "i002";
    const shape = { shape: "{ comments(page: { first: 50 }) { items { id body } } }" };
    const added = await as("u03").command<{ id: string }>("addComment", { input: { issueId, body: "Seen it too." } }, { shape: "{ id author { id } }" });
    expect(added).toMatchObject({ id: `c${store.nextId - 1}`, author: { id: "m03" } });
    const after = await owner().query<{ comments: Page<{ id: string; body: string }> }>("issue", { id: issueId }, shape);
    expect(after.comments.items.map((c) => c.id)).toEqual(["c0001", "c0002", "c0003", added.id]);

    // c0001 is m06's: a member who did not write it cannot delete it
    const refused = await failure(as("u03").command("deleteComment", { id: "c0001" }));
    expect([refused.type, refused.data]).toEqual(["Forbidden", { reason: "Only the author of a comment can delete it" }]);
    const author = as("u03");
    await author.query("issue", { id: issueId }, shape);
    expect(author.cache.has(`Comment:${added.id}`)).toBe(true);
    await author.command("deleteComment", { id: added.id }, { shape: "{ id }" });
    // the command's patch takes the comment out of the cache of the client that deleted it
    expect(author.cache.has(`Comment:${added.id}`)).toBe(false);
    await as("u02").command("deleteComment", { id: "c0001" }); // an admin may
    const left = await owner().query<{ comments: Page<{ id: string }> }>("issue", { id: issueId }, { shape: "{ comments(page: { first: 50 }) { items { id } total } }" });
    expect(left.comments).toEqual({ items: [{ $type: "Comment", id: "c0002" }, { $type: "Comment", id: "c0003" }], total: 2 });
    expect([store.comments.has("c0001"), store.comments.has(added.id)]).toEqual([false, false]);
  });

  it("createProject lists it under its team; a member may not create one", async () => {
    const made = await owner().command<{ id: string; status: string }>("createProject", { input: { teamId: "t3", name: "Cost review", key: "COST" } }, { shape: "{ id status lead { id } team { id } }" });
    expect(made).toMatchObject({ status: "PLANNED", lead: { id: "m01" }, team: { id: "t3" } });
    const team = await owner().query<{ projects: Page<Ref> }>("team", { id: "t3" }, { shape: "{ projects { items { id } } }" });
    expect(team.projects.items.map((p) => p.id)).toEqual(["p5", "p6", made.id]);
    const refused = await failure(as("u03").command("createProject", { input: { teamId: "t3", name: "Mine", key: "MINE" } }));
    expect(refused.code).toBe("permission_denied");
    const foreign = await failure(as("u13").command("createProject", { input: { teamId: "t3", name: "Theirs", key: "THR" } }));
    expect(foreign.type).toBe("Forbidden");
  });

  it("closeSprint carries every unfinished issue to the next sprint, and says how many", async () => {
    const before = store.index.issuesBySprint.get("s02")!.map((id) => store.issues.get(id)!);
    const unfinished = before.filter((i) => i.state !== "DONE" && i.state !== "CANCELLED").map((i) => i.id);
    expect([before.length, unfinished.length]).toEqual([20, 11]);
    const nextBefore = [...store.index.issuesBySprint.get("s03")!];

    const dry = await owner().command<{ moved: number }>("closeSprint", { id: "s02", carryTo: "s03" }, { shape: "{ moved carriedOver sprint { state } }", simulate: true });
    expect(dry).toEqual({ moved: 11, carriedOver: 11, sprint: { $type: "Sprint", state: "CLOSED" } });
    expect([store.sprints.get("s02")!.state, store.index.issuesBySprint.get("s02")!.length]).toEqual(["ACTIVE", 20]);

    const c = owner();
    await c.query("issue", { id: unfinished[0] }, { shape: "{ id version sprint { id } }" });
    const closed = await c.command("closeSprint", { id: "s02", carryTo: "s03" }, { shape: "{ moved carriedOver sprint { id state } }" });
    expect(closed).toEqual({ moved: 11, carriedOver: 11, sprint: { $type: "Sprint", id: "s02", state: "CLOSED" } });
    expect(store.sprints.get("s02")!.state).toBe("CLOSED");
    expect(store.index.issuesBySprint.get("s02")!.sort()).toEqual(before.map((i) => i.id).filter((id) => !unfinished.includes(id)).sort());
    expect(store.index.issuesBySprint.get("s03")).toEqual([...[...unfinished].reverse(), ...nextBefore]);
    for (const id of unfinished) expect(store.issues.get(id), id).toMatchObject({ sprintId: "s03", version: 2 });
    // the client that held one of them was corrected by the command's patch
    expect(c.cache.get(`Issue:${unfinished[0]}`)).toMatchObject({ version: 2 });

    const again = await failure(owner().command("closeSprint", { id: "s02", carryTo: "s03" }));
    expect([again.type, again.data]).toEqual(["SprintNotActive", { state: "CLOSED" }]);
    const nowhere = await failure(owner().command("closeSprint", { id: "s05", carryTo: "s99" }));
    expect([nowhere.type, nowhere.data]).toEqual(["NotFound", { what: "Sprint", id: "s99" }]);
    expect(store.sprints.get("s05")!.state).toBe("ACTIVE");
  });

  it("closeSprint without a next sprint leaves the unfinished issues in none", async () => {
    const unfinished = store.index.issuesBySprint.get("s05")!.filter((id) => !["DONE", "CANCELLED"].includes(store.issues.get(id)!.state));
    const closed = await owner().command<{ moved: number; carriedOver: number }>("closeSprint", { id: "s05", carryTo: null }, { shape: "{ moved carriedOver }" });
    expect(closed).toEqual({ moved: unfinished.length, carriedOver: 0 });
    for (const id of unfinished) expect(store.issues.get(id)!.sprintId).toBeNull();
  });

  it("readNotifications marks the unread ones up to a time and counts them; once read, they are not counted again", async () => {
    const mine = [...store.notifications.values()];
    const upTo = [...mine].sort((a, b) => (a.at < b.at ? -1 : 1))[12]!.at;
    const expected = mine.filter((n) => !n.readAt && n.at <= upTo).length;
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(mine.filter((n) => !n.readAt).length);
    expect(await owner().command("readNotifications", { upTo })).toBe(expected);
    expect(mine.filter((n) => !store.notifications.get(n.id)!.readAt && n.at <= upTo)).toEqual([]);
    expect(await owner().command("readNotifications", { upTo })).toBe(0);
    // someone else's are not theirs to read
    expect(await as("u03").command("readNotifications", { upTo: "2030-01-01T00:00:00.000Z" })).toBe(0);
  });

  it("a command on another tenant's issue is refused before it changes anything", async () => {
    const theirs = [...store.issues.values()].find((i) => i.orgId === "o2" && i.state === "TODO")!;
    for (const [op, args] of [
      ["moveIssue", { id: theirs.id, to: "IN_PROGRESS" }],
      ["updateIssue", { id: theirs.id, patch: { title: "Mine now" } }],
      ["assignIssue", { id: theirs.id, memberId: "m03" }],
      ["addComment", { input: { issueId: theirs.id, body: "Hello" } }],
    ] as const) {
      const e = await failure(owner().command(op, args));
      expect([op, e.type]).toEqual([op, "Forbidden"]);
    }
    expect(store.issues.get(theirs.id)).toMatchObject({ state: "TODO", version: 1 });
    // guard: its own admin moves it
    expect(await as("u13").command("moveIssue", { id: theirs.id, to: "IN_PROGRESS" }, { shape: "{ state }" })).toMatchObject({ state: "IN_PROGRESS" });
  });
});
