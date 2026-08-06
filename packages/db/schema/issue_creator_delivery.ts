import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AgentVisibleIssueStatus,
  IssueCreatorEdgeTerminalReason,
  IssueCreatorKind,
  IssueDisposition,
  SystemCreatorSourceKind,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { issueExecutionRuns } from "./issue_execution_runs.js";
import { issueComments } from "./issue_comments.js";
import {
  issueExecutionAuthorities,
  issueExecutionRefs,
} from "./issue_execution_runtime.js";
import { issues } from "./issues.js";
import { issueSessions } from "./issue_sessions.js";

type CreatorDeliveryPolicySnapshot = {
  maxRetryAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  pausedOrBudgetStoppedStalenessMs: number;
};

export const issueCreatorEdgeReceivability = pgTable(
  "issue_creator_edge_receivability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    admissionVersion: integer("admission_version").notNull().default(1),
    creatorKind: text("creator_kind").$type<IssueCreatorKind>().notNull(),
    endpointKind: text("endpoint_kind")
      .$type<"agent-execution" | "user/board" | "plugin" | "routine" | "system">()
      .notNull(),
    endpointId: text("endpoint_id"),
    endpointSnapshot: jsonb("endpoint_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    endpointTombstone: jsonb("endpoint_tombstone").$type<Record<
      string,
      unknown
    > | null>(),
    state: text("state").$type<"receivable" | "terminal">().notNull().default("receivable"),
    terminalReason: text("terminal_reason")
      .$type<IssueCreatorEdgeTerminalReason>(),
    terminalSourceKind: text("terminal_source_kind"),
    terminalSourceId: text("terminal_source_id"),
    terminalAudit: jsonb("terminal_audit").$type<Record<string, unknown> | null>(),
    terminalizedAt: timestamp("terminalized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "issue_creator_edge_receivability_creator_kind_check",
      sql`${table.creatorKind} in ('agent-execution', 'user/board', 'plugin', 'routine', 'system')`,
    ),
    check(
      "issue_creator_edge_receivability_endpoint_kind_check",
      sql`${table.endpointKind} in ('agent-execution', 'user/board', 'plugin', 'routine', 'system')
        and ${table.endpointKind} = ${table.creatorKind}`,
    ),
    check(
      "issue_creator_edge_receivability_state_check",
      sql`${table.state} in ('receivable', 'terminal')`,
    ),
    check(
      "issue_creator_edge_receivability_admission_version_check",
      sql`${table.admissionVersion} > 0`,
    ),
    check(
      "issue_creator_edge_receivability_terminal_check",
      sql`(
        ${table.state} = 'receivable'
        and ${table.terminalReason} is null
        and ${table.terminalizedAt} is null
      ) or (
        ${table.state} = 'terminal'
        and ${table.terminalReason} is not null
        and ${table.terminalSourceKind} is not null
        and ${table.terminalSourceId} is not null
        and ${table.terminalizedAt} is not null
      )`,
    ),
    check(
      "issue_creator_edge_receivability_terminal_reason_check",
      sql`${table.terminalReason} is null or ${table.terminalReason} in (
        'delivery_exhausted',
        'paused_or_budget_staleness',
        'creator_execution_superseded',
        'agent_terminated',
        'agent_deleted',
        'plugin_disabled',
        'plugin_uninstalled',
        'routine_deleted'
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_creator_edge_receivability_scope_fk",
    }).onDelete("cascade"),
    unique("issue_creator_edge_receivability_scope_id_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.id,
    ),
    unique("issue_creator_edge_receivability_admission_identity_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.id,
      table.admissionVersion,
    ),
    unique("issue_creator_edge_receivability_epoch_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
    ),
    index("issue_creator_edge_receivability_current_idx").on(
      table.companyId,
      table.issueId,
      table.state,
    ),
    index("issue_creator_edge_receivability_endpoint_idx").on(
      table.companyId,
      table.endpointKind,
      table.endpointId,
      table.state,
    ),
  ],
);

export const issueUpdates = pgTable(
  "issue_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    form: text("form").$type<"owner" | "creator">().notNull(),
    sourceKind: text("source_kind")
      .$type<"agent-execution" | "user/board" | "plugin" | "routine" | "system">()
      .notNull(),
    sourceAuthorityId: uuid("source_authority_id"),
    sourceIdentity: jsonb("source_identity").$type<Record<string, unknown>>().notNull(),
    runId: uuid("run_id"),
    gatewayInvocationId: text("gateway_invocation_id").notNull(),
    runSequence: integer("run_sequence").notNull(),
    message: text("message").notNull(),
    status: text("status").$type<AgentVisibleIssueStatus>(),
    disposition: jsonb("disposition").$type<IssueDisposition | null>(),
    commentId: uuid("comment_id").notNull(),
    creatorEdgeId: uuid("creator_edge_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "issue_updates_form_check",
      sql`${table.form} in ('owner', 'creator')`,
    ),
    check(
      "issue_updates_source_kind_check",
      sql`${table.sourceKind} in ('agent-execution', 'user/board', 'plugin', 'routine', 'system')`,
    ),
    check(
      "issue_updates_status_check",
      sql`${table.status} is null or ${table.status} in ('open', 'blocked', 'done', 'cancelled')`,
    ),
    check(
      "issue_updates_message_check",
      sql`char_length(${table.message}) > 0`,
    ),
    check(
      "issue_updates_form_shape_check",
      sql`(
        ${table.form} = 'creator'
        and ${table.status} is null
        and ${table.disposition} is null
      ) or (
        ${table.form} = 'owner'
        and (
          (${table.status} is null and ${table.disposition} is null)
          or (
            ${table.status} is not null
            and (
              (${table.status} in ('open', 'blocked') and ${table.disposition} is null)
              or (
                ${table.status} in ('done', 'cancelled')
                and ${table.disposition} is not null
                and jsonb_typeof(${table.disposition}) = 'object'
                and ${table.disposition} ? 'message'
                and jsonb_typeof(${table.disposition} -> 'message') = 'string'
                and btrim(${table.disposition} ->> 'message') <> ''
                and ${table.disposition} - 'message' - 'structuredResult' = '{}'::jsonb
              )
            )
          )
        )
      )`,
    ),
    check("issue_updates_run_sequence_check", sql`${table.runSequence} >= 0`),
    check(
      "issue_updates_creator_edge_check",
      sql`${table.creatorEdgeId} is not null or (
        ${table.form} = 'owner'
        and ${table.sourceKind} = 'plugin'
        and ${table.runId} is null
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_updates_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.creatorEdgeId,
      ],
      foreignColumns: [
        issueCreatorEdgeReceivability.companyId,
        issueCreatorEdgeReceivability.issueId,
        issueCreatorEdgeReceivability.ownershipEpoch,
        issueCreatorEdgeReceivability.id,
      ],
      name: "issue_updates_creator_edge_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.runId],
      foreignColumns: [issueExecutionRuns.companyId, issueExecutionRuns.id],
      name: "issue_updates_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.sourceAuthorityId],
      foreignColumns: [
        issueExecutionAuthorities.companyId,
        issueExecutionAuthorities.id,
      ],
      name: "issue_updates_source_authority_fk",
    }).onDelete("restrict"),
    unique("issue_updates_scope_id_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.id,
    ),
    uniqueIndex("issue_updates_gateway_invocation_uq").on(
      table.companyId,
      table.gatewayInvocationId,
    ),
    uniqueIndex("issue_updates_run_sequence_uq").on(
      table.companyId,
      table.runId,
      table.runSequence,
    ),
    uniqueIndex("issue_updates_comment_uq").on(table.commentId),
    index("issue_updates_issue_sequence_idx").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.createdAt,
    ),
  ],
);

export const creatorDeliveries = pgTable(
  "creator_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    creatorEdgeId: uuid("creator_edge_id").notNull(),
    issueUpdateId: uuid("issue_update_id").notNull(),
    commentId: uuid("comment_id").notNull(),
    recipientKind: text("recipient_kind")
      .$type<"agent-execution" | "user/board" | "plugin" | "routine" | "system">()
      .notNull(),
    recipientRef: jsonb("recipient_ref").$type<Record<string, unknown>>().notNull(),
    direction: text("direction").$type<"to_creator" | "to_owner">().notNull(),
    counterpartExecutionKey: text("counterpart_execution_key").notNull(),
    committedSequence: integer("committed_sequence").notNull(),
    deliveryId: text("delivery_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state")
      .$type<
        | "pending"
        | "leased"
        | "retryable"
        | "delivered"
        | "exhausted"
        | "permanently_unreceivable"
      >()
      .notNull()
      .default("pending"),
    policySnapshot: jsonb("policy_snapshot").$type<CreatorDeliveryPolicySnapshot>().notNull(),
    firstQueuedAt: timestamp("first_queued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    heldSince: timestamp("held_since", { withTimezone: true }),
    holdReason: text("hold_reason"),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    firstLeasedAt: timestamp("first_leased_at", { withTimezone: true }),
    leasedAt: timestamp("leased_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseGeneration: integer("lease_generation").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    lastFailure: text("last_failure"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    terminalReason: text("terminal_reason"),
    counterpartRefId: uuid("counterpart_ref_id").references(
      () => issueExecutionRefs.id,
      { onDelete: "restrict" },
    ),
    fallbackAudit: jsonb("fallback_audit").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "creator_deliveries_recipient_kind_check",
      sql`${table.recipientKind} in ('agent-execution', 'user/board', 'plugin', 'routine', 'system')`,
    ),
    check(
      "creator_deliveries_direction_check",
      sql`${table.direction} in ('to_creator', 'to_owner')`,
    ),
    check(
      "creator_deliveries_committed_sequence_check",
      sql`${table.committedSequence} >= 0`,
    ),
    check(
      "creator_deliveries_state_check",
      sql`${table.state} in (
        'pending',
        'leased',
        'retryable',
        'delivered',
        'exhausted',
        'permanently_unreceivable'
      )`,
    ),
    check(
      "creator_deliveries_terminal_check",
      sql`(
        ${table.state} = 'delivered'
        and ${table.deliveredAt} is not null
        and ${table.terminalAt} is not null
      ) or (
        ${table.state} in ('exhausted', 'permanently_unreceivable')
        and ${table.terminalAt} is not null
        and ${table.terminalReason} is not null
      ) or ${table.state} in ('pending', 'leased', 'retryable')`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "creator_deliveries_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.creatorEdgeId,
      ],
      foreignColumns: [
        issueCreatorEdgeReceivability.companyId,
        issueCreatorEdgeReceivability.issueId,
        issueCreatorEdgeReceivability.ownershipEpoch,
        issueCreatorEdgeReceivability.id,
      ],
      name: "creator_deliveries_edge_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.issueUpdateId,
      ],
      foreignColumns: [
        issueUpdates.companyId,
        issueUpdates.issueId,
        issueUpdates.ownershipEpoch,
        issueUpdates.id,
      ],
      name: "creator_deliveries_update_fk",
    }).onDelete("restrict"),
    unique("creator_deliveries_scope_id_uq").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.id,
    ),
    unique("creator_deliveries_company_issue_id_uq").on(
      table.companyId,
      table.issueId,
      table.id,
    ),
    uniqueIndex("creator_deliveries_delivery_id_uq").on(table.deliveryId),
    uniqueIndex("creator_deliveries_idempotency_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    uniqueIndex("creator_deliveries_update_uq").on(table.issueUpdateId),
    uniqueIndex("creator_deliveries_counterpart_sequence_uq").on(
      table.companyId,
      table.counterpartExecutionKey,
      table.committedSequence,
    ),
    index("creator_deliveries_claim_idx").on(
      table.companyId,
      table.state,
      table.retryAt,
      table.leaseExpiresAt,
      table.firstQueuedAt,
    ),
    index("creator_deliveries_counterpart_claim_idx").on(
      table.companyId,
      table.counterpartExecutionKey,
      table.committedSequence,
      table.state,
    ),
    index("creator_deliveries_edge_state_idx").on(table.creatorEdgeId, table.state),
    index("creator_deliveries_hold_idx").on(
      table.companyId,
      table.holdReason,
      table.heldSince,
    ),
  ],
);

export const pluginCreatorDeliveries = pgTable(
  "plugin_creator_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    creatorDeliveryId: uuid("creator_delivery_id").notNull(),
    /** Immutable operation actor identity; intentionally not a live installation FK. */
    pluginInstallationId: uuid("plugin_installation_id").notNull(),
    pluginKey: text("plugin_key").notNull(),
    callbackKey: text("callback_key").notNull(),
    callbackVersion: text("callback_version").notNull(),
    committedSequence: integer("committed_sequence").notNull(),
    deliveryId: text("delivery_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    state: text("state")
      .$type<
        | "pending"
        | "leased"
        | "retryable"
        | "delivered"
        | "exhausted"
        | "permanently_unreceivable"
      >()
      .notNull()
      .default("pending"),
    policySnapshot: jsonb("policy_snapshot").$type<CreatorDeliveryPolicySnapshot>().notNull(),
    firstQueuedAt: timestamp("first_queued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    heldSince: timestamp("held_since", { withTimezone: true }),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    firstLeasedAt: timestamp("first_leased_at", { withTimezone: true }),
    leasedAt: timestamp("leased_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseGeneration: integer("lease_generation").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    lastFailure: text("last_failure"),
    acknowledgement: jsonb("acknowledgement").$type<{
      deliveryId: string;
      accepted: true;
    } | null>(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    terminalReason: text("terminal_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "plugin_creator_deliveries_state_check",
      sql`${table.state} in (
        'pending',
        'leased',
        'retryable',
        'delivered',
        'exhausted',
        'permanently_unreceivable'
      )`,
    ),
    check(
      "plugin_creator_deliveries_ack_check",
      sql`(
        ${table.state} = 'delivered'
        and ${table.acknowledgement} is not null
        and ${table.deliveredAt} is not null
        and ${table.terminalAt} is not null
      ) or (
        ${table.state} in ('exhausted', 'permanently_unreceivable')
        and ${table.terminalAt} is not null
        and ${table.terminalReason} is not null
      ) or ${table.state} in ('pending', 'leased', 'retryable')`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "plugin_creator_deliveries_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.issueId, table.creatorDeliveryId],
      foreignColumns: [
        creatorDeliveries.companyId,
        creatorDeliveries.issueId,
        creatorDeliveries.id,
      ],
      name: "plugin_creator_deliveries_delivery_fk",
    }).onDelete("restrict"),
    uniqueIndex("plugin_creator_deliveries_creator_delivery_uq").on(
      table.creatorDeliveryId,
    ),
    uniqueIndex("plugin_creator_deliveries_delivery_id_uq").on(table.deliveryId),
    uniqueIndex("plugin_creator_deliveries_callback_sequence_uq").on(
      table.pluginInstallationId,
      table.pluginKey,
      table.callbackKey,
      table.callbackVersion,
      table.committedSequence,
    ),
    uniqueIndex("plugin_creator_deliveries_idempotency_uq").on(
      table.pluginInstallationId,
      table.idempotencyKey,
    ),
    index("plugin_creator_deliveries_claim_idx").on(
      table.companyId,
      table.state,
      table.retryAt,
      table.leaseExpiresAt,
      table.firstQueuedAt,
    ),
  ],
);

export const pluginWithdrawalOperations = pgTable(
  "plugin_withdrawal_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Immutable operation actor identity; intentionally not a live installation FK. */
    pluginInstallationId: uuid("plugin_installation_id").notNull(),
    pluginKey: text("plugin_key").notNull(),
    hostRpcOperationId: text("host_rpc_operation_id").notNull(),
    identityDigest: text("identity_digest").notNull(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "restrict" }),
    message: text("message").notNull(),
    state: text("state").$type<"pending" | "accepted" | "rejected">().notNull(),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    issueUpdateId: uuid("issue_update_id").references(() => issueUpdates.id, {
      onDelete: "restrict",
    }),
    mutationCommentId: uuid("mutation_comment_id").references(() => issueComments.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "plugin_withdrawal_operations_state_check",
      sql`${table.state} in ('pending', 'accepted', 'rejected')`,
    ),
    check(
      "plugin_withdrawal_operations_result_check",
      sql`(
        ${table.state} = 'pending'
        and ${table.result} is null
        and ${table.issueUpdateId} is null
        and ${table.mutationCommentId} is null
        and ${table.completedAt} is null
      ) or (
        ${table.state} = 'accepted'
        and ${table.result} is not null
        and ${table.issueUpdateId} is not null
        and ${table.mutationCommentId} is not null
        and ${table.completedAt} is not null
      ) or (
        ${table.state} = 'rejected'
        and ${table.result} is not null
        and ${table.issueUpdateId} is null
        and ${table.mutationCommentId} is null
        and ${table.completedAt} is not null
      )`,
    ),
    uniqueIndex("plugin_withdrawal_operations_rpc_uq").on(
      table.pluginInstallationId,
      table.hostRpcOperationId,
    ),
    unique("plugin_withdrawal_operations_command_source_uq").on(
      table.companyId,
      table.issueId,
      table.id,
      table.pluginInstallationId,
      table.pluginKey,
      table.issueUpdateId,
    ),
    index("plugin_withdrawal_operations_issue_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
  ],
);

export const systemEscalationIdentities = pgTable(
  "system_escalation_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    affectedIssueId: uuid("affected_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "restrict" }),
    affectedOwnershipEpoch: integer("affected_ownership_epoch").notNull(),
    escalationIssueId: uuid("escalation_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "restrict" }),
    systemSource: text("system_source")
      .$type<SystemCreatorSourceKind>()
      .notNull(),
    triggeringRunId: uuid("triggering_run_id").references(() => issueExecutionRuns.id, {
      onDelete: "restrict",
    }),
    terminalCreatorEdgeId: uuid("terminal_creator_edge_id")
      .notNull()
      .references(() => issueCreatorEdgeReceivability.id, {
        onDelete: "restrict",
      }),
    immutableSource: jsonb("immutable_source")
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "system_escalation_identities_source_check",
      sql`${table.systemSource} in ('watchdog', 'recovery', 'liveness')`,
    ),
    check(
      "system_escalation_identities_distinct_issue_check",
      sql`${table.affectedIssueId} <> ${table.escalationIssueId}`,
    ),
    uniqueIndex("system_escalation_identities_affected_epoch_uq").on(
      table.companyId,
      table.affectedIssueId,
      table.affectedOwnershipEpoch,
    ),
    uniqueIndex("system_escalation_identities_escalation_issue_uq").on(
      table.companyId,
      table.escalationIssueId,
    ),
    unique(
      "system_escalation_identities_command_source_uq",
    ).on(
      table.companyId,
      table.escalationIssueId,
      table.id,
    ),
    index("system_escalation_identities_source_idx").on(
      table.companyId,
      table.systemSource,
      table.createdAt,
    ),
  ],
);
