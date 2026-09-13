/**
 * Rayfold resolvers for the workspace. Every field that returns entities is a batch loader: it takes the parents of
 * a level at once and answers them in one call, which is what keeps a board or a feed at one call per level however
 * many rows it holds.
 *
 * No resolver checks who may read a row. The policies in `workspace.rayfold` do that, and the executor applies them
 * before a value leaves the server.
 */
import { RayfoldError, ok, type PatchOp, type Resolvers } from "@rayfold/server";
import {
  BOARD_STATES,
  TRANSITIONS,
  addIssueToIndex,
  count,
  iso,
  moveIssueInIndex,
  type ActivityRow,
  type CommentRow,
  type IssueRow,
  type IssueState,
  type MemberRow,
  type NotificationRow,
  type Priority,
  type ProjectRow,
  type Store,
} from "./data.ts";
import {
  activityIds,
  assignedPages,
  boardColumns,
  childPages,
  commentPages,
  issueIds,
  issuePage,
  orgTeamPages,
  pageOfIds,
  projectIssuePages,
  projectSprintPages,
  projectSummary,
  searchHits,
  sprintIssuePages,
  teamMemberPages,
  teamProjectPages,
  type IssueFilter,
  type PageArgs,
} from "./queries.ts";

export interface Viewer {
  id: string;
  orgId: string;
  role: "OWNER" | "ADMIN" | "MEMBER" | "GUEST";
  /** the viewer's membership in `orgId`; commands record it as the actor */
  memberId: string;
}

const notFound = (what: string, id: string): never => {
  throw RayfoldError.domain("NotFound", { what, id }, `${what} ${id} not found`);
};
const forbidden = (reason: string): never => {
  throw RayfoldError.domain("Forbidden", { reason }, reason);
};

/** A command may only touch rows of the viewer's own organisation. Reads get the same rule from the schema. */
function sameOrg(viewer: Viewer, orgId: string): void {
  if (viewer.orgId !== orgId) forbidden("Not a member of that organisation");
}

export function workspaceResolvers(store: Store): Resolvers {
  const issueOr404 = (id: string): IssueRow => store.issues.get(id) ?? (notFound("Issue", id) as never);
  const now = (): string => iso(Date.parse("2026-02-01T12:00:00.000Z") + store.nextId);

  return {
    Query: {
      board: (args: { projectId: string }) => {
        count(store, "Query.board");
        const project = store.projects.get(args.projectId);
        if (!project) return null;
        return { project, columns: boardColumns(store, project.id, BOARD_STATES) };
      },
      issue: (args: { id: string }) => {
        count(store, "Query.issue");
        return store.issues.get(args.id) ?? null;
      },
      issues: (args: { filter: IssueFilter | null; page: PageArgs }) => {
        count(store, "Query.issues");
        return issuePage(store, issueIds(store, args.filter), args.page);
      },
      project: (args: { id: string }) => {
        count(store, "Query.project");
        return store.projects.get(args.id) ?? null;
      },
      team: (args: { id: string }) => {
        count(store, "Query.team");
        return store.teams.get(args.id) ?? null;
      },
      org: (args: { slug: string }) => {
        count(store, "Query.org");
        return [...store.orgs.values()].find((o) => o.slug === args.slug) ?? null;
      },
      member: (args: { id: string }) => {
        count(store, "Query.member");
        return store.members.get(args.id) ?? null;
      },
      sprint: (args: { id: string }) => {
        count(store, "Query.sprint");
        return store.sprints.get(args.id) ?? null;
      },
      search: (args: { q: string; page: PageArgs }, ctx) => {
        count(store, "Query.search");
        const viewer = ctx.viewer as Viewer | null;
        const hits = searchHits(store, args.q, viewer?.orgId ?? "");
        const page = pageOfIds(
          hits.map((h) => `${h.$type}:${h.id}`),
          (key) => {
            const [type, id] = key.split(":") as ["Issue" | "Project" | "Comment", string];
            const row = type === "Issue" ? store.issues.get(id) : type === "Project" ? store.projects.get(id) : store.comments.get(id);
            return row ? { $type: type, ...row } : undefined;
          },
          args.page,
        );
        return page;
      },
      activity: (args: { projectId: string; page: PageArgs }) => {
        count(store, "Query.activity");
        return pageOfIds(activityIds(store, args.projectId), (id) => store.activity.get(id), args.page);
      },
      notifications: (args: { page: PageArgs }, ctx) => {
        count(store, "Query.notifications");
        const viewer = ctx.viewer as Viewer;
        return pageOfIds(store.index.notificationsByRecipient.get(viewer.id) ?? [], (id) => store.notifications.get(id), args.page);
      },
    },

    Command: {
      createIssue: (args: { input: { projectId: string; title: string; description: string | null; priority: Priority; assigneeId: string | null; labelIds: string[]; parentId: string | null; estimate: number | null } }, ctx) => {
        count(store, "Command.createIssue");
        const viewer = ctx.viewer as Viewer;
        const project = store.projects.get(args.input.projectId) ?? (notFound("Project", args.input.projectId) as never);
        sameOrg(viewer, project.orgId);
        if (args.input.parentId) {
          const parent = store.issues.get(args.input.parentId) ?? (notFound("Issue", args.input.parentId) as never);
          if (parent.parentId) forbidden("A sub-issue cannot have sub-issues");
        }
        const n = (store.index.issuesByProject.get(project.id)?.length ?? 0) + 1;
        const id = `i${store.nextId}`;
        const row: IssueRow = {
          id,
          orgId: project.orgId,
          key: `${project.key}-${n}`,
          title: args.input.title,
          description: args.input.description,
          state: "TRIAGE",
          priority: args.input.priority,
          estimate: args.input.estimate,
          createdAt: now(),
          updatedAt: now(),
          version: 1,
          projectId: project.id,
          sprintId: null,
          reporterId: viewer.memberId,
          assigneeId: args.input.assigneeId,
          labelIds: args.input.labelIds,
          parentId: args.input.parentId,
          attachments: [],
          externalState: null,
        };
        if (!ctx.simulate) {
          store.nextId++;
          store.issues.set(id, row);
          addIssueToIndex(store, row, true);
        }
        // The board's TRIAGE column and every issue list gained a row: invalidate the lists, the entity travels in `ok`.
        return ok(row, { patch: [{ invOp: ["board", "issues", "activity"] }], emit: [{ event: "IssueCreated", payload: { issueId: id, projectId: project.id, key: row.key } }] });
      },

      moveIssue: (args: { id: string; to: IssueState }, ctx) => {
        count(store, "Command.moveIssue");
        const viewer = ctx.viewer as Viewer;
        const issue = issueOr404(args.id);
        sameOrg(viewer, issue.orgId);
        const from = issue.state;
        if (from === args.to || !TRANSITIONS[from].includes(args.to)) {
          throw RayfoldError.domain("InvalidTransition", { from, to: args.to }, `An issue cannot go from ${from} to ${args.to}`);
        }
        const next: IssueRow = { ...issue, state: args.to, updatedAt: now(), version: issue.version + 1 };
        if (ctx.simulate) return next;
        store.issues.set(issue.id, next);
        moveIssueInIndex(store, next, from, args.to);
        return ok(next, {
          patch: [{ set: `Issue:${issue.id}`, value: { state: args.to, version: next.version, updatedAt: next.updatedAt } }, { invOp: ["board"] }],
          emit: [{ event: "IssueMoved", payload: { issueId: issue.id, from, to: args.to } }],
        });
      },

      updateIssue: (args: { id: string; patch: Partial<Record<"title" | "description" | "priority" | "estimate" | "assigneeId" | "sprintId", unknown>> }, ctx) => {
        count(store, "Command.updateIssue");
        const viewer = ctx.viewer as Viewer;
        const issue = issueOr404(args.id);
        sameOrg(viewer, issue.orgId);
        // A stale `ifVersion` (or `If-Match`) loses the race and is told so, with the row as it stands now.
        ctx.checkVersion(`Issue:${issue.id}`, issue.version, issue);
        const next: IssueRow = { ...issue, ...(args.patch as Partial<IssueRow>), updatedAt: now(), version: issue.version + 1 };
        if (ctx.simulate) return next;
        store.issues.set(issue.id, next);
        if (next.assigneeId !== issue.assigneeId) {
          const list = store.index.issuesByAssignee;
          const old = issue.assigneeId ? list.get(issue.assigneeId) : undefined;
          if (old) {
            const at = old.indexOf(issue.id);
            if (at >= 0) old.splice(at, 1);
          }
          if (next.assigneeId) (list.get(next.assigneeId) ?? list.set(next.assigneeId, []).get(next.assigneeId)!).unshift(issue.id);
        }
        return ok(next);
      },

      assignIssue: (args: { id: string; memberId: string | null }, ctx) => {
        count(store, "Command.assignIssue");
        const viewer = ctx.viewer as Viewer;
        const issue = issueOr404(args.id);
        sameOrg(viewer, issue.orgId);
        if (args.memberId) {
          const member = store.members.get(args.memberId) ?? (notFound("Member", args.memberId) as never);
          sameOrg(viewer, member.orgId);
        }
        const next: IssueRow = { ...issue, assigneeId: args.memberId, updatedAt: now(), version: issue.version + 1 };
        if (ctx.simulate) return next;
        store.issues.set(issue.id, next);
        const list = store.index.issuesByAssignee;
        if (issue.assigneeId) {
          const old = list.get(issue.assigneeId);
          const at = old?.indexOf(issue.id) ?? -1;
          if (old && at >= 0) old.splice(at, 1);
        }
        if (args.memberId) (list.get(args.memberId) ?? list.set(args.memberId, []).get(args.memberId)!).unshift(issue.id);
        return ok(next, { patch: [{ set: `Issue:${issue.id}`, value: { version: next.version, updatedAt: next.updatedAt } }] });
      },

      addComment: (args: { input: { issueId: string; body: string } }, ctx) => {
        count(store, "Command.addComment");
        const viewer = ctx.viewer as Viewer;
        const issue = issueOr404(args.input.issueId);
        sameOrg(viewer, issue.orgId);
        const id = `c${store.nextId}`;
        const row: CommentRow = { id, orgId: issue.orgId, issueId: issue.id, authorId: viewer.memberId, body: args.input.body, createdAt: now(), version: 1 };
        if (!ctx.simulate) {
          store.nextId++;
          store.comments.set(id, row);
          const list = store.index.commentsByIssue;
          (list.get(issue.id) ?? list.set(issue.id, []).get(issue.id)!).push(id);
        }
        return ok(row, { patch: [{ invOp: ["activity"] }], emit: [{ event: "CommentAdded", payload: { commentId: id, issueId: issue.id } }] });
      },

      deleteComment: (args: { id: string }, ctx) => {
        count(store, "Command.deleteComment");
        const viewer = ctx.viewer as Viewer;
        const comment = store.comments.get(args.id) ?? (notFound("Comment", args.id) as never);
        sameOrg(viewer, comment.orgId);
        if (comment.authorId !== viewer.memberId && viewer.role !== "OWNER" && viewer.role !== "ADMIN") forbidden("Only the author of a comment can delete it");
        if (!ctx.simulate) {
          store.comments.delete(comment.id);
          const list = store.index.commentsByIssue.get(comment.issueId);
          const at = list?.indexOf(comment.id) ?? -1;
          if (list && at >= 0) list.splice(at, 1);
        }
        return ok(comment, { patch: [{ del: `Comment:${comment.id}` }] });
      },

      createProject: (args: { input: { teamId: string; name: string; key: string; targetDate: string | null } }, ctx) => {
        count(store, "Command.createProject");
        const viewer = ctx.viewer as Viewer;
        const team = store.teams.get(args.input.teamId) ?? (notFound("Team", args.input.teamId) as never);
        sameOrg(viewer, team.orgId);
        const id = `p${store.nextId}`;
        const row: ProjectRow = { id, orgId: team.orgId, key: args.input.key, name: args.input.name, status: "PLANNED", startDate: null, targetDate: args.input.targetDate, teamId: team.id, leadId: viewer.memberId, summary: null };
        if (!ctx.simulate) {
          store.nextId++;
          store.projects.set(id, row);
          const list = store.index.projectsByTeam;
          (list.get(team.id) ?? list.set(team.id, []).get(team.id)!).push(id);
        }
        return ok(row, { patch: [{ invOp: ["team"] }] });
      },

      closeSprint: (args: { id: string; carryTo: string | null }, ctx) => {
        count(store, "Command.closeSprint");
        const viewer = ctx.viewer as Viewer;
        const sprint = store.sprints.get(args.id) ?? (notFound("Sprint", args.id) as never);
        sameOrg(viewer, sprint.orgId);
        if (sprint.state !== "ACTIVE") throw RayfoldError.domain("SprintNotActive", { state: sprint.state }, `Sprint ${sprint.id} is ${sprint.state}`);
        const carry = args.carryTo ? (store.sprints.get(args.carryTo) ?? (notFound("Sprint", args.carryTo) as never)) : null;
        const ids = [...(store.index.issuesBySprint.get(sprint.id) ?? [])];
        const unfinished = ids.map((id) => store.issues.get(id)!).filter((i) => i.state !== "DONE" && i.state !== "CANCELLED");
        const completed = ids.length - unfinished.length;

        const patch: PatchOp[] = [];
        const emit: Array<{ event: string; payload: Record<string, unknown> }> = [{ event: "SprintClosed", payload: { sprintId: sprint.id, moved: unfinished.length } }];
        for (const issue of unfinished) {
          const next: IssueRow = { ...issue, sprintId: carry?.id ?? null, updatedAt: now(), version: issue.version + 1 };
          if (!ctx.simulate) {
            store.issues.set(issue.id, next);
            const from = store.index.issuesBySprint.get(sprint.id);
            const at = from?.indexOf(issue.id) ?? -1;
            if (from && at >= 0) from.splice(at, 1);
            if (carry) {
              const to = store.index.issuesBySprint;
              (to.get(carry.id) ?? to.set(carry.id, []).get(carry.id)!).unshift(issue.id);
            }
          }
          // Every client holding any of these issues is corrected by the command's own answer, with no refetch.
          patch.push({ set: `Issue:${issue.id}`, value: { sprintId: carry?.id ?? null, version: next.version, updatedAt: next.updatedAt } });
        }
        const closed = { ...sprint, state: "CLOSED" as const };
        if (!ctx.simulate) store.sprints.set(sprint.id, closed);
        patch.push({ set: `Sprint:${sprint.id}`, value: { state: "CLOSED" } }, { invOp: ["board", "issues", "activity"] });
        return ok({ sprint: closed, moved: unfinished.length, carriedOver: carry ? unfinished.length : 0 }, { patch, emit });
      },

      readNotifications: (args: { upTo: string }, ctx) => {
        count(store, "Command.readNotifications");
        const viewer = ctx.viewer as Viewer;
        let n = 0;
        for (const id of store.index.notificationsByRecipient.get(viewer.id) ?? []) {
          const row = store.notifications.get(id);
          if (!row || row.readAt || row.at > args.upTo) continue;
          n++;
          if (!ctx.simulate) store.notifications.set(id, { ...row, readAt: args.upTo });
        }
        return n;
      },
    },

    Stream: {
      projectFeed: (args: { projectId: string }, ctx) => {
        count(store, "Stream.projectFeed");
        const source = ctx.events.subscribe<{ issueId: string; from: IssueState; to: IssueState }>("IssueMoved", ctx.signal);
        return (async function* () {
          for await (const ev of source) {
            if (store.issues.get(ev.issueId)?.projectId === args.projectId) yield ev;
          }
        })();
      },
    },

    // ---------------------------------------------------------------- field loaders, one call per level

    Org: {
      teams: (parents: Array<{ id: string }>, args: { page: PageArgs }) => orgTeamPages(store, parents.map((o) => o.id), args.page),
    },
    Member: {
      user: (parents: MemberRow[]) => {
        count(store, "Member.user");
        // Not `@partial`: people are not optional on a screen that shows who did what, so this failure fails the op.
        if (store.down.directory) throw new RayfoldError("unavailable", "The directory service is not answering");
        return parents.map((m) => store.users.get(m.userId) ?? null);
      },
      assigned: (parents: MemberRow[], args: { page: PageArgs }) => assignedPages(store, parents.map((m) => m.id), args.page),
    },
    Team: {
      members: (parents: Array<{ id: string }>, args: { page: PageArgs }) => teamMemberPages(store, parents.map((t) => t.id), args.page),
      projects: (parents: Array<{ id: string }>, args: { page: PageArgs }) => teamProjectPages(store, parents.map((t) => t.id), args.page),
    },
    Project: {
      team: (parents: ProjectRow[]) => {
        count(store, "Project.team");
        return parents.map((p) => store.teams.get(p.teamId) ?? null);
      },
      lead: (parents: ProjectRow[]) => {
        count(store, "Project.lead");
        return parents.map((p) => (p.leadId ? (store.members.get(p.leadId) ?? null) : null));
      },
      summary: (parents: ProjectRow[]) => parents.map((p) => projectSummary(store, p.id)),
      spend: (parents: ProjectRow[]) => {
        count(store, "Project.spend");
        if (store.down.billing) throw new RayfoldError("unavailable", "The billing service is not answering");
        return parents.map((p) => (p.status === "PLANNED" ? null : (1000 + p.id.length * 137).toFixed(2)));
      },
      issues: (parents: Array<{ id: string }>, args: { page: PageArgs }) => projectIssuePages(store, parents.map((p) => p.id), args.page),
      sprints: (parents: Array<{ id: string }>, args: { page: PageArgs }) => projectSprintPages(store, parents.map((p) => p.id), args.page),
      labels: (parents: ProjectRow[]) => {
        count(store, "Project.labels");
        return parents.map((p) => (store.index.labelsByOrg.get(p.orgId) ?? []).slice(0, 4).map((id) => store.labels.get(id)!));
      },
    },
    Sprint: {
      project: (parents: Array<{ projectId: string }>) => {
        count(store, "Sprint.project");
        return parents.map((s) => store.projects.get(s.projectId) ?? null);
      },
      issues: (parents: Array<{ id: string }>, args: { page: PageArgs }) => sprintIssuePages(store, parents.map((s) => s.id), args.page),
    },
    Issue: {
      project: (parents: IssueRow[]) => {
        count(store, "Issue.project");
        return parents.map((i) => store.projects.get(i.projectId) ?? null);
      },
      sprint: (parents: IssueRow[]) => {
        count(store, "Issue.sprint");
        return parents.map((i) => (i.sprintId ? (store.sprints.get(i.sprintId) ?? null) : null));
      },
      reporter: (parents: IssueRow[]) => {
        count(store, "Issue.reporter");
        return parents.map((i) => store.members.get(i.reporterId) ?? null);
      },
      assignee: (parents: IssueRow[]) => {
        count(store, "Issue.assignee");
        return parents.map((i) => (i.assigneeId ? (store.members.get(i.assigneeId) ?? null) : null));
      },
      labels: (parents: IssueRow[]) => {
        count(store, "Issue.labels");
        return parents.map((i) => i.labelIds.map((id) => store.labels.get(id)!).filter(Boolean));
      },
      parent: (parents: IssueRow[]) => {
        count(store, "Issue.parent");
        return parents.map((i) => (i.parentId ? (store.issues.get(i.parentId) ?? null) : null));
      },
      children: (parents: Array<{ id: string }>, args: { page: PageArgs }) => childPages(store, parents.map((i) => i.id), args.page),
      comments: (parents: Array<{ id: string }>, args: { page: PageArgs }) => commentPages(store, parents.map((i) => i.id), args.page),
      externalState: (parents: IssueRow[]) => {
        count(store, "Issue.externalState");
        if (store.down.tracker) throw new RayfoldError("unavailable", "The customer's tracker is not answering");
        return parents.map((i) => i.externalState);
      },
    },
    Comment: {
      issue: (parents: CommentRow[]) => {
        count(store, "Comment.issue");
        return parents.map((c) => store.issues.get(c.issueId) ?? null);
      },
      author: (parents: CommentRow[]) => {
        count(store, "Comment.author");
        return parents.map((c) => store.members.get(c.authorId) ?? null);
      },
    },
    Notification: {
      issue: (parents: NotificationRow[]) => {
        count(store, "Notification.issue");
        return parents.map((n) => store.issues.get(n.issueId) ?? null);
      },
    },
    BoardColumn: {
      /** One call for every column of the board, each with its own page. */
      issues: (parents: Array<{ ids: readonly string[] }>, args: { page: PageArgs }) => {
        count(store, "BoardColumn.issues");
        return parents.map((c) => issuePage(store, c.ids, args.page));
      },
    },
    BulkResult: {
      sprint: (parents: Array<{ sprint: unknown }>) => parents.map((r) => r.sprint),
    },
    IssueOpened: {
      actor: (parents: ActivityRow[]) => actors(store, parents),
      issue: (parents: ActivityRow[]) => issuesOf(store, parents),
    },
    IssueMovedActivity: {
      actor: (parents: ActivityRow[]) => actors(store, parents),
      issue: (parents: ActivityRow[]) => issuesOf(store, parents),
    },
    IssueCommented: {
      actor: (parents: ActivityRow[]) => actors(store, parents),
      comment: (parents: ActivityRow[]) => {
        count(store, "Activity.comment");
        return parents.map((a) => (a.commentId ? (store.comments.get(a.commentId) ?? null) : null));
      },
    },
    SprintClosedActivity: {
      actor: (parents: ActivityRow[]) => actors(store, parents),
      sprint: (parents: ActivityRow[]) => {
        count(store, "Activity.sprint");
        return parents.map((a) => (a.sprintId ? (store.sprints.get(a.sprintId) ?? null) : null));
      },
    },
  } as Resolvers;
}

function actors(store: Store, parents: ActivityRow[]): Array<MemberRow | null> {
  count(store, "Activity.actor");
  return parents.map((a) => store.members.get(a.actorId) ?? null);
}

function issuesOf(store: Store, parents: ActivityRow[]): Array<IssueRow | null> {
  count(store, "Activity.issue");
  return parents.map((a) => (a.issueId ? (store.issues.get(a.issueId) ?? null) : null));
}
