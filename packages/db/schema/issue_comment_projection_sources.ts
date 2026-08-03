import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { issueComments } from "./issue_comments.js";
import {
  issueSessionMessages,
  issueSessions,
} from "./issue_sessions.js";
import {
  issueExecutionPromptSegments,
  issueExecutionRuns,
} from "./issue_execution_runs.js";

export const issueCommentProjectionSources = pgTable(
  "issue_comment_projection_sources",
  {
    commentId: uuid("comment_id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    sourceKind: text("source_kind")
      .$type<
        | "issue_request"
        | "human_comment"
        | "harness_delivery"
        | "system_control"
        | "run_output"
        | "run_progress"
        | "issue_update"
        | "plugin_withdrawal"
      >()
      .notNull(),
    sourceId: text("source_id").notNull(),
    messageId: text("message_id").notNull(),
    runId: uuid("run_id"),
    steeringTargetRunId: uuid("steering_target_run_id"),
    replyToCommentId: uuid("reply_to_comment_id"),
    replyToProjectedEventSeq: bigint("reply_to_projected_event_seq", {
      mode: "number",
    }),
    threadRootCommentId: uuid("thread_root_comment_id"),
    threadRootProjectedEventSeq: bigint("thread_root_projected_event_seq", {
      mode: "number",
    }),
    refId: uuid("ref_id"),
    refOrdinal: integer("ref_ordinal"),
    segmentOrdinal: integer("segment_ordinal"),
    terminalSessionMessageId: text("terminal_session_message_id"),
    admittedEventSeq: bigint("admitted_event_seq", { mode: "number" }),
    promotedEventSeq: bigint("promoted_event_seq", { mode: "number" }),
    projectedEventSeq: bigint("projected_event_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "issue_comment_projection_sources_kind_check",
      sql`${table.sourceKind} in (
        'issue_request',
        'human_comment',
        'harness_delivery',
        'system_control',
        'run_output',
        'run_progress',
        'issue_update',
        'plugin_withdrawal'
      )`,
    ),
    check(
      "issue_comment_projection_sources_run_check",
      sql`(
        ${table.sourceKind} in ('run_output', 'run_progress')
        and ${table.runId} is not null
      ) or (
        ${table.sourceKind} not in ('run_output', 'run_progress')
      )`,
    ),
    check(
      "issue_comment_projection_sources_reply_shape_check",
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
    check(
      "issue_comment_projection_sources_reply_order_check",
      sql`${table.replyToProjectedEventSeq} is null
        or ${table.replyToProjectedEventSeq} < ${table.projectedEventSeq}`,
    ),
    check(
      "issue_comment_projection_sources_steering_segment_shape_check",
      sql`(
        ${table.steeringTargetRunId} is null
        and ${table.refId} is null
        and ${table.refOrdinal} is null
        and ${table.segmentOrdinal} is null
      ) or (
        ${table.steeringTargetRunId} is not null
        and ${table.refId} is not null
        and ${table.refOrdinal} is not null
        and ${table.refOrdinal} >= 0
        and ${table.segmentOrdinal} is not null
        and ${table.segmentOrdinal} > 0
      )`,
    ),
    check(
      "issue_comment_projection_sources_terminal_dependency_check",
      sql`${table.terminalSessionMessageId} is null
        or ${table.sourceKind} = 'run_progress'`,
    ),
    check(
      "issue_comment_projection_sources_sequence_check",
      sql`(${table.admittedEventSeq} is null
          or ${table.projectedEventSeq} = ${table.admittedEventSeq})
        and (
          ${table.promotedEventSeq} is null
          or ${table.admittedEventSeq} is null
          or ${table.promotedEventSeq} >= ${table.admittedEventSeq}
        )`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_comment_projection_sources_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId, table.runId],
      foreignColumns: [
        issueExecutionRuns.companyId,
        issueExecutionRuns.issueId,
        issueExecutionRuns.sessionId,
        issueExecutionRuns.id,
      ],
      name: "issue_comment_projection_sources_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.commentId,
        table.projectedEventSeq,
      ],
      foreignColumns: [
        issueComments.companyId,
        issueComments.issueId,
        issueComments.id,
        issueComments.projectedEventSeq,
      ],
      name: "issue_comment_projection_sources_comment_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.replyToCommentId,
        table.replyToProjectedEventSeq,
      ],
      foreignColumns: [
        issueComments.companyId,
        issueComments.issueId,
        issueComments.id,
        issueComments.projectedEventSeq,
      ],
      name: "issue_comment_projection_sources_reply_parent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.threadRootCommentId,
        table.threadRootProjectedEventSeq,
      ],
      foreignColumns: [
        issueComments.companyId,
        issueComments.issueId,
        issueComments.id,
        issueComments.projectedEventSeq,
      ],
      name: "issue_comment_projection_sources_thread_root_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sessionId,
        table.steeringTargetRunId,
        table.refOrdinal,
        table.refId,
        table.segmentOrdinal,
      ],
      foreignColumns: [
        issueExecutionPromptSegments.companyId,
        issueExecutionPromptSegments.issueId,
        issueExecutionPromptSegments.sessionId,
        issueExecutionPromptSegments.runId,
        issueExecutionPromptSegments.refOrdinal,
        issueExecutionPromptSegments.refId,
        issueExecutionPromptSegments.segmentOrdinal,
      ],
      name: "issue_comment_projection_sources_steering_segment_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sessionId,
        table.terminalSessionMessageId,
      ],
      foreignColumns: [
        issueSessionMessages.companyId,
        issueSessionMessages.issueId,
        issueSessionMessages.sessionId,
        issueSessionMessages.id,
      ],
      name: "issue_comment_projection_sources_terminal_message_fk",
    }).onDelete("restrict"),
    uniqueIndex("issue_comment_projection_sources_source_uq").on(
      table.sessionId,
      table.sourceKind,
      table.sourceId,
    ),
    uniqueIndex("issue_comment_projection_sources_message_uq").on(
      table.sessionId,
      table.messageId,
    ),
    uniqueIndex("issue_comment_projection_sources_run_progress_uq")
      .on(table.companyId, table.issueId, table.runId, table.sourceKind)
      .where(sql`${table.sourceKind} = 'run_progress'`),
    index("issue_comment_projection_sources_event_idx").on(
      table.sessionId,
      table.projectedEventSeq,
    ),
    index("issue_comment_projection_sources_run_idx").on(
      table.companyId,
      table.runId,
    ),
  ],
);
