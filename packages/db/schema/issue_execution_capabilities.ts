import type {
  AcpCostCursorState,
  IssueExecutionLaneKind,
  IssueExecutionNativeCorrelationPurpose,
  IssueExecutionNativeCorrelationState,
  IssueExecutionPromptCapabilityState,
} from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentAdapterConfigRevisions } from "./agent_adapter_config_revisions.js";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import {
  issueConsultExecutions,
  issueExecutionAuthorities,
  issueExecutionWorkspaceBindings,
} from "./issue_execution_runtime.js";
import {
  issueExecutionRunRefs,
  issueExecutionRuns,
} from "./issue_execution_runs.js";
import { issues } from "./issues.js";
import {
  budgetCurrencyColumn,
  moneyAmountColumn,
  nonnegativeFiniteMoneyCheck,
} from "./money.js";

/**
 * Worker-owned opaque ACP target correlation. This is not the canonical issue
 * Session and stores neither a plaintext native id nor provider conversation.
 */
export const issueExecutionSessions = pgTable(
  "issue_execution_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    purpose: text("purpose")
      .$type<IssueExecutionNativeCorrelationPurpose>()
      .notNull(),
    state: text("state")
      .$type<IssueExecutionNativeCorrelationState>()
      .notNull(),
    targetAgentId: uuid("target_agent_id").notNull(),
    adapterConfigIdentity: uuid("adapter_config_identity").notNull(),
    workspaceIdentity: uuid("workspace_identity").notNull(),
    laneKind: text("lane_kind").$type<IssueExecutionLaneKind>(),
    runId: uuid("run_id"),
    currentRefId: uuid("current_ref_id"),
    currentRefOrdinal: integer("current_ref_ordinal"),
    currentSegmentOrdinal: integer("current_segment_ordinal"),
    authorizedContextExposureDigest: text(
      "authorized_context_exposure_digest",
    ),
    envelopeVersion: text("envelope_version")
      .$type<"issue-execution-native/v1">()
      .notNull()
      .default("issue-execution-native/v1"),
    codecKind: text("codec_kind")
      .$type<"acp-session/v1">()
      .notNull()
      .default("acp-session/v1"),
    acpWireProtocolVersion: integer("acp_wire_protocol_version")
      .notNull()
      .default(1),
    protectedTargetSession: text("protected_target_session").notNull(),
    protectedTargetSessionDigest: text(
      "protected_target_session_digest",
    ).notNull(),
    targetFingerprint: text("target_fingerprint").notNull(),
    correlationGeneration: integer("correlation_generation").notNull(),
    lastProtocolSettledRunId: uuid("last_protocol_settled_run_id"),
    lastProtocolSettledRefId: uuid("last_protocol_settled_ref_id"),
    lastProtocolSettledRefOrdinal: integer(
      "last_protocol_settled_ref_ordinal",
    ),
    lastProtocolSettledSegmentOrdinal: integer(
      "last_protocol_settled_segment_ordinal",
    ),
    costCursorState: text("cost_cursor_state")
      .$type<AcpCostCursorState>()
      .notNull()
      .default("unanchored"),
    costCursorAmount: moneyAmountColumn("cost_cursor_amount"),
    costCursorCurrency: budgetCurrencyColumn("cost_cursor_currency"),
    supersessionReason: text("supersession_reason"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "issue_execution_sessions_epoch_generation_check",
      sql`${table.ownershipEpoch} > 0
        and ${table.correlationGeneration} > 0`,
    ),
    check(
      "issue_execution_sessions_purpose_shape_check",
      sql`(
        ${table.purpose} = 'carry'
        and ${table.state} in ('eligible', 'superseded')
        and ${table.laneKind} is not null
        and ${table.laneKind} in ('owner', 'consult')
        and ${table.runId} is null
        and ${table.currentRefId} is null
        and ${table.currentRefOrdinal} is null
        and ${table.currentSegmentOrdinal} is null
        and ${table.authorizedContextExposureDigest} is not null
      ) or (
        ${table.purpose} = 'active_run_steering'
        and ${table.state} in ('current', 'superseded')
        and ${table.laneKind} is null
        and ${table.runId} is not null
        and ${table.currentRefId} is not null
        and ${table.currentRefOrdinal} is not null
        and ${table.currentRefOrdinal} >= 0
        and ${table.currentSegmentOrdinal} is not null
        and ${table.currentSegmentOrdinal} >= 0
        and ${table.authorizedContextExposureDigest} is null
      )`,
    ),
    check(
      "issue_execution_sessions_supersession_check",
      sql`(
        ${table.state} in ('eligible', 'current')
        and ${table.supersessionReason} is null
        and ${table.supersededAt} is null
      ) or (
        ${table.state} = 'superseded'
        and ${table.supersessionReason} is not null
        and length(btrim(${table.supersessionReason})) between 1 and 200
        and ${table.supersededAt} is not null
        and ${table.supersededAt} >= ${table.createdAt}
      )`,
    ),
    check(
      "issue_execution_sessions_envelope_check",
      sql`${table.envelopeVersion} = 'issue-execution-native/v1'
        and ${table.codecKind} = 'acp-session/v1'
        and ${table.acpWireProtocolVersion} = 1
        and length(btrim(${table.protectedTargetSession})) > 0
        and ${table.protectedTargetSession} like 'pcnc.v1.%'`,
    ),
    check(
      "issue_execution_sessions_digest_check",
      sql`${table.protectedTargetSessionDigest} ~ '^[0-9a-f]{64}$'
        and ${table.targetFingerprint} ~ '^[0-9a-f]{64}$'
        and (
          ${table.authorizedContextExposureDigest} is null
          or ${table.authorizedContextExposureDigest} ~ '^[0-9a-f]{64}$'
        )`,
    ),
    check(
      "issue_execution_sessions_last_settled_prompt_check",
      sql`(
        ${table.lastProtocolSettledRunId} is null
        and ${table.lastProtocolSettledRefId} is null
        and ${table.lastProtocolSettledRefOrdinal} is null
        and ${table.lastProtocolSettledSegmentOrdinal} is null
      ) or (
        ${table.lastProtocolSettledRunId} is not null
        and ${table.lastProtocolSettledRefId} is not null
        and ${table.lastProtocolSettledRefOrdinal} is not null
        and ${table.lastProtocolSettledRefOrdinal} >= 0
        and ${table.lastProtocolSettledSegmentOrdinal} is not null
        and ${table.lastProtocolSettledSegmentOrdinal} >= 0
      )`,
    ),
    check(
      "issue_execution_sessions_cost_cursor_check",
      sql`(
        ${table.costCursorState} = 'unanchored'
        and ${table.costCursorAmount} is null
        and ${table.costCursorCurrency} is null
        and ${table.lastProtocolSettledRunId} is null
      ) or (
        ${table.costCursorState} = 'known'
        and ${table.costCursorAmount} is not null
        and ${nonnegativeFiniteMoneyCheck(table.costCursorAmount)}
        and ${table.costCursorCurrency} is not null
        and ${table.lastProtocolSettledRunId} is not null
      ) or (
        ${table.costCursorState} = 'unavailable'
        and ${table.costCursorAmount} is null
        and ${table.costCursorCurrency} is null
        and ${table.lastProtocolSettledRunId} is not null
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.costCursorCurrency],
      foreignColumns: [companies.id, companies.budgetCurrency],
      name: "issue_execution_sessions_cost_cursor_currency_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "issue_execution_sessions_issue_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.targetAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "issue_execution_sessions_target_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.targetAgentId,
        table.adapterConfigIdentity,
      ],
      foreignColumns: [
        agentAdapterConfigRevisions.companyId,
        agentAdapterConfigRevisions.agentId,
        agentAdapterConfigRevisions.id,
      ],
      name: "issue_execution_sessions_adapter_config_identity_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.workspaceIdentity,
      ],
      foreignColumns: [
        issueExecutionWorkspaceBindings.companyId,
        issueExecutionWorkspaceBindings.issueId,
        issueExecutionWorkspaceBindings.ownershipEpoch,
        issueExecutionWorkspaceBindings.id,
      ],
      name: "issue_execution_sessions_workspace_identity_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.runId,
        table.targetAgentId,
        table.adapterConfigIdentity,
        table.workspaceIdentity,
      ],
      foreignColumns: [
        issueExecutionRuns.companyId,
        issueExecutionRuns.issueId,
        issueExecutionRuns.ownershipEpoch,
        issueExecutionRuns.id,
        issueExecutionRuns.targetAgentId,
        issueExecutionRuns.adapterConfigRevisionId,
        issueExecutionRuns.executionWorkspaceBindingId,
      ],
      name: "issue_execution_sessions_steering_target_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.runId,
        table.currentRefOrdinal,
        table.currentRefId,
      ],
      foreignColumns: [
        issueExecutionRunRefs.runId,
        issueExecutionRunRefs.refOrdinal,
        issueExecutionRunRefs.refId,
      ],
      name: "issue_execution_sessions_current_run_ref_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.lastProtocolSettledRunId,
        table.lastProtocolSettledRefOrdinal,
        table.lastProtocolSettledRefId,
      ],
      foreignColumns: [
        issueExecutionRunRefs.runId,
        issueExecutionRunRefs.refOrdinal,
        issueExecutionRunRefs.refId,
      ],
      name: "issue_execution_sessions_last_settled_run_ref_fk",
    }).onDelete("cascade"),
    unique("issue_execution_sessions_company_id_uq").on(
      table.companyId,
      table.id,
    ),
    uniqueIndex("issue_execution_sessions_current_carry_uq")
      .on(
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.targetAgentId,
        table.adapterConfigIdentity,
        table.workspaceIdentity,
        table.laneKind,
      )
      .where(
        sql`${table.purpose} = 'carry' and ${table.state} = 'eligible'`,
      ),
    uniqueIndex("issue_execution_sessions_current_steering_uq")
      .on(
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.runId,
        table.targetAgentId,
        table.adapterConfigIdentity,
        table.workspaceIdentity,
      )
      .where(
        sql`${table.purpose} = 'active_run_steering' and ${table.state} = 'current'`,
      ),
    uniqueIndex("issue_execution_sessions_carry_generation_uq")
      .on(
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.targetAgentId,
        table.adapterConfigIdentity,
        table.workspaceIdentity,
        table.laneKind,
        table.correlationGeneration,
      )
      .where(sql`${table.purpose} = 'carry'`),
    uniqueIndex("issue_execution_sessions_steering_generation_uq")
      .on(
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.runId,
        table.targetAgentId,
        table.adapterConfigIdentity,
        table.workspaceIdentity,
        table.correlationGeneration,
      )
      .where(sql`${table.purpose} = 'active_run_steering'`),
    index("issue_execution_sessions_digest_idx").on(
      table.companyId,
      table.protectedTargetSessionDigest,
    ),
    index("issue_execution_sessions_issue_state_idx").on(
      table.companyId,
      table.issueId,
      table.state,
    ),
  ],
);

/**
 * One request-scoped gateway capability generation for one exact ACP prompt.
 * The plaintext bearer and compiled descriptor/catalog are never persisted.
 */
export const issueExecutionPromptCapabilities = pgTable(
  "issue_execution_prompt_capabilities",
  {
    companyId: uuid("company_id").notNull(),
    capabilityConnectionId: uuid("capability_connection_id").notNull(),
    capabilityGeneration: integer("capability_generation").notNull(),
    runId: uuid("run_id").notNull(),
    runBatchDigest: text("run_batch_digest").notNull(),
    refId: uuid("ref_id").notNull(),
    refOrdinal: integer("ref_ordinal").notNull(),
    segmentOrdinal: integer("segment_ordinal").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    leaseId: uuid("lease_id").notNull(),
    leaseGeneration: integer("lease_generation").notNull(),
    workerProcessIdentity: uuid("worker_process_identity").notNull(),
    issueId: uuid("issue_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    targetAgentId: uuid("target_agent_id").notNull(),
    laneKind: text("lane_kind").$type<IssueExecutionLaneKind>().notNull(),
    executionMode: text("execution_mode")
      .$type<IssueExecutionLaneKind>()
      .notNull(),
    issueExecutionAuthorityId: uuid("issue_execution_authority_id"),
    consultExecutionId: uuid("consult_execution_id"),
    adapterConfigIdentity: uuid("adapter_config_identity").notNull(),
    workspaceIdentity: uuid("workspace_identity").notNull(),
    targetSessionCorrelationId: uuid("target_session_correlation_id"),
    effectiveContextExposureDigest: text(
      "effective_context_exposure_digest",
    ).notNull(),
    effectiveToolsDigest: text("effective_tools_digest").notNull(),
    bearerHash: text("bearer_hash").notNull(),
    ingressHighWater: bigint("ingress_high_water", { mode: "number" })
      .notNull()
      .default(-1),
    classificationHighWater: bigint("classification_high_water", {
      mode: "number",
    })
      .notNull()
      .default(-1),
    state: text("state")
      .$type<IssueExecutionPromptCapabilityState>()
      .notNull()
      .default("pending_setup"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.capabilityConnectionId, table.capabilityGeneration],
      name: "issue_execution_prompt_capabilities_pk",
    }),
    check(
      "issue_execution_prompt_capabilities_identity_check",
      sql`${table.capabilityGeneration} > 0
        and ${table.ownershipEpoch} > 0
        and ${table.refOrdinal} >= 0
        and ${table.segmentOrdinal} >= 0
        and ${table.leaseGeneration} > 0
        and ${table.runBatchDigest} ~ '^[0-9a-f]{64}$'
        and ${table.effectiveContextExposureDigest} ~ '^[0-9a-f]{64}$'
        and ${table.effectiveToolsDigest} ~ '^[0-9a-f]{64}$'
        and ${table.bearerHash} ~ '^[0-9a-f]{64}$'
        and ${table.ingressHighWater} >= -1
        and ${table.ingressHighWater} <= 9007199254740991
        and ${table.classificationHighWater} >= -1
        and ${table.classificationHighWater} <= 9007199254740991
        and ${table.classificationHighWater} <= ${table.ingressHighWater}`,
    ),
    check(
      "issue_execution_prompt_capabilities_mode_check",
      sql`(
        ${table.laneKind} = 'owner'
        and ${table.executionMode} = 'owner'
        and ${table.issueExecutionAuthorityId} is not null
        and ${table.consultExecutionId} is null
      ) or (
        ${table.laneKind} = 'consult'
        and ${table.executionMode} = 'consult'
        and ${table.issueExecutionAuthorityId} is null
        and ${table.consultExecutionId} is not null
      )`,
    ),
    check(
      "issue_execution_prompt_capabilities_state_check",
      sql`(
        ${table.state} = 'pending_setup'
        and ${table.activatedAt} is null
        and ${table.revocationReason} is null
        and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'active'
        and ${table.targetSessionCorrelationId} is not null
        and ${table.activatedAt} is not null
        and ${table.revocationReason} is null
        and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'revoked'
        and ${table.revocationReason} is not null
        and length(btrim(${table.revocationReason})) between 1 and 200
        and ${table.revokedAt} is not null
        and (
          ${table.activatedAt} is null
          or ${table.revokedAt} >= ${table.activatedAt}
        )
      )`,
    ),
    check(
      "issue_execution_prompt_capabilities_time_check",
      sql`${table.expiresAt} > ${table.createdAt}
        and (
          ${table.activatedAt} is null
          or ${table.activatedAt} >= ${table.createdAt}
        )
        and (
          ${table.revokedAt} is null
          or ${table.revokedAt} >= ${table.createdAt}
        )`,
    ),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.runId,
        table.targetAgentId,
        table.adapterConfigIdentity,
        table.workspaceIdentity,
        table.executionMode,
      ],
      foreignColumns: [
        issueExecutionRuns.companyId,
        issueExecutionRuns.issueId,
        issueExecutionRuns.ownershipEpoch,
        issueExecutionRuns.id,
        issueExecutionRuns.targetAgentId,
        issueExecutionRuns.adapterConfigRevisionId,
        issueExecutionRuns.executionWorkspaceBindingId,
        issueExecutionRuns.executionMode,
      ],
      name: "issue_execution_prompt_capabilities_prompt_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.runId,
        table.refOrdinal,
        table.refId,
        table.runBatchDigest,
      ],
      foreignColumns: [
        issueExecutionRunRefs.runId,
        issueExecutionRunRefs.refOrdinal,
        issueExecutionRunRefs.refId,
        issueExecutionRunRefs.batchDigest,
      ],
      name: "issue_execution_prompt_capabilities_run_ref_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.targetAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "issue_execution_prompt_capabilities_target_agent_fk",
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
      name: "issue_execution_prompt_capabilities_authority_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.targetAgentId,
        table.consultExecutionId,
      ],
      foreignColumns: [
        issueConsultExecutions.companyId,
        issueConsultExecutions.issueId,
        issueConsultExecutions.ownershipEpoch,
        issueConsultExecutions.targetAgentId,
        issueConsultExecutions.id,
      ],
      name: "issue_execution_prompt_capabilities_consult_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.targetAgentId,
        table.adapterConfigIdentity,
      ],
      foreignColumns: [
        agentAdapterConfigRevisions.companyId,
        agentAdapterConfigRevisions.agentId,
        agentAdapterConfigRevisions.id,
      ],
      name: "issue_execution_prompt_capabilities_adapter_identity_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.workspaceIdentity,
      ],
      foreignColumns: [
        issueExecutionWorkspaceBindings.companyId,
        issueExecutionWorkspaceBindings.issueId,
        issueExecutionWorkspaceBindings.ownershipEpoch,
        issueExecutionWorkspaceBindings.id,
      ],
      name: "issue_execution_prompt_capabilities_workspace_identity_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.targetSessionCorrelationId],
      foreignColumns: [
        issueExecutionSessions.companyId,
        issueExecutionSessions.id,
      ],
      name: "issue_execution_prompt_capabilities_native_correlation_fk",
    }).onDelete("restrict"),
    unique("issue_execution_prompt_capabilities_company_pair_uq").on(
      table.companyId,
      table.capabilityConnectionId,
      table.capabilityGeneration,
    ),
    unique("issue_execution_prompt_capabilities_connection_uq").on(
      table.capabilityConnectionId,
    ),
    unique("issue_execution_prompt_capabilities_run_generation_uq").on(
      table.runId,
      table.capabilityGeneration,
    ),
    uniqueIndex("issue_execution_prompt_capabilities_bearer_hash_uq").on(
      table.bearerHash,
    ),
    uniqueIndex("issue_execution_prompt_capabilities_live_run_uq")
      .on(table.runId)
      .where(sql`${table.state} in ('pending_setup', 'active')`),
    index("issue_execution_prompt_capabilities_issue_state_idx").on(
      table.companyId,
      table.issueId,
      table.state,
    ),
    index("issue_execution_prompt_capabilities_expiry_idx").on(
      table.companyId,
      table.expiresAt,
    ),
  ],
);

export type IssueExecutionSession =
  typeof issueExecutionSessions.$inferSelect;
export type NewIssueExecutionSession =
  typeof issueExecutionSessions.$inferInsert;
export type IssueExecutionPromptCapability =
  typeof issueExecutionPromptCapabilities.$inferSelect;
export type NewIssueExecutionPromptCapability =
  typeof issueExecutionPromptCapabilities.$inferInsert;
