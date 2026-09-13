/**
 * Deterministic in-memory workspace data: two organisations with their teams, projects, sprints, issues, comments,
 * activity and notifications. Reset with `seed()` between tests.
 *
 * Nothing here is random at run time. One seeded generator builds the same rows on every machine, and the list
 * orders every stack serves from are built once, here, so a comparison between REST, GraphQL and Rayfold is about
 * the protocols rather than about three different ways of scanning a table.
 */

export type Role = "OWNER" | "ADMIN" | "MEMBER" | "GUEST";
export type Plan = "FREE" | "TEAM" | "ENTERPRISE";
export type IssueState = "TRIAGE" | "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "CANCELLED";
export type Priority = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type ProjectStatus = "PLANNED" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED";
export type SprintState = "UPCOMING" | "ACTIVE" | "CLOSED";
export type NotificationKind = "ASSIGNED" | "MENTIONED" | "STATE_CHANGED" | "COMMENTED";
export type ActivityType = "IssueOpened" | "IssueMovedActivity" | "IssueCommented" | "SprintClosedActivity";

/** The columns of a board, in the order a board shows them. `CANCELLED` is reachable but is not a column. */
export const BOARD_STATES: readonly IssueState[] = ["TRIAGE", "BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"];
export const ISSUE_STATES: readonly IssueState[] = [...BOARD_STATES, "CANCELLED"];
/** Which states an issue may move to from each state (the workflow `moveIssue` enforces). */
export const TRANSITIONS: Record<IssueState, readonly IssueState[]> = {
  TRIAGE: ["BACKLOG", "TODO", "CANCELLED"],
  BACKLOG: ["TODO", "TRIAGE", "CANCELLED"],
  TODO: ["IN_PROGRESS", "BACKLOG", "CANCELLED"],
  IN_PROGRESS: ["IN_REVIEW", "TODO", "CANCELLED"],
  IN_REVIEW: ["DONE", "IN_PROGRESS", "CANCELLED"],
  DONE: ["IN_PROGRESS"],
  CANCELLED: ["TRIAGE"],
};

export interface OrgRow { id: string; slug: string; name: string; plan: Plan; seats: number }
export interface UserRow { id: string; name: string; email: string; avatarUrl: string | null }
export interface MemberRow { id: string; orgId: string; userId: string; role: Role; joinedAt: string; teamId: string }
export interface TeamRow { id: string; orgId: string; key: string; name: string }
export interface ProjectRow {
  id: string;
  orgId: string;
  key: string;
  name: string;
  status: ProjectStatus;
  startDate: string | null;
  targetDate: string | null;
  teamId: string;
  leadId: string | null;
  /** built on demand by the resolvers: the schema marks it `@lazy` */
  summary: string | null;
}
export interface LabelRow { id: string; orgId: string; name: string; color: string }
export interface SprintRow { id: string; orgId: string; name: string; state: SprintState; startsAt: string; endsAt: string; projectId: string }
export interface AttachmentRow { filename: string; contentType: string; size: number; url: string }
export interface IssueRow {
  id: string;
  orgId: string;
  key: string;
  title: string;
  description: string | null;
  state: IssueState;
  priority: Priority;
  estimate: number | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  projectId: string;
  sprintId: string | null;
  reporterId: string;
  assigneeId: string | null;
  labelIds: string[];
  parentId: string | null;
  attachments: AttachmentRow[];
  externalState: string | null;
}
export interface CommentRow { id: string; orgId: string; issueId: string; authorId: string; body: string; createdAt: string; version: number }
export interface NotificationRow { id: string; recipientId: string; kind: NotificationKind; issueId: string; at: string; readAt: string | null }
export interface ActivityRow {
  id: string;
  $type: ActivityType;
  orgId: string;
  projectId: string;
  at: string;
  actorId: string;
  issueId: string | null;
  commentId: string | null;
  sprintId: string | null;
  from: IssueState | null;
  to: IssueState | null;
  completed: number | null;
  carriedOver: number | null;
}

/**
 * List orders, built once by `seed()` and kept correct by the commands. Every stack reads its pages from these,
 * so no stack pays for a scan another one avoids.
 */
export interface Index {
  /** project id -> issue ids, newest first */
  issuesByProject: Map<string, string[]>;
  /** `${projectId}|${state}` -> issue ids, newest first (the board's columns) */
  issuesByColumn: Map<string, string[]>;
  issuesBySprint: Map<string, string[]>;
  issuesByAssignee: Map<string, string[]>;
  issuesByParent: Map<string, string[]>;
  commentsByIssue: Map<string, string[]>;
  /** project id -> activity ids, newest first */
  activityByProject: Map<string, string[]>;
  projectsByTeam: Map<string, string[]>;
  membersByTeam: Map<string, string[]>;
  teamsByOrg: Map<string, string[]>;
  sprintsByProject: Map<string, string[]>;
  labelsByOrg: Map<string, string[]>;
  notificationsByRecipient: Map<string, string[]>;
}

export interface Store {
  orgs: Map<string, OrgRow>;
  users: Map<string, UserRow>;
  members: Map<string, MemberRow>;
  teams: Map<string, TeamRow>;
  projects: Map<string, ProjectRow>;
  labels: Map<string, LabelRow>;
  sprints: Map<string, SprintRow>;
  issues: Map<string, IssueRow>;
  comments: Map<string, CommentRow>;
  notifications: Map<string, NotificationRow>;
  activity: Map<string, ActivityRow>;
  index: Index;
  nextId: number;
  /** Count of loader invocations, for N+1 assertions. */
  calls: Record<string, number>;
  /**
   * Downstream systems the workspace reads from but does not own. When one is down, the fields it feeds fail on
   * their own (`@partial`) instead of failing the page.
   */
  down: { billing: boolean; tracker: boolean; directory: boolean };
}

export function count(store: Store, loader: string): void {
  store.calls[loader] = (store.calls[loader] ?? 0) + 1;
}

/** Deterministic pseudo-randomness: the same sequence on every machine and every run. */
function rng(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_MS = Date.parse("2026-01-05T09:00:00.000Z");
export const iso = (ms: number): string => new Date(ms).toISOString();
const pad = (n: number, width: number): string => String(n).padStart(width, "0");
const pick = <T,>(xs: readonly T[], r: number): T => xs[Math.min(xs.length - 1, Math.floor(r * xs.length))]!;
const push = (m: Map<string, string[]>, k: string, v: string): void => void (m.get(k) ?? m.set(k, []).get(k)!).push(v);

const FIRST = ["Ada", "Grace", "Alan", "Katherine", "Barbara", "Edsger", "Radia", "Tim", "Margaret", "Vint", "Anita", "Leslie", "Hedy", "Shafi", "Jean", "Frances", "Donald", "Karen"];
const LAST = ["Lovelace", "Hopper", "Turing", "Johnson", "Liskov", "Dijkstra", "Perlman", "Berners-Lee", "Hamilton", "Cerf", "Borg", "Lamport", "Lamarr", "Goldwasser", "Bartik", "Allen", "Knuth", "Sparck Jones"];
const TEAMS: Array<[string, string, string]> = [["t1", "ENG", "Platform"], ["t2", "APP", "Product"], ["t3", "OPS", "Operations"]];
const PROJECTS: Array<[string, string, string, string, ProjectStatus]> = [
  ["p1", "t1", "ING", "Ingest pipeline", "ACTIVE"],
  ["p2", "t1", "RT", "Realtime sync", "ACTIVE"],
  ["p3", "t2", "MOB", "Mobile app", "ACTIVE"],
  ["p4", "t2", "WEB", "Web console", "PAUSED"],
  ["p5", "t3", "MIG", "Storage migration", "ACTIVE"],
  ["p6", "t3", "SEC", "Security review", "PLANNED"],
];
const LABELS = ["bug", "feature", "chore", "docs", "performance", "security", "ux", "infra", "flaky", "regression"];
const COLORS = ["#d73a4a", "#0e8a16", "#cfd3d7", "#0075ca", "#a2eeef", "#b60205", "#d4c5f9", "#5319e7", "#fbca04", "#e99695"];
const VERBS = ["Fix", "Add", "Remove", "Investigate", "Refactor", "Document", "Measure", "Harden", "Retry", "Cache"];
const NOUNS = ["the batch planner", "cursor pagination", "the retry budget", "schema reload", "the WebSocket transport", "cold starts", "the idempotency store", "policy pushdown", "keep-alives", "the shape registry"];
const WHY = ["under load", "on reconnect", "for large pages", "in the Kotlin runtime", "behind a proxy", "after a redeploy", "on slow networks", "for offline clients"];

/** Attachments are rare and small; they exist so a list of objects inside an entity is part of the comparison. */
function attachmentsFor(n: number, r: () => number): AttachmentRow[] {
  if (n % 10 !== 0) return [];
  const size = 40_000 + Math.floor(r() * 400_000);
  return [{ filename: `trace-${pad(n, 3)}.json`, contentType: "application/json", size, url: `https://files.example.com/trace-${pad(n, 3)}.json` }];
}

export function seed(): Store {
  const r = rng(20260105);
  const store: Store = {
    orgs: new Map(),
    users: new Map(),
    members: new Map(),
    teams: new Map(),
    projects: new Map(),
    labels: new Map(),
    sprints: new Map(),
    issues: new Map(),
    comments: new Map(),
    notifications: new Map(),
    activity: new Map(),
    index: {
      issuesByProject: new Map(),
      issuesByColumn: new Map(),
      issuesBySprint: new Map(),
      issuesByAssignee: new Map(),
      issuesByParent: new Map(),
      commentsByIssue: new Map(),
      activityByProject: new Map(),
      projectsByTeam: new Map(),
      membersByTeam: new Map(),
      teamsByOrg: new Map(),
      sprintsByProject: new Map(),
      labelsByOrg: new Map(),
      notificationsByRecipient: new Map(),
    },
    nextId: 1,
    calls: {},
    down: { billing: false, tracker: false, directory: false },
  };
  const ix = store.index;

  store.orgs.set("o1", { id: "o1", slug: "acme", name: "Acme Corp", plan: "TEAM", seats: 50 });
  store.orgs.set("o2", { id: "o2", slug: "globex", name: "Globex", plan: "ENTERPRISE", seats: 200 });

  // 12 people in the first organisation, 6 in the second; the tenant boundary between them is what the policy tests use.
  for (let i = 0; i < 18; i++) {
    const id = `u${pad(i + 1, 2)}`;
    const name = `${FIRST[i]!} ${LAST[i]!}`;
    const orgId = i < 12 ? "o1" : "o2";
    store.users.set(id, { id, name, email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@${orgId === "o1" ? "acme" : "globex"}.example`, avatarUrl: i % 3 === 0 ? null : `https://avatars.example.com/${id}.png` });
    const teamId = orgId === "o2" ? "t4" : i < 5 ? "t1" : i < 9 ? "t2" : "t3";
    const role: Role = i === 0 ? "OWNER" : i === 1 || i === 12 ? "ADMIN" : i === 11 ? "GUEST" : "MEMBER";
    const mid = `m${pad(i + 1, 2)}`;
    store.members.set(mid, { id: mid, orgId, userId: id, role, joinedAt: iso(BASE_MS - (500 - i * 7) * 86_400_000), teamId });
    push(ix.membersByTeam, teamId, mid);
  }

  for (const [id, key, name] of TEAMS) {
    store.teams.set(id, { id, orgId: "o1", key, name });
    push(ix.teamsByOrg, "o1", id);
  }
  store.teams.set("t4", { id: "t4", orgId: "o2", key: "GX", name: "Globex Core" });
  push(ix.teamsByOrg, "o2", "t4");

  for (let i = 0; i < LABELS.length; i++) {
    const id = `l${pad(i + 1, 2)}`;
    store.labels.set(id, { id, orgId: "o1", name: LABELS[i]!, color: COLORS[i]! });
    push(ix.labelsByOrg, "o1", id);
  }
  for (const [i, name] of ["bug", "feature"].entries()) {
    const id = `l${pad(11 + i, 2)}`;
    store.labels.set(id, { id, orgId: "o2", name, color: COLORS[i]! });
    push(ix.labelsByOrg, "o2", id);
  }

  for (const [id, teamId, key, name, status] of PROJECTS) {
    const leadId = `m${pad(1 + PROJECTS.findIndex((p) => p[0] === id), 2)}`;
    store.projects.set(id, {
      id,
      orgId: "o1",
      key,
      name,
      status,
      startDate: "2026-01-05",
      targetDate: status === "PLANNED" ? null : `2026-0${3 + (PROJECTS.findIndex((p) => p[0] === id) % 4)}-15`,
      teamId,
      leadId,
      summary: null,
    });
    push(ix.projectsByTeam, teamId, id);
  }
  store.projects.set("p7", { id: "p7", orgId: "o2", key: "GXC", name: "Globex core", status: "ACTIVE", startDate: "2026-01-05", targetDate: "2026-06-30", teamId: "t4", leadId: "m13", summary: null });
  push(ix.projectsByTeam, "t4", "p7");

  // Three sprints per project in the first organisation: one closed, one running, one ahead.
  let sprintN = 0;
  for (const [id] of PROJECTS) {
    for (const [i, state] of (["CLOSED", "ACTIVE", "UPCOMING"] as SprintState[]).entries()) {
      const sid = `s${pad(++sprintN, 2)}`;
      const startsAt = BASE_MS + (i - 1) * 14 * 86_400_000;
      store.sprints.set(sid, { id: sid, orgId: "o1", name: `${store.projects.get(id)!.key} Sprint ${i + 1}`, state, startsAt: iso(startsAt), endsAt: iso(startsAt + 14 * 86_400_000), projectId: id });
      push(ix.sprintsByProject, id, sid);
    }
  }

  const memberIds = [...store.members.values()].filter((m) => m.orgId === "o1").map((m) => m.id);
  const labelIds = ix.labelsByOrg.get("o1")!;
  let commentN = 0;
  let activityN = 0;
  const addActivity = (row: Omit<ActivityRow, "id">): void => {
    const id = `a${pad(++activityN, 4)}`;
    store.activity.set(id, { id, ...row });
  };

  // 100 issues per project: enough that a page is a real slice of a list, and that a board is worth loading.
  let issueN = 0;
  for (const [pid] of PROJECTS) {
    const project = store.projects.get(pid)!;
    const sprints = ix.sprintsByProject.get(pid)!;
    for (let n = 1; n <= 100; n++) {
      const id = `i${pad(++issueN, 3)}`;
      const state = pick(ISSUE_STATES, r());
      const createdAt = BASE_MS - (700 - issueN) * 3_600_000;
      const updatedAt = createdAt + Math.floor(r() * 40) * 3_600_000;
      const reporterId = pick(memberIds, r());
      const assigneeId = r() < 0.8 ? pick(memberIds, r()) : null;
      const mine = labelIds.filter(() => r() < 0.22).slice(0, 3);
      // Sub-issues hang off an earlier issue of the same project, and never off another sub-issue.
      const parentId = n > 12 && r() < 0.15 ? `i${pad(issueN - 1 - Math.floor(r() * 10), 3)}` : null;
      const parent = parentId ? store.issues.get(parentId) : undefined;
      const sprintId = state === "TRIAGE" || state === "BACKLOG" ? null : sprints[Math.floor(r() * sprints.length)]!;
      const row: IssueRow = {
        id,
        orgId: "o1",
        key: `${project.key}-${n}`,
        title: `${pick(VERBS, r())} ${pick(NOUNS, r())} ${pick(WHY, r())}`,
        description: `${pick(VERBS, r())} ${pick(NOUNS, r())}.\n\nSeen ${pick(WHY, r())}: the first request is served, the next one is not, and the client retries until the budget runs out. The fix is to keep the connection warm and to charge the retry to the caller's budget, not to the queue.\n\nAcceptance: a soak run of one hour with no error frames, and the p99 under 40 ms.`,
        state,
        priority: pick(["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as Priority[], r()),
        estimate: r() < 0.7 ? pick([1, 2, 3, 5, 8, 13], r()) : null,
        createdAt: iso(createdAt),
        updatedAt: iso(updatedAt),
        version: 1,
        projectId: pid,
        sprintId,
        reporterId,
        assigneeId,
        labelIds: mine,
        parentId: parent && !parent.parentId ? parentId : null,
        attachments: attachmentsFor(issueN, r),
        externalState: issueN % 7 === 0 ? "SYNCED" : null,
      };
      store.issues.set(id, row);
      addIssueToIndex(store, row);

      addActivity({ $type: "IssueOpened", orgId: "o1", projectId: pid, at: row.createdAt, actorId: reporterId, issueId: id, commentId: null, sprintId: null, from: null, to: null, completed: null, carriedOver: null });
      if (state === "IN_PROGRESS" || state === "IN_REVIEW" || state === "DONE") {
        addActivity({ $type: "IssueMovedActivity", orgId: "o1", projectId: pid, at: iso(updatedAt), actorId: assigneeId ?? reporterId, issueId: id, commentId: null, sprintId: null, from: "TODO", to: state, completed: null, carriedOver: null });
      }
      // Every other issue carries a short discussion, so a comment page is never empty on the issues tests use.
      if (issueN % 2 === 0) {
        for (let c = 0; c < 3; c++) {
          const cid = `c${pad(++commentN, 4)}`;
          const authorId = pick(memberIds, r());
          const at = iso(updatedAt + c * 900_000);
          store.comments.set(cid, { id: cid, orgId: "o1", issueId: id, authorId, body: `${["Reproduced on the staging cluster.", "This is the same root cause as the retry storm last month.", "Shipped behind a flag; watching the error rate.", "Needs a test that fails without the fix.", "Moving to review."][c % 5]!}`, createdAt: at, version: 1 });
          push(ix.commentsByIssue, id, cid);
          if (c === 0) addActivity({ $type: "IssueCommented", orgId: "o1", projectId: pid, at, actorId: authorId, issueId: id, commentId: cid, sprintId: null, from: null, to: null, completed: null, carriedOver: null });
        }
      }
    }
    // The closed sprint of each project left a mark on the feed.
    const closed = sprints[0]!;
    addActivity({ $type: "SprintClosedActivity", orgId: "o1", projectId: pid, at: store.sprints.get(closed)!.endsAt, actorId: "m01", issueId: null, commentId: null, sprintId: closed, from: null, to: null, completed: 14, carriedOver: 3 });
  }

  // The second organisation: smaller, and only ever read by its own members. Tenant isolation is asserted against it.
  for (let n = 1; n <= 30; n++) {
    const id = `i${pad(++issueN, 3)}`;
    const row: IssueRow = {
      id,
      orgId: "o2",
      key: `GXC-${n}`,
      title: `${pick(VERBS, r())} ${pick(NOUNS, r())}`,
      description: "Internal to Globex.",
      state: pick(ISSUE_STATES, r()),
      priority: pick(["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as Priority[], r()),
      estimate: null,
      createdAt: iso(BASE_MS - (60 - n) * 3_600_000),
      updatedAt: iso(BASE_MS - (60 - n) * 1_800_000),
      version: 1,
      projectId: "p7",
      sprintId: null,
      reporterId: "m13",
      assigneeId: n % 2 === 0 ? "m14" : null,
      labelIds: [],
      parentId: null,
      attachments: [],
      externalState: null,
    };
    store.issues.set(id, row);
    addIssueToIndex(store, row);
  }

  // Issue lists read newest first; they were built oldest first.
  for (const ids of ix.issuesByProject.values()) ids.reverse();
  for (const ids of ix.issuesByColumn.values()) ids.reverse();
  for (const ids of ix.issuesBySprint.values()) ids.reverse();
  for (const ids of ix.issuesByAssignee.values()) ids.reverse();
  // The feed is ordered by when things happened, not by when they were generated, so it is sorted on `at`.
  for (const a of store.activity.values()) push(ix.activityByProject, a.projectId, a.id);
  for (const ids of ix.activityByProject.values()) {
    ids.sort((x, y) => {
      const ax = store.activity.get(x)!;
      const ay = store.activity.get(y)!;
      return ax.at === ay.at ? (x < y ? 1 : -1) : ax.at < ay.at ? 1 : -1;
    });
  }

  // What the first person sees waiting for them when they open the app.
  let notifN = 0;
  for (const issue of [...store.issues.values()].filter((i) => i.assigneeId === "m01").slice(0, 25)) {
    const id = `n${pad(++notifN, 2)}`;
    store.notifications.set(id, { id, recipientId: "u01", kind: pick(["ASSIGNED", "MENTIONED", "STATE_CHANGED", "COMMENTED"] as NotificationKind[], r()), issueId: issue.id, at: issue.updatedAt, readAt: notifN % 4 === 0 ? issue.updatedAt : null });
    push(ix.notificationsByRecipient, "u01", id);
  }

  store.nextId = 1000;
  return store;
}

/** Add a new issue to every list it belongs to, newest first. Used by `seed()` and by `createIssue`. */
export function addIssueToIndex(store: Store, row: IssueRow, atFront = false): void {
  const ix = store.index;
  const lists: Array<[Map<string, string[]>, string]> = [
    [ix.issuesByProject, row.projectId],
    [ix.issuesByColumn, `${row.projectId}|${row.state}`],
  ];
  if (row.sprintId) lists.push([ix.issuesBySprint, row.sprintId]);
  if (row.assigneeId) lists.push([ix.issuesByAssignee, row.assigneeId]);
  if (row.parentId) lists.push([ix.issuesByParent, row.parentId]);
  for (const [map, key] of lists) {
    const list = map.get(key) ?? map.set(key, []).get(key)!;
    if (atFront) list.unshift(row.id);
    else list.push(row.id);
  }
}

/** Move an issue between two board columns, keeping both orders. */
export function moveIssueInIndex(store: Store, row: IssueRow, from: IssueState, to: IssueState): void {
  const ix = store.index;
  const out = ix.issuesByColumn.get(`${row.projectId}|${from}`);
  if (out) {
    const at = out.indexOf(row.id);
    if (at >= 0) out.splice(at, 1);
  }
  const into = ix.issuesByColumn.get(`${row.projectId}|${to}`) ?? ix.issuesByColumn.set(`${row.projectId}|${to}`, []).get(`${row.projectId}|${to}`)!;
  into.unshift(row.id);
}

/** Totals, for tests that assert the comparison ran against the whole data set rather than a corner of it. */
export function sizes(store: Store): Record<string, number> {
  return {
    orgs: store.orgs.size,
    users: store.users.size,
    teams: store.teams.size,
    projects: store.projects.size,
    sprints: store.sprints.size,
    issues: store.issues.size,
    comments: store.comments.size,
    activity: store.activity.size,
    notifications: store.notifications.size,
  };
}
