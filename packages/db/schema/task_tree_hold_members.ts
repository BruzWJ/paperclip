import { index, pgTable, text, timestamp, uniqueIndex, uuid, boolean, integer } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { taskExecutionRuns } from "./task_execution_runs.js";
import { tasks } from "./tasks.js";
import { taskTreeHolds } from "./task_tree_holds.js";

export const taskTreeHoldMembers = pgTable(
  "task_tree_hold_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    holdId: uuid("hold_id").notNull().references(() => taskTreeHolds.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    parentTaskId: uuid("parent_task_id").references(() => tasks.id, { onDelete: "set null" }),
    depth: integer("depth").notNull().default(0),
    taskIdentifier: text("task_identifier").notNull(),
    taskTitle: text("task_title"),
    taskStatus: text("task_status").notNull(),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ownerUserId: text("owner_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    activeRunId: uuid("active_run_id").references(() => taskExecutionRuns.id, { onDelete: "set null" }),
    activeRunStatus: text("active_run_status"),
    skipped: boolean("skipped").notNull().default(false),
    skipReason: text("skip_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    holdTaskUniqueIdx: uniqueIndex("task_tree_hold_members_hold_task_uq").on(table.holdId, table.taskId),
    companyTaskIdx: index("task_tree_hold_members_company_task_idx").on(table.companyId, table.taskId),
    holdDepthIdx: index("task_tree_hold_members_hold_depth_idx").on(table.holdId, table.depth),
  }),
);
