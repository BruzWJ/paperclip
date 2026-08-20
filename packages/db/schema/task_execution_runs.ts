import type {
  TaskExecutionFinalizationAction,
  TaskExecutionPromptOutcome,
  TaskExecutionPromptTransmissionPhase,
  TaskExecutionProtocolSettlementState,
  TaskExecutionRunKind,
  TaskExecutionSessionOperation,
  TaskExecutionRunStatus,
  TaskExecutionRunTerminalClassification,
  RunLivenessState,
} from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentAdapterConfigRevisions } from "./agent_adapter_config_revisions.js";
import { acpPromptAccounting } from "./acp_prompt_accounting.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { costEvents } from "./cost_events.js";
import { taskUpdates } from "./task_creator_edge.js";
import { taskComments } from "./task_comments.js";
import { taskExecutionPromptCapabilities } from "./task_execution_capabilities.js";
import {
  taskConsultExecutions,
  taskExecutionAuthorities,
  taskExecutionLanes,
  taskExecutionRefs,
  taskExecutionWorkspaceBindings,
} from "./task_execution_runtime.js";
import {
  taskSessionEvents,
  taskSessionInputs,
  taskSessionMessages,
  taskSessions,
} from "./task_sessions.js";

export type TaskExecutionMode = "owner" | "consult";

/**
 * The sole task-provider run envelope. Conversational records, current prompt
 * identity, settlements, accounting, and finalization dependencies remain in
 * their typed owners and are joined only by readers.
 */
export const taskExecutionRuns = pgTable(
  "task_execution_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    sessionId: text("session_id").notNull(),
    executionScopeId: uuid("execution_scope_id").notNull(),
    kind: text("kind").$type<TaskExecutionRunKind>().notNull(),
    status: text("status")
      .$type<TaskExecutionRunStatus>()
      .notNull()
      .default("queued"),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    targetAgentId: uuid("target_agent_id").notNull(),
    adapterConfigRevisionId: uuid("adapter_config_revision_id")
      .notNull()
      .references(() => agentAdapterConfigRevisions.id, {
        onDelete: "restrict",
      }),
    executionWorkspaceBindingId: uuid(
      "execution_workspace_binding_id",
    ).notNull(),
    executionMode: text("execution_mode").$type<TaskExecutionMode>().notNull(),
    taskExecutionAuthorityId: uuid("task_execution_authority_id"),
    consultExecutionId: uuid("consult_execution_id"),
    parentRunId: uuid("parent_run_id"),
    retryOfRunId: uuid("retry_of_run_id"),
    currentAttemptId: uuid("current_attempt_id").references(
      (): AnyPgColumn => taskExecutionAttempts.id,
      { onDelete: "restrict" },
    ),
    currentLeaseId: uuid("current_lease_id").references(
      (): AnyPgColumn => taskExecutionLeases.id,
      { onDelete: "restrict" },
    ),
    cancellationIntentId: uuid("cancellation_intent_id").references(
      (): AnyPgColumn => taskExecutionCancellationIntents.id,
      { onDelete: "restrict" },
    ),
    terminalFinalizationId: uuid("terminal_finalization_id").references(
      (): AnyPgColumn => taskExecutionFinalizations.id,
      { onDelete: "restrict" },
    ),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    terminalClassification: text("terminal_classification").$type<
      TaskExecutionRunTerminalClassification
    >(),
    terminalReasonCode: text("terminal_reason_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "task_execution_runs_kind_check",
      sql`${table.kind} in ('productive', 'consult')`,
    ),
    check(
      "task_execution_runs_status_check",
      sql`${table.status} in (
        'queued',
        'scheduled_retry',
        'running',
        'succeeded',
        'interrupted',
        'failed',
        'cancelled',
        'timed_out'
      )`,
    ),
    check(
      "task_execution_runs_epoch_check",
      sql`${table.ownershipEpoch} > 0`,
    ),
    check(
      "task_execution_runs_mode_check",
      sql`${table.executionMode} in ('owner', 'consult')`,
    ),
    check(
      "task_execution_runs_kind_shape_check",
      sql`(
        ${table.kind} = 'productive'
        and ${table.targetAgentId} is not null
        and ${table.executionMode} = 'owner'
        and ${table.taskExecutionAuthorityId} is not null
        and ${table.consultExecutionId} is null
        and ${table.parentRunId} is null
      ) or (
        ${table.kind} = 'consult'
        and ${table.targetAgentId} is not null
        and ${table.executionMode} = 'consult'
        and ${table.taskExecutionAuthorityId} is null
        and ${table.consultExecutionId} is not null
        and ${table.parentRunId} is not null
      )`,
    ),
    check(
      "task_execution_runs_current_attempt_lease_check",
      sql`(
        ${table.currentAttemptId} is null
        and ${table.currentLeaseId} is null
      ) or (
        ${table.currentAttemptId} is not null
        and ${table.currentLeaseId} is not null
      )`,
    ),
    check(
      "task_execution_runs_terminal_shape_check",
      sql`(
        ${table.status} in ('queued', 'scheduled_retry', 'running')
        and ${table.finishedAt} is null
        and ${table.terminalClassification} is null
        and ${table.terminalReasonCode} is null
        and ${table.terminalFinalizationId} is null
      ) or (
        ${table.status} in (
          'succeeded',
          'interrupted',
          'failed',
          'cancelled',
          'timed_out'
        )
        and ${table.finishedAt} is not null
        and ${table.terminalClassification} = ${table.status}
        and ${table.terminalReasonCode} is not null
        and length(btrim(${table.terminalReasonCode})) between 1 and 200
        and ${table.terminalFinalizationId} is not null
        and ${table.currentAttemptId} is null
        and ${table.currentLeaseId} is null
      )`,
    ),
    check(
      "task_execution_runs_time_check",
      sql`${table.updatedAt} >= ${table.createdAt}
        and (
          ${table.startedAt} is null
          or ${table.startedAt} >= ${table.createdAt}
        )
        and (
          ${table.finishedAt} is null
          or ${table.startedAt} is null
          or ${table.finishedAt} >= ${table.startedAt}
        )`,
    ),
    foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId],
      foreignColumns: [
        taskSessions.companyId,
        taskSessions.taskId,
        taskSessions.id,
      ],
      name: "task_execution_runs_session_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.targetAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "task_execution_runs_target_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.ownershipEpoch,
        table.targetAgentId,
      ],
      foreignColumns: [
        taskExecutionLanes.companyId,
        taskExecutionLanes.taskId,
        taskExecutionLanes.ownershipEpoch,
        taskExecutionLanes.targetAgentId,
      ],
      name: "task_execution_runs_lane_fk",
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
      name: "task_execution_runs_adapter_revision_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.ownershipEpoch,
        table.targetAgentId,
        table.taskExecutionAuthorityId,
      ],
      foreignColumns: [
        taskExecutionAuthorities.companyId,
        taskExecutionAuthorities.taskId,
        taskExecutionAuthorities.ownershipEpoch,
        taskExecutionAuthorities.agentId,
        taskExecutionAuthorities.id,
      ],
      name: "task_execution_runs_authority_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.sessionId,
        table.consultExecutionId,
      ],
      foreignColumns: [
        taskConsultExecutions.companyId,
        taskConsultExecutions.taskId,
        taskConsultExecutions.sessionId,
        taskConsultExecutions.id,
      ],
      name: "task_execution_runs_consult_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.sessionId,
        table.ownershipEpoch,
        table.executionWorkspaceBindingId,
      ],
      foreignColumns: [
        taskExecutionWorkspaceBindings.companyId,
        taskExecutionWorkspaceBindings.taskId,
        taskExecutionWorkspaceBindings.sessionId,
        taskExecutionWorkspaceBindings.ownershipEpoch,
        taskExecutionWorkspaceBindings.id,
      ],
      name: "task_execution_runs_workspace_binding_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.taskId, table.parentRunId],
      foreignColumns: [table.companyId, table.taskId, table.id],
      name: "task_execution_runs_parent_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.taskId, table.retryOfRunId],
      foreignColumns: [table.companyId, table.taskId, table.id],
      name: "task_execution_runs_retry_fk",
    }).onDelete("cascade"),
    unique("task_execution_runs_company_id_uq").on(table.companyId, table.id),
    unique("task_execution_runs_company_task_id_uq").on(
      table.companyId,
      table.taskId,
      table.id,
    ),
    unique("task_execution_runs_scope_id_uq").on(
      table.companyId,
      table.taskId,
      table.sessionId,
      table.id,
    ),
    unique("task_execution_runs_company_task_id_kind_uq").on(
      table.companyId,
      table.taskId,
      table.id,
      table.kind,
    ),
    unique("task_execution_runs_epoch_id_uq").on(
      table.companyId,
      table.taskId,
      table.ownershipEpoch,
      table.id,
    ),
    unique("task_execution_runs_liveness_identity_uq").on(
      table.companyId,
      table.taskId,
      table.ownershipEpoch,
      table.id,
      table.targetAgentId,
      table.executionMode,
    ),
    unique("task_execution_runs_company_id_target_agent_uq").on(
      table.companyId,
      table.id,
      table.targetAgentId,
    ),
    unique("task_execution_runs_accounting_revision_uq").on(
      table.companyId,
      table.taskId,
      table.id,
      table.kind,
      table.adapterConfigRevisionId,
    ),
    unique("task_execution_runs_native_target_scope_uq").on(
      table.companyId,
      table.taskId,
      table.ownershipEpoch,
      table.id,
      table.targetAgentId,
      table.adapterConfigRevisionId,
      table.executionWorkspaceBindingId,
    ),
    unique("task_execution_runs_prompt_scope_uq").on(
      table.companyId,
      table.taskId,
      table.ownershipEpoch,
      table.id,
      table.targetAgentId,
      table.adapterConfigRevisionId,
      table.executionWorkspaceBindingId,
      table.executionMode,
    ),
    index("task_execution_runs_execution_scope_idx").on(
      table.companyId,
      table.executionScopeId,
    ),
    index("task_execution_runs_task_status_idx").on(
      table.companyId,
      table.taskId,
      table.status,
      table.createdAt,
    ),
    index("task_execution_runs_agent_status_idx").on(
      table.companyId,
      table.targetAgentId,
      table.status,
      table.createdAt,
    ),
    index("task_execution_runs_parent_idx").on(
      table.companyId,
      table.parentRunId,
    ),
  ],
);

/** Immutable, ordered productive/consult run membership and base prompt. */
export const taskExecutionRunRefs = pgTable(
  "task_execution_run_refs",
  {
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    sessionId: text("session_id").notNull(),
    runId: uuid("run_id").notNull(),
    refId: uuid("ref_id").notNull(),
    refOrdinal: integer("ref_ordinal").notNull(),
    admissionOrder: bigint("admission_order", { mode: "number" }).notNull(),
    batchDigest: text("batch_digest").notNull(),
    /** Null only when the member ref is a direct canonical synthetic event. */
    inputId: text("input_id"),
    promptTransmissionPhase: text("prompt_transmission_phase")
      .$type<TaskExecutionPromptTransmissionPhase>()
      .notNull()
      .default("not_transmitted"),
    outcome: text("outcome").$type<TaskExecutionPromptOutcome>(),
    outcomeReferenceId: uuid("outcome_reference_id"),
    protocolSettlementState: text("protocol_settlement_state").$type<
      TaskExecutionProtocolSettlementState
    >(),
    accountingId: uuid("accounting_id"),
    costEventId: uuid("cost_event_id"),
    settlementVersion: integer("settlement_version").notNull().default(0),
    attemptId: uuid("attempt_id").references(
      (): AnyPgColumn => taskExecutionAttempts.id,
      { onDelete: "restrict" },
    ),
    capabilityConnectionId: uuid("capability_connection_id"),
    capabilityGeneration: integer("capability_generation"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "task_execution_run_refs_ordinal_check",
      sql`${table.refOrdinal} >= 0 and ${table.admissionOrder} >= 0`,
    ),
    check(
      "task_execution_run_refs_batch_digest_check",
      sql`length(${table.batchDigest}) = 64
        and ${table.batchDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "task_execution_run_refs_transmission_check",
      sql`${table.promptTransmissionPhase} in ('not_transmitted', 'transmitted')`,
    ),
    check(
      "task_execution_run_refs_outcome_check",
      sql`${table.outcome} is null
        or ${table.outcome} in (
          'released_unsent',
          'succeeded',
          'refused',
          'failed',
          'ambiguous',
          'cancelled'
        )`,
    ),
    check(
      "task_execution_run_refs_protocol_settlement_state_check",
      sql`${table.protocolSettlementState} is null
        or ${table.protocolSettlementState} in ('not_sent', 'settled', 'incomplete')`,
    ),
    check(
      "task_execution_run_refs_settlement_matrix_check",
      sql`(
        ${table.protocolSettlementState} is null
        and ${table.outcome} is null
        and ${table.outcomeReferenceId} is null
        and ${table.accountingId} is null
        and ${table.costEventId} is null
        and ${table.settlementVersion} = 0
        and ${table.settledAt} is null
      ) or (
        ${table.protocolSettlementState} = 'not_sent'
        and ${table.promptTransmissionPhase} = 'not_transmitted'
        and ${table.outcome} = 'released_unsent'
        and ${table.outcomeReferenceId} is not null
        and ${table.accountingId} is null
        and ${table.costEventId} is null
        and ${table.settlementVersion} > 0
        and ${table.settledAt} is not null
      ) or (
        ${table.protocolSettlementState} = 'incomplete'
        and ${table.promptTransmissionPhase} = 'transmitted'
        and ${table.outcome} in ('failed', 'ambiguous', 'cancelled')
        and ${table.outcomeReferenceId} is not null
        and ${table.accountingId} is null
        and ${table.costEventId} is null
        and ${table.settlementVersion} > 0
        and ${table.settledAt} is not null
      ) or (
        ${table.protocolSettlementState} = 'settled'
        and ${table.promptTransmissionPhase} = 'transmitted'
        and ${table.outcome} in ('succeeded', 'refused', 'failed', 'cancelled')
        and ${table.outcomeReferenceId} is not null
        and ${table.accountingId} is not null
        and ${table.costEventId} is not null
        and ${table.settlementVersion} > 0
        and ${table.settledAt} is not null
      )`,
    ),
    check(
      "task_execution_run_refs_capability_generation_check",
      sql`(
        ${table.attemptId} is null
        and ${table.capabilityConnectionId} is null
        and ${table.capabilityGeneration} is null
      ) or (
        ${table.attemptId} is not null
        and ${table.capabilityConnectionId} is not null
        and ${table.capabilityGeneration} is not null
        and ${table.capabilityGeneration} > 0
      )`,
    ),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.sessionId,
        table.runId,
      ],
      foreignColumns: [
        taskExecutionRuns.companyId,
        taskExecutionRuns.taskId,
        taskExecutionRuns.sessionId,
        taskExecutionRuns.id,
      ],
      name: "task_execution_run_refs_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.sessionId,
        table.refId,
      ],
      foreignColumns: [
        taskExecutionRefs.companyId,
        taskExecutionRefs.taskId,
        taskExecutionRefs.sessionId,
        taskExecutionRefs.id,
      ],
      name: "task_execution_run_refs_ref_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.sessionId,
        table.inputId,
      ],
      foreignColumns: [
        taskSessionInputs.companyId,
        taskSessionInputs.taskId,
        taskSessionInputs.sessionId,
        taskSessionInputs.id,
      ],
      name: "task_execution_run_refs_input_fk",
    }).onDelete("restrict"),
    unique("task_execution_run_refs_run_ordinal_uq").on(
      table.runId,
      table.refOrdinal,
    ),
    unique("task_execution_run_refs_run_ref_uq").on(
      table.runId,
      table.refId,
    ),
    unique("task_execution_run_refs_run_ordinal_ref_uq").on(
      table.runId,
      table.refOrdinal,
      table.refId,
    ),
    unique("task_execution_run_refs_prompt_identity_uq").on(
      table.runId,
      table.refOrdinal,
      table.refId,
      table.batchDigest,
    ),
    unique("task_execution_run_refs_scope_member_uq").on(
      table.companyId,
      table.taskId,
      table.sessionId,
      table.runId,
      table.refOrdinal,
      table.refId,
    ),
    unique("task_execution_run_refs_company_task_run_ordinal_ref_uq").on(
      table.companyId,
      table.taskId,
      table.runId,
      table.refOrdinal,
      table.refId,
    ),
    uniqueIndex("task_execution_run_refs_active_ref_uq")
      .on(table.companyId, table.refId)
      .where(sql`${table.protocolSettlementState} is null`),
    index("task_execution_run_refs_run_order_idx").on(
      table.runId,
      table.refOrdinal,
    ),
  ],
);

/** Sole current-prompt pointer. Its three-column shape is intentionally closed. */
export const taskExecutionRunControls = pgTable(
  "task_execution_run_controls",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => taskExecutionRuns.id, { onDelete: "cascade" }),
    currentRefId: uuid("current_ref_id"),
    currentOrdinal: integer("current_ordinal"),
  },
  (table) => [
    check(
      "task_execution_run_controls_current_prompt_shape_check",
      sql`(
        ${table.currentRefId} is null
        and ${table.currentOrdinal} is null
      ) or (
        ${table.currentRefId} is not null
        and ${table.currentOrdinal} is not null
        and ${table.currentOrdinal} >= 0
      )`,
    ),
    foreignKey({
      columns: [
        table.runId,
        table.currentOrdinal,
        table.currentRefId,
      ],
      foreignColumns: [
        taskExecutionRunRefs.runId,
        taskExecutionRunRefs.refOrdinal,
        taskExecutionRunRefs.refId,
      ],
      name: "task_execution_run_controls_current_member_fk",
    }).onDelete("restrict"),
  ],
);

/**
 * One worker attempt owns exactly one canonical run-ref prompt identity.
 */
export const taskExecutionAttempts = pgTable(
  "task_execution_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    sessionId: text("session_id").notNull(),
    runId: uuid("run_id").notNull(),
    runKind: text("run_kind").$type<TaskExecutionRunKind>().notNull(),
    sessionOperation: text("session_operation")
      .$type<TaskExecutionSessionOperation>()
      .notNull(),
    refId: uuid("ref_id"),
    refOrdinal: integer("ref_ordinal"),
    attemptGeneration: integer("attempt_generation").notNull(),
    state: text("state")
      .$type<
        "pending" | "leased" | "running" | "settled" | "failed" | "cancelled"
      >()
      .notNull()
      .default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "task_execution_attempts_session_operation_check",
      sql`${table.sessionOperation} in ('new', 'resume')`,
    ),
    check(
      "task_execution_attempts_state_check",
      sql`${table.state} in (
        'pending',
        'leased',
        'running',
        'settled',
        'failed',
        'cancelled'
      )`,
    ),
    check(
      "task_execution_attempts_generation_check",
      sql`${table.attemptGeneration} > 0`,
    ),
    check(
      "task_execution_attempts_prompt_identity_check",
      sql`${table.runKind} in ('productive', 'consult')
        and ${table.refId} is not null
        and ${table.refOrdinal} is not null
        and ${table.refOrdinal} >= 0`,
    ),
    check(
      "task_execution_attempts_time_check",
      sql`(
        (
          ${table.state} in ('pending', 'leased')
          and ${table.startedAt} is null
          and ${table.finishedAt} is null
        ) or (
          ${table.state} = 'running'
          and ${table.startedAt} is not null
          and ${table.finishedAt} is null
        ) or (
          ${table.state} in ('settled', 'failed', 'cancelled')
          and ${table.finishedAt} is not null
        )
      )
      and (
        ${table.startedAt} is null
        or ${table.startedAt} >= ${table.createdAt}
      )
      and (
        ${table.finishedAt} is null
        or ${table.finishedAt} >= coalesce(${table.startedAt}, ${table.createdAt})
      )`,
    ),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.sessionId,
        table.runId,
      ],
      foreignColumns: [
        taskExecutionRuns.companyId,
        taskExecutionRuns.taskId,
        taskExecutionRuns.sessionId,
        taskExecutionRuns.id,
      ],
      name: "task_execution_attempts_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.taskId, table.runId, table.runKind],
      foreignColumns: [
        taskExecutionRuns.companyId,
        taskExecutionRuns.taskId,
        taskExecutionRuns.id,
        taskExecutionRuns.kind,
      ],
      name: "task_execution_attempts_run_kind_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.sessionId,
        table.runId,
        table.refOrdinal,
        table.refId,
      ],
      foreignColumns: [
        taskExecutionRunRefs.companyId,
        taskExecutionRunRefs.taskId,
        taskExecutionRunRefs.sessionId,
        taskExecutionRunRefs.runId,
        taskExecutionRunRefs.refOrdinal,
        taskExecutionRunRefs.refId,
      ],
      name: "task_execution_attempts_run_ref_fk",
    }).onDelete("cascade"),
    unique("task_execution_attempts_scope_id_uq").on(
      table.companyId,
      table.taskId,
      table.runId,
      table.id,
    ),
    unique("task_execution_attempts_accounting_productive_uq").on(
      table.companyId,
      table.taskId,
      table.runId,
      table.id,
      table.runKind,
      table.refOrdinal,
      table.refId,
    ),
    uniqueIndex("task_execution_attempts_prompt_uq")
      .on(
        table.runId,
        table.refOrdinal,
        table.refId,
        table.attemptGeneration,
      ),
    uniqueIndex("task_execution_attempts_live_run_uq")
      .on(table.runId)
      .where(sql`${table.state} in ('pending', 'leased', 'running')`),
    index("task_execution_attempts_state_idx").on(
      table.companyId,
      table.state,
      table.createdAt,
    ),
  ],
);

/**
 * Typed owner for a delayed pre-send successor attempt. Retry timing and
 * reason never leak onto the closed run envelope.
 */
export const taskExecutionAttemptRetrySchedules = pgTable(
  "task_execution_attempt_retry_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    runId: uuid("run_id").notNull(),
    predecessorAttemptId: uuid("predecessor_attempt_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    retryAt: timestamp("retry_at", { withTimezone: true }).notNull(),
    state: text("state")
      .$type<"scheduled" | "claimed" | "cancelled">()
      .notNull()
      .default("scheduled"),
    successorAttemptId: uuid("successor_attempt_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "task_execution_attempt_retry_schedules_reason_check",
      sql`length(btrim(${table.reasonCode})) between 1 and 200`,
    ),
    check(
      "task_execution_attempt_retry_schedules_state_check",
      sql`${table.state} in ('scheduled', 'claimed', 'cancelled')`,
    ),
    check(
      "task_execution_attempt_retry_schedules_state_time_check",
      sql`(
        ${table.state} = 'scheduled'
        and ${table.successorAttemptId} is null
        and ${table.claimedAt} is null
        and ${table.cancelledAt} is null
      ) or (
        ${table.state} = 'claimed'
        and ${table.successorAttemptId} is not null
        and ${table.claimedAt} is not null
        and ${table.cancelledAt} is null
      ) or (
        ${table.state} = 'cancelled'
        and ${table.successorAttemptId} is null
        and ${table.claimedAt} is null
        and ${table.cancelledAt} is not null
      )`,
    ),
    check(
      "task_execution_attempt_retry_schedules_time_check",
      sql`${table.retryAt} >= ${table.createdAt}
        and (
          ${table.claimedAt} is null
          or ${table.claimedAt} >= ${table.createdAt}
        )
        and (
          ${table.cancelledAt} is null
          or ${table.cancelledAt} >= ${table.createdAt}
        )`,
    ),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.runId,
        table.predecessorAttemptId,
      ],
      foreignColumns: [
        taskExecutionAttempts.companyId,
        taskExecutionAttempts.taskId,
        taskExecutionAttempts.runId,
        taskExecutionAttempts.id,
      ],
      name: "task_execution_attempt_retry_schedules_predecessor_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.runId,
        table.successorAttemptId,
      ],
      foreignColumns: [
        taskExecutionAttempts.companyId,
        taskExecutionAttempts.taskId,
        taskExecutionAttempts.runId,
        taskExecutionAttempts.id,
      ],
      name: "task_execution_attempt_retry_schedules_successor_fk",
    }).onDelete("cascade"),
    unique("task_execution_attempt_retry_schedules_predecessor_uq").on(
      table.predecessorAttemptId,
    ),
    unique("task_execution_attempt_retry_schedules_successor_uq").on(
      table.successorAttemptId,
    ),
    unique("task_execution_attempt_retry_schedules_scope_id_uq").on(
      table.companyId,
      table.taskId,
      table.runId,
      table.id,
    ),
    index("task_execution_attempt_retry_schedules_due_idx").on(
      table.companyId,
      table.state,
      table.retryAt,
      table.id,
    ),
  ],
);

/** One fenced worker lease for one prompt attempt. */
export const taskExecutionLeases = pgTable(
  "task_execution_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    runId: uuid("run_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    leaseGeneration: integer("lease_generation").notNull(),
    workerId: text("worker_id").notNull(),
    state: text("state")
      .$type<"active" | "released" | "expired" | "revoked">()
      .notNull()
      .default("active"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    renewedAt: timestamp("renewed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "task_execution_leases_generation_check",
      sql`${table.leaseGeneration} > 0`,
    ),
    check(
      "task_execution_leases_worker_check",
      sql`length(btrim(${table.workerId})) between 1 and 200`,
    ),
    check(
      "task_execution_leases_state_check",
      sql`${table.state} in ('active', 'released', 'expired', 'revoked')`,
    ),
    check(
      "task_execution_leases_state_time_check",
      sql`(
        (
          ${table.state} = 'active'
          and ${table.releasedAt} is null
        ) or (
          ${table.state} in ('released', 'expired', 'revoked')
          and ${table.releasedAt} is not null
        )
      )
      and ${table.expiresAt} > ${table.acquiredAt}
      and (
        ${table.renewedAt} is null
        or ${table.renewedAt} >= ${table.acquiredAt}
      )
      and (
        ${table.releasedAt} is null
        or ${table.releasedAt} >= ${table.acquiredAt}
      )`,
    ),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.runId,
        table.attemptId,
      ],
      foreignColumns: [
        taskExecutionAttempts.companyId,
        taskExecutionAttempts.taskId,
        taskExecutionAttempts.runId,
        taskExecutionAttempts.id,
      ],
      name: "task_execution_leases_attempt_fk",
    }).onDelete("cascade"),
    unique("task_execution_leases_attempt_uq").on(table.attemptId),
    unique("task_execution_leases_scope_id_uq").on(
      table.companyId,
      table.taskId,
      table.runId,
      table.attemptId,
      table.id,
    ),
    uniqueIndex("task_execution_leases_active_run_uq")
      .on(table.runId)
      .where(sql`${table.state} = 'active'`),
    index("task_execution_leases_expiry_idx").on(
      table.companyId,
      table.state,
      table.expiresAt,
    ),
  ],
);

/**
 * One typed stop intent for an exact prompt attempt. The attempt is the sole
 * prompt-identity owner, so cancellation never copies a run/ref/segment union.
 */
export const taskExecutionCancellationIntents = pgTable(
  "task_execution_cancellation_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    runId: uuid("run_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    leaseId: uuid("lease_id"),
    reasonKind: text("reason_kind")
      .$type<"lifecycle" | "authority" | "timeout" | "lease_expired">()
      .notNull(),
    actorKind: text("actor_kind")
      .$type<"system" | "user" | "agent">()
      .notNull(),
    actorUserId: text("actor_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    actorAgentId: uuid("actor_agent_id"),
    state: text("state")
      .$type<"requested" | "acknowledged" | "completed" | "failed">()
      .notNull()
      .default("requested"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    nativeCancellationSettledAt: timestamp("native_cancellation_settled_at", {
      withTimezone: true,
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "task_execution_cancellation_intents_reason_check",
      sql`${table.reasonKind} in (
        'lifecycle',
        'authority',
        'timeout',
        'lease_expired'
      )`,
    ),
    check(
      "task_execution_cancellation_intents_actor_check",
      sql`(
        ${table.actorKind} = 'system'
        and ${table.actorUserId} is null
        and ${table.actorAgentId} is null
      ) or (
        ${table.actorKind} = 'user'
        and ${table.actorUserId} is not null
        and ${table.actorAgentId} is null
      ) or (
        ${table.actorKind} = 'agent'
        and ${table.actorUserId} is null
        and ${table.actorAgentId} is not null
      )`,
    ),
    check(
      "task_execution_cancellation_intents_state_check",
      sql`${table.state} in ('requested', 'acknowledged', 'completed', 'failed')`,
    ),
    check(
      "task_execution_cancellation_intents_state_time_check",
      sql`(
        ${table.state} = 'requested'
        and ${table.acknowledgedAt} is null
        and ${table.completedAt} is null
        and ${table.failedAt} is null
        and ${table.failureCode} is null
      ) or (
        ${table.state} = 'acknowledged'
        and ${table.acknowledgedAt} is not null
        and ${table.completedAt} is null
        and ${table.failedAt} is null
        and ${table.failureCode} is null
      ) or (
        ${table.state} = 'completed'
        and ${table.acknowledgedAt} is not null
        and ${table.completedAt} is not null
        and ${table.failedAt} is null
        and ${table.failureCode} is null
      ) or (
        ${table.state} = 'failed'
        and ${table.completedAt} is null
        and ${table.failedAt} is not null
        and ${table.failureCode} is not null
        and length(btrim(${table.failureCode})) between 1 and 200
      )`,
    ),
    check(
      "task_execution_cancellation_intents_time_check",
      sql`${table.requestedAt} >= ${table.createdAt}
        and (
          ${table.acknowledgedAt} is null
          or ${table.acknowledgedAt} >= ${table.requestedAt}
        )
        and (
          ${table.nativeCancellationSettledAt} is null
          or ${table.nativeCancellationSettledAt} >= ${table.requestedAt}
        )
        and (
          ${table.completedAt} is null
          or ${table.completedAt} >= ${table.requestedAt}
        )
        and (
          ${table.failedAt} is null
          or ${table.failedAt} >= ${table.requestedAt}
        )`,
    ),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.runId,
        table.attemptId,
      ],
      foreignColumns: [
        taskExecutionAttempts.companyId,
        taskExecutionAttempts.taskId,
        taskExecutionAttempts.runId,
        taskExecutionAttempts.id,
      ],
      name: "task_execution_cancellation_intents_attempt_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.runId,
        table.attemptId,
        table.leaseId,
      ],
      foreignColumns: [
        taskExecutionLeases.companyId,
        taskExecutionLeases.taskId,
        taskExecutionLeases.runId,
        taskExecutionLeases.attemptId,
        taskExecutionLeases.id,
      ],
      name: "task_execution_cancellation_intents_lease_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.actorAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "task_execution_cancellation_intents_actor_agent_fk",
    }).onDelete("restrict"),
    unique("task_execution_cancellation_intents_attempt_uq").on(
      table.attemptId,
    ),
    unique("task_execution_cancellation_intents_scope_id_uq").on(
      table.companyId,
      table.taskId,
      table.runId,
      table.attemptId,
      table.id,
    ),
    index("task_execution_cancellation_intents_state_idx").on(
      table.companyId,
      table.state,
      table.requestedAt,
    ),
  ],
);

/** Immutable five-field productive-run classification owned by finalization. */
export const taskExecutionRunLivenessFacts = pgTable(
  "task_execution_run_liveness_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    runId: uuid("run_id").notNull(),
    livenessState: text("liveness_state").$type<RunLivenessState>().notNull(),
    livenessReason: text("liveness_reason").notNull(),
    continuationAttempt: integer("continuation_attempt").notNull(),
    lastUsefulActionAt: timestamp("last_useful_action_at", {
      withTimezone: true,
    }),
    nextAction: text("next_action"),
  },
  (table) => [
    check(
      "task_execution_run_liveness_facts_state_check",
      sql`${table.livenessState} in (
        'completed',
        'advanced',
        'plan_only',
        'empty_response',
        'blocked',
        'failed',
        'needs_followup'
      )`,
    ),
    check(
      "task_execution_run_liveness_facts_payload_check",
      sql`length(btrim(${table.livenessReason})) between 1 and 500
        and ${table.continuationAttempt} >= 0
        and (
          ${table.nextAction} is null
          or length(btrim(${table.nextAction})) between 1 and 500
        )`,
    ),
    foreignKey({
      columns: [table.companyId, table.runId],
      foreignColumns: [taskExecutionRuns.companyId, taskExecutionRuns.id],
      name: "task_execution_run_liveness_facts_run_fk",
    }).onDelete("cascade"),
    unique("task_execution_run_liveness_facts_run_uq").on(table.runId),
    unique("task_execution_run_liveness_facts_run_id_uq").on(
      table.runId,
      table.id,
    ),
  ],
);

/** Reference-only, text-free terminal finalization identity. */
export const taskExecutionFinalizations = pgTable(
  "task_execution_finalizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    runId: uuid("run_id").notNull(),
    finalizationIdentityDigest: text("finalization_identity_digest").notNull(),
    action: text("action").$type<TaskExecutionFinalizationAction>().notNull(),
    terminalSessionEventId: text("terminal_session_event_id").references(
      () => taskSessionEvents.id,
      { onDelete: "restrict" },
    ),
    terminalSessionMessageId: text("terminal_session_message_id").references(
      () => taskSessionMessages.id,
      { onDelete: "restrict" },
    ),
    progressCommentId: uuid("progress_comment_id").references(
      () => taskComments.id,
      { onDelete: "restrict" },
    ),
    gatewayCapabilityConnectionId: uuid(
      "gateway_capability_connection_id",
    ),
    gatewayCapabilityGeneration: integer(
      "gateway_capability_generation",
    ),
    runLivenessFactId: uuid("run_liveness_fact_id"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "task_execution_finalizations_action_check",
      sql`${table.action} in (
        'comment_only',
        'updates_committed',
        'no_conversational_output'
      )`,
    ),
    check(
      "task_execution_finalizations_identity_digest_check",
      sql`length(${table.finalizationIdentityDigest}) = 64
        and ${table.finalizationIdentityDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "task_execution_finalizations_gateway_revocation_check",
      sql`(
        ${table.gatewayCapabilityConnectionId} is null
        and ${table.gatewayCapabilityGeneration} is null
      ) or (
        ${table.gatewayCapabilityConnectionId} is not null
        and ${table.gatewayCapabilityGeneration} is not null
        and ${table.gatewayCapabilityGeneration} > 0
      )`,
    ),
    check(
      "task_execution_finalizations_reference_shape_check",
      sql`(
        ${table.action} = 'comment_only'
        and ${table.terminalSessionEventId} is not null
        and ${table.terminalSessionMessageId} is not null
        and ${table.progressCommentId} is not null
      ) or (
        ${table.action} = 'updates_committed'
        and ${table.terminalSessionEventId} is not null
        and ${table.terminalSessionMessageId} is null
        and ${table.progressCommentId} is not null
      ) or (
        ${table.action} = 'no_conversational_output'
        and ${table.terminalSessionMessageId} is null
      )`,
    ),
    check(
      "task_execution_finalizations_time_check",
      sql`${table.finalizedAt} >= ${table.createdAt}`,
    ),
    foreignKey({
      columns: [table.companyId, table.runId],
      foreignColumns: [taskExecutionRuns.companyId, taskExecutionRuns.id],
      name: "task_execution_finalizations_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId, table.runLivenessFactId],
      foreignColumns: [
        taskExecutionRunLivenessFacts.runId,
        taskExecutionRunLivenessFacts.id,
      ],
      name: "task_execution_finalizations_liveness_fact_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.gatewayCapabilityConnectionId,
        table.gatewayCapabilityGeneration,
      ],
      foreignColumns: [
        taskExecutionPromptCapabilities.capabilityConnectionId,
        taskExecutionPromptCapabilities.capabilityGeneration,
      ],
      name: "task_execution_finalizations_gateway_revocation_fk",
    }).onDelete("restrict"),
    unique("task_execution_finalizations_run_uq").on(table.runId),
    unique("task_execution_finalizations_company_run_id_uq").on(
      table.companyId,
      table.runId,
      table.id,
    ),
  ],
);

/**
 * Immutable traversal of every prompt settlement authorized by one run
 * finalization. Conversational input and output remain in their canonical
 * Session owners; this table stores identities and settlement versions only.
 */
export const taskExecutionFinalizationPromptDependencies = pgTable(
  "task_execution_finalization_prompt_dependencies",
  {
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    runId: uuid("run_id").notNull(),
    finalizationId: uuid("finalization_id").notNull(),
    dependencyOrdinal: integer("dependency_ordinal").notNull(),
    refId: uuid("ref_id"),
    refOrdinal: integer("ref_ordinal"),
    protocolSettlementState: text("protocol_settlement_state")
      .$type<TaskExecutionProtocolSettlementState>()
      .notNull(),
    settlementVersion: integer("settlement_version").notNull(),
    accountingId: uuid("accounting_id"),
    costEventId: uuid("cost_event_id"),
  },
  (table) => [
    primaryKey({
      columns: [table.finalizationId, table.dependencyOrdinal],
      name: "task_execution_finalization_prompt_dependencies_pk",
    }),
    check(
      "task_execution_finalization_prompt_dependencies_ordinal_check",
      sql`${table.dependencyOrdinal} >= 0
        and ${table.settlementVersion} > 0`,
    ),
    check(
      "task_execution_finalization_prompt_dependencies_identity_check",
      sql`${table.refId} is not null
        and ${table.refOrdinal} is not null
        and ${table.refOrdinal} >= 0`,
    ),
    check(
      "task_execution_finalization_prompt_dependencies_settlement_check",
      sql`(
        ${table.protocolSettlementState} = 'settled'
        and ${table.accountingId} is not null
        and ${table.costEventId} is not null
      ) or (
        ${table.protocolSettlementState} in ('not_sent', 'incomplete')
        and ${table.accountingId} is null
        and ${table.costEventId} is null
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.runId, table.finalizationId],
      foreignColumns: [
        taskExecutionFinalizations.companyId,
        taskExecutionFinalizations.runId,
        taskExecutionFinalizations.id,
      ],
      name: "task_execution_finalization_prompt_dependencies_finalization_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.runId,
        table.refOrdinal,
        table.refId,
      ],
      foreignColumns: [
        taskExecutionRunRefs.companyId,
        taskExecutionRunRefs.taskId,
        taskExecutionRunRefs.runId,
        taskExecutionRunRefs.refOrdinal,
        taskExecutionRunRefs.refId,
      ],
      name: "task_execution_finalization_prompt_dependencies_run_ref_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.runId,
        table.accountingId,
      ],
      foreignColumns: [
        acpPromptAccounting.companyId,
        acpPromptAccounting.taskId,
        acpPromptAccounting.runId,
        acpPromptAccounting.id,
      ],
      name: "task_execution_finalization_prompt_dependencies_accounting_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.costEventId],
      foreignColumns: [costEvents.id],
      name: "task_execution_finalization_prompt_dependencies_cost_fk",
    }).onDelete("restrict"),
    unique("task_execution_finalization_prompt_dependencies_prompt_uq").on(
      table.finalizationId,
      table.refId,
    ),
    index("task_execution_finalization_prompt_dependencies_run_idx").on(
      table.companyId,
      table.runId,
      table.dependencyOrdinal,
    ),
  ],
);

/** Ordered references to the accepted task updates owned by a finalization. */
export const taskExecutionFinalizationUpdateDependencies = pgTable(
  "task_execution_finalization_update_dependencies",
  {
    companyId: uuid("company_id").notNull(),
    runId: uuid("run_id").notNull(),
    finalizationId: uuid("finalization_id").notNull(),
    dependencyOrdinal: integer("dependency_ordinal").notNull(),
    taskUpdateId: uuid("task_update_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.finalizationId, table.dependencyOrdinal],
      name: "task_execution_finalization_update_dependencies_pk",
    }),
    check(
      "task_execution_finalization_update_dependencies_ordinal_check",
      sql`${table.dependencyOrdinal} >= 0`,
    ),
    foreignKey({
      columns: [table.companyId, table.runId, table.finalizationId],
      foreignColumns: [
        taskExecutionFinalizations.companyId,
        taskExecutionFinalizations.runId,
        taskExecutionFinalizations.id,
      ],
      name: "task_execution_finalization_update_dependencies_finalization_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.taskUpdateId],
      foreignColumns: [taskUpdates.id],
      name: "task_execution_finalization_update_dependencies_update_fk",
    }).onDelete("restrict"),
    unique("task_execution_finalization_update_dependencies_update_uq").on(
      table.finalizationId,
      table.taskUpdateId,
    ),
    index("task_execution_finalization_update_dependencies_run_idx").on(
      table.companyId,
      table.runId,
      table.dependencyOrdinal,
    ),
  ],
);

export type TaskExecutionRun = typeof taskExecutionRuns.$inferSelect;
export type NewTaskExecutionRun = typeof taskExecutionRuns.$inferInsert;
export type TaskExecutionRunRef = typeof taskExecutionRunRefs.$inferSelect;
export type NewTaskExecutionRunRef = typeof taskExecutionRunRefs.$inferInsert;
export type TaskExecutionRunControl =
  typeof taskExecutionRunControls.$inferSelect;
export type TaskExecutionAttempt = typeof taskExecutionAttempts.$inferSelect;
export type NewTaskExecutionAttempt =
  typeof taskExecutionAttempts.$inferInsert;
export type TaskExecutionAttemptRetrySchedule =
  typeof taskExecutionAttemptRetrySchedules.$inferSelect;
export type NewTaskExecutionAttemptRetrySchedule =
  typeof taskExecutionAttemptRetrySchedules.$inferInsert;
export type TaskExecutionLease = typeof taskExecutionLeases.$inferSelect;
export type NewTaskExecutionLease = typeof taskExecutionLeases.$inferInsert;
export type TaskExecutionCancellationIntent =
  typeof taskExecutionCancellationIntents.$inferSelect;
export type NewTaskExecutionCancellationIntent =
  typeof taskExecutionCancellationIntents.$inferInsert;
export type TaskExecutionRunLivenessFactRow =
  typeof taskExecutionRunLivenessFacts.$inferSelect;
export type TaskExecutionFinalization =
  typeof taskExecutionFinalizations.$inferSelect;
export type NewTaskExecutionFinalization =
  typeof taskExecutionFinalizations.$inferInsert;
export type TaskExecutionFinalizationPromptDependency =
  typeof taskExecutionFinalizationPromptDependencies.$inferSelect;
export type NewTaskExecutionFinalizationPromptDependency =
  typeof taskExecutionFinalizationPromptDependencies.$inferInsert;
export type TaskExecutionFinalizationUpdateDependency =
  typeof taskExecutionFinalizationUpdateDependencies.$inferSelect;
export type NewTaskExecutionFinalizationUpdateDependency =
  typeof taskExecutionFinalizationUpdateDependencies.$inferInsert;
