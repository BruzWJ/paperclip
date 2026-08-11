import type {
  DocumentAnnotationAnchorConfidence,
  DocumentAnnotationAnchorSelector,
  DocumentAnnotationAnchorState,
  DocumentAnnotationThreadStatus,
} from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { documentRevisions } from "./document_revisions.js";
import { documents } from "./documents.js";
import { tasks } from "./tasks.js";
import { routines } from "./routines.js";

export const documentAnnotationThreads = pgTable(
  "document_annotation_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id").references(() => routines.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    documentKey: text("document_key").notNull(),
    status: text("status").$type<DocumentAnnotationThreadStatus>().notNull().default("open"),
    anchorState: text("anchor_state").$type<DocumentAnnotationAnchorState>().notNull().default("active"),
    originalRevisionId: uuid("original_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    originalRevisionNumber: integer("original_revision_number").notNull(),
    currentRevisionId: uuid("current_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    currentRevisionNumber: integer("current_revision_number").notNull(),
    selectedText: text("selected_text").notNull(),
    prefixText: text("prefix_text").notNull().default(""),
    suffixText: text("suffix_text").notNull().default(""),
    normalizedStart: integer("normalized_start").notNull(),
    normalizedEnd: integer("normalized_end").notNull(),
    markdownStart: integer("markdown_start").notNull(),
    markdownEnd: integer("markdown_end").notNull(),
    anchorConfidence: text("anchor_confidence")
      .$type<DocumentAnnotationAnchorConfidence>()
      .notNull()
      .default("exact"),
    anchorSelector: jsonb("anchor_selector").$type<DocumentAnnotationAnchorSelector>().notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    resolvedByAgentId: uuid("resolved_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    resolvedByUserId: text("resolved_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDocumentStatusIdx: index("document_annotation_threads_company_document_status_idx").on(
      table.companyId,
      table.documentId,
      table.status,
    ),
    companyTaskStatusIdx: index("document_annotation_threads_company_task_status_idx").on(
      table.companyId,
      table.taskId,
      table.status,
    ),
    companyRoutineStatusIdx: index("document_annotation_threads_company_routine_status_idx").on(
      table.companyId,
      table.routineId,
      table.status,
    ),
    companyCurrentRevisionOpenIdx: index("document_annotation_threads_company_current_revision_open_idx").on(
      table.companyId,
      table.documentId,
      table.currentRevisionId,
      table.status,
    ),
    companyAnchorStateIdx: index("document_annotation_threads_company_anchor_state_idx").on(
      table.companyId,
      table.anchorState,
    ),
    exactlyOneOwnerChk: check(
      "document_annotation_threads_exactly_one_owner_chk",
      sql`num_nonnulls(${table.taskId}, ${table.routineId}) = 1`,
    ),
  }),
);
