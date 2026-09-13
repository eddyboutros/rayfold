import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRayfoldServer, type RayfoldServer, type RayfoldServerOptions } from "@rayfold/server";
import { seed, type Store } from "./data.ts";
import { workspaceResolvers } from "./resolvers.ts";

export {
  seed,
  sizes,
  count,
  iso,
  addIssueToIndex,
  moveIssueInIndex,
  BOARD_STATES,
  ISSUE_STATES,
  TRANSITIONS,
  type Store,
  type Index,
  type OrgRow,
  type UserRow,
  type MemberRow,
  type TeamRow,
  type ProjectRow,
  type LabelRow,
  type SprintRow,
  type IssueRow,
  type CommentRow,
  type NotificationRow,
  type ActivityRow,
  type ActivityType,
  type AttachmentRow,
  type IssueState,
  type Priority,
  type Role,
} from "./data.ts";
export {
  pageOfIds,
  issuePage,
  issueIds,
  boardColumns,
  searchHits,
  activityIds,
  commentPages,
  childPages,
  projectIssuePages,
  sprintIssuePages,
  assignedPages,
  teamMemberPages,
  teamProjectPages,
  orgTeamPages,
  projectSprintPages,
  projectSummary,
  type Page,
  type PageArgs,
  type IssueFilter,
  type Column,
  type Hit,
} from "./queries.ts";
export { workspaceResolvers, type Viewer } from "./resolvers.ts";

export const WORKSPACE_SCHEMA_PATH = fileURLToPath(new URL("../workspace.rayfold", import.meta.url));
export const workspaceSchemaText = (): string => readFileSync(WORKSPACE_SCHEMA_PATH, "utf8");

export interface Workspace {
  server: RayfoldServer;
  store: Store;
}

export function createWorkspace(opts: Partial<Omit<RayfoldServerOptions, "schema" | "resolvers">> & { store?: Store } = {}): Workspace {
  const store = opts.store ?? seed();
  const { store: _s, ...rest } = opts;
  const server = createRayfoldServer({ schema: workspaceSchemaText(), resolvers: workspaceResolvers(store), ...rest });
  return { server, store };
}
