import { pgTable, uuid, text, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";
import { approvals } from "./approvals.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";

export const taskApprovals = pgTable(
  "task_approvals",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id, { onDelete: "cascade" }),
    linkedByAgentId: uuid("linked_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    linkedByUserId: text("linked_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.taskId, table.approvalId], name: "task_approvals_pk" }),
    taskIdx: index("task_approvals_task_idx").on(table.taskId),
    approvalIdx: index("task_approvals_approval_idx").on(table.approvalId),
    companyIdx: index("task_approvals_company_idx").on(table.companyId),
  }),
);
