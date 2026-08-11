import { pgTable, uuid, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";
import { labels } from "./labels.js";

export const taskLabels = pgTable(
  "task_labels",
  {
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    labelId: uuid("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.taskId, table.labelId], name: "task_labels_pk" }),
    taskIdx: index("task_labels_task_idx").on(table.taskId),
    labelIdx: index("task_labels_label_idx").on(table.labelId),
    companyIdx: index("task_labels_company_idx").on(table.companyId),
  }),
);
