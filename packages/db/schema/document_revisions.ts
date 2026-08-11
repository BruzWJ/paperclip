import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { documents } from "./documents.js";
import { taskExecutionRuns } from "./task_execution_runs.js";
import { taskComments } from "./task_comments.js";

export const documentRevisions = pgTable(
  "document_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    title: text("title"),
    format: text("format").notNull().default("markdown"),
    body: text("body").notNull(),
    changeSummary: text("change_summary"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    createdByRunId: uuid("created_by_run_id").references(() => taskExecutionRuns.id, { onDelete: "set null" }),
    sourceTaskCommentId: uuid("source_task_comment_id").references(() => taskComments.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentRevisionUq: uniqueIndex("document_revisions_document_revision_uq").on(
      table.documentId,
      table.revisionNumber,
    ),
    companyDocumentCreatedIdx: index("document_revisions_company_document_created_idx").on(
      table.companyId,
      table.documentId,
      table.createdAt,
    ),
    sourceTaskCommentUq: uniqueIndex("document_revisions_source_task_comment_uq").on(
      table.sourceTaskCommentId,
    ),
  }),
);
