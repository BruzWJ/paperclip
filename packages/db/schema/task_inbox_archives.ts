import { sql } from "drizzle-orm";
import { check, pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { taskExecutionRuns } from "./task_execution_runs.js";
import { tasks } from "./tasks.js";

export const taskInboxArchives = pgTable(
  "task_inbox_archives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    archivedByActorType: text("archived_by_actor_type").$type<"user" | "agent">().notNull().default("user"),
    // Agent-attributed writes must set both IDs; SET NULL preserves rows if referenced records are deleted.
    archivedByAgentId: uuid("archived_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    archivedByRunId: uuid("archived_by_run_id").references(() => taskExecutionRuns.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTaskIdx: index("task_inbox_archives_company_task_idx").on(table.companyId, table.taskId),
    companyUserIdx: index("task_inbox_archives_company_user_idx").on(table.companyId, table.userId),
    companyTaskUserUnique: uniqueIndex("task_inbox_archives_company_task_user_idx").on(
      table.companyId,
      table.taskId,
      table.userId,
    ),
    archivedByActorTypeCheck: check(
      "task_inbox_archives_archived_by_actor_type_check",
      sql`${table.archivedByActorType} in ('user', 'agent')`,
    ),
  }),
);
