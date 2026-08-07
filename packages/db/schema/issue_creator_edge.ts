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
import { issueExecutionAuthorities } from "./issue_execution_runtime.js";
import { issues } from "./issues.js";
import { issueSessions } from "./issue_sessions.js";

// Immutable creator provenance plus the single canonical issue-update ledger.
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
        (${table.status} is null and ${table.disposition} is null)
        or (
          ${table.status} in ('open', 'blocked')
          and ${table.disposition} is null
          and (
            ${table.form} <> 'creator'
            or ${table.sourceKind} = 'agent-execution'
          )
        ) or (
          ${table.form} = 'owner'
          and ${table.status} in ('done', 'cancelled')
          and ${table.disposition} is not null
          and jsonb_typeof(${table.disposition}) = 'object'
          and ${table.disposition} ? 'message'
          and jsonb_typeof(${table.disposition} -> 'message') = 'string'
          and btrim(${table.disposition} ->> 'message') <> ''
          and ${table.disposition} - 'message' - 'structuredResult' = '{}'::jsonb
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
