import type { TaskCommentAuthorType, SourceTrustMetadata } from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { documentAnnotationThreads } from "./document_annotation_threads.js";
import { documents } from "./documents.js";
import { taskExecutionRuns } from "./task_execution_runs.js";
import { taskComments } from "./task_comments.js";
import { tasks } from "./tasks.js";
import { routines } from "./routines.js";

export const documentAnnotationComments = pgTable(
  "document_annotation_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    threadId: uuid("thread_id").notNull().references(() => documentAnnotationThreads.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id").references(() => routines.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorType: text("author_type").$type<TaskCommentAuthorType>().notNull(),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    createdByRunId: uuid("created_by_run_id").references(() => taskExecutionRuns.id, { onDelete: "set null" }),
    taskCommentId: uuid("task_comment_id").references(() => taskComments.id, { onDelete: "set null" }),
    sourceTrust: jsonb("source_trust").$type<SourceTrustMetadata | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyThreadCreatedAtIdx: index("document_annotation_comments_company_thread_created_at_idx").on(
      table.companyId,
      table.threadId,
      table.createdAt,
    ),
    companyTaskCreatedAtIdx: index("document_annotation_comments_company_task_created_at_idx").on(
      table.companyId,
      table.taskId,
      table.createdAt,
    ),
    companyRoutineCreatedAtIdx: index("document_annotation_comments_company_routine_created_at_idx").on(
      table.companyId,
      table.routineId,
      table.createdAt,
    ),
    companyDocumentCreatedAtIdx: index("document_annotation_comments_company_document_created_at_idx").on(
      table.companyId,
      table.documentId,
      table.createdAt,
    ),
    taskCommentIdx: index("document_annotation_comments_task_comment_idx").on(table.taskCommentId),
    bodySearchIdx: index("document_annotation_comments_body_search_idx").using("gin", table.body.op("gin_trgm_ops")),
    exactlyOneOwnerChk: check(
      "document_annotation_comments_exactly_one_owner_chk",
      sql`num_nonnulls(${table.taskId}, ${table.routineId}) = 1`,
    ),
  }),
);
