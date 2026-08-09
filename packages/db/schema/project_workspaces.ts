import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const projectWorkspaces = pgTable(
  "project_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    cwd: text("cwd"),
    repoUrl: text("repo_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("project_workspaces_company_project_idx").on(table.companyId, table.projectId),
    projectCodebaseUq: uniqueIndex("project_workspaces_project_codebase_uq").on(table.projectId),
  }),
);
