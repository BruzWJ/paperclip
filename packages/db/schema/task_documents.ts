import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";
import { documents } from "./documents.js";

export const taskDocuments = pgTable(
  "task_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTaskKeyUq: uniqueIndex("task_documents_company_task_key_uq").on(
      table.companyId,
      table.taskId,
      table.key,
    ),
    documentUq: uniqueIndex("task_documents_document_uq").on(table.documentId),
    companyTaskUpdatedIdx: index("task_documents_company_task_updated_idx").on(
      table.companyId,
      table.taskId,
      table.updatedAt,
    ),
  }),
);
