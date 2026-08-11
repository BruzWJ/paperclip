import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  IssueExecutionRefDisposition,
  IssueExecutionRefMessageKind,
  IssueExecutionRefMode,
  IssueExecutionRefSourceKind,
} from "@paperclipai/shared";
import { agentAdapterConfigRevisions } from "./agent_adapter_config_revisions.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { issueExecutionRuns } from "./issue_execution_runs.js";
import { issues } from "./issues.js";
import { issueSessionMessages, issueSessions } from "./issue_sessions.js";

export const issueExecutionAuthorities = pgTable(
  "issue_execution_authorities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    agentId: uuid("agent_id").notNull(),
    auditAdapterConfigRevisionId: uuid("audit_adapter_config_revision_id").notNull(),
    state: text("state").$type<"current" | "revoked">().notNull().default("current"),
    revocationReason: text("revocation_reason"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "issue_execution_authorities_state_check",
      sql`${table.state} in ('current', 'revoked')`,
    ),
    check(
      "issue_execution_authorities_revocation_check",
      sql`(
        ${table.state} = 'current'
        and ${table.revocationReason} is null
        and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'revoked'
        and ${table.revocationReason} is not null
        and ${table.revokedAt} is not null
      )`,
    ),
    check(
      "issue_execution_authorities_epoch_check",
      sql`${table.ownershipEpoch} > 0`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_execution_authorities_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "issue_execution_authorities_company_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.agentId,
        table.auditAdapterConfigRevisionId,
      ],
      foreignColumns: [
        agentAdapterConfigRevisions.companyId,
        agentAdapterConfigRevisions.agentId,
        agentAdapterConfigRevisions.id,
      ],
      name: "issue_execution_authorities_adapter_revision_fk",
    }).onDelete("restrict"),
    unique("issue_execution_authorities_scope_id_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.agentId,
      table.id,
    ),
    unique("issue_execution_authorities_company_issue_id_uq").on(
      table.companyId,
      table.issueId,
      table.id,
    ),
    unique("issue_execution_authorities_company_id_uq").on(
      table.companyId,
      table.id,
    ),
    uniqueIndex("issue_execution_authorities_identity_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.agentId,
    ),
    index("issue_execution_authorities_current_idx").on(
      table.companyId,
      table.issueId,
      table.state,
    ),
    index("issue_execution_authorities_agent_state_idx").on(
      table.companyId,
      table.agentId,
      table.state,
    ),
  ],
);

export const issueConsultExecutions = pgTable(
  "issue_consult_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    sourceRunId: uuid("source_run_id").notNull(),
    sourceRefId: uuid("source_ref_id").notNull(),
    callerExecutionScopeId: uuid("caller_execution_scope_id").notNull(),
    targetAgentId: uuid("target_agent_id").notNull(),
    adapterConfigRevisionId: uuid("adapter_config_revision_id").notNull(),
    chainToken: text("chain_token").notNull(),
    state: text("state")
      .$type<"active" | "completed" | "cancelled" | "revoked">()
      .notNull()
      .default("active"),
    closeReason: text("close_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "issue_consult_executions_state_check",
      sql`${table.state} in ('active', 'completed', 'cancelled', 'revoked')`,
    ),
    check(
      "issue_consult_executions_close_check",
      sql`(
        ${table.state} = 'active'
        and ${table.closedAt} is null
        and ${table.closeReason} is null
      ) or (
        ${table.state} <> 'active'
        and ${table.closedAt} is not null
        and ${table.closeReason} is not null
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_consult_executions_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.sourceRunId],
      foreignColumns: [issueExecutionRuns.companyId, issueExecutionRuns.id],
      name: "issue_consult_executions_source_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.targetAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "issue_consult_executions_target_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.targetAgentId,
        table.adapterConfigRevisionId,
      ],
      foreignColumns: [
        agentAdapterConfigRevisions.companyId,
        agentAdapterConfigRevisions.agentId,
        agentAdapterConfigRevisions.id,
      ],
      name: "issue_consult_executions_adapter_revision_fk",
    }).onDelete("restrict"),
    unique("issue_consult_executions_scope_id_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
      table.id,
    ),
    unique("issue_consult_executions_lane_identity_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.targetAgentId,
      table.id,
    ),
    index("issue_consult_executions_active_idx").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.state,
    ),
    index("issue_consult_executions_source_run_idx").on(table.sourceRunId),
  ],
);

/**
 * The one durable same-target FIFO for an issue ownership epoch. Mode and
 * native-session correlation deliberately remain properties of each admitted
 * ref; they never split or duplicate this queue.
 */
export const issueExecutionLanes = pgTable(
  "issue_execution_lanes",
  {
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    targetAgentId: uuid("target_agent_id").notNull(),
    nextOrdinal: bigint("next_ordinal", { mode: "number" })
      .notNull()
      .default(0),
    activeOrdinal: bigint("active_ordinal", { mode: "number" }),
    activeLeaseGeneration: integer("active_lease_generation"),
    activeLeaseId: uuid("active_lease_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.targetAgentId,
      ],
      name: "issue_execution_lanes_pk",
    }),
    check(
      "issue_execution_lanes_epoch_check",
      sql`${table.ownershipEpoch} > 0`,
    ),
    check(
      "issue_execution_lanes_ordinal_check",
      sql`${table.nextOrdinal} between 0 and 9007199254740991
        and (
          ${table.activeOrdinal} is null
          or (
            ${table.activeOrdinal} between 0 and 9007199254740991
            and ${table.activeOrdinal} < ${table.nextOrdinal}
          )
        )`,
    ),
    check(
      "issue_execution_lanes_active_lease_check",
      sql`(
        ${table.activeOrdinal} is null
        and ${table.activeLeaseGeneration} is null
        and ${table.activeLeaseId} is null
      ) or (
        ${table.activeOrdinal} is not null
        and ${table.activeLeaseGeneration} is not null
        and ${table.activeLeaseGeneration} > 0
        and ${table.activeLeaseId} is not null
      )`,
    ),
    check(
      "issue_execution_lanes_time_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "issue_execution_lanes_issue_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.targetAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "issue_execution_lanes_target_agent_fk",
    }).onDelete("restrict"),
    index("issue_execution_lanes_active_idx").on(
      table.companyId,
      table.activeOrdinal,
    ),
    uniqueIndex("issue_execution_lanes_active_lease_uq")
      .on(table.activeLeaseId)
      .where(sql`${table.activeLeaseId} is not null`),
  ],
);

export const issueExecutionRefs = pgTable(
  "issue_execution_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    /**
     * Immutable outgoing epoch for a reassignment-created ref. Other sources
     * have no previous-epoch interpretation.
     */
    previousOwnershipEpoch: integer("previous_ownership_epoch"),
    executionScopeId: uuid("execution_scope_id").notNull(),
    executionLineageId: uuid("execution_lineage_id").notNull(),
    mode: text("mode").$type<IssueExecutionRefMode>().notNull(),
    sourceKind: text("source_kind").$type<IssueExecutionRefSourceKind>().notNull(),
    sourceId: text("source_id").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    messageKind: text("message_kind").$type<IssueExecutionRefMessageKind>().notNull(),
    sourceMessageId: text("source_message_id").notNull(),
    exactMessage: text("exact_message").notNull(),
    deliveryIdempotencyKey: text("delivery_idempotency_key").notNull(),
    targetAgentId: uuid("target_agent_id").notNull(),
    laneOrdinal: bigint("lane_ordinal", { mode: "number" }).notNull(),
    issueExecutionAuthorityId: uuid("issue_execution_authority_id"),
    consultExecutionId: uuid("consult_execution_id"),
    adapterConfigRevisionId: uuid("adapter_config_revision_id").notNull(),
    contextEpoch: integer("context_epoch").notNull(),
    historyViewId: uuid("history_view_id").notNull(),
    admissionHighWaterSeq: bigint("admission_high_water_seq", { mode: "number" })
      .notNull(),
    inputId: text("input_id"),
    admittedSeq: bigint("admitted_seq", { mode: "number" }),
    promotedSeq: bigint("promoted_seq", { mode: "number" }),
    counterpartIssueId: uuid("counterpart_issue_id"),
    counterpartAuthorityId: uuid("counterpart_authority_id"),
    counterpartOwnershipEpoch: integer("counterpart_ownership_epoch"),
    consultCallerRefId: uuid("consult_caller_ref_id"),
    consultChainToken: text("consult_chain_token"),
    disposition: text("disposition")
      .$type<IssueExecutionRefDisposition>()
      .notNull()
      .default("active"),
    invalidationReason: text("invalidation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "issue_execution_refs_mode_check",
      sql`${table.mode} in ('owner', 'consult')`,
    ),
    check(
      "issue_execution_refs_source_kind_check",
      sql`${table.sourceKind} in (
        'issue_request',
        'issue_reassignment',
        'issue_reopen',
        'human_comment_mention',
        'routine_dispatch',
        'issue_update',
        'consult_mention',
        'system_nudge'
      )`,
    ),
    check(
      "issue_execution_refs_previous_epoch_check",
      sql`(
        ${table.sourceKind} = 'issue_reassignment'
        and ${table.previousOwnershipEpoch} > 0
        and ${table.previousOwnershipEpoch} = ${table.ownershipEpoch} - 1
      ) or (
        ${table.sourceKind} <> 'issue_reassignment'
        and ${table.previousOwnershipEpoch} is null
      )`,
    ),
    check(
      "issue_execution_refs_message_kind_check",
      sql`${table.messageKind} in ('user', 'synthetic')`,
    ),
    check(
      "issue_execution_refs_message_input_shape_check",
      sql`(
        ${table.messageKind} = 'user'
        and ${table.inputId} is not null
        and ${table.admittedSeq} is not null
        and ${table.admittedSeq} between 0 and 9007199254740991
        and (
          ${table.promotedSeq} is null
          or ${table.promotedSeq} between ${table.admittedSeq} and 9007199254740991
        )
      ) or (
        ${table.messageKind} = 'synthetic'
        and ${table.inputId} is null
        and ${table.admittedSeq} is null
        and ${table.promotedSeq} is null
      )`,
    ),
    check(
      "issue_execution_refs_disposition_check",
      sql`${table.disposition} in ('active', 'invalidated', 'terminal')`,
    ),
    check(
      "issue_execution_refs_lane_ordinal_check",
      sql`${table.laneOrdinal} between 0 and 9007199254740991`,
    ),
    check(
      "issue_execution_refs_mode_binding_check",
      sql`(
        ${table.mode} = 'owner'
        and ${table.issueExecutionAuthorityId} is not null
        and ${table.consultExecutionId} is null
      ) or (
        ${table.mode} = 'consult'
        and ${table.issueExecutionAuthorityId} is null
        and ${table.consultExecutionId} is not null
      )`,
    ),
    check(
      "issue_execution_refs_counterpart_check",
      sql`(
        ${table.counterpartIssueId} is null
        and ${table.counterpartAuthorityId} is null
        and ${table.counterpartOwnershipEpoch} is null
      ) or (
        ${table.counterpartIssueId} is not null
        and ${table.counterpartAuthorityId} is not null
        and ${table.counterpartOwnershipEpoch} is not null
      )`,
    ),
    check(
      "issue_execution_refs_consult_chain_check",
      sql`(
        ${table.mode} = 'owner'
        and ${table.consultCallerRefId} is null
        and ${table.consultChainToken} is null
      ) or (
        ${table.mode} = 'consult'
        and ${table.consultCallerRefId} is not null
        and ${table.consultChainToken} is not null
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_execution_refs_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.targetAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "issue_execution_refs_target_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.targetAgentId, table.adapterConfigRevisionId],
      foreignColumns: [
        agentAdapterConfigRevisions.companyId,
        agentAdapterConfigRevisions.agentId,
        agentAdapterConfigRevisions.id,
      ],
      name: "issue_execution_refs_adapter_revision_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.targetAgentId,
      ],
      foreignColumns: [
        issueExecutionLanes.companyId,
        issueExecutionLanes.issueId,
        issueExecutionLanes.ownershipEpoch,
        issueExecutionLanes.targetAgentId,
      ],
      name: "issue_execution_refs_lane_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.targetAgentId,
        table.issueExecutionAuthorityId,
      ],
      foreignColumns: [
        issueExecutionAuthorities.companyId,
        issueExecutionAuthorities.issueId,
        issueExecutionAuthorities.ownershipEpoch,
        issueExecutionAuthorities.agentId,
        issueExecutionAuthorities.id,
      ],
      name: "issue_execution_refs_authority_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sessionId,
        table.consultExecutionId,
      ],
      foreignColumns: [
        issueConsultExecutions.companyId,
        issueConsultExecutions.issueId,
        issueConsultExecutions.sessionId,
        issueConsultExecutions.id,
      ],
      name: "issue_execution_refs_consult_fk",
    }).onDelete("restrict"),
    unique("issue_execution_refs_scope_id_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
      table.id,
    ),
    unique("issue_execution_refs_company_issue_id_uq").on(
      table.companyId,
      table.issueId,
      table.id,
    ),
    unique("issue_execution_refs_company_issue_epoch_id_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.id,
    ),
    unique("issue_execution_refs_lane_ordinal_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.targetAgentId,
      table.laneOrdinal,
    ),
    unique("issue_execution_refs_scope_epoch_id_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
      table.id,
      table.ownershipEpoch,
    ),
    unique("issue_execution_refs_liveness_identity_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.id,
      table.targetAgentId,
      table.mode,
    ),
    uniqueIndex("issue_execution_refs_delivery_idempotency_uq").on(
      table.companyId,
      table.deliveryIdempotencyKey,
    ),
    uniqueIndex("issue_execution_refs_history_view_uq").on(table.historyViewId),
    index("issue_execution_refs_lane_order_idx").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.targetAgentId,
      table.laneOrdinal,
    ),
    index("issue_execution_refs_source_idx").on(
      table.companyId,
      table.sourceKind,
      table.sourceRecordId,
    ),
    index("issue_execution_refs_counterpart_idx").on(
      table.companyId,
      table.counterpartIssueId,
      table.counterpartOwnershipEpoch,
    ),
    index("issue_execution_refs_lineage_idx").on(
      table.sessionId,
      table.executionLineageId,
      table.createdAt,
    ),
  ],
);

export const issueExecutionHistoryViews = pgTable(
  "issue_execution_history_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    refId: uuid("ref_id").notNull(),
    executionLineageId: uuid("execution_lineage_id").notNull(),
    state: text("state")
      .$type<"empty" | "preparing" | "current" | "invalidated" | "terminal">()
      .notNull()
      .default("empty"),
    compositionDepth: text("composition_depth")
      .$type<"none" | "comments" | "turns">()
      .notNull()
      .default("none"),
    sourceHighWaterSeq: bigint("source_high_water_seq", { mode: "number" }).notNull(),
    contextEpoch: integer("context_epoch").notNull(),
    contextEpochBaselineSeq: bigint("context_epoch_baseline_seq", {
      mode: "number",
    }).notNull(),
    historyScopeKind: text("history_scope_kind").$type<
      "execution-lineage" | "turns-composition" | "comments-composition"
    >(),
    historyScopeId: text("history_scope_id"),
    compositionAudience: text("composition_audience").$type<
      "turns" | "comments"
    >(),
    effectiveDialSnapshot: jsonb("effective_dial_snapshot")
      .$type<Record<string, boolean>>(),
    effectiveDialDigest: text("effective_dial_digest"),
    selectedRecordIds: jsonb("selected_record_ids").$type<string[]>(),
    lowerOrderSnapshot: jsonb("lower_order_snapshot").$type<
      Array<Record<string, unknown>>
    >(),
    compositionPreparationId: uuid("composition_preparation_id"),
    compositionBytes: text("composition_bytes"),
    compositionHash: text("composition_hash"),
    sourceMessageId: text("source_message_id").notNull(),
    sourceInputId: text("source_input_id"),
    sourceAdmittedSeq: bigint("source_admitted_seq", { mode: "number" }),
    sourcePromotedSeq: bigint("source_promoted_seq", { mode: "number" }),
    invalidationReason: text("invalidation_reason"),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "issue_execution_history_views_state_check",
      sql`${table.state} in ('empty', 'preparing', 'current', 'invalidated', 'terminal')`,
    ),
    check(
      "issue_execution_history_views_depth_check",
      sql`${table.compositionDepth} in ('none', 'comments', 'turns')`,
    ),
    check(
      "issue_execution_history_views_scope_check",
      sql`(
        ${table.state} in ('empty', 'invalidated', 'terminal')
      ) or (
        ${table.historyScopeKind} in (
          'execution-lineage',
          'turns-composition',
          'comments-composition'
        )
        and ${table.historyScopeId} is not null
        and (
          (${table.compositionDepth} = 'none' and ${table.compositionAudience} is null)
          or (${table.compositionDepth} = 'comments' and ${table.compositionAudience} = 'comments')
          or (${table.compositionDepth} = 'turns' and ${table.compositionAudience} = 'turns')
        )
      )`,
    ),
    check(
      "issue_execution_history_views_snapshot_check",
      sql`(
        ${table.state} <> 'current'
      ) or (
        ${table.effectiveDialSnapshot} is not null
        and ${table.effectiveDialDigest} is not null
        and ${table.selectedRecordIds} is not null
        and ${table.lowerOrderSnapshot} is not null
      )`,
    ),
    check(
      "issue_execution_history_views_composition_check",
      sql`(
        ${table.compositionDepth} = 'none'
        and ${table.compositionBytes} is null
        and ${table.compositionHash} is null
        and ${table.compositionPreparationId} is null
      ) or (
        ${table.compositionDepth} in ('comments', 'turns')
        and (
          ${table.state} in ('empty', 'preparing')
          or (
            ${table.compositionBytes} is not null
            and ${table.compositionHash} is not null
            and ${table.compositionPreparationId} is not null
          )
        )
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_execution_history_views_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId, table.refId],
      foreignColumns: [
        issueExecutionRefs.companyId,
        issueExecutionRefs.issueId,
        issueExecutionRefs.sessionId,
        issueExecutionRefs.id,
      ],
      name: "issue_execution_history_views_ref_fk",
    }).onDelete("cascade"),
    unique("issue_execution_history_views_scope_id_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
      table.id,
    ),
    uniqueIndex("issue_execution_history_views_ref_uq").on(table.refId),
    unique("issue_execution_history_views_scope_ref_id_lineage_context_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
      table.refId,
      table.id,
      table.executionLineageId,
      table.contextEpoch,
    ),
    index("issue_execution_history_views_lineage_idx").on(
      table.sessionId,
      table.executionLineageId,
      table.sourceHighWaterSeq,
    ),
    index("issue_execution_history_views_preparation_idx").on(
      table.compositionPreparationId,
    ),
    index("issue_execution_history_views_state_idx").on(
      table.companyId,
      table.state,
      table.updatedAt,
    ),
  ],
);

/** The immutable workspace selection for an ownership epoch. */
export const issueExecutionWorkspaceBindings = pgTable(
  "issue_execution_workspace_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    executionWorkspaceId: uuid("execution_workspace_id").notNull(),
    absoluteCwd: text("absolute_cwd").notNull(),
    boundByAgentId: uuid("bound_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    boundByUserId: text("bound_by_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "issue_execution_workspace_bindings_epoch_check",
      sql`${table.ownershipEpoch} > 0`,
    ),
    check(
      "issue_execution_workspace_bindings_absolute_cwd_check",
      sql`left(${table.absoluteCwd}, 1) = '/'`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_execution_workspace_bindings_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.executionWorkspaceId],
      foreignColumns: [executionWorkspaces.companyId, executionWorkspaces.id],
      name: "issue_execution_workspace_bindings_workspace_fk",
    }).onDelete("restrict"),
    unique("issue_execution_workspace_bindings_scope_epoch_id_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
      table.ownershipEpoch,
      table.id,
    ),
    unique("issue_execution_workspace_bindings_identity_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.id,
    ),
    uniqueIndex("issue_execution_workspace_bindings_epoch_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
    ),
    index("issue_execution_workspace_bindings_workspace_idx").on(
      table.companyId,
      table.executionWorkspaceId,
    ),
  ],
);

export const issueExecutionHistoryViewMessages = pgTable(
  "issue_execution_history_view_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    historyViewId: uuid("history_view_id").notNull(),
    messageId: text("message_id").notNull(),
    lowerOrder: integer("lower_order").notNull(),
    membershipKind: text("membership_kind")
      .$type<"composition" | "source" | "execution">()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "issue_execution_history_view_messages_kind_check",
      sql`${table.membershipKind} in (
        'composition',
        'source',
        'execution'
      )`,
    ),
    check(
      "issue_execution_history_view_messages_order_check",
      sql`${table.lowerOrder} >= 0`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId, table.historyViewId],
      foreignColumns: [
        issueExecutionHistoryViews.companyId,
        issueExecutionHistoryViews.issueId,
        issueExecutionHistoryViews.sessionId,
        issueExecutionHistoryViews.id,
      ],
      name: "issue_execution_history_view_messages_view_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId, table.messageId],
      foreignColumns: [
        issueSessionMessages.companyId,
        issueSessionMessages.issueId,
        issueSessionMessages.sessionId,
        issueSessionMessages.id,
      ],
      name: "issue_execution_history_view_messages_message_fk",
    }).onDelete("cascade"),
    uniqueIndex("issue_execution_history_view_messages_order_uq").on(
      table.historyViewId,
      table.lowerOrder,
    ),
    uniqueIndex("issue_execution_history_view_messages_message_uq").on(
      table.historyViewId,
      table.messageId,
    ),
    index("issue_execution_history_view_messages_scope_idx").on(
      table.sessionId,
      table.historyViewId,
    ),
  ],
);

export type IssueExecutionLane = typeof issueExecutionLanes.$inferSelect;
export type NewIssueExecutionLane = typeof issueExecutionLanes.$inferInsert;
