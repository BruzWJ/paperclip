import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  unique,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projectWorkspaces } from "./project_workspaces.js";
import { projects } from "./projects.js";

export const executionWorkspaces = pgTable(
  "execution_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    projectWorkspaceId: uuid("project_workspace_id").references(() => projectWorkspaces.id, { onDelete: "set null" }),
    cwd: text("cwd").notNull(),
    repoUrl: text("repo_url"),
    /** Null for ordinary shared local folders; set only by a retained managed-branch safeguard caller. */
    branchName: text("branch_name"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("execution_workspaces_company_project_idx").on(
      table.companyId,
      table.projectId,
    ),
    companyProjectWorkspaceIdx: index("execution_workspaces_company_project_workspace_idx").on(
      table.companyId,
      table.projectWorkspaceId,
    ),
    companyLastUsedIdx: index("execution_workspaces_company_last_used_idx").on(
      table.companyId,
      table.lastUsedAt,
    ),
    companyBranchIdx: index("execution_workspaces_company_branch_idx").on(
      table.companyId,
      table.branchName,
    ),
    companyIdUq: unique("execution_workspaces_company_id_uq").on(
      table.companyId,
      table.id,
    ),
  }),
);
