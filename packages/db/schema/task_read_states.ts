import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";

export const taskReadStates = pgTable(
  "task_read_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTaskIdx: index("task_read_states_company_task_idx").on(table.companyId, table.taskId),
    companyUserIdx: index("task_read_states_company_user_idx").on(table.companyId, table.userId),
    companyTaskUserUnique: uniqueIndex("task_read_states_company_task_user_idx").on(
      table.companyId,
      table.taskId,
      table.userId,
    ),
  }),
);
