import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { taskComments } from "./task_comments.js";
import {
  taskSessionMessages,
  taskSessions,
} from "./task_sessions.js";
import { taskExecutionRuns } from "./task_execution_runs.js";

export const taskCommentProjectionSources = pgTable(
  "task_comment_projection_sources",
  {
    commentId: uuid("comment_id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    sessionId: text("session_id").notNull(),
    sourceKind: text("source_kind")
      .$type<
        | "task_request"
        | "human_comment"
        | "harness_delivery"
        | "system_control"
        | "run_output"
        | "run_progress"
        | "task_update"
        | "plugin_withdrawal"
      >()
      .notNull(),
    sourceId: text("source_id").notNull(),
    messageId: text("message_id").notNull(),
    runId: uuid("run_id"),
    replyToCommentId: uuid("reply_to_comment_id"),
    replyToProjectedEventSeq: bigint("reply_to_projected_event_seq", {
      mode: "number",
    }),
    threadRootCommentId: uuid("thread_root_comment_id"),
    threadRootProjectedEventSeq: bigint("thread_root_projected_event_seq", {
      mode: "number",
    }),
    terminalSessionMessageId: text("terminal_session_message_id"),
    admittedEventSeq: bigint("admitted_event_seq", { mode: "number" }),
    promotedEventSeq: bigint("promoted_event_seq", { mode: "number" }),
    projectedEventSeq: bigint("projected_event_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "task_comment_projection_sources_kind_check",
      sql`${table.sourceKind} in (
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
    check(
      "task_comment_projection_sources_run_check",
      sql`(
        ${table.sourceKind} in ('run_output', 'run_progress')
        and ${table.runId} is not null
      ) or (
        ${table.sourceKind} not in ('run_output', 'run_progress')
      )`,
    ),
    check(
      "task_comment_projection_sources_reply_shape_check",
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
      "task_comment_projection_sources_reply_order_check",
      sql`${table.replyToProjectedEventSeq} is null
        or ${table.replyToProjectedEventSeq} < ${table.projectedEventSeq}`,
    ),
    check(
      "task_comment_projection_sources_terminal_dependency_check",
      sql`${table.terminalSessionMessageId} is null
        or ${table.sourceKind} = 'run_progress'`,
    ),
    check(
      "task_comment_projection_sources_sequence_check",
      sql`(${table.admittedEventSeq} is null
          or ${table.projectedEventSeq} = ${table.admittedEventSeq})
        and (
          ${table.promotedEventSeq} is null
          or ${table.admittedEventSeq} is null
          or ${table.promotedEventSeq} >= ${table.admittedEventSeq}
        )`,
    ),
    foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId],
      foreignColumns: [taskSessions.companyId, taskSessions.taskId, taskSessions.id],
      name: "task_comment_projection_sources_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId, table.runId],
      foreignColumns: [
        taskExecutionRuns.companyId,
        taskExecutionRuns.taskId,
        taskExecutionRuns.sessionId,
        taskExecutionRuns.id,
      ],
      name: "task_comment_projection_sources_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.commentId,
        table.projectedEventSeq,
      ],
      foreignColumns: [
        taskComments.companyId,
        taskComments.taskId,
        taskComments.id,
        taskComments.projectedEventSeq,
      ],
      name: "task_comment_projection_sources_comment_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.replyToCommentId,
        table.replyToProjectedEventSeq,
      ],
      foreignColumns: [
        taskComments.companyId,
        taskComments.taskId,
        taskComments.id,
        taskComments.projectedEventSeq,
      ],
      name: "task_comment_projection_sources_reply_parent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.threadRootCommentId,
        table.threadRootProjectedEventSeq,
      ],
      foreignColumns: [
        taskComments.companyId,
        taskComments.taskId,
        taskComments.id,
        taskComments.projectedEventSeq,
      ],
      name: "task_comment_projection_sources_thread_root_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.sessionId,
        table.terminalSessionMessageId,
      ],
      foreignColumns: [
        taskSessionMessages.companyId,
        taskSessionMessages.taskId,
        taskSessionMessages.sessionId,
        taskSessionMessages.id,
      ],
      name: "task_comment_projection_sources_terminal_message_fk",
    }).onDelete("restrict"),
    uniqueIndex("task_comment_projection_sources_source_uq").on(
      table.sessionId,
      table.sourceKind,
      table.sourceId,
    ),
    uniqueIndex("task_comment_projection_sources_message_uq").on(
      table.sessionId,
      table.messageId,
    ),
    uniqueIndex("task_comment_projection_sources_run_progress_uq")
      .on(table.companyId, table.taskId, table.runId, table.sourceKind)
      .where(sql`${table.sourceKind} = 'run_progress'`),
    index("task_comment_projection_sources_event_idx").on(
      table.sessionId,
      table.projectedEventSeq,
    ),
    index("task_comment_projection_sources_run_idx").on(
      table.companyId,
      table.runId,
    ),
  ],
);
