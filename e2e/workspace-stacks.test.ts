/**
 * The three workspace stacks behind e2e/workspace.test.ts. A Rayfold lead there only means something when the REST and
 * GraphQL stacks hold the tenant, field and state rules a careful team writes by hand, so each rule is checked here on
 * its own, next to the honest request that still goes through.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RayfoldClient, createWebSocketTransport } from "@rayfold/client";
import { freshWorkspace, startWorkspaceRest, type WorkspaceStack } from "./workspace-rest.ts";
import { startWorkspaceGraphQL } from "./workspace-gql.ts";
import { startWorkspaceRayfold } from "./workspace-rayfold.ts";
import { Signal, openSse } from "./wait.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
/** u01 owns acme (o1), u05 is a plain member of it, u13 administers globex (o2). */
const OWNER = { authorization: "Bearer u01" };
const MEMBER = { authorization: "Bearer u05" };
const OTHER_TENANT = { authorization: "Bearer u13" };
const JSON_CT = { "content-type": "application/json" };

describe("the workspace REST stack", () => {
  let rest: WorkspaceStack;
  beforeEach(async () => {
    rest = await startWorkspaceRest(freshWorkspace());
  });
  afterEach(() => rest.close());
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const res = await fetch(rest.base + path, { method, headers: { ...JSON_CT, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, etag: res.headers.get("etag"), body: text ? (JSON.parse(text) as Obj) : null };
  };

  it("seats and other people's addresses only for owners and admins; a user with no membership is nobody", async () => {
    expect((await call("GET", "/orgs/acme", MEMBER)).body).toEqual({ id: "o1", slug: "acme", name: rest.store.orgs.get("o1")!.name, plan: rest.store.orgs.get("o1")!.plan });
    expect((await call("GET", "/orgs/acme", OWNER)).body!["seats"]).toBe(50);
    const assignee = (r: { body: Obj | null }) => r.body!["assignee"].user as Obj;
    expect(assignee(await call("GET", "/issues/i001", MEMBER))).not.toHaveProperty("email");
    expect(assignee(await call("GET", "/issues/i001", OWNER))["email"]).toBe(rest.store.users.get(rest.store.members.get("m08")!.userId)!.email);
    expect((await call("GET", "/search?q=a", { authorization: "Bearer u999" })).status).toBe(401);
    expect((await call("GET", "/search?q=a", MEMBER)).status).toBe(200);
  });

  it("a list never shows another tenant's issues", async () => {
    expect((await call("GET", "/issues?projectId=p7&limit=5", OWNER)).body!["items"]).toEqual([]);
    expect((await call("GET", "/issues?projectId=p7&limit=5", OTHER_TENANT)).body!["items"]).toHaveLength(5);
  });

  it("an issue revalidates on its version", async () => {
    const first = await call("GET", "/issues/i001", OWNER);
    expect(first.etag).toBe('"1"');
    expect((await call("GET", "/issues/i001", { ...OWNER, "if-none-match": '"1"' })).status).toBe(304);
    expect((await call("GET", "/issues/i001", { ...OWNER, "if-none-match": '"0"' })).status).toBe(200);
  });

  it("a create needs an Idempotency-Key and replays on its retry", async () => {
    const input = { projectId: "p1", title: "Fix the gate" };
    expect(await call("POST", "/issues", OWNER, input)).toMatchObject({ status: 400, body: { title: "idempotency_key_required" } });
    const before = rest.store.issues.size;
    const made = await call("POST", "/issues", { ...OWNER, "idempotency-key": "k-ws-create-0001" }, input);
    const again = await call("POST", "/issues", { ...OWNER, "idempotency-key": "k-ws-create-0001" }, input);
    expect([made.status, again.status, again.body]).toEqual([201, 201, made.body]);
    expect(rest.store.issues.size).toBe(before + 1);
  });

  it("a move must be a transition, and is announced on the event stream", async () => {
    expect(await call("POST", "/issues/i001/move", OWNER, { to: "IN_PROGRESS" })).toMatchObject({ status: 422, body: { title: "invalid_transition", from: "IN_PROGRESS", to: "IN_PROGRESS" } });
    expect(await call("POST", "/issues/i001/move", OWNER, { to: "DONE" })).toMatchObject({ status: 422, body: { from: "IN_PROGRESS", to: "DONE" } });
    // registered after the stack's own handler, so it hears a request close only once the stack has
    const closed = new Signal<string>();
    rest.server.on("request", (req) => req.on("close", () => closed.push(req.url ?? "")));
    const sse = openSse(`${rest.base}/events`, { headers: OWNER });
    try {
      await sse.ready;
      expect(rest.bus!.listenerCount("event")).toBe(1);
      expect((await call("POST", "/issues/i001/move", OWNER, { to: "IN_REVIEW" })).body!["state"]).toBe("IN_REVIEW");
      await sse.events.atLeast(1, "the move event");
    } finally {
      await sse.close();
    }
    expect(sse.events.items).toEqual([{ event: "IssueMoved", issueId: "i001", from: "IN_PROGRESS", to: "IN_REVIEW" }]);
    await closed.until((xs) => xs.includes("/events"), "the stream's request closing", 2_000);
    expect(rest.bus!.listenerCount("event")).toBe(0);
  });

  it("only an admin closes a sprint, only an active one, and the unfinished issues land in the next", async () => {
    expect((await call("POST", "/sprints/s02/close", MEMBER, { carryTo: "s03" })).status).toBe(403);
    expect(await call("POST", "/sprints/s01/close", OWNER, { carryTo: "s03" })).toMatchObject({ status: 409, body: { title: "sprint_not_active", state: "CLOSED" } });
    const inS03 = async () => ((await call("GET", "/issues?sprintId=s03&limit=200", OWNER)).body!["items"] as Obj[]).map((i) => i["id"] as string);
    const before = await inS03();
    const inS02 = [...rest.store.issues.values()].filter((i) => i.sprintId === "s02");
    const unfinished = inS02.filter((i) => i.state !== "DONE" && i.state !== "CANCELLED").map((i) => i.id);
    // guard on the seed: s02 holds both finished and cancelled work, so dropping either test moves too much
    expect(new Set(inS02.map((i) => i.state)).has("DONE") && new Set(inS02.map((i) => i.state)).has("CANCELLED")).toBe(true);
    const closed = await call("POST", "/sprints/s02/close", OWNER, { carryTo: "s03" });
    expect(closed).toMatchObject({ status: 200, body: { sprint: { id: "s02", name: rest.store.sprints.get("s02")!.name, state: "CLOSED" }, moved: unfinished.length, carriedOver: unfinished.length } });
    expect((await inS03()).sort()).toEqual([...before, ...unfinished].sort());
  });
});

describe("the workspace GraphQL stack", () => {
  let gql: WorkspaceStack;
  beforeEach(async () => {
    gql = await startWorkspaceGraphQL(freshWorkspace());
  });
  afterEach(() => gql.close());
  const post = async (query: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${gql.base}/graphql`, { method: "POST", headers: { ...JSON_CT, ...headers }, body: JSON.stringify({ query }) });
    return { cacheControl: res.headers.get("cache-control"), body: (await res.json()) as Obj };
  };
  const codes = (r: { body: Obj }) => (r.body["errors"] as Obj[] | undefined)?.map((e) => e["extensions"]?.code as string) ?? [];

  it("seats only for owners and admins; a POST answer is never stored", async () => {
    const member = await post(`{ org(slug: "acme") { seats } }`, MEMBER);
    expect([member.cacheControl, member.body["data"]]).toEqual(["no-store", { org: { seats: null } }]);
    expect((await post(`{ org(slug: "acme") { seats } }`, OWNER)).body["data"]).toEqual({ org: { seats: 50 } });
  });

  it("another tenant's board is refused; a closed sprint stays closed; billing down fails spend alone", async () => {
    expect(codes(await post(`{ board(projectId: "p1") { project { key } } }`, OTHER_TENANT))).toEqual(["FORBIDDEN"]);
    expect((await post(`{ board(projectId: "p1") { project { key } } }`, OWNER)).body["data"]["board"].project.key).toBe(gql.store.projects.get("p1")!.key);
    expect(codes(await post(`mutation { closeSprint(id: "s01", carryTo: null) { moved } }`, OWNER))).toEqual(["SPRINT_NOT_ACTIVE"]);
    expect(gql.store.sprints.get("s01")!.state).toBe("CLOSED");
    gql.store.down.billing = true;
    const p = await post(`{ project(id: "p1") { key spend } }`, OWNER);
    expect([codes(p), p.body["data"]]).toEqual([["UNAVAILABLE"], { project: { key: gql.store.projects.get("p1")!.key, spend: null } }]);
  });

  it("a project feed hears its own project only", async () => {
    const other = [...gql.store.issues.values()].find((i) => i.orgId === "o1" && i.projectId !== "p1" && i.state === "TODO")!;
    const sse = openSse(`${gql.base}/graphql`, { method: "POST", headers: { ...OWNER, ...JSON_CT }, body: JSON.stringify({ query: `subscription { projectFeed(projectId: "p1") { issueId from to } }` }) });
    try {
      await sse.ready;
      expect(codes(await post(`mutation { moveIssue(id: "${other.id}", to: IN_PROGRESS) { state } }`, OWNER))).toEqual([]);
      expect(codes(await post(`mutation { moveIssue(id: "i001", to: IN_REVIEW) { state } }`, OWNER))).toEqual([]);
      await sse.events.atLeast(1, "the p1 move");
    } finally {
      await sse.close();
    }
    expect(sse.events.items).toEqual([{ data: { projectFeed: { issueId: "i001", from: "IN_PROGRESS", to: "IN_REVIEW" } } }]);
  });
});

describe("the workspace Rayfold stack", () => {
  let rayfold: WorkspaceStack;
  beforeEach(async () => {
    rayfold = await startWorkspaceRayfold(freshWorkspace());
  });
  afterEach(() => rayfold.close());

  it("counts every request at the origin, and a WebSocket carries the viewer its URL names", async () => {
    const before = rayfold.counters.originRequests;
    await fetch(`${rayfold.base}/rayfold/manifest`);
    await fetch(`${rayfold.base}/nothing-here`);
    expect(rayfold.counters.originRequests).toBe(before + 2);

    const ws = (auth?: string) => createWebSocketTransport({ url: `${rayfold.base.replace("http", "ws")}/rayfold/ws${auth ? `?auth=${auth}` : ""}` });
    const signedIn = ws("u01");
    const anonymous = ws();
    try {
      const read = (t: ReturnType<typeof ws>) => new RayfoldClient({ transport: t }).query("issue", { id: "i001" }, { shape: "{ id key }" }).catch((e: unknown) => ({ code: (e as { code: string }).code }));
      expect(await read(signedIn)).toEqual({ $type: "Issue", id: "i001", key: rayfold.store.issues.get("i001")!.key });
      expect(await read(anonymous)).toBeNull(); // the tenant rule hides it from a socket with no viewer
    } finally {
      signedIn.close();
      anonymous.close();
    }
  });
});
