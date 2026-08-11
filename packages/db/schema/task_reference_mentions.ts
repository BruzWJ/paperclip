import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";

export const taskReferenceMentions = pgTable(
  "task_reference_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceTaskId: uuid("source_task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    targetTaskId: uuid("target_task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").$type<"title" | "request" | "comment" | "document">().notNull(),
    sourceRecordId: uuid("source_record_id"),
    documentKey: text("document_key"),
    matchedText: text("matched_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceTaskIdx: index("task_reference_mentions_company_source_task_idx").on(
      table.companyId,
      table.sourceTaskId,
    ),
    companyTargetTaskIdx: index("task_reference_mentions_company_target_task_idx").on(
      table.companyId,
      table.targetTaskId,
    ),
    companyTaskPairIdx: index("task_reference_mentions_company_task_pair_idx").on(
      table.companyId,
      table.sourceTaskId,
      table.targetTaskId,
    ),
    companySourceMentionWithRecordUq: uniqueIndex("task_reference_mentions_company_source_mention_record_uq").on(
      table.companyId,
      table.sourceTaskId,
      table.targetTaskId,
      table.sourceKind,
      table.sourceRecordId,
    ).where(sql`${table.sourceRecordId} is not null`),
    companySourceMentionWithoutRecordUq: uniqueIndex("task_reference_mentions_company_source_mention_null_record_uq").on(
      table.companyId,
      table.sourceTaskId,
      table.targetTaskId,
      table.sourceKind,
    ).where(sql`${table.sourceRecordId} is null`),
  }),
);
