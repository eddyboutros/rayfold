/**
 * Reads over the workspace store, shared by everything that serves it: the Rayfold resolvers and the REST and
 * GraphQL stacks in the end-to-end comparison. One implementation of every list keeps the comparison about the
 * protocols rather than about three different ways of scanning a table.
 *
 * Nothing here applies an authorization policy. Rayfold gets its policies from the schema, and the other two stacks
 * write theirs by hand; that difference is one of the things being measured, so it must not hide in here.
 */
import type { IssueRow, IssueState, Priority, Store } from "./data.ts";
import { count } from "./data.ts";

export interface PageArgs { first: number; after?: string | null; offset?: number | null }
export interface Page<T> { items: T[]; cursor: string | null; hasMore: boolean; total: number }
export interface IssueFilter {
  projectId?: string | null;
  state?: IssueState | null;
  priority?: Priority | null;
  assigneeId?: string | null;
  labelId?: string | null;
  sprintId?: string | null;
  titleContains?: string | null;
}

const EMPTY: readonly string[] = [];

/** Where a page starts: just past the `after` cursor (an unknown cursor gives an empty page), else at `offset`. */
function startOf(ids: readonly string[], p: PageArgs): number {
  if (p.after) {
    const i = ids.indexOf(p.after);
    return i < 0 ? ids.length : i + 1;
  }
  return p.offset || 0;
}

/** A page of rows, taken from a list of ids that is already in the order the list is served in. */
export function pageOfIds<T>(ids: readonly string[], get: (id: string) => T | undefined, p: PageArgs): Page<T> {
  const start = startOf(ids, p);
  const slice = ids.slice(start, start + p.first);
  const items = slice.map((id) => get(id)).filter((v): v is T => v !== undefined);
  return { items, cursor: slice.length ? slice[slice.length - 1]! : null, hasMore: start + p.first < ids.length, total: ids.length };
}

export const issuePage = (store: Store, ids: readonly string[], p: PageArgs): Page<IssueRow> => pageOfIds(ids, (id) => store.issues.get(id), p);

/**
 * The ids a filter selects, in list order. Everything a single index answers is read straight off it; only a
 * combination that no index covers falls back to a scan, and then it scans once.
 */
export function issueIds(store: Store, filter: IssueFilter | null | undefined): readonly string[] {
  const f = filter ?? {};
  const ix = store.index;
  const only = (keys: Array<keyof IssueFilter>): boolean => Object.entries(f).every(([k, v]) => v === null || v === undefined || keys.includes(k as keyof IssueFilter));

  if (f.projectId && f.state && only(["projectId", "state"])) return ix.issuesByColumn.get(`${f.projectId}|${f.state}`) ?? EMPTY;
  if (f.projectId && only(["projectId"])) return ix.issuesByProject.get(f.projectId) ?? EMPTY;
  if (f.sprintId && only(["sprintId"])) return ix.issuesBySprint.get(f.sprintId) ?? EMPTY;
  if (f.assigneeId && only(["assigneeId"])) return ix.issuesByAssignee.get(f.assigneeId) ?? EMPTY;

  const base = f.projectId ? (ix.issuesByProject.get(f.projectId) ?? EMPTY) : f.sprintId ? (ix.issuesBySprint.get(f.sprintId) ?? EMPTY) : f.assigneeId ? (ix.issuesByAssignee.get(f.assigneeId) ?? EMPTY) : allIssueIds(store);
  const needle = f.titleContains?.toLowerCase();
  return base.filter((id) => {
    const i = store.issues.get(id);
    if (!i) return false;
    if (f.state && i.state !== f.state) return false;
    if (f.priority && i.priority !== f.priority) return false;
    if (f.assigneeId && i.assigneeId !== f.assigneeId) return false;
    if (f.sprintId && i.sprintId !== f.sprintId) return false;
    if (f.labelId && !i.labelIds.includes(f.labelId)) return false;
    if (needle && !i.title.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** Every issue, newest first: the concatenation of the per-project lists, which are already in that order. */
function allIssueIds(store: Store): readonly string[] {
  const out: string[] = [];
  for (const ids of store.index.issuesByProject.values()) out.push(...ids);
  return out.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

export interface Column { state: IssueState; count: number; ids: readonly string[] }

/** One board: every column with its total and the ids behind it, from the index alone. */
export function boardColumns(store: Store, projectId: string, states: readonly IssueState[]): Column[] {
  return states.map((state) => {
    const ids = store.index.issuesByColumn.get(`${projectId}|${state}`) ?? EMPTY;
    return { state, count: ids.length, ids };
  });
}

export interface Hit { $type: "Issue" | "Project" | "Comment"; id: string }

/**
 * Everything in one organisation matching a phrase: issues by title or key, projects by name or key, comments by
 * body. Issues first, then projects, then comments; within a kind, newest first.
 */
export function searchHits(store: Store, q: string, orgId: string): Hit[] {
  const needle = q.toLowerCase();
  const hits: Hit[] = [];
  for (const id of allIssueIds(store)) {
    const i = store.issues.get(id)!;
    if (i.orgId === orgId && (i.title.toLowerCase().includes(needle) || i.key.toLowerCase().includes(needle))) hits.push({ $type: "Issue", id });
  }
  for (const p of store.projects.values()) {
    if (p.orgId === orgId && (p.name.toLowerCase().includes(needle) || p.key.toLowerCase().includes(needle))) hits.push({ $type: "Project", id: p.id });
  }
  for (const c of store.comments.values()) {
    if (c.orgId === orgId && c.body.toLowerCase().includes(needle)) hits.push({ $type: "Comment", id: c.id });
  }
  return hits;
}

export const activityIds = (store: Store, projectId: string): readonly string[] => store.index.activityByProject.get(projectId) ?? EMPTY;

// ---------------------------------------------------------------- batch loads: one call, many parents
//
// Every one of these takes the parents of a level at once. A stack that loads them one parent at a time makes N
// calls where these make one, which is exactly what the N+1 rows of the comparison measure.

const pagesFor = <T,>(store: Store, keys: readonly string[], list: (key: string) => readonly string[], get: (id: string) => T | undefined, p: PageArgs, loader: string): Array<Page<T>> => {
  count(store, loader);
  return keys.map((k) => pageOfIds(list(k), get, p));
};

export const commentPages = (store: Store, issueIds: readonly string[], p: PageArgs): Array<Page<{ id: string }>> =>
  pagesFor(store, issueIds, (id) => store.index.commentsByIssue.get(id) ?? EMPTY, (id) => store.comments.get(id), p, "Issue.comments");

export const childPages = (store: Store, issueIds: readonly string[], p: PageArgs): Array<Page<IssueRow>> =>
  pagesFor(store, issueIds, (id) => store.index.issuesByParent.get(id) ?? EMPTY, (id) => store.issues.get(id), p, "Issue.children");

export const projectIssuePages = (store: Store, projectIds: readonly string[], p: PageArgs): Array<Page<IssueRow>> =>
  pagesFor(store, projectIds, (id) => store.index.issuesByProject.get(id) ?? EMPTY, (id) => store.issues.get(id), p, "Project.issues");

export const sprintIssuePages = (store: Store, sprintIds: readonly string[], p: PageArgs): Array<Page<IssueRow>> =>
  pagesFor(store, sprintIds, (id) => store.index.issuesBySprint.get(id) ?? EMPTY, (id) => store.issues.get(id), p, "Sprint.issues");

export const assignedPages = (store: Store, memberIds: readonly string[], p: PageArgs): Array<Page<IssueRow>> =>
  pagesFor(store, memberIds, (id) => store.index.issuesByAssignee.get(id) ?? EMPTY, (id) => store.issues.get(id), p, "Member.assigned");

export const teamMemberPages = (store: Store, teamIds: readonly string[], p: PageArgs): Array<Page<{ id: string }>> =>
  pagesFor(store, teamIds, (id) => store.index.membersByTeam.get(id) ?? EMPTY, (id) => store.members.get(id), p, "Team.members");

export const teamProjectPages = (store: Store, teamIds: readonly string[], p: PageArgs): Array<Page<{ id: string }>> =>
  pagesFor(store, teamIds, (id) => store.index.projectsByTeam.get(id) ?? EMPTY, (id) => store.projects.get(id), p, "Team.projects");

export const orgTeamPages = (store: Store, orgIds: readonly string[], p: PageArgs): Array<Page<{ id: string }>> =>
  pagesFor(store, orgIds, (id) => store.index.teamsByOrg.get(id) ?? EMPTY, (id) => store.teams.get(id), p, "Org.teams");

export const projectSprintPages = (store: Store, projectIds: readonly string[], p: PageArgs): Array<Page<{ id: string }>> =>
  pagesFor(store, projectIds, (id) => store.index.sprintsByProject.get(id) ?? EMPTY, (id) => store.sprints.get(id), p, "Project.sprints");

/** The rollup behind `Project.summary`: real work, which is why the schema marks the field `@lazy`. */
export function projectSummary(store: Store, projectId: string): string {
  count(store, "Project.summary");
  const ids = store.index.issuesByProject.get(projectId) ?? EMPTY;
  let done = 0;
  let points = 0;
  for (const id of ids) {
    const i = store.issues.get(id);
    if (!i) continue;
    if (i.state === "DONE") done++;
    points += i.estimate ?? 0;
  }
  const project = store.projects.get(projectId);
  return `${project?.name ?? projectId}: ${done} of ${ids.length} issues done, ${points} points planned.`;
}
