/**
 * The workspace served as REST, written the way a careful team writes it: resources with ETags and conditional
 * requests, batch endpoints instead of a request per id, purpose-built endpoints for the screens that need them
 * (the board, the feed), an `Idempotency-Key` convention on writes, `If-Match` on updates, and Server-Sent Events
 * for what happens next.
 *
 * Two things are deliberately hand-written, because in REST they always are: every tenant and field check, and
 * every shape. They are what the comparison measures.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  BOARD_STATES,
  TRANSITIONS,
  activityIds,
  addIssueToIndex,
  boardColumns,
  childPages,
  commentPages,
  count,
  iso,
  issueIds,
  issuePage,
  moveIssueInIndex,
  pageOfIds,
  searchHits,
  seed,
  type ActivityRow,
  type CommentRow,
  type IssueRow,
  type IssueState,
  type MemberRow,
  type ProjectRow,
  type Store,
  type Viewer,
} from "../examples/workspace-ts/src/index.ts";

export interface Counters {
  originRequests: number;
  loaderCalls: Record<string, number>;
}

export type StackName = "REST" | "GraphQL" | "Rayfold";

export interface WorkspaceStack {
  name: StackName;
  base: string;
  server: Server;
  counters: Counters;
  store: Store;
  /** domain events, for the streaming comparisons; the Rayfold stack publishes through its own server bus */
  bus?: EventEmitter;
  close(): Promise<void>;
}

export const freshWorkspace = (): Store => seed();

export function listen(handler: (req: IncomingMessage, res: ServerResponse) => unknown): Promise<Server> {
  const s = createServer((req, res) => void handler(req, res));
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

export const closeServer = (s: Server): Promise<void> =>
  new Promise((r) => {
    s.close(() => r());
    s.closeAllConnections();
  });

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

export const etagOf = (body: string): string => `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;

/** `Bearer u01` is that user, with the membership they hold; anything else is anonymous. */
export function viewerOf(store: Store, auth: string | undefined): Viewer | null {
  if (!auth?.startsWith("Bearer ")) return null;
  const userId = auth.slice(7);
  const member = [...store.members.values()].find((m) => m.userId === userId);
  if (!member) return null;
  return { id: userId, orgId: member.orgId, role: member.role, memberId: member.id };
}

const num = (v: string | null, fallback: number): number => (v === null || Number.isNaN(Number(v)) ? fallback : Number(v));

// ---------------------------------------------------------------- hand-written representations
//
// Every one of these is a decision a REST team makes once and then repeats: which fields belong to the resource,
// which are private, and how much of a related resource to embed. Rayfold takes all three from the schema and the
// request shape instead.

const memberOut = (store: Store, m: MemberRow | null | undefined, viewer: Viewer | null): Record<string, unknown> | null => {
  if (!m) return null;
  const user = store.users.get(m.userId);
  const out: Record<string, unknown> = { id: m.id, role: m.role, user: user ? { id: user.id, name: user.name, avatarUrl: user.avatarUrl } : null };
  // The address is private: the owner of it, and admins, may read it. Forgetting this line is how REST leaks data.
  if (user && (viewer?.id === user.id || viewer?.role === "OWNER" || viewer?.role === "ADMIN")) (out["user"] as Record<string, unknown>)["email"] = user.email;
  return out;
};

const labelsOut = (store: Store, ids: readonly string[]): Array<Record<string, unknown>> =>
  ids.map((id) => store.labels.get(id)).filter((l): l is NonNullable<typeof l> => !!l).map((l) => ({ id: l.id, name: l.name, color: l.color }));

/** The full issue resource: everything the row holds, because a resource has one representation. */
const issueOut = (store: Store, i: IssueRow, viewer: Viewer | null): Record<string, unknown> => ({
  id: i.id,
  key: i.key,
  title: i.title,
  description: i.description,
  state: i.state,
  priority: i.priority,
  estimate: i.estimate,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
  version: i.version,
  projectId: i.projectId,
  sprintId: i.sprintId,
  reporterId: i.reporterId,
  assigneeId: i.assigneeId,
  labelIds: i.labelIds,
  parentId: i.parentId,
  attachments: i.attachments,
  externalState: i.externalState,
  assignee: memberOut(store, i.assigneeId ? store.members.get(i.assigneeId) : null, viewer),
  labels: labelsOut(store, i.labelIds),
});

const projectOut = (p: ProjectRow): Record<string, unknown> => ({
  id: p.id,
  key: p.key,
  name: p.name,
  status: p.status,
  startDate: p.startDate,
  targetDate: p.targetDate,
  teamId: p.teamId,
  leadId: p.leadId,
});

const commentOut = (store: Store, c: CommentRow, viewer: Viewer | null): Record<string, unknown> => ({
  id: c.id,
  body: c.body,
  createdAt: c.createdAt,
  version: c.version,
  issueId: c.issueId,
  authorId: c.authorId,
  author: memberOut(store, store.members.get(c.authorId), viewer),
});

/**
 * The feed as REST can send it: one array with a `type` string. A client that wants to know what a row means
 * reads that string and trusts a convention; nothing checks that it did.
 */
const activityOut = (store: Store, a: ActivityRow, viewer: Viewer | null): Record<string, unknown> => {
  const base: Record<string, unknown> = { id: a.id, type: a.$type, at: a.at, actor: memberOut(store, store.members.get(a.actorId), viewer) };
  const issue = a.issueId ? store.issues.get(a.issueId) : null;
  if (a.$type === "IssueOpened") base["issue"] = issue ? { id: issue.id, key: issue.key, title: issue.title } : null;
  if (a.$type === "IssueMovedActivity") {
    base["issue"] = issue ? { id: issue.id, key: issue.key, title: issue.title } : null;
    base["from"] = a.from;
    base["to"] = a.to;
  }
  if (a.$type === "IssueCommented") {
    const c = a.commentId ? store.comments.get(a.commentId) : null;
    base["comment"] = c ? { id: c.id, body: c.body, createdAt: c.createdAt } : null;
  }
  if (a.$type === "SprintClosedActivity") {
    const s = a.sprintId ? store.sprints.get(a.sprintId) : null;
    base["sprint"] = s ? { id: s.id, name: s.name, state: s.state } : null;
    base["completed"] = a.completed;
    base["carriedOver"] = a.carriedOver;
  }
  return base;
};

export async function startWorkspaceRest(store: Store): Promise<WorkspaceStack> {
  const counters: Counters = { originRequests: 0, loaderCalls: store.calls };
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const idempotency = new Map<string, { status: number; body: string }>();

  const server = await listen(async (req, res) => {
    counters.originRequests++;
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const q = url.searchParams;
    const viewer = viewerOf(store, req.headers.authorization);
    const method = req.method ?? "GET";

    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      const text = body === undefined ? "" : JSON.stringify(body);
      const etag = status === 200 && method === "GET" ? etagOf(text) : undefined;
      if (etag && req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag, "cache-control": "private, max-age=30" }).end();
        return;
      }
      res.writeHead(status, { "content-type": "application/json", ...(etag ? { etag, "cache-control": "private, max-age=30" } : {}), ...headers }).end(text);
    };
    const problem = (status: number, title: string, extra: Record<string, unknown> = {}): void => {
      res.writeHead(status, { "content-type": "application/problem+json" }).end(JSON.stringify({ type: `https://example.com/errors/${title}`, title, status, ...extra }));
    };
    /** The tenant check, repeated at every entry point. Rayfold declares it once, on the entity. */
    const readable = (orgId: string): boolean => !!viewer && viewer.orgId === orgId;

    // ---- reads

    if (method === "GET" && path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": open\n\n");
      const on = (payload: unknown): void => void res.write(`data: ${JSON.stringify(payload)}\n\n`);
      bus.on("event", on);
      req.on("close", () => bus.off("event", on));
      return;
    }

    let m = /^\/orgs\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const org = [...store.orgs.values()].find((o) => o.slug === m![1]);
      if (!org) return problem(404, "not_found");
      const out: Record<string, unknown> = { id: org.id, slug: org.slug, name: org.name, plan: org.plan };
      if (viewer?.role === "OWNER" || viewer?.role === "ADMIN") out["seats"] = org.seats;
      return send(200, out);
    }

    m = /^\/projects\/([^/]+)\/board$/.exec(path);
    if (method === "GET" && m) {
      const project = store.projects.get(m[1]!);
      if (!project) return problem(404, "not_found");
      if (!readable(project.orgId)) return problem(viewer ? 403 : 401, viewer ? "forbidden" : "unauthenticated");
      const first = num(q.get("limit"), 10);
      count(store, "REST.board");
      const columns = boardColumns(store, project.id, BOARD_STATES).map((c) => ({
        state: c.state,
        count: c.count,
        issues: c.ids.slice(0, first).map((id) => issueOut(store, store.issues.get(id)!, viewer)),
      }));
      return send(200, { project: projectOut(project), columns });
    }

    m = /^\/projects\/([^/]+)\/activity$/.exec(path);
    if (method === "GET" && m) {
      const project = store.projects.get(m[1]!);
      if (!project) return problem(404, "not_found");
      if (!readable(project.orgId)) return problem(viewer ? 403 : 401, viewer ? "forbidden" : "unauthenticated");
      count(store, "REST.activity");
      const page = pageOfIds(activityIds(store, project.id), (id) => store.activity.get(id), { first: num(q.get("limit"), 20), after: q.get("cursor") });
      return send(200, { items: page.items.map((a) => activityOut(store, a, viewer)), cursor: page.cursor, hasMore: page.hasMore, total: page.total });
    }

    m = /^\/projects\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const project = store.projects.get(m[1]!);
      if (!project) return problem(404, "not_found");
      if (!readable(project.orgId)) return problem(viewer ? 403 : 401, viewer ? "forbidden" : "unauthenticated");
      return send(200, projectOut(project));
    }

    m = /^\/issues\/([^/]+)\/comments$/.exec(path);
    if (method === "GET" && m) {
      const issue = store.issues.get(m[1]!);
      if (!issue) return problem(404, "not_found");
      if (!readable(issue.orgId)) return problem(viewer ? 403 : 401, viewer ? "forbidden" : "unauthenticated");
      const page = commentPages(store, [issue.id], { first: num(q.get("limit"), 10), after: q.get("cursor") })[0]!;
      return send(200, { items: (page.items as CommentRow[]).map((c) => commentOut(store, c, viewer)), cursor: page.cursor, hasMore: page.hasMore, total: page.total });
    }

    m = /^\/issues\/([^/]+)\/children$/.exec(path);
    if (method === "GET" && m) {
      const issue = store.issues.get(m[1]!);
      if (!issue) return problem(404, "not_found");
      if (!readable(issue.orgId)) return problem(viewer ? 403 : 401, viewer ? "forbidden" : "unauthenticated");
      const page = childPages(store, [issue.id], { first: num(q.get("limit"), 10), after: q.get("cursor") })[0]!;
      return send(200, { items: page.items.map((i) => issueOut(store, i, viewer)), cursor: page.cursor, hasMore: page.hasMore, total: page.total });
    }

    m = /^\/issues\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const issue = store.issues.get(m[1]!);
      if (!issue) return problem(404, "not_found");
      if (!readable(issue.orgId)) return problem(viewer ? 403 : 401, viewer ? "forbidden" : "unauthenticated");
      count(store, "REST.issue");
      const body = issueOut(store, issue, viewer);
      // The tracker is a system this service only reads from. Keeping the page alive when it is down means catching
      // the failure here, in this endpoint, and saying so in a field the client has to know to look at.
      if (store.down.tracker) {
        body["externalState"] = null;
        body["warnings"] = [{ field: "externalState", detail: "The customer tracker is not answering" }];
      }
      const text = JSON.stringify(body);
      const etag = `"${issue.version}"`;
      if (req.headers["if-none-match"] === etag) return void res.writeHead(304, { etag }).end();
      return void res.writeHead(200, { "content-type": "application/json", etag, "cache-control": "private, max-age=30" }).end(text);
    }

    if (method === "GET" && path === "/issues") {
      count(store, "REST.issues");
      const ids = issueIds(store, {
        projectId: q.get("projectId"),
        state: q.get("state") as IssueState | null,
        assigneeId: q.get("assigneeId"),
        sprintId: q.get("sprintId"),
        titleContains: q.get("q"),
      });
      const page = issuePage(store, ids, { first: num(q.get("limit"), 20), after: q.get("cursor") });
      const visible = page.items.filter((i) => readable(i.orgId));
      return send(200, { items: visible.map((i) => issueOut(store, i, viewer)), cursor: page.cursor, hasMore: page.hasMore, total: page.total });
    }

    if (method === "GET" && path === "/members") {
      const ids = (q.get("ids") ?? "").split(",").filter(Boolean);
      count(store, "REST.members");
      return send(200, { items: ids.map((id) => memberOut(store, store.members.get(id), viewer)).filter(Boolean) });
    }

    if (method === "GET" && path === "/search") {
      if (!viewer) return problem(401, "unauthenticated");
      count(store, "REST.search");
      const hits = searchHits(store, q.get("q") ?? "", viewer.orgId);
      const page = pageOfIds(hits.map((h) => `${h.$type}:${h.id}`), (k) => k, { first: num(q.get("limit"), 20) });
      const items = page.items.map((key) => {
        const [type, id] = key.split(":") as ["Issue" | "Project" | "Comment", string];
        if (type === "Issue") return { type, issue: issueOut(store, store.issues.get(id)!, viewer) };
        if (type === "Project") return { type, project: projectOut(store.projects.get(id)!) };
        return { type, comment: commentOut(store, store.comments.get(id)!, viewer) };
      });
      return send(200, { items, cursor: page.cursor, hasMore: page.hasMore, total: page.total });
    }

    if (method === "GET" && path === "/notifications") {
      if (!viewer) return problem(401, "unauthenticated");
      count(store, "REST.notifications");
      const page = pageOfIds(store.index.notificationsByRecipient.get(viewer.id) ?? [], (id) => store.notifications.get(id), { first: num(q.get("limit"), 20) });
      return send(200, { items: page.items, cursor: page.cursor, hasMore: page.hasMore, total: page.total }, { "cache-control": "private, no-store" });
    }

    // ---- writes

    if (method === "POST" && path === "/issues") {
      if (!viewer) return problem(401, "unauthenticated");
      const key = String(req.headers["idempotency-key"] ?? "");
      if (!key) return problem(400, "idempotency_key_required");
      const replayed = idempotency.get(key);
      if (replayed) return void res.writeHead(replayed.status, { "content-type": "application/json", "idempotent-replayed": "true" }).end(replayed.body);
      const input = JSON.parse((await readBody(req)) || "{}") as { projectId: string; title: string; priority?: string; assigneeId?: string | null; labelIds?: string[] };
      const project = store.projects.get(input.projectId);
      if (!project) return problem(404, "not_found", { detail: `Project ${input.projectId} not found` });
      if (!readable(project.orgId)) return problem(403, "forbidden");
      count(store, "REST.createIssue");
      const id = `i${store.nextId++}`;
      const n = (store.index.issuesByProject.get(project.id)?.length ?? 0) + 1;
      const row: IssueRow = {
        id,
        orgId: project.orgId,
        key: `${project.key}-${n}`,
        title: input.title,
        description: null,
        state: "TRIAGE",
        priority: (input.priority ?? "MEDIUM") as IssueRow["priority"],
        estimate: null,
        createdAt: iso(Date.parse("2026-02-01T12:00:00.000Z")),
        updatedAt: iso(Date.parse("2026-02-01T12:00:00.000Z")),
        version: 1,
        projectId: project.id,
        sprintId: null,
        reporterId: viewer.memberId,
        assigneeId: input.assigneeId ?? null,
        labelIds: input.labelIds ?? [],
        parentId: null,
        attachments: [],
        externalState: null,
      };
      store.issues.set(id, row);
      addIssueToIndex(store, row, true);
      const body = JSON.stringify(issueOut(store, row, viewer));
      idempotency.set(key, { status: 201, body });
      bus.emit("event", { event: "IssueCreated", issueId: id, projectId: project.id, key: row.key });
      return void res.writeHead(201, { "content-type": "application/json", location: `/issues/${id}` }).end(body);
    }

    m = /^\/issues\/([^/]+)\/move$/.exec(path);
    if (method === "POST" && m) {
      if (!viewer) return problem(401, "unauthenticated");
      const issue = store.issues.get(m[1]!);
      if (!issue) return problem(404, "not_found");
      if (!readable(issue.orgId)) return problem(403, "forbidden");
      const { to } = JSON.parse((await readBody(req)) || "{}") as { to: IssueState };
      if (issue.state === to || !TRANSITIONS[issue.state].includes(to)) {
        return problem(422, "invalid_transition", { detail: `An issue cannot go from ${issue.state} to ${to}`, from: issue.state, to });
      }
      count(store, "REST.moveIssue");
      const from = issue.state;
      const next: IssueRow = { ...issue, state: to, updatedAt: iso(Date.parse("2026-02-01T12:00:00.000Z")), version: issue.version + 1 };
      store.issues.set(issue.id, next);
      moveIssueInIndex(store, next, from, to);
      bus.emit("event", { event: "IssueMoved", issueId: issue.id, from, to });
      return send(200, issueOut(store, next, viewer));
    }

    m = /^\/issues\/([^/]+)$/.exec(path);
    if (method === "PATCH" && m) {
      if (!viewer) return problem(401, "unauthenticated");
      const issue = store.issues.get(m[1]!);
      if (!issue) return problem(404, "not_found");
      if (!readable(issue.orgId)) return problem(403, "forbidden");
      const ifMatch = req.headers["if-match"];
      if (ifMatch && ifMatch !== `"${issue.version}"`) {
        return problem(412, "precondition_failed", { detail: `Issue ${issue.id} is at version ${issue.version}`, current: issueOut(store, issue, viewer) });
      }
      count(store, "REST.updateIssue");
      const patch = JSON.parse((await readBody(req)) || "{}") as Partial<IssueRow>;
      const next: IssueRow = { ...issue, ...patch, updatedAt: iso(Date.parse("2026-02-01T12:00:00.000Z")), version: issue.version + 1 };
      store.issues.set(issue.id, next);
      return send(200, issueOut(store, next, viewer), { etag: `"${next.version}"` });
    }

    m = /^\/sprints\/([^/]+)\/close$/.exec(path);
    if (method === "POST" && m) {
      if (!viewer) return problem(401, "unauthenticated");
      if (viewer.role !== "OWNER" && viewer.role !== "ADMIN") return problem(403, "forbidden");
      const sprint = store.sprints.get(m[1]!);
      if (!sprint) return problem(404, "not_found");
      if (!readable(sprint.orgId)) return problem(403, "forbidden");
      if (sprint.state !== "ACTIVE") return problem(409, "sprint_not_active", { state: sprint.state });
      const { carryTo } = JSON.parse((await readBody(req)) || "{}") as { carryTo: string | null };
      count(store, "REST.closeSprint");
      const ids = [...(store.index.issuesBySprint.get(sprint.id) ?? [])];
      const unfinished = ids.map((id) => store.issues.get(id)!).filter((i) => i.state !== "DONE" && i.state !== "CANCELLED");
      for (const issue of unfinished) {
        const next: IssueRow = { ...issue, sprintId: carryTo ?? null, updatedAt: iso(Date.parse("2026-02-01T12:00:00.000Z")), version: issue.version + 1 };
        store.issues.set(issue.id, next);
        const from = store.index.issuesBySprint.get(sprint.id);
        const at = from?.indexOf(issue.id) ?? -1;
        if (from && at >= 0) from.splice(at, 1);
        if (carryTo) {
          const to = store.index.issuesBySprint;
          (to.get(carryTo) ?? to.set(carryTo, []).get(carryTo)!).unshift(issue.id);
        }
      }
      store.sprints.set(sprint.id, { ...sprint, state: "CLOSED" });
      bus.emit("event", { event: "SprintClosed", sprintId: sprint.id, moved: unfinished.length });
      // The body says what happened; which of the client's cached issues it invalidates is left to the client.
      return send(200, { sprint: { id: sprint.id, name: sprint.name, state: "CLOSED" }, moved: unfinished.length, carriedOver: carryTo ? unfinished.length : 0 });
    }

    problem(404, "not_found");
  });

  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { name: "REST", base, server, counters, store, bus, close: () => closeServer(server) };
}
