import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { taskExecutionRuns } from "./task_execution_runs.js";

export const taskExecutionDecisions = pgTable(
  "task_execution_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    stageId: uuid("stage_id").notNull(),
    stageType: text("stage_type").notNull(),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id),
    actorUserId: text("actor_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    outcome: text("outcome").notNull(),
    body: text("body").notNull(),
    createdByRunId: uuid("created_by_run_id").references(() => taskExecutionRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTaskIdx: index("task_execution_decisions_company_task_idx").on(table.companyId, table.taskId),
    stageIdx: index("task_execution_decisions_stage_idx").on(table.taskId, table.stageId, table.createdAt),
  }),
);
