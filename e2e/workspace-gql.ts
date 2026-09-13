/**
 * The workspace served as GraphQL, written the way a careful team writes it: a typed schema with an interface for
 * the activity feed and a union for search, DataLoader-style batching on every relation and on every per-parent
 * page, `GET` for queries so a cache can hold them, `POST` for mutations, and Server-Sent Events for subscriptions.
 *
 * `batching: false` keeps the same schema and the obvious resolvers, which is what a team ships before it discovers
 * N+1. Both variants are measured, so the comparison is against GraphQL at its best and at its most common.
 *
 * Authorization is hand-written here, as it is in every GraphQL server: the schema cannot say who may read a field.
 */
import { buildSchema, graphql, parse, subscribe, type ExecutionResult, type GraphQLInterfaceType, type GraphQLUnionType } from "graphql";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import {
  BOARD_STATES,
  TRANSITIONS,
  activityIds,
  addIssueToIndex,
  assignedPages,
  boardColumns,
  childPages,
  commentPages,
  iso,
  issueIds,
  issuePage,
  moveIssueInIndex,
  orgTeamPages,
  pageOfIds,
  projectIssuePages,
  projectSprintPages,
  projectSummary,
  searchHits,
  sprintIssuePages,
  teamMemberPages,
  teamProjectPages,
  type ActivityRow,
  type CommentRow,
  type IssueRow,
  type IssueState,
  type LabelRow,
  type MemberRow,
  type NotificationRow,
  type Page,
  type PageArgs,
  type ProjectRow,
  type SprintRow,
  type Store,
  type TeamRow,
  type Viewer,
} from "../examples/workspace-ts/src/index.ts";
import { closeServer, etagOf, listen, readBody, viewerOf, type Counters, type WorkspaceStack } from "./workspace-rest.ts";

export const WORKSPACE_SDL = `
  interface Activity { id: ID! at: String! actor: Member! }

  enum Role { OWNER ADMIN MEMBER GUEST }
  enum Plan { FREE TEAM ENTERPRISE }
  enum IssueState { TRIAGE BACKLOG TODO IN_PROGRESS IN_REVIEW DONE CANCELLED }
  enum Priority { NONE LOW MEDIUM HIGH URGENT }
  enum ProjectStatus { PLANNED ACTIVE PAUSED COMPLETED ARCHIVED }
  enum SprintState { UPCOMING ACTIVE CLOSED }
  enum NotificationKind { ASSIGNED MENTIONED STATE_CHANGED COMMENTED }

  type Org { id: ID! slug: String! name: String! plan: Plan! seats: Int teams(first: Int = 10, after: String): TeamPage! }
  type User { id: ID! name: String! email: String avatarUrl: String }
  type Member { id: ID! role: Role! joinedAt: String! user: User! assigned(first: Int = 10, after: String): IssuePage! }
  type Team { id: ID! key: String! name: String! members(first: Int = 20, after: String): MemberPage! projects(first: Int = 10, after: String): ProjectPage! }
  type Project {
    id: ID! key: String! name: String! status: ProjectStatus! startDate: String targetDate: String
    team: Team! lead: Member summary: String spend: String labels: [Label!]!
    issues(first: Int = 20, after: String): IssuePage!
    sprints(first: Int = 10, after: String): SprintPage!
  }
  type Label { id: ID! name: String! color: String! }
  type Sprint { id: ID! name: String! state: SprintState! startsAt: String! endsAt: String! project: Project! issues(first: Int = 20, after: String): IssuePage! }
  type Attachment { filename: String! contentType: String! size: Int! url: String! }
  type Issue {
    id: ID! key: String! title: String! description: String state: IssueState! priority: Priority!
    estimate: Int createdAt: String! updatedAt: String! version: Int!
    project: Project! sprint: Sprint reporter: Member! assignee: Member labels: [Label!]!
    parent: Issue attachments: [Attachment!]! externalState: String
    children(first: Int = 10, after: String): IssuePage!
    comments(first: Int = 10, after: String): CommentPage!
  }
  type Comment { id: ID! body: String! createdAt: String! version: Int! issue: Issue! author: Member! }
  type Notification { id: ID! kind: NotificationKind! at: String! readAt: String issue: Issue! }

  type IssueOpened implements Activity { id: ID! at: String! actor: Member! issue: Issue! }
  type IssueMovedActivity implements Activity { id: ID! at: String! actor: Member! issue: Issue! from: IssueState! to: IssueState! }
  type IssueCommented implements Activity { id: ID! at: String! actor: Member! comment: Comment! }
  type SprintClosedActivity implements Activity { id: ID! at: String! actor: Member! sprint: Sprint! completed: Int! carriedOver: Int! }

  union SearchHit = Issue | Project | Comment

  type BoardColumn { state: IssueState! count: Int! issues(first: Int = 10, after: String): IssuePage! }
  type Board { project: Project! columns: [BoardColumn!]! }
  type BulkResult { sprint: Sprint! moved: Int! carriedOver: Int! }

  type IssuePage { items: [Issue!]! cursor: String hasMore: Boolean! total: Int! }
  type CommentPage { items: [Comment!]! cursor: String hasMore: Boolean! total: Int! }
  type MemberPage { items: [Member!]! cursor: String hasMore: Boolean! total: Int! }
  type ProjectPage { items: [Project!]! cursor: String hasMore: Boolean! total: Int! }
  type SprintPage { items: [Sprint!]! cursor: String hasMore: Boolean! total: Int! }
  type TeamPage { items: [Team!]! cursor: String hasMore: Boolean! total: Int! }
  type ActivityPage { items: [Activity!]! cursor: String hasMore: Boolean! total: Int! }
  type SearchHitPage { items: [SearchHit!]! cursor: String hasMore: Boolean! total: Int! }
  type NotificationPage { items: [Notification!]! cursor: String hasMore: Boolean! total: Int! }

  input IssueFilterInput { projectId: ID, state: IssueState, priority: Priority, assigneeId: ID, labelId: ID, sprintId: ID, titleContains: String }
  input IssueInput { projectId: ID!, title: String!, description: String, priority: Priority = MEDIUM, assigneeId: ID, labelIds: [ID!] = [], parentId: ID, estimate: Int }
  input IssuePatchInput { title: String, description: String, priority: Priority, estimate: Int, assigneeId: ID, sprintId: ID }
  input CommentInput { issueId: ID!, body: String! }

  type IssueMovedEvent { issueId: ID! from: IssueState! to: IssueState! }

  type Query {
    board(projectId: ID!): Board
    issue(id: ID!): Issue
    issues(filter: IssueFilterInput, first: Int = 20, after: String): IssuePage!
    project(id: ID!): Project
    team(id: ID!): Team
    org(slug: String!): Org
    member(id: ID!): Member
    sprint(id: ID!): Sprint
    search(q: String!, first: Int = 20): SearchHitPage!
    activity(projectId: ID!, first: Int = 20, after: String): ActivityPage!
    notifications(first: Int = 20): NotificationPage!
  }
  type Mutation {
    createIssue(input: IssueInput!): Issue!
    moveIssue(id: ID!, to: IssueState!): Issue!
    updateIssue(id: ID!, patch: IssuePatchInput!, ifVersion: Int): Issue!
    assignIssue(id: ID!, memberId: ID): Issue!
    addComment(input: CommentInput!): Comment!
    closeSprint(id: ID!, carryTo: ID): BulkResult!
  }
  type Subscription { projectFeed(projectId: ID!): IssueMovedEvent! }
`;

function gqlError(message: string, code: string, extra: Record<string, unknown> = {}): Error {
  const e = new Error(message) as Error & { extensions: unknown };
  e.extensions = { code, ...extra };
  return e;
}

interface Ctx {
  viewer: Viewer | null;
  /** one queue per loader name, drained on the next microtask: DataLoader in twenty lines */
  byId: Map<string, Map<string, Array<(v: unknown) => void>>> | null;
  pages: Map<string, { page: PageArgs; waiting: Map<string, Array<(v: unknown) => void>> }> | null;
}

export async function startWorkspaceGraphQL(store: Store, opts: { batching?: boolean } = {}): Promise<WorkspaceStack> {
  const batching = opts.batching ?? true;
  const counters: Counters = { originRequests: 0, loaderCalls: {} };
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const schema = buildSchema(WORKSPACE_SDL);
  // The concrete type of a feed row and of a search hit is carried by the value, as it must be in any typed feed.
  (schema.getType("Activity") as GraphQLInterfaceType).resolveType = (v) => (v as { __typename: string }).__typename;
  (schema.getType("SearchHit") as GraphQLUnionType).resolveType = (v) => (v as { __typename: string }).__typename;
  const called = (name: string): void => void (counters.loaderCalls[name] = (counters.loaderCalls[name] ?? 0) + 1);

  /** Load one row by id, with every sibling asking for the same kind of row in the same tick. */
  function byId<T>(ctx: Ctx, name: string, id: string, many: (ids: string[]) => Array<T | null>, wrap: (row: T) => unknown): Promise<unknown> {
    if (!batching) {
      called(name);
      const [row] = many([id]);
      return Promise.resolve(row ? wrap(row) : null);
    }
    return new Promise((resolve) => {
      if (!ctx.byId) {
        ctx.byId = new Map();
        queueMicrotask(() => {
          const queues = ctx.byId!;
          ctx.byId = null;
          for (const [loader, waiting] of queues) {
            called(loader);
            const ids = [...waiting.keys()];
            const rows = LOADERS[loader]!(ids);
            rows.forEach((row, i) => {
              for (const cb of waiting.get(ids[i]!)!) cb(row === null || row === undefined ? null : WRAPPERS[loader]!(row));
            });
          }
        });
      }
      LOADERS[name] = many as (ids: string[]) => unknown[];
      WRAPPERS[name] = wrap as (row: unknown) => unknown;
      const waiting = ctx.byId.get(name) ?? ctx.byId.set(name, new Map()).get(name)!;
      (waiting.get(id) ?? waiting.set(id, []).get(id)!).push(resolve);
    });
  }
  const LOADERS: Record<string, (ids: string[]) => unknown[]> = {};
  const WRAPPERS: Record<string, (row: unknown) => unknown> = {};

  /** One page per parent, with every parent at this level asking for the same page in the same tick. */
  function pageFor<T>(ctx: Ctx, name: string, key: string, page: PageArgs, many: (keys: string[], p: PageArgs) => Array<Page<T>>, wrap: (row: T) => unknown): Promise<unknown> {
    if (!batching) {
      called(name);
      return Promise.resolve(pageOut(many([key], page)[0]!, wrap));
    }
    return new Promise((resolve) => {
      if (!ctx.pages) {
        ctx.pages = new Map();
        queueMicrotask(() => {
          const groups = ctx.pages!;
          ctx.pages = null;
          for (const [groupKey, g] of groups) {
            const loader = groupKey.slice(0, groupKey.indexOf("|"));
            called(loader);
            const keys = [...g.waiting.keys()];
            const pages = PAGE_LOADERS[loader]!(keys, g.page);
            pages.forEach((p, i) => {
              for (const cb of g.waiting.get(keys[i]!)!) cb(pageOut(p as Page<unknown>, PAGE_WRAPPERS[loader]!));
            });
          }
        });
      }
      PAGE_LOADERS[name] = many as (keys: string[], p: PageArgs) => Array<Page<unknown>>;
      PAGE_WRAPPERS[name] = wrap as (row: unknown) => unknown;
      const groupKey = `${name}|${JSON.stringify(page)}`;
      const g = ctx.pages.get(groupKey) ?? ctx.pages.set(groupKey, { page, waiting: new Map() }).get(groupKey)!;
      (g.waiting.get(key) ?? g.waiting.set(key, []).get(key)!).push(resolve);
    });
  }
  const PAGE_LOADERS: Record<string, (keys: string[], p: PageArgs) => Array<Page<unknown>>> = {};
  const PAGE_WRAPPERS: Record<string, (row: unknown) => unknown> = {};

  const pageOut = <T,>(p: Page<T>, wrap: (row: T) => unknown): Record<string, unknown> => ({ items: p.items.map(wrap), cursor: p.cursor, hasMore: p.hasMore, total: p.total });
  const args = (a: { first: number; after?: string | null }): PageArgs => ({ first: a.first, after: a.after ?? null });

  // ---- the tenant rule, repeated wherever a row can be reached. Nothing checks that it was not forgotten.
  const ownIssue = (ctx: Ctx, i: IssueRow | undefined): IssueRow | null => (i && ctx.viewer?.orgId === i.orgId ? i : null);

  const userObj = (u: { id: string; name: string; email: string; avatarUrl: string | null }, ctx: Ctx): Record<string, unknown> => ({
    id: u.id,
    name: u.name,
    avatarUrl: u.avatarUrl,
    // Hand-written, per field, in the resolver: the schema above cannot say this.
    email: ctx.viewer?.id === u.id || ctx.viewer?.role === "OWNER" || ctx.viewer?.role === "ADMIN" ? u.email : null,
  });

  const memberObj = (m: MemberRow): Record<string, unknown> => ({
    id: m.id,
    role: m.role,
    joinedAt: m.joinedAt,
    user: (_a: unknown, ctx: Ctx) => byId(ctx, "Member.user", m.userId, (ids) => ids.map((id) => store.users.get(id) ?? null), (u) => userObj(u, ctx)),
    assigned: (a: { first: number; after?: string | null }, ctx: Ctx) => pageFor(ctx, "Member.assigned", m.id, args(a), (keys, p) => assignedPages(store, keys, p), issueObj),
  });

  const labelObj = (l: LabelRow): Record<string, unknown> => ({ id: l.id, name: l.name, color: l.color });

  const teamObj = (t: TeamRow): Record<string, unknown> => ({
    id: t.id,
    key: t.key,
    name: t.name,
    members: (a: { first: number; after?: string | null }, ctx: Ctx) => pageFor(ctx, "Team.members", t.id, args(a), (keys, p) => teamMemberPages(store, keys, p) as Array<Page<MemberRow>>, memberObj),
    projects: (a: { first: number; after?: string | null }, ctx: Ctx) => pageFor(ctx, "Team.projects", t.id, args(a), (keys, p) => teamProjectPages(store, keys, p) as Array<Page<ProjectRow>>, projectObj),
  });

  function projectObj(p: ProjectRow): Record<string, unknown> {
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      status: p.status,
      startDate: p.startDate,
      targetDate: p.targetDate,
      team: (_a: unknown, ctx: Ctx) => byId(ctx, "Project.team", p.teamId, (ids) => ids.map((id) => store.teams.get(id) ?? null), teamObj),
      lead: (_a: unknown, ctx: Ctx) => (p.leadId ? byId(ctx, "Project.lead", p.leadId, (ids) => ids.map((id) => store.members.get(id) ?? null), memberObj) : null),
      summary: () => projectSummary(store, p.id),
      spend: () => {
        if (store.down.billing) throw gqlError("The billing service is not answering", "UNAVAILABLE");
        return p.status === "PLANNED" ? null : (1000 + p.id.length * 137).toFixed(2);
      },
      labels: () => (store.index.labelsByOrg.get(p.orgId) ?? []).slice(0, 4).map((id) => labelObj(store.labels.get(id)!)),
      issues: (a: { first: number; after?: string | null }, ctx: Ctx) => pageFor(ctx, "Project.issues", p.id, args(a), (keys, q) => projectIssuePages(store, keys, q), issueObj),
      sprints: (a: { first: number; after?: string | null }, ctx: Ctx) => pageFor(ctx, "Project.sprints", p.id, args(a), (keys, q) => projectSprintPages(store, keys, q) as Array<Page<SprintRow>>, sprintObj),
    };
  }

  function sprintObj(s: SprintRow): Record<string, unknown> {
    return {
      id: s.id,
      name: s.name,
      state: s.state,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      project: (_a: unknown, ctx: Ctx) => byId(ctx, "Sprint.project", s.projectId, (ids) => ids.map((id) => store.projects.get(id) ?? null), projectObj),
      issues: (a: { first: number; after?: string | null }, ctx: Ctx) => pageFor(ctx, "Sprint.issues", s.id, args(a), (keys, p) => sprintIssuePages(store, keys, p), issueObj),
    };
  }

  function commentObj(c: CommentRow): Record<string, unknown> {
    return {
      id: c.id,
      body: c.body,
      createdAt: c.createdAt,
      version: c.version,
      issue: (_a: unknown, ctx: Ctx) => byId(ctx, "Comment.issue", c.issueId, (ids) => ids.map((id) => store.issues.get(id) ?? null), issueObj),
      author: (_a: unknown, ctx: Ctx) => byId(ctx, "Comment.author", c.authorId, (ids) => ids.map((id) => store.members.get(id) ?? null), memberObj),
    };
  }

  function issueObj(i: IssueRow): Record<string, unknown> {
    return {
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
      attachments: i.attachments,
      externalState: () => {
        if (store.down.tracker) throw gqlError("The customer tracker is not answering", "UNAVAILABLE");
        return i.externalState;
      },
      project: (_a: unknown, ctx: Ctx) => byId(ctx, "Issue.project", i.projectId, (ids) => ids.map((id) => store.projects.get(id) ?? null), projectObj),
      sprint: (_a: unknown, ctx: Ctx) => (i.sprintId ? byId(ctx, "Issue.sprint", i.sprintId, (ids) => ids.map((id) => store.sprints.get(id) ?? null), sprintObj) : null),
      reporter: (_a: unknown, ctx: Ctx) => byId(ctx, "Issue.reporter", i.reporterId, (ids) => ids.map((id) => store.members.get(id) ?? null), memberObj),
      assignee: (_a: unknown, ctx: Ctx) => (i.assigneeId ? byId(ctx, "Issue.assignee", i.assigneeId, (ids) => ids.map((id) => store.members.get(id) ?? null), memberObj) : null),
      parent: (_a: unknown, ctx: Ctx) => (i.parentId ? byId(ctx, "Issue.parent", i.parentId, (ids) => ids.map((id) => store.issues.get(id) ?? null), issueObj) : null),
      labels: () => i.labelIds.map((id) => store.labels.get(id)).filter((l): l is LabelRow => !!l).map(labelObj),
      children: (a: { first: number; after?: string | null }, ctx: Ctx) => pageFor(ctx, "Issue.children", i.id, args(a), (keys, p) => childPages(store, keys, p), issueObj),
      comments: (a: { first: number; after?: string | null }, ctx: Ctx) => pageFor(ctx, "Issue.comments", i.id, args(a), (keys, p) => commentPages(store, keys, p) as Array<Page<CommentRow>>, commentObj),
    };
  }

  const notificationObj = (n: NotificationRow): Record<string, unknown> => ({
    id: n.id,
    kind: n.kind,
    at: n.at,
    readAt: n.readAt,
    issue: (_a: unknown, ctx: Ctx) => byId(ctx, "Notification.issue", n.issueId, (ids) => ids.map((id) => store.issues.get(id) ?? null), issueObj),
  });

  /** A feed row: `__typename` is what lets the client tell the kinds apart, and what `resolveType` reads. */
  const activityObj = (a: ActivityRow): Record<string, unknown> => ({
    __typename: a.$type,
    id: a.id,
    at: a.at,
    from: a.from,
    to: a.to,
    completed: a.completed,
    carriedOver: a.carriedOver,
    actor: (_x: unknown, ctx: Ctx) => byId(ctx, "Activity.actor", a.actorId, (ids) => ids.map((id) => store.members.get(id) ?? null), memberObj),
    issue: (_x: unknown, ctx: Ctx) => (a.issueId ? byId(ctx, "Activity.issue", a.issueId, (ids) => ids.map((id) => store.issues.get(id) ?? null), issueObj) : null),
    comment: (_x: unknown, ctx: Ctx) => (a.commentId ? byId(ctx, "Activity.comment", a.commentId, (ids) => ids.map((id) => store.comments.get(id) ?? null), commentObj) : null),
    sprint: (_x: unknown, ctx: Ctx) => (a.sprintId ? byId(ctx, "Activity.sprint", a.sprintId, (ids) => ids.map((id) => store.sprints.get(id) ?? null), sprintObj) : null),
  });

  const root = {
    board: ({ projectId }: { projectId: string }, ctx: Ctx) => {
      const project = store.projects.get(projectId);
      if (!project) return null;
      if (ctx.viewer?.orgId !== project.orgId) throw gqlError("Not your organisation", ctx.viewer ? "FORBIDDEN" : "UNAUTHENTICATED");
      return {
        project: projectObj(project),
        columns: boardColumns(store, project.id, BOARD_STATES).map((c) => ({
          state: c.state,
          count: c.count,
          issues: (a: { first: number; after?: string | null }, inner: Ctx) =>
            pageFor(inner, "BoardColumn.issues", `${project.id}|${c.state}`, args(a), (keys, p) => keys.map((k) => issuePage(store, store.index.issuesByColumn.get(k) ?? [], p)), issueObj),
        })),
      };
    },
    issue: ({ id }: { id: string }, ctx: Ctx) => {
      const i = ownIssue(ctx, store.issues.get(id));
      return i ? issueObj(i) : null;
    },
    issues: ({ filter, first, after }: { filter?: Record<string, string>; first: number; after?: string }, ctx: Ctx) => {
      const page = issuePage(store, issueIds(store, filter ?? {}), { first, after: after ?? null });
      return pageOut({ ...page, items: page.items.filter((i) => i.orgId === ctx.viewer?.orgId) }, issueObj);
    },
    project: ({ id }: { id: string }, ctx: Ctx) => {
      const p = store.projects.get(id);
      return p && p.orgId === ctx.viewer?.orgId ? projectObj(p) : null;
    },
    team: ({ id }: { id: string }, ctx: Ctx) => {
      const t = store.teams.get(id);
      return t && t.orgId === ctx.viewer?.orgId ? teamObj(t) : null;
    },
    member: ({ id }: { id: string }, ctx: Ctx) => {
      const m = store.members.get(id);
      return m && m.orgId === ctx.viewer?.orgId ? memberObj(m) : null;
    },
    sprint: ({ id }: { id: string }, ctx: Ctx) => {
      const s = store.sprints.get(id);
      return s && s.orgId === ctx.viewer?.orgId ? sprintObj(s) : null;
    },
    org: ({ slug }: { slug: string }, ctx: Ctx) => {
      const o = [...store.orgs.values()].find((x) => x.slug === slug);
      if (!o) return null;
      return {
        id: o.id,
        slug: o.slug,
        name: o.name,
        plan: o.plan,
        seats: ctx.viewer?.role === "OWNER" || ctx.viewer?.role === "ADMIN" ? o.seats : null,
        teams: (a: { first: number; after?: string | null }, inner: Ctx) => pageFor(inner, "Org.teams", o.id, args(a), (keys, p) => orgTeamPages(store, keys, p) as Array<Page<TeamRow>>, teamObj),
      };
    },
    search: ({ q, first }: { q: string; first: number }, ctx: Ctx) => {
      if (!ctx.viewer) throw gqlError("Sign in", "UNAUTHENTICATED");
      const hits = searchHits(store, q, ctx.viewer.orgId);
      const page = pageOfIds(hits.map((h) => `${h.$type}:${h.id}`), (k) => k, { first });
      return {
        items: page.items.map((key) => {
          const [type, id] = key.split(":") as ["Issue" | "Project" | "Comment", string];
          if (type === "Issue") return { __typename: "Issue", ...issueObj(store.issues.get(id)!) };
          if (type === "Project") return { __typename: "Project", ...projectObj(store.projects.get(id)!) };
          return { __typename: "Comment", ...commentObj(store.comments.get(id)!) };
        }),
        cursor: page.cursor,
        hasMore: page.hasMore,
        total: page.total,
      };
    },
    activity: ({ projectId, first, after }: { projectId: string; first: number; after?: string }, ctx: Ctx) => {
      const project = store.projects.get(projectId);
      if (!project) return null;
      if (ctx.viewer?.orgId !== project.orgId) throw gqlError("Not your organisation", ctx.viewer ? "FORBIDDEN" : "UNAUTHENTICATED");
      return pageOut(pageOfIds(activityIds(store, projectId), (id) => store.activity.get(id), { first, after: after ?? null }), activityObj);
    },
    notifications: ({ first }: { first: number }, ctx: Ctx) => {
      if (!ctx.viewer) throw gqlError("Sign in", "UNAUTHENTICATED");
      return pageOut(pageOfIds(store.index.notificationsByRecipient.get(ctx.viewer.id) ?? [], (id) => store.notifications.get(id), { first }), notificationObj);
    },

    createIssue: ({ input }: { input: { projectId: string; title: string; priority?: string; assigneeId?: string | null; labelIds?: string[] } }, ctx: Ctx) => {
      if (!ctx.viewer) throw gqlError("Sign in", "UNAUTHENTICATED");
      const project = store.projects.get(input.projectId);
      if (!project) throw gqlError(`Project ${input.projectId} not found`, "NOT_FOUND");
      if (project.orgId !== ctx.viewer.orgId) throw gqlError("Not your organisation", "FORBIDDEN");
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
        reporterId: ctx.viewer.memberId,
        assigneeId: input.assigneeId ?? null,
        labelIds: input.labelIds ?? [],
        parentId: null,
        attachments: [],
        externalState: null,
      };
      store.issues.set(id, row);
      addIssueToIndex(store, row, true);
      return issueObj(row);
    },
    moveIssue: ({ id, to }: { id: string; to: IssueState }, ctx: Ctx) => {
      if (!ctx.viewer) throw gqlError("Sign in", "UNAUTHENTICATED");
      const issue = ownIssue(ctx, store.issues.get(id));
      if (!issue) throw gqlError(`Issue ${id} not found`, "NOT_FOUND");
      if (issue.state === to || !TRANSITIONS[issue.state].includes(to)) {
        throw gqlError(`An issue cannot go from ${issue.state} to ${to}`, "INVALID_TRANSITION", { from: issue.state, to });
      }
      const from = issue.state;
      const next: IssueRow = { ...issue, state: to, updatedAt: iso(Date.parse("2026-02-01T12:00:00.000Z")), version: issue.version + 1 };
      store.issues.set(issue.id, next);
      moveIssueInIndex(store, next, from, to);
      bus.emit("moved", { issueId: issue.id, from, to, projectId: issue.projectId });
      return issueObj(next);
    },
    updateIssue: ({ id, patch, ifVersion }: { id: string; patch: Partial<IssueRow>; ifVersion?: number }, ctx: Ctx) => {
      if (!ctx.viewer) throw gqlError("Sign in", "UNAUTHENTICATED");
      const issue = ownIssue(ctx, store.issues.get(id));
      if (!issue) throw gqlError(`Issue ${id} not found`, "NOT_FOUND");
      // Optimistic concurrency has no place in the protocol here, so it is an argument and a convention.
      if (ifVersion !== undefined && ifVersion !== issue.version) {
        throw gqlError(`Issue ${id} is at version ${issue.version}`, "CONFLICT", { actual: issue.version });
      }
      const next: IssueRow = { ...issue, ...patch, updatedAt: iso(Date.parse("2026-02-01T12:00:00.000Z")), version: issue.version + 1 };
      store.issues.set(issue.id, next);
      return issueObj(next);
    },
    assignIssue: ({ id, memberId }: { id: string; memberId: string | null }, ctx: Ctx) => {
      if (!ctx.viewer) throw gqlError("Sign in", "UNAUTHENTICATED");
      const issue = ownIssue(ctx, store.issues.get(id));
      if (!issue) throw gqlError(`Issue ${id} not found`, "NOT_FOUND");
      const next: IssueRow = { ...issue, assigneeId: memberId, updatedAt: iso(Date.parse("2026-02-01T12:00:00.000Z")), version: issue.version + 1 };
      store.issues.set(issue.id, next);
      return issueObj(next);
    },
    addComment: ({ input }: { input: { issueId: string; body: string } }, ctx: Ctx) => {
      if (!ctx.viewer) throw gqlError("Sign in", "UNAUTHENTICATED");
      const issue = ownIssue(ctx, store.issues.get(input.issueId));
      if (!issue) throw gqlError(`Issue ${input.issueId} not found`, "NOT_FOUND");
      const id = `c${store.nextId++}`;
      const row: CommentRow = { id, orgId: issue.orgId, issueId: issue.id, authorId: ctx.viewer.memberId, body: input.body, createdAt: iso(Date.parse("2026-02-01T12:00:00.000Z")), version: 1 };
      store.comments.set(id, row);
      const list = store.index.commentsByIssue;
      (list.get(issue.id) ?? list.set(issue.id, []).get(issue.id)!).push(id);
      return commentObj(row);
    },
    closeSprint: ({ id, carryTo }: { id: string; carryTo: string | null }, ctx: Ctx) => {
      if (!ctx.viewer) throw gqlError("Sign in", "UNAUTHENTICATED");
      if (ctx.viewer.role !== "OWNER" && ctx.viewer.role !== "ADMIN") throw gqlError("Admins only", "FORBIDDEN");
      const sprint = store.sprints.get(id);
      if (!sprint || sprint.orgId !== ctx.viewer.orgId) throw gqlError(`Sprint ${id} not found`, "NOT_FOUND");
      if (sprint.state !== "ACTIVE") throw gqlError(`Sprint ${id} is ${sprint.state}`, "SPRINT_NOT_ACTIVE", { state: sprint.state });
      const ids = [...(store.index.issuesBySprint.get(sprint.id) ?? [])];
      const unfinished = ids.map((x) => store.issues.get(x)!).filter((i) => i.state !== "DONE" && i.state !== "CANCELLED");
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
      const closed: SprintRow = { ...sprint, state: "CLOSED" };
      store.sprints.set(sprint.id, closed);
      // The mutation answers with what the caller selected. Which cached issues it invalidated is the client's problem.
      return { sprint: sprintObj(closed), moved: unfinished.length, carriedOver: carryTo ? unfinished.length : 0 };
    },

    projectFeed: ({ projectId }: { projectId: string }) => {
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      const on = (e: { issueId: string; from: IssueState; to: IssueState; projectId: string }): void => {
        if (e.projectId !== projectId) return;
        queue.push({ projectFeed: { issueId: e.issueId, from: e.from, to: e.to } });
        wake?.();
      };
      bus.on("moved", on);
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              while (!queue.length) await new Promise<void>((r) => (wake = r));
              return { value: queue.shift(), done: false };
            },
            return: async () => {
              bus.off("moved", on);
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
  };

  const server = await listen(async (req, res) => {
    counters.originRequests++;
    const url = new URL(req.url ?? "/", "http://x");
    const viewer = viewerOf(store, req.headers.authorization);
    const ctx: Ctx = { viewer, byId: null, pages: null };
    if (url.pathname === "/graphql" && req.method === "GET") {
      const query = url.searchParams.get("query") ?? "";
      const variables = url.searchParams.get("variables");
      const doc = parse(query);
      if (doc.definitions.some((d) => d.kind === "OperationDefinition" && d.operation !== "query")) {
        res.writeHead(405, { allow: "POST", "content-type": "application/graphql-response+json" }).end(JSON.stringify({ errors: [{ message: "Mutations must use POST" }] }));
        return;
      }
      const r = await graphql({ schema, source: query, rootValue: root, contextValue: ctx, variableValues: variables ? JSON.parse(variables) : {} });
      const text = JSON.stringify(r);
      const etag = etagOf(text);
      const cc = viewer ? "private, max-age=60" : "public, max-age=60";
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag, "cache-control": cc }).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/graphql-response+json", etag, "cache-control": cc }).end(text);
      return;
    }
    if (url.pathname === "/graphql" && req.method === "POST") {
      const { query, variables } = JSON.parse(await readBody(req)) as { query: string; variables?: Record<string, unknown> };
      const doc = parse(query);
      if (query.trimStart().startsWith("subscription")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        const it = (await subscribe({ schema, document: doc, rootValue: root, contextValue: ctx, variableValues: variables ?? {} })) as AsyncIterableIterator<ExecutionResult>;
        req.on("close", () => void it.return?.());
        res.write(": subscribed\n\n");
        for await (const r of it) res.write(`data: ${JSON.stringify(r)}\n\n`);
        return;
      }
      const r = await graphql({ schema, source: query, rootValue: root, contextValue: ctx, variableValues: variables ?? {} });
      res.writeHead(200, { "content-type": "application/graphql-response+json", "cache-control": "no-store" }).end(JSON.stringify(r));
      return;
    }
    if (url.pathname === "/graphql") {
      res.writeHead(405, { allow: "GET, POST", "content-type": "application/json" }).end(JSON.stringify({ errors: [{ message: `${req.method} is not part of GraphQL over HTTP; use GET or POST` }] }));
      return;
    }
    res.writeHead(404).end();
  });

  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { name: "GraphQL", base, server, counters, store, bus, close: () => closeServer(server) };
}
