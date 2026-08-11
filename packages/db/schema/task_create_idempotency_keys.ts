import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";

export const taskCreateIdempotencyKeys = pgTable(
  "task_create_idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyIdx: uniqueIndex("task_create_idempotency_keys_company_key_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    taskIdx: index("task_create_idempotency_keys_task_idx").on(table.taskId),
    companyCreatedAtIdx: index("task_create_idempotency_keys_company_created_at_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
