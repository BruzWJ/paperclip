import type {
  AgentLivenessActionKind,
  AgentLivenessAttentionReason,
  IssueExecutionRefMode,
} from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { issueComments } from "./issue_comments.js";
import { issueCreatorEdgeReceivability } from "./issue_creator_edge.js";
import {
  issueExecutionFinalizations,
  issueExecutionRuns,
} from "./issue_execution_runs.js";
import { issueExecutionRefs } from "./issue_execution_runtime.js";
import { issues } from "./issues.js";

/**
 * One reference-only post-finalization work item. Processing is driven only by
 * a committed productive/consult finalization; the nullable timestamp is the
 * sole processing marker and deliberately is not an outcome/status machine.
 */
export const issueExecutionFinalizationStaleCheckOutbox = pgTable(
  "issue_execution_finalization_stale_check_outbox",
  {
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    runId: uuid("run_id").notNull(),
    finalizationId: uuid("finalization_id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "issue_execution_finalization_stale_check_outbox_epoch_check",
      sql`${table.ownershipEpoch} > 0`,
    ),
    check(
      "issue_execution_finalization_stale_check_outbox_time_check",
      sql`${table.processedAt} is null
        or ${table.processedAt} >= ${table.createdAt}`,
    ),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.runId,
      ],
      foreignColumns: [
        issueExecutionRuns.companyId,
        issueExecutionRuns.issueId,
        issueExecutionRuns.ownershipEpoch,
        issueExecutionRuns.id,
      ],
      name: "issue_execution_finalization_stale_check_outbox_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.runId, table.finalizationId],
      foreignColumns: [
        issueExecutionFinalizations.companyId,
        issueExecutionFinalizations.runId,
        issueExecutionFinalizations.id,
      ],
      name: "issue_execution_finalization_stale_check_outbox_finalization_fk",
    }).onDelete("cascade"),
    index("issue_execution_finalization_stale_check_outbox_pending_idx")
      .on(table.createdAt, table.finalizationId)
      .where(sql`${table.processedAt} is null`),
  ],
);

/**
 * Durable P15-P17 frontier audit. All mutable columns are closed reference or
 * timestamp facts. There is intentionally no liveness state/status/outcome,
 * prompt text, retry policy, deadline, delivery, or escalation payload here.
 */
export const issueLivenessReconciliations = pgTable(
  "issue_liveness_reconciliations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    frontierFinalizationId: uuid("frontier_finalization_id").notNull(),
    creatorEdgeId: uuid("creator_edge_id").notNull(),
    creatorEdgeAdmissionVersion: integer(
      "creator_edge_admission_version",
    ).notNull(),
    staleTargetAgentId: uuid("stale_target_agent_id").notNull(),
    sourceRunId: uuid("source_run_id").notNull(),
    sourceMode: text("source_mode").$type<IssueExecutionRefMode>().notNull(),
    sourceCommentId: uuid("source_comment_id").notNull(),
    followupSystemReplyCommentId: uuid(
      "followup_system_reply_comment_id",
    ),
    followupRefId: uuid("followup_ref_id"),
    followupRunId: uuid("followup_run_id"),
    followupFinalizationId: uuid("followup_finalization_id"),
    acceptedActionKind: text("accepted_action_kind")
      .$type<AgentLivenessActionKind>(),
    acceptedActionSourceId: text("accepted_action_source_id"),
    acceptedActionCommittedAt: timestamp("accepted_action_committed_at", {
      withTimezone: true,
    }),
    supersededBeforeAttentionAt: timestamp(
      "superseded_before_attention_at",
      { withTimezone: true },
    ),
    boardAttentionEmittedAt: timestamp("board_attention_emitted_at", {
      withTimezone: true,
    }),
    boardAttentionReason: text("board_attention_reason")
      .$type<AgentLivenessAttentionReason>(),
    exitActionKind: text("exit_action_kind").$type<AgentLivenessActionKind>(),
    exitActionSourceId: text("exit_action_source_id"),
    exitActionCommittedAt: timestamp("exit_action_committed_at", {
      withTimezone: true,
    }),
    admittedAt: timestamp("admitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "issue_liveness_reconciliations_epoch_version_check",
      sql`${table.ownershipEpoch} > 0
        and ${table.creatorEdgeAdmissionVersion} > 0`,
    ),
    check(
      "issue_liveness_reconciliations_source_mode_check",
      sql`${table.sourceMode} in ('owner', 'consult')`,
    ),
    check(
      "issue_liveness_reconciliations_followup_chain_check",
      sql`(${table.followupRefId} is null
          or ${table.followupSystemReplyCommentId} is not null)
        and (${table.followupRunId} is null
          or ${table.followupRefId} is not null)
        and (${table.followupFinalizationId} is null
          or ${table.followupRunId} is not null)`,
    ),
    check(
      "issue_liveness_reconciliations_accepted_action_tuple_check",
      sql`(
        ${table.acceptedActionKind} is null
        and ${table.acceptedActionSourceId} is null
        and ${table.acceptedActionCommittedAt} is null
      ) or (
        ${table.acceptedActionKind} is not null
        and ${table.acceptedActionSourceId} is not null
        and length(btrim(${table.acceptedActionSourceId})) between 1 and 500
        and ${table.acceptedActionCommittedAt} is not null
        and ${table.acceptedActionCommittedAt} > ${table.admittedAt}
      )`,
    ),
    check(
      "issue_liveness_reconciliations_accepted_action_kind_check",
      sql`${table.acceptedActionKind} is null or ${table.acceptedActionKind} in (
        'authenticated_human_comment',
        'issue_create_child',
        'mention_agent',
        'mention_board',
        'issue_assign',
        'issue_update',
        'creator_withdrawal',
        'board_lifecycle_command',
        'board_reopen'
      )`,
    ),
    check(
      "issue_liveness_reconciliations_attention_tuple_check",
      sql`(
        ${table.boardAttentionEmittedAt} is null
        and ${table.boardAttentionReason} is null
      ) or (
        ${table.boardAttentionEmittedAt} is not null
        and ${table.boardAttentionEmittedAt} >= ${table.admittedAt}
        and ${table.boardAttentionReason} in (
          'agent_no_action',
          'agent_followup_failed',
          'agent_unavailable'
        )
      )`,
    ),
    check(
      "issue_liveness_reconciliations_supersession_time_check",
      sql`${table.supersededBeforeAttentionAt} is null
        or ${table.supersededBeforeAttentionAt} >= ${table.admittedAt}`,
    ),
    check(
      "issue_liveness_reconciliations_exit_action_tuple_check",
      sql`(
        ${table.exitActionKind} is null
        and ${table.exitActionSourceId} is null
        and ${table.exitActionCommittedAt} is null
      ) or (
        ${table.exitActionKind} is not null
        and ${table.exitActionSourceId} is not null
        and length(btrim(${table.exitActionSourceId})) between 1 and 500
        and ${table.exitActionCommittedAt} is not null
        and ${table.boardAttentionEmittedAt} is not null
        and ${table.exitActionCommittedAt} > ${table.boardAttentionEmittedAt}
      )`,
    ),
    check(
      "issue_liveness_reconciliations_exit_action_kind_check",
      sql`${table.exitActionKind} is null or ${table.exitActionKind} in (
        'authenticated_human_comment',
        'issue_create_child',
        'mention_agent',
        'mention_board',
        'issue_assign',
        'issue_update',
        'creator_withdrawal',
        'board_lifecycle_command',
        'board_reopen'
      )`,
    ),
    check(
      "issue_liveness_reconciliations_initial_settlement_check",
      sql`not (
          ${table.acceptedActionKind} is not null
          and ${table.supersededBeforeAttentionAt} is not null
        )
        and not (
          ${table.acceptedActionKind} is not null
          and ${table.boardAttentionEmittedAt} is not null
        )
        and not (
          ${table.supersededBeforeAttentionAt} is not null
          and ${table.boardAttentionEmittedAt} is not null
        )
        and (
          ${table.followupFinalizationId} is null
          or ${table.acceptedActionKind} is not null
          or ${table.supersededBeforeAttentionAt} is not null
          or ${table.boardAttentionEmittedAt} is not null
        )`,
    ),
    check(
      "issue_liveness_reconciliations_incomplete_followup_check",
      sql`not (
        ${table.followupSystemReplyCommentId} is not null
        and ${table.followupFinalizationId} is null
      ) or (
        ${table.acceptedActionKind} is null
        and ${table.supersededBeforeAttentionAt} is null
        and ${table.boardAttentionEmittedAt} is null
        and ${table.exitActionKind} is null
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "issue_liveness_reconciliations_issue_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.staleTargetAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "issue_liveness_reconciliations_target_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.creatorEdgeId,
        table.creatorEdgeAdmissionVersion,
      ],
      foreignColumns: [
        issueCreatorEdgeReceivability.companyId,
        issueCreatorEdgeReceivability.issueId,
        issueCreatorEdgeReceivability.ownershipEpoch,
        issueCreatorEdgeReceivability.id,
        issueCreatorEdgeReceivability.admissionVersion,
      ],
      name: "issue_liveness_reconciliations_creator_edge_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.sourceRunId,
        table.staleTargetAgentId,
        table.sourceMode,
      ],
      foreignColumns: [
        issueExecutionRuns.companyId,
        issueExecutionRuns.issueId,
        issueExecutionRuns.ownershipEpoch,
        issueExecutionRuns.id,
        issueExecutionRuns.targetAgentId,
        issueExecutionRuns.executionMode,
      ],
      name: "issue_liveness_reconciliations_source_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.sourceRunId,
        table.frontierFinalizationId,
      ],
      foreignColumns: [
        issueExecutionFinalizations.companyId,
        issueExecutionFinalizations.runId,
        issueExecutionFinalizations.id,
      ],
      name: "issue_liveness_reconciliations_frontier_finalization_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sourceRunId,
        table.sourceCommentId,
      ],
      foreignColumns: [
        issueComments.companyId,
        issueComments.issueId,
        issueComments.runId,
        issueComments.id,
      ],
      name: "issue_liveness_reconciliations_source_comment_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.followupSystemReplyCommentId,
        table.sourceCommentId,
      ],
      foreignColumns: [
        issueComments.companyId,
        issueComments.issueId,
        issueComments.id,
        issueComments.replyToCommentId,
      ],
      name: "issue_liveness_reconciliations_followup_reply_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.followupRefId,
        table.staleTargetAgentId,
        table.sourceMode,
      ],
      foreignColumns: [
        issueExecutionRefs.companyId,
        issueExecutionRefs.issueId,
        issueExecutionRefs.ownershipEpoch,
        issueExecutionRefs.id,
        issueExecutionRefs.targetAgentId,
        issueExecutionRefs.mode,
      ],
      name: "issue_liveness_reconciliations_followup_ref_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.followupRunId,
        table.staleTargetAgentId,
        table.sourceMode,
      ],
      foreignColumns: [
        issueExecutionRuns.companyId,
        issueExecutionRuns.issueId,
        issueExecutionRuns.ownershipEpoch,
        issueExecutionRuns.id,
        issueExecutionRuns.targetAgentId,
        issueExecutionRuns.executionMode,
      ],
      name: "issue_liveness_reconciliations_followup_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.followupRunId,
        table.followupFinalizationId,
      ],
      foreignColumns: [
        issueExecutionFinalizations.companyId,
        issueExecutionFinalizations.runId,
        issueExecutionFinalizations.id,
      ],
      name: "issue_liveness_reconciliations_followup_finalization_fk",
    }).onDelete("restrict"),
    unique("issue_liveness_reconciliations_frontier_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.frontierFinalizationId,
    ),
    uniqueIndex("issue_liveness_reconciliations_followup_comment_uq")
      .on(table.followupSystemReplyCommentId)
      .where(sql`${table.followupSystemReplyCommentId} is not null`),
    uniqueIndex("issue_liveness_reconciliations_followup_ref_uq")
      .on(table.followupRefId)
      .where(sql`${table.followupRefId} is not null`),
    uniqueIndex("issue_liveness_reconciliations_followup_run_uq")
      .on(table.followupRunId)
      .where(sql`${table.followupRunId} is not null`),
    uniqueIndex("issue_liveness_reconciliations_followup_finalization_uq")
      .on(table.followupFinalizationId)
      .where(sql`${table.followupFinalizationId} is not null`),
    index("issue_liveness_reconciliations_attention_idx").on(
      table.companyId,
      table.boardAttentionEmittedAt,
      table.exitActionCommittedAt,
    ),
  ],
);

export type IssueExecutionFinalizationStaleCheckOutboxRow =
  typeof issueExecutionFinalizationStaleCheckOutbox.$inferSelect;
export type NewIssueExecutionFinalizationStaleCheckOutboxRow =
  typeof issueExecutionFinalizationStaleCheckOutbox.$inferInsert;
export type IssueLivenessReconciliation =
  typeof issueLivenessReconciliations.$inferSelect;
export type NewIssueLivenessReconciliation =
  typeof issueLivenessReconciliations.$inferInsert;
