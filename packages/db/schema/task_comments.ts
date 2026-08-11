import type {
  TaskCommentAuthorType,
  TaskCommentMetadata,
  TaskCommentPresentation,
  SourceTrustMetadata,
} from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  jsonb,
  unique,
  type PgTableExtraConfig,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { taskSessions } from "./task_sessions.js";
import { taskExecutionRuns } from "./task_execution_runs.js";

export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    authorAgentId: uuid("author_agent_id"),
    authorUserId: text("author_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    /** Immutable actor identity; intentionally not a live installation FK. */
    authorPluginInstallationId: uuid("author_plugin_installation_id"),
    authorPluginKey: text("author_plugin_key"),
    authorType: text("author_type")
      .$type<TaskCommentAuthorType>()
      .notNull(),
    runId: uuid("run_id"),
    sessionId: text("session_id").notNull(),
    canonicalSourceKind: text("canonical_source_kind").notNull(),
    canonicalSourceId: text("canonical_source_id").notNull(),
    canonicalMessageId: text("canonical_message_id").notNull(),
    admittedEventSeq: bigint("admitted_event_seq", {
      mode: "number",
    }).notNull(),
    promotedEventSeq: bigint("promoted_event_seq", { mode: "number" }),
    projectedEventSeq: bigint("projected_event_seq", {
      mode: "number",
    }).notNull(),
    replyToCommentId: uuid("reply_to_comment_id"),
    replyToProjectedEventSeq: bigint("reply_to_projected_event_seq", {
      mode: "number",
    }),
    threadRootCommentId: uuid("thread_root_comment_id"),
    threadRootProjectedEventSeq: bigint("thread_root_projected_event_seq", {
      mode: "number",
    }),
    body: text("body").notNull(),
    presentation: jsonb("presentation").$type<TaskCommentPresentation | null>(),
    metadata: jsonb("metadata").$type<TaskCommentMetadata | null>(),
    sourceTrust: jsonb("source_trust").$type<SourceTrustMetadata | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfig => ({
    taskIdx: index("task_comments_task_idx").on(table.taskId),
    companyIdx: index("task_comments_company_idx").on(table.companyId),
    companyTaskCreatedAtIdx: index("task_comments_company_task_created_at_idx").on(
      table.companyId,
      table.taskId,
      table.createdAt,
    ),
    companyAuthorTaskCreatedAtIdx: index("task_comments_company_author_task_created_at_idx").on(
      table.companyId,
      table.authorUserId,
      table.taskId,
      table.createdAt,
    ),
    bodySearchIdx: index("task_comments_body_search_idx").using("gin", table.body.op("gin_trgm_ops")),
    canonicalSourceKindCheck: check(
      "task_comments_canonical_source_kind_check",
      sql`${table.canonicalSourceKind} in (
        'task_request',
        'human_comment',
        'harness_delivery',
        'system_control',
        'run_output',
        'run_progress',
        'task_update',
        'plugin_withdrawal'
      )`,
    ),
    authorShapeCheck: check(
      "task_comments_author_shape_check",
      sql`(
        ${table.authorType} = 'agent'
        and ${table.authorAgentId} is not null
        and ${table.authorUserId} is null
        and ${table.authorPluginInstallationId} is null
        and ${table.authorPluginKey} is null
      ) or (
        ${table.authorType} = 'user'
        and ${table.authorAgentId} is null
        and ${table.authorUserId} is not null
        and ${table.authorPluginInstallationId} is null
        and ${table.authorPluginKey} is null
      ) or (
        ${table.authorType} = 'plugin'
        and ${table.authorAgentId} is null
        and ${table.authorUserId} is null
        and ${table.authorPluginInstallationId} is not null
        and ${table.authorPluginKey} is not null
      ) or (
        ${table.authorType} = 'system'
        and ${table.authorAgentId} is null
        and ${table.authorUserId} is null
        and ${table.authorPluginInstallationId} is null
        and ${table.authorPluginKey} is null
      )`,
    ),
    runShapeCheck: check(
      "task_comments_run_shape_check",
      sql`(
        ${table.authorType} = 'agent'
        and ${table.runId} is not null
      ) or (
        ${table.authorType} in ('user', 'plugin', 'system')
        and ${table.runId} is null
      )`,
    ),
    replyShapeCheck: check(
      "task_comments_reply_shape_check",
      sql`(
        ${table.replyToCommentId} is null
        and ${table.replyToProjectedEventSeq} is null
        and ${table.threadRootCommentId} is null
        and ${table.threadRootProjectedEventSeq} is null
      ) or (
        ${table.replyToCommentId} is not null
        and ${table.replyToProjectedEventSeq} is not null
        and ${table.threadRootCommentId} is not null
        and ${table.threadRootProjectedEventSeq} is not null
      )`,
    ),
    replyOrderCheck: check(
      "task_comments_reply_order_check",
      sql`${table.replyToProjectedEventSeq} is null
        or ${table.replyToProjectedEventSeq} < ${table.projectedEventSeq}`,
    ),
    canonicalProjectionSequenceCheck: check(
      "task_comments_canonical_projection_sequence_check",
      sql`${table.projectedEventSeq} = ${table.admittedEventSeq}
        and (
          ${table.promotedEventSeq} is null
          or ${table.promotedEventSeq} >= ${table.admittedEventSeq}
        )`,
    ),
    authorAgentScopeFk: foreignKey({
      columns: [table.companyId, table.authorAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "task_comments_author_agent_scope_fk",
    }).onDelete("restrict"),
    runScopeFk: foreignKey({
      columns: [table.companyId, table.taskId, table.runId],
      foreignColumns: [
        taskExecutionRuns.companyId,
        taskExecutionRuns.taskId,
        taskExecutionRuns.id,
      ],
      name: "task_comments_run_scope_fk",
    }).onDelete("restrict"),
    sessionScopeFk: foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId],
      foreignColumns: [
        taskSessions.companyId,
        taskSessions.taskId,
        taskSessions.id,
      ],
      name: "task_comments_session_scope_fk",
    }).onDelete("cascade"),
    projectedIdentityUq: unique("task_comments_projected_identity_uq").on(
      table.companyId,
      table.taskId,
      table.id,
      table.projectedEventSeq,
    ),
    scopeIdentityUq: unique("task_comments_scope_identity_uq").on(
      table.companyId,
      table.taskId,
      table.id,
    ),
    runIdentityUq: unique("task_comments_run_identity_uq").on(
      table.companyId,
      table.taskId,
      table.runId,
      table.id,
    ),
    replyIdentityUq: unique("task_comments_reply_identity_uq").on(
      table.companyId,
      table.taskId,
      table.id,
      table.replyToCommentId,
    ),
    replyParentFk: foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.replyToCommentId,
        table.replyToProjectedEventSeq,
      ],
      foreignColumns: [
        table.companyId,
        table.taskId,
        table.id,
        table.projectedEventSeq,
      ],
      name: "task_comments_reply_parent_fk",
    }).onDelete("restrict"),
    threadRootFk: foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.threadRootCommentId,
        table.threadRootProjectedEventSeq,
      ],
      foreignColumns: [
        table.companyId,
        table.taskId,
        table.id,
        table.projectedEventSeq,
      ],
      name: "task_comments_thread_root_fk",
    }).onDelete("restrict"),
  }),
);
