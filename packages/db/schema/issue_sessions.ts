import { sql } from "drizzle-orm";
import type {
  IssueExecutionPromptTransmissionPhase,
  IssueExecutionProtocolSettlementState,
} from "@paperclipai/shared";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentAdapterConfigRevisions } from "./agent_adapter_config_revisions.js";
import { acpPromptAccounting } from "./acp_prompt_accounting.js";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { costEvents } from "./cost_events.js";
import { issueComments } from "./issue_comments.js";
import {
  issueExecutionRunRefs,
  issueExecutionRuns,
} from "./issue_execution_runs.js";
import { issues } from "./issues.js";

export type IssueSessionModelRef = {
  id: string;
  providerID: string;
  variant?: string;
};

export type IssueSessionRevertState = {
  messageID: string;
  partID?: string;
  snapshot?: string;
  diff?: string;
  files?: readonly {
    path: string;
    status: "added" | "modified" | "deleted";
    additions: number;
    deletions: number;
    patch: string;
  }[];
};

export type IssueSessionCompactionControlDisposition =
  | "active"
  | "invalidated";

type IssueSessionEventData = Record<string, unknown>;
type IssueSessionMessageData = Record<string, unknown>;
type IssueSessionPrompt = Record<string, unknown>;
type IssueSessionContextSnapshot = Record<
  string,
  {
    value: unknown;
    removed?: string;
  }
>;

export const issueSessions = pgTable(
  "issue_sessions",
  {
    id: text("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    parentSessionId: text("parent_session_id"),
    projectId: text("project_id").notNull(),
    agent: text("agent"),
    model: jsonb("model").$type<IssueSessionModelRef>(),
    cost: doublePrecision("cost"),
    tokensInput: bigint("tokens_input", { mode: "number" }),
    tokensOutput: bigint("tokens_output", { mode: "number" }),
    tokensReasoning: bigint("tokens_reasoning", { mode: "number" }),
    tokensCacheRead: bigint("tokens_cache_read", { mode: "number" }),
    tokensCacheWrite: bigint("tokens_cache_write", { mode: "number" }),
    title: text("title").notNull(),
    directory: text("directory").notNull(),
    workspaceId: text("workspace_id"),
    subpath: text("subpath"),
    revert: jsonb("revert").$type<IssueSessionRevertState>(),
    timeCreated: timestamp("time_created", { withTimezone: true }).notNull().defaultNow(),
    timeUpdated: timestamp("time_updated", { withTimezone: true }).notNull().defaultNow(),
    timeArchived: timestamp("time_archived", { withTimezone: true }),
    projectedEventSeq: bigint("projected_event_seq", { mode: "number" })
      .notNull()
      .default(-1),
    integrityState: text("integrity_state")
      .$type<"building" | "ready" | "archived" | "purge_fenced">()
      .notNull()
      .default("building"),
    migratedAt: timestamp("migrated_at", { withTimezone: true }),
    refAdmittableAt: timestamp("ref_admittable_at", { withTimezone: true }),
    purgeFencedAt: timestamp("purge_fenced_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "issue_sessions_integrity_state_check",
      sql`${table.integrityState} in ('building', 'ready', 'archived', 'purge_fenced')`,
    ),
    check(
      "issue_sessions_projected_event_seq_check",
      sql`${table.projectedEventSeq} >= -1`,
    ),
    check(
      "issue_sessions_cost_and_tokens_check",
      sql`(${table.cost} is null or ${table.cost} >= 0)
        and (
          (
            ${table.tokensInput} is null
            and ${table.tokensOutput} is null
            and ${table.tokensReasoning} is null
            and ${table.tokensCacheRead} is null
            and ${table.tokensCacheWrite} is null
          )
          or (
            ${table.tokensInput} is not null
            and ${table.tokensOutput} is not null
            and ${table.tokensReasoning} is not null
            and ${table.tokensCacheRead} is not null
            and ${table.tokensCacheWrite} is not null
            and ${table.tokensInput} >= 0
            and ${table.tokensOutput} >= 0
            and ${table.tokensReasoning} >= 0
            and ${table.tokensCacheRead} >= 0
            and ${table.tokensCacheWrite} >= 0
          )
        )`,
    ),
    check(
      "issue_sessions_time_check",
      sql`${table.timeUpdated} >= ${table.timeCreated}
        and (${table.timeArchived} is null or ${table.timeArchived} >= ${table.timeCreated})`,
    ),
    check(
      "issue_sessions_info_shape_check",
      sql`length(${table.projectId}) > 0
        and length(${table.title}) > 0
        and length(${table.directory}) > 0
        and left(${table.directory}, 1) = '/'
        and (${table.agent} is null or length(${table.agent}) > 0)
        and (${table.workspaceId} is null or length(${table.workspaceId}) > 0)
        and (${table.model} is null or jsonb_typeof(${table.model}) = 'object')
        and (${table.revert} is null or jsonb_typeof(${table.revert}) = 'object')`,
    ),
    foreignKey({
      columns: [table.companyId, table.parentSessionId],
      foreignColumns: [table.companyId, table.id],
      name: "issue_sessions_company_parent_fk",
    }).onDelete("restrict"),
    unique("issue_sessions_company_id_uq").on(table.companyId, table.id),
    unique("issue_sessions_scope_id_uq").on(table.companyId, table.issueId, table.id),
    uniqueIndex("issue_sessions_company_issue_uq").on(table.companyId, table.issueId),
    index("issue_sessions_company_parent_idx").on(table.companyId, table.parentSessionId),
    index("issue_sessions_company_integrity_idx").on(
      table.companyId,
      table.integrityState,
    ),
  ],
);

export const issueSessionEventSequences = pgTable(
  "issue_session_event_sequences",
  {
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    ownerId: text("owner_id"),
  },
  (table) => [
    check("issue_session_event_sequences_seq_check", sql`${table.seq} >= -1`),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_session_event_sequences_scope_fk",
    }).onDelete("cascade"),
    unique("issue_session_event_sequences_scope_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
    ),
    index("issue_session_event_sequences_owner_idx").on(table.ownerId),
  ],
);

/**
 * The Session owns its message-id clock. Writers advance this row under the
 * same Session lock used for event sequencing, then persist an immutable
 * reservation before publishing any event that names the message. The
 * zero-padded ordinal is intentionally the final sortable component of every
 * message id, so maximum-ID `latest()` selection remains stable after
 * reorderings.
 */
export const issueSessionMessageIdAllocators = pgTable(
  "issue_session_message_id_allocators",
  {
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").primaryKey(),
    lastOrdinal: bigint("last_ordinal", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "issue_session_message_id_allocators_ordinal_check",
      sql`${table.lastOrdinal} >= 0`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_session_message_id_allocators_scope_fk",
    }).onDelete("cascade"),
    unique("issue_session_message_id_allocators_scope_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
    ),
  ],
);

/**
 * A reservation is the durable, idempotent proof that a canonical V2 message
 * id was allocated. Keeping it after projection makes duplicate delivery and
 * crash recovery reuse the exact id instead of deriving a hash or timestamp.
 */
export const issueSessionMessageIdReservations = pgTable(
  "issue_session_message_id_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    reservationKey: text("reservation_key").notNull(),
    ordinal: bigint("ordinal", { mode: "number" }).notNull(),
    messageId: text("message_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "issue_session_message_id_reservations_value_check",
      sql`${table.ordinal} > 0
        and btrim(${table.reservationKey}) <> ''
        and length(${table.reservationKey}) <= 500
        and ${table.messageId} = (
          'msg_' || ${table.sessionId} || '_' || lpad(${table.ordinal}::text, 19, '0')
        )`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_session_message_id_reservations_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [
        issueSessionMessageIdAllocators.companyId,
        issueSessionMessageIdAllocators.issueId,
        issueSessionMessageIdAllocators.sessionId,
      ],
      name: "issue_session_message_id_reservations_allocator_fk",
    }).onDelete("cascade"),
    unique("issue_session_message_id_reservations_scope_key_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
      table.reservationKey,
    ),
    unique("issue_session_message_id_reservations_scope_ordinal_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
      table.ordinal,
    ),
    unique("issue_session_message_id_reservations_scope_message_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
      table.messageId,
    ),
    uniqueIndex("issue_session_message_id_reservations_message_uq").on(
      table.messageId,
    ),
    index("issue_session_message_id_reservations_scope_ordinal_idx").on(
      table.sessionId,
      table.ordinal,
    ),
  ],
);

export const issueSessionEvents = pgTable(
  "issue_session_events",
  {
    id: text("id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type<IssueSessionEventData>().notNull(),
    runId: uuid("run_id"),
    ownershipEpoch: integer("ownership_epoch"),
    agentId: uuid("agent_id"),
    adapterConfigRevisionId: uuid("adapter_config_revision_id"),
    sourceKind: text("source_kind"),
    sourceId: text("source_id"),
    immutableSourceKey: text("immutable_source_key"),
    sourceRecordId: text("source_record_id"),
    sourceIdentityDigest: text("source_identity_digest"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "issue_session_events_type_check",
      sql`${table.type} in (
        'session.next.agent.switched.1',
        'session.next.model.switched.1',
        'session.next.moved.1',
        'session.next.prompted.1',
        'session.next.prompt.admitted.1',
        'session.next.context.updated.1',
        'session.next.synthetic.1',
        'session.next.shell.started.1',
        'session.next.shell.ended.1',
        'session.next.step.started.1',
        'session.next.step.ended.3',
        'session.next.step.failed.2',
        'session.next.text.started.1',
        'session.next.text.ended.1',
        'session.next.reasoning.started.1',
        'session.next.reasoning.ended.1',
        'session.next.tool.input.started.1',
        'session.next.tool.input.ended.1',
        'session.next.tool.called.1',
        'session.next.tool.progress.1',
        'session.next.tool.success.1',
        'session.next.tool.failed.1',
        'session.next.retried.1',
        'session.next.compaction.started.1',
        'session.next.compaction.ended.1',
        'session.next.revert.staged.1',
        'session.next.revert.cleared.1',
        'session.next.revert.committed.1'
      )`,
    ),
    check(
      "issue_session_events_data_check",
      sql`jsonb_typeof(${table.data}) = 'object'
        and not (${table.data} ? 'id')
        and not (${table.data} ? 'type')
        and not (${table.data} ? 'durable')
        and not (${table.data} ? 'metadata')`,
    ),
    check("issue_session_events_seq_check", sql`${table.seq} >= 0`),
    check(
      "issue_session_events_source_identity_check",
      sql`(
        ${table.sourceKind} is null
        and ${table.sourceId} is null
        and ${table.immutableSourceKey} is null
        and ${table.sourceRecordId} is null
        and ${table.sourceIdentityDigest} is null
      ) or (
        ${table.sourceKind} is not null
        and length(${table.sourceKind}) > 0
        and ${table.sourceId} is not null
        and length(${table.sourceId}) > 0
        and ${table.immutableSourceKey} is not null
        and length(${table.immutableSourceKey}) > 0
        and ${table.sourceRecordId} is not null
        and length(${table.sourceRecordId}) > 0
        and ${table.sourceIdentityDigest} is not null
        and length(${table.sourceIdentityDigest}) = 64
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_session_events_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [
        issueSessionEventSequences.companyId,
        issueSessionEventSequences.issueId,
        issueSessionEventSequences.sessionId,
      ],
      name: "issue_session_events_sequence_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.runId],
      foreignColumns: [issueExecutionRuns.companyId, issueExecutionRuns.id],
      name: "issue_session_events_company_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "issue_session_events_company_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.agentId, table.adapterConfigRevisionId],
      foreignColumns: [
        agentAdapterConfigRevisions.companyId,
        agentAdapterConfigRevisions.agentId,
        agentAdapterConfigRevisions.id,
      ],
      name: "issue_session_events_adapter_revision_fk",
    }).onDelete("restrict"),
    uniqueIndex("issue_session_events_session_seq_uq").on(table.sessionId, table.seq),
    unique("issue_session_events_session_event_uq").on(table.sessionId, table.id),
    uniqueIndex("issue_session_events_source_identity_uq")
      .on(table.sessionId, table.sourceKind, table.immutableSourceKey)
      .where(sql`${table.sourceKind} is not null`),
    index("issue_session_events_session_type_seq_idx").on(
      table.sessionId,
      table.type,
      table.seq,
    ),
    index("issue_session_events_scope_run_idx").on(
      table.companyId,
      table.issueId,
      table.runId,
    ),
  ],
);

export const issueSessionMessages = pgTable(
  "issue_session_messages",
  {
    id: text("id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    modelStateSeq: bigint("model_state_seq", { mode: "number" }).notNull(),
    type: text("type")
      .$type<
        | "agent-switched"
        | "model-switched"
        | "user"
        | "synthetic"
        | "system"
        | "shell"
        | "assistant"
        | "compaction"
      >()
      .notNull(),
    data: jsonb("data").$type<IssueSessionMessageData>().notNull(),
    runId: uuid("run_id"),
    ownershipEpoch: integer("ownership_epoch"),
    agentId: uuid("agent_id"),
    adapterConfigRevisionId: uuid("adapter_config_revision_id"),
    timeCreated: timestamp("time_created", { withTimezone: true }).notNull().defaultNow(),
    timeUpdated: timestamp("time_updated", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "issue_session_messages_type_check",
      sql`${table.type} in (
        'agent-switched',
        'model-switched',
        'user',
        'synthetic',
        'system',
        'shell',
        'assistant',
        'compaction'
      )`,
    ),
    check(
      "issue_session_messages_data_check",
      sql`jsonb_typeof(${table.data}) = 'object'
        and not (${table.data} ? 'id')
        and not (${table.data} ? 'type')`,
    ),
    check(
      "issue_session_messages_time_check",
      sql`${table.timeUpdated} >= ${table.timeCreated}`,
    ),
    check("issue_session_messages_seq_check", sql`${table.seq} >= 0`),
    check(
      "issue_session_messages_model_state_seq_check",
      sql`${table.modelStateSeq} >= ${table.seq}`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_session_messages_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId, table.id],
      foreignColumns: [
        issueSessionMessageIdReservations.companyId,
        issueSessionMessageIdReservations.issueId,
        issueSessionMessageIdReservations.sessionId,
        issueSessionMessageIdReservations.messageId,
      ],
      name: "issue_session_messages_message_id_reservation_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.runId],
      foreignColumns: [issueExecutionRuns.companyId, issueExecutionRuns.id],
      name: "issue_session_messages_company_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "issue_session_messages_company_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.agentId, table.adapterConfigRevisionId],
      foreignColumns: [
        agentAdapterConfigRevisions.companyId,
        agentAdapterConfigRevisions.agentId,
        agentAdapterConfigRevisions.id,
      ],
      name: "issue_session_messages_adapter_revision_fk",
    }).onDelete("restrict"),
    unique("issue_session_messages_scope_id_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
      table.id,
    ),
    uniqueIndex("issue_session_messages_session_seq_uq").on(table.sessionId, table.seq),
    index("issue_session_messages_session_type_seq_idx").on(
      table.sessionId,
      table.type,
      table.seq,
    ),
    index("issue_session_messages_session_model_state_seq_idx").on(
      table.sessionId,
      table.modelStateSeq,
      table.seq,
    ),
    index("issue_session_messages_time_created_idx").on(table.timeCreated),
    index("issue_session_messages_scope_run_idx").on(
      table.companyId,
      table.issueId,
      table.runId,
    ),
  ],
);

export const issueSessionInputs = pgTable(
  "issue_session_inputs",
  {
    id: text("id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    prompt: jsonb("prompt").$type<IssueSessionPrompt>().notNull(),
    delivery: text("delivery").$type<"steer" | "queue">().notNull(),
    admittedSeq: bigint("admitted_seq", { mode: "number" }).notNull(),
    promotedSeq: bigint("promoted_seq", { mode: "number" }),
    timeCreated: timestamp("time_created", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "issue_session_inputs_delivery_check",
      sql`${table.delivery} in ('steer', 'queue')`,
    ),
    check(
      "issue_session_inputs_promotion_check",
      sql`${table.admittedSeq} >= 0
        and (${table.promotedSeq} is null or ${table.promotedSeq} >= ${table.admittedSeq})`,
    ),
    check(
      "issue_session_inputs_prompt_check",
      sql`jsonb_typeof(${table.prompt}) = 'object'`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_session_inputs_scope_fk",
    }).onDelete("cascade"),
    unique("issue_session_inputs_scope_id_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
      table.id,
    ),
    uniqueIndex("issue_session_inputs_session_admitted_seq_uq").on(
      table.sessionId,
      table.admittedSeq,
    ),
    uniqueIndex("issue_session_inputs_session_promoted_seq_uq")
      .on(table.sessionId, table.promotedSeq)
      .where(sql`${table.promotedSeq} is not null`),
    index("issue_session_inputs_pending_delivery_idx").on(
      table.sessionId,
      table.delivery,
      table.promotedSeq,
      table.admittedSeq,
    ),
  ],
);

export const issueSessionInputDispositions = pgTable(
  "issue_session_input_dispositions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    inputId: text("input_id").notNull(),
    sourceRefId: uuid("source_ref_id"),
    state: text("state").$type<"active" | "invalidated">().notNull().default("active"),
    invalidationReason: text("invalidation_reason"),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidatedBySourceKind: text("invalidated_by_source_kind"),
    invalidatedBySourceId: text("invalidated_by_source_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "issue_session_input_dispositions_state_check",
      sql`${table.state} in ('active', 'invalidated')`,
    ),
    check(
      "issue_session_input_dispositions_invalidation_check",
      sql`(
        ${table.state} = 'active'
        and ${table.invalidationReason} is null
        and ${table.invalidatedAt} is null
        and ${table.invalidatedBySourceKind} is null
        and ${table.invalidatedBySourceId} is null
      ) or (
        ${table.state} = 'invalidated'
        and ${table.invalidationReason} is not null
        and ${table.invalidatedAt} is not null
        and ${table.invalidatedBySourceKind} is not null
        and ${table.invalidatedBySourceId} is not null
        and length(btrim(${table.invalidatedBySourceKind})) > 0
        and length(btrim(${table.invalidatedBySourceId})) > 0
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId, table.inputId],
      foreignColumns: [
        issueSessionInputs.companyId,
        issueSessionInputs.issueId,
        issueSessionInputs.sessionId,
        issueSessionInputs.id,
      ],
      name: "issue_session_input_dispositions_input_fk",
    }).onDelete("cascade"),
    uniqueIndex("issue_session_input_dispositions_input_uq").on(table.inputId),
    index("issue_session_input_dispositions_source_ref_idx").on(table.sourceRefId),
    index("issue_session_input_dispositions_pending_idx").on(
      table.sessionId,
      table.state,
      table.inputId,
    ),
  ],
);

export const issueSessionContextEpochs = pgTable(
  "issue_session_context_epochs",
  {
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").primaryKey(),
    baseline: text("baseline"),
    snapshot: jsonb("snapshot").$type<IssueSessionContextSnapshot>(),
    baselineSeq: bigint("baseline_seq", { mode: "number" }),
    generation: integer("generation").notNull().default(0),
  },
  (table) => [
    check(
      "issue_session_context_epochs_state_check",
      sql`(
        ${table.baseline} is null
        and ${table.snapshot} is null
        and ${table.baselineSeq} is null
      ) or (
        ${table.baseline} is not null
        and ${table.snapshot} is not null
        and jsonb_typeof(${table.snapshot}) = 'object'
        and ${table.baselineSeq} >= -1
      )`,
    ),
    check(
      "issue_session_context_epochs_generation_check",
      sql`${table.generation} >= 0`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_session_context_epochs_scope_fk",
    }).onDelete("cascade"),
    unique("issue_session_context_epochs_scope_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
    ),
    index("issue_session_context_epochs_session_baseline_idx").on(
      table.sessionId,
      table.baselineSeq,
    ),
  ],
);

export const issueSessionSourceUserExecutions = pgTable(
  "issue_session_source_user_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    messageId: text("message_id").notNull(),
    sourceAgentId: uuid("source_agent_id").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    variant: text("variant"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId, table.messageId],
      foreignColumns: [
        issueSessionMessages.companyId,
        issueSessionMessages.issueId,
        issueSessionMessages.sessionId,
        issueSessionMessages.id,
      ],
      name: "issue_session_source_user_executions_message_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.sourceAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "issue_session_source_user_executions_agent_fk",
    }).onDelete("restrict"),
    uniqueIndex("issue_session_source_user_executions_message_uq").on(table.messageId),
    unique("issue_session_source_user_executions_scope_id_message_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
      table.id,
      table.messageId,
    ),
    index("issue_session_source_user_executions_model_idx").on(
      table.companyId,
      table.providerId,
      table.modelId,
    ),
  ],
);

export const issueSessionCompletedToolSources = pgTable(
  "issue_session_completed_tool_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    assistantMessageId: text("assistant_message_id").notNull(),
    toolId: text("tool_id").notNull(),
    sourceOutputText: text("source_output_text").notNull(),
    normalizationCodecVersion: text("normalization_codec_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sessionId,
        table.assistantMessageId,
      ],
      foreignColumns: [
        issueSessionMessages.companyId,
        issueSessionMessages.issueId,
        issueSessionMessages.sessionId,
        issueSessionMessages.id,
      ],
      name: "issue_session_completed_tool_sources_message_fk",
    }).onDelete("cascade"),
    uniqueIndex("issue_session_completed_tool_sources_tool_uq").on(
      table.sessionId,
      table.assistantMessageId,
      table.toolId,
    ),
  ],
);

export const issueSessionErrorToolSources = pgTable(
  "issue_session_error_tool_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    assistantMessageId: text("assistant_message_id").notNull(),
    toolId: text("tool_id").notNull(),
    interrupted: boolean("interrupted").notNull(),
    interruptedOutputText: text("interrupted_output_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "issue_session_error_tool_sources_output_check",
      sql`${table.interrupted} = true or ${table.interruptedOutputText} is null`,
    ),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sessionId,
        table.assistantMessageId,
      ],
      foreignColumns: [
        issueSessionMessages.companyId,
        issueSessionMessages.issueId,
        issueSessionMessages.sessionId,
        issueSessionMessages.id,
      ],
      name: "issue_session_error_tool_sources_message_fk",
    }).onDelete("cascade"),
    uniqueIndex("issue_session_error_tool_sources_tool_uq").on(
      table.sessionId,
      table.assistantMessageId,
      table.toolId,
    ),
  ],
);

export const issueSessionAssistantSources = pgTable(
  "issue_session_assistant_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    assistantMessageId: text("assistant_message_id").notNull(),
    sourceTotalTokens: bigint("source_total_tokens", { mode: "number" }),
    sourceAssistantErrorKind: text("source_assistant_error_kind").$type<
      "aborted" | "other"
    >(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "issue_session_assistant_sources_nonempty_check",
      sql`${table.sourceTotalTokens} is not null or ${table.sourceAssistantErrorKind} is not null`,
    ),
    check(
      "issue_session_assistant_sources_token_check",
      sql`${table.sourceTotalTokens} is null or ${table.sourceTotalTokens} >= 0`,
    ),
    check(
      "issue_session_assistant_sources_error_kind_check",
      sql`${table.sourceAssistantErrorKind} is null or ${table.sourceAssistantErrorKind} in ('aborted', 'other')`,
    ),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sessionId,
        table.assistantMessageId,
      ],
      foreignColumns: [
        issueSessionMessages.companyId,
        issueSessionMessages.issueId,
        issueSessionMessages.sessionId,
        issueSessionMessages.id,
      ],
      name: "issue_session_assistant_sources_message_fk",
    }).onDelete("cascade"),
    uniqueIndex("issue_session_assistant_sources_message_uq").on(
      table.assistantMessageId,
    ),
  ],
);

/**
 * Immutable authorization and high-water selection for one missing-target
 * recovery. Compiled prompt bytes and copied source rows never enter this
 * owner; members below retain identities only.
 */
export const issueSessionRecoverySelections = pgTable(
  "issue_session_recovery_selections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    visibility: text("visibility")
      .$type<"active" | "archived">()
      .notNull(),
    historyScopeKind: text("history_scope_kind")
      .$type<"turns-recovery" | "comments-recovery">()
      .notNull(),
    historyScopeId: text("history_scope_id").notNull(),
    audience: text("audience").$type<"turns" | "comments">().notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    targetAgentId: uuid("target_agent_id").notNull(),
    laneKind: text("lane_kind").$type<"owner" | "consult">().notNull(),
    contextEpoch: integer("context_epoch").notNull(),
    executionLineageId: uuid("execution_lineage_id").notNull(),
    sourceHighWaterSeq: bigint("source_high_water_seq", {
      mode: "number",
    }).notNull(),
    effectiveContextDigest: text("effective_context_digest").notNull(),
    selectedCheckpointControlId: uuid("selected_checkpoint_control_id"),
    latestFinishedAssistantMessageId: text(
      "latest_finished_assistant_message_id",
    ),
    sourceRunId: uuid("source_run_id").notNull(),
    sourceRefId: uuid("source_ref_id").notNull(),
    sourceRefOrdinal: integer("source_ref_ordinal").notNull(),
    sourceSegmentOrdinal: integer("source_segment_ordinal").notNull(),
    selectionIdentityDigest: text("selection_identity_digest").notNull(),
    expectedAssembledContentDigest: text(
      "expected_assembled_content_digest",
    ).notNull(),
    disposition: text("disposition")
      .$type<"active" | "consumed" | "invalidated">()
      .notNull()
      .default("active"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "issue_session_recovery_selections_scope_check",
      sql`(
        ${table.historyScopeKind} = 'turns-recovery'
        and ${table.audience} = 'turns'
      ) or (
        ${table.historyScopeKind} = 'comments-recovery'
        and ${table.audience} = 'comments'
      )`,
    ),
    check(
      "issue_session_recovery_selections_identity_check",
      sql`${table.visibility} in ('active', 'archived')
        and ${table.laneKind} in ('owner', 'consult')
        and ${table.ownershipEpoch} > 0
        and ${table.contextEpoch} >= 0
        and ${table.sourceHighWaterSeq} >= 0
        and ${table.sourceRefOrdinal} >= 0
        and ${table.sourceSegmentOrdinal} >= 0
        and length(btrim(${table.historyScopeId})) > 0
        and ${table.effectiveContextDigest} ~ '^[0-9a-f]{64}$'
        and ${table.selectionIdentityDigest} ~ '^[0-9a-f]{64}$'
        and ${table.expectedAssembledContentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "issue_session_recovery_selections_disposition_check",
      sql`(
        ${table.disposition} = 'active'
        and ${table.consumedAt} is null
        and ${table.invalidatedAt} is null
        and ${table.invalidationReason} is null
      ) or (
        ${table.disposition} = 'consumed'
        and ${table.consumedAt} is not null
        and ${table.consumedAt} >= ${table.createdAt}
        and ${table.invalidatedAt} is null
        and ${table.invalidationReason} is null
      ) or (
        ${table.disposition} = 'invalidated'
        and ${table.consumedAt} is null
        and ${table.invalidatedAt} is not null
        and ${table.invalidatedAt} >= ${table.createdAt}
        and ${table.invalidationReason} is not null
        and length(btrim(${table.invalidationReason})) between 1 and 200
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [
        issueSessions.companyId,
        issueSessions.issueId,
        issueSessions.id,
      ],
      name: "issue_session_recovery_selections_session_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.targetAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "issue_session_recovery_selections_target_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sourceRunId],
      foreignColumns: [
        issueExecutionRuns.companyId,
        issueExecutionRuns.issueId,
        issueExecutionRuns.id,
      ],
      name: "issue_session_recovery_selections_source_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sessionId,
        table.sourceRunId,
        table.sourceRefOrdinal,
        table.sourceRefId,
      ],
      foreignColumns: [
        issueExecutionRunRefs.companyId,
        issueExecutionRunRefs.issueId,
        issueExecutionRunRefs.sessionId,
        issueExecutionRunRefs.runId,
        issueExecutionRunRefs.refOrdinal,
        issueExecutionRunRefs.refId,
      ],
      name: "issue_session_recovery_selections_source_run_ref_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sessionId,
        table.latestFinishedAssistantMessageId,
      ],
      foreignColumns: [
        issueSessionMessages.companyId,
        issueSessionMessages.issueId,
        issueSessionMessages.sessionId,
        issueSessionMessages.id,
      ],
      name: "issue_session_recovery_selections_latest_assistant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.selectedCheckpointControlId],
      foreignColumns: [issueSessionCompactionControls.id],
      name: "issue_session_recovery_selections_checkpoint_fk",
    }).onDelete("cascade"),
    unique("issue_session_recovery_selections_scope_id_uq").on(
      table.companyId,
      table.issueId,
      table.sessionId,
      table.id,
    ),
    uniqueIndex("issue_session_recovery_selections_identity_uq").on(
      table.companyId,
      table.selectionIdentityDigest,
    ),
    uniqueIndex("issue_session_recovery_selections_active_source_uq")
      .on(
        table.companyId,
        table.issueId,
        table.sourceRunId,
        table.sourceRefOrdinal,
        table.sourceSegmentOrdinal,
      )
      .where(sql`${table.disposition} = 'active'`),
    index("issue_session_recovery_selections_active_scope_idx").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.targetAgentId,
      table.disposition,
      table.createdAt,
    ),
  ],
);

/** Ordered identity-only members pinned by one recovery selection. */
export const issueSessionRecoverySelectionMembers = pgTable(
  "issue_session_recovery_selection_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    selectionId: uuid("selection_id").notNull(),
    memberOrdinal: integer("member_ordinal").notNull(),
    memberKind: text("member_kind")
      .$type<"message" | "comment">()
      .notNull(),
    selectionRole: text("selection_role")
      .$type<"history" | "retained-tail">()
      .notNull(),
    sourceSequence: bigint("source_sequence", { mode: "number" }).notNull(),
    messageId: text("message_id"),
    commentId: uuid("comment_id"),
    commentProjectedEventSeq: bigint("comment_projected_event_seq", {
      mode: "number",
    }),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "issue_session_recovery_selection_members_ordinal_check",
      sql`${table.memberOrdinal} >= 0 and ${table.sourceSequence} >= 0`,
    ),
    check(
      "issue_session_recovery_selection_members_shape_check",
      sql`(
        ${table.memberKind} = 'message'
        and ${table.messageId} is not null
        and ${table.commentId} is null
        and ${table.commentProjectedEventSeq} is null
      ) or (
        ${table.memberKind} = 'comment'
        and ${table.selectionRole} = 'history'
        and ${table.messageId} is null
        and ${table.commentId} is not null
        and ${table.commentProjectedEventSeq} is not null
        and ${table.sourceSequence} = ${table.commentProjectedEventSeq}
      )`,
    ),
    check(
      "issue_session_recovery_selection_members_role_check",
      sql`${table.selectionRole} in ('history', 'retained-tail')`,
    ),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sessionId,
        table.selectionId,
      ],
      foreignColumns: [
        issueSessionRecoverySelections.companyId,
        issueSessionRecoverySelections.issueId,
        issueSessionRecoverySelections.sessionId,
        issueSessionRecoverySelections.id,
      ],
      name: "issue_session_recovery_selection_members_selection_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sessionId,
        table.messageId,
      ],
      foreignColumns: [
        issueSessionMessages.companyId,
        issueSessionMessages.issueId,
        issueSessionMessages.sessionId,
        issueSessionMessages.id,
      ],
      name: "issue_session_recovery_selection_members_message_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.commentId,
        table.commentProjectedEventSeq,
      ],
      foreignColumns: [
        issueComments.companyId,
        issueComments.issueId,
        issueComments.id,
        issueComments.projectedEventSeq,
      ],
      name: "issue_session_recovery_selection_members_comment_fk",
    }).onDelete("restrict"),
    unique("issue_session_recovery_selection_members_selection_ordinal_uq").on(
      table.selectionId,
      table.memberOrdinal,
    ),
    uniqueIndex("issue_session_recovery_selection_members_message_uq")
      .on(table.selectionId, table.messageId)
      .where(sql`${table.memberKind} = 'message'`),
    uniqueIndex("issue_session_recovery_selection_members_comment_uq")
      .on(table.selectionId, table.commentId)
      .where(sql`${table.memberKind} = 'comment'`),
    index("issue_session_recovery_selection_members_order_idx").on(
      table.selectionId,
      table.memberOrdinal,
    ),
  ],
);

export const issueSessionCompactionControls = pgTable(
  "issue_session_compaction_controls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    /** Null only for a recovery prompt fenced before Session publication. */
    seq: bigint("seq", { mode: "number" }),
    kind: text("kind")
      .$type<
        | "recovery-prompt"
        | "checkpoint"
        | "failed-compaction"
        | "tool-pruned"
      >()
      .notNull(),
    disposition: text("disposition")
      .$type<IssueSessionCompactionControlDisposition>()
      .notNull()
      .default("active"),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidatedByRevertEventId: text("invalidated_by_revert_event_id"),
    invalidatedBoundaryMessageId: text(
      "invalidated_boundary_message_id",
    ),
    invalidatedBoundarySeq: bigint("invalidated_boundary_seq", {
      mode: "number",
    }),
    historyScopeKind: text("history_scope_kind")
      .$type<"turns-recovery" | "comments-recovery">()
      .notNull(),
    historyScopeId: text("history_scope_id").notNull(),
    audience: text("audience")
      .$type<"turns" | "comments">()
      .notNull(),
    contextEpoch: integer("context_epoch").notNull(),
    executionLineageId: uuid("execution_lineage_id").notNull(),
    sourceHighWaterSeq: bigint("source_high_water_seq", { mode: "number" }).notNull(),
    latestFinishedAssistantMessageId: text(
      "latest_finished_assistant_message_id",
    ),
    sourceRunId: uuid("source_run_id").notNull(),
    sourceRunKind: text("source_run_kind")
      .$type<"productive" | "consult">()
      .notNull(),
    sourceRefId: uuid("source_ref_id").notNull(),
    sourceRefOrdinal: integer("source_ref_ordinal").notNull(),
    sourceSegmentOrdinal: integer("source_segment_ordinal").notNull(),
    recoveryIdentityDigest: text("recovery_identity_digest"),
    compactionRequestMessageId: text("compaction_request_message_id"),
    summaryAssistantMessageId: text("summary_assistant_message_id"),
    failedAssistantMessageId: text("failed_assistant_message_id"),
    failedAssistantErrorKind: text("failed_assistant_error_kind"),
    assistantMessageId: text("assistant_message_id"),
    toolId: text("tool_id"),
    prunedAt: timestamp("pruned_at", { withTimezone: true }),
    tailStartMessageId: text("tail_start_message_id"),
    replayMessageId: text("replay_message_id"),
    continuationMessageId: text("continuation_message_id"),
    postCheckpointAction: text("post_checkpoint_action")
      .$type<"none" | "overflow-replay" | "auto-continue">()
      .notNull()
      .default("none"),
    compactionRunId: uuid("compaction_run_id"),
    /** Database-only discriminator: control writers always stamp compaction. */
    compactionRunKind: text("compaction_run_kind")
      .$type<"compaction">()
      .notNull()
      .default("compaction"),
    promptTransmissionPhase: text("prompt_transmission_phase").$type<
      IssueExecutionPromptTransmissionPhase
    >(),
    protocolSettlementState: text("protocol_settlement_state").$type<
      IssueExecutionProtocolSettlementState
    >(),
    promptSettlementReferenceId: uuid("prompt_settlement_reference_id"),
    accountingId: uuid("accounting_id"),
    costEventId: uuid("cost_event_id"),
    settlementVersion: integer("settlement_version").notNull().default(0),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    compactionFailureKind: text("compaction_failure_kind"),
    structuralPositions: jsonb("structural_positions")
      .$type<Array<Record<string, unknown>> | null>(),
    settingsSnapshot: jsonb("settings_snapshot").$type<Record<string, unknown> | null>(),
    modelSnapshot: jsonb("model_snapshot").$type<Record<string, unknown> | null>(),
    triggerModelSnapshot: jsonb("trigger_model_snapshot").$type<
      Record<string, unknown> | null
    >(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "issue_session_compaction_controls_kind_check",
      sql`${table.kind} in (
        'recovery-prompt',
        'checkpoint',
        'failed-compaction',
        'tool-pruned'
      )`,
    ),
    check(
      "issue_session_compaction_controls_disposition_check",
      sql`${table.disposition} in ('active', 'invalidated')`,
    ),
    check(
      "issue_session_compaction_controls_revert_provenance_check",
      sql`(
        ${table.disposition} = 'active'
        and ${table.invalidatedAt} is null
        and ${table.invalidatedByRevertEventId} is null
        and ${table.invalidatedBoundaryMessageId} is null
        and ${table.invalidatedBoundarySeq} is null
      ) or (
        ${table.disposition} = 'invalidated'
        and ${table.invalidatedAt} is not null
        and ${table.invalidatedByRevertEventId} is not null
        and length(${table.invalidatedByRevertEventId}) > 0
        and ${table.invalidatedBoundaryMessageId} is not null
        and length(${table.invalidatedBoundaryMessageId}) > 0
        and ${table.invalidatedBoundarySeq} is not null
        and ${table.invalidatedBoundarySeq} >= 0
      )`,
    ),
    check(
      "issue_session_compaction_controls_scope_check",
      sql`(
          (
            ${table.historyScopeKind} = 'turns-recovery'
            and ${table.audience} = 'turns'
          ) or (
            ${table.historyScopeKind} = 'comments-recovery'
            and ${table.audience} = 'comments'
          )
        )
        and btrim(${table.historyScopeId}) <> ''
        and ${table.contextEpoch} >= 0
        and ${table.sourceHighWaterSeq} >= 0
        and ${table.sourceRefOrdinal} >= 0
        and ${table.sourceSegmentOrdinal} >= 0`,
    ),
    check(
      "issue_session_compaction_controls_post_checkpoint_action_check",
      sql`${table.postCheckpointAction} in (
        'none',
        'overflow-replay',
        'auto-continue'
      )`,
    ),
    // A control snapshot is an immutable copy of the sparse company setting,
    // not a materialized-default document. Keep absent keys absent and retain
    // explicit numeric zero, exactly as the public settings validator does.
    check(
      "issue_session_compaction_controls_settings_snapshot_check",
      sql`${table.settingsSnapshot} is null
        or (
          jsonb_typeof(${table.settingsSnapshot}) = 'object'
          and ${table.settingsSnapshot}
            - 'auto'
            - 'prune'
            - 'reserved'
            - 'tail_turns'
            - 'preserve_recent_tokens'
            - 'modelRef' = '{}'::jsonb
          and (
            not (${table.settingsSnapshot} ? 'auto')
            or jsonb_typeof(${table.settingsSnapshot} -> 'auto') = 'boolean'
          )
          and (
            not (${table.settingsSnapshot} ? 'prune')
            or jsonb_typeof(${table.settingsSnapshot} -> 'prune') = 'boolean'
          )
          and (
            not (${table.settingsSnapshot} ? 'reserved')
            or (
              jsonb_typeof(${table.settingsSnapshot} -> 'reserved') = 'number'
              and (${table.settingsSnapshot} ->> 'reserved') ~ '^(0|[1-9][0-9]*)$'
            )
          )
          and (
            not (${table.settingsSnapshot} ? 'tail_turns')
            or (
              jsonb_typeof(${table.settingsSnapshot} -> 'tail_turns') = 'number'
              and (${table.settingsSnapshot} ->> 'tail_turns') ~ '^(0|[1-9][0-9]*)$'
            )
          )
          and (
            not (${table.settingsSnapshot} ? 'preserve_recent_tokens')
            or (
              jsonb_typeof(${table.settingsSnapshot} -> 'preserve_recent_tokens') = 'number'
              and (${table.settingsSnapshot} ->> 'preserve_recent_tokens') ~ '^(0|[1-9][0-9]*)$'
            )
          )
          and (
            not (${table.settingsSnapshot} ? 'modelRef')
            or (
              jsonb_typeof(${table.settingsSnapshot} -> 'modelRef') = 'string'
              and btrim(${table.settingsSnapshot} ->> 'modelRef') <> ''
              and length(btrim(${table.settingsSnapshot} ->> 'modelRef')) <= 500
            )
          )
        )`,
    ),
    check(
      "issue_session_compaction_controls_prompt_settlement_check",
      sql`(
        ${table.kind} <> 'recovery-prompt'
        and ${table.promptTransmissionPhase} is null
        and ${table.protocolSettlementState} is null
        and ${table.promptSettlementReferenceId} is null
        and ${table.accountingId} is null
        and ${table.costEventId} is null
        and ${table.settlementVersion} = 0
        and ${table.settledAt} is null
        and ${table.compactionFailureKind} is null
      ) or (
        ${table.kind} = 'recovery-prompt'
        and ${table.promptTransmissionPhase} is not null
        and (
          (
            ${table.protocolSettlementState} is null
            and ${table.promptSettlementReferenceId} is null
            and ${table.accountingId} is null
            and ${table.costEventId} is null
            and ${table.settlementVersion} = 0
            and ${table.settledAt} is null
            and ${table.compactionFailureKind} is null
          ) or (
            ${table.promptTransmissionPhase} = 'not_transmitted'
            and ${table.protocolSettlementState} = 'not_sent'
            and ${table.promptSettlementReferenceId} is not null
            and ${table.accountingId} is null
            and ${table.costEventId} is null
            and ${table.settlementVersion} > 0
            and ${table.settledAt} is not null
            and ${table.compactionFailureKind} is not null
          ) or (
            ${table.promptTransmissionPhase} = 'transmitted'
            and ${table.protocolSettlementState} = 'incomplete'
            and ${table.promptSettlementReferenceId} is not null
            and ${table.accountingId} is null
            and ${table.costEventId} is null
            and ${table.settlementVersion} > 0
            and ${table.settledAt} is not null
            and ${table.compactionFailureKind} is not null
          ) or (
            ${table.promptTransmissionPhase} = 'transmitted'
            and ${table.protocolSettlementState} = 'settled'
            and ${table.promptSettlementReferenceId} is not null
            and ${table.accountingId} is not null
            and ${table.costEventId} is not null
            and ${table.settlementVersion} > 0
            and ${table.settledAt} is not null
          )
        )
      )`,
    ),
    check(
      "issue_session_compaction_controls_shape_check",
      sql`(
        ${table.kind} = 'recovery-prompt'
        and ${table.compactionRequestMessageId} is null
        and ${table.summaryAssistantMessageId} is null
        and ${table.failedAssistantMessageId} is null
        and ${table.failedAssistantErrorKind} is null
        and ${table.assistantMessageId} is null
        and ${table.toolId} is null
        and ${table.prunedAt} is null
        and ${table.tailStartMessageId} is null
        and ${table.replayMessageId} is null
        and ${table.continuationMessageId} is null
        and ${table.postCheckpointAction} = 'none'
        and ${table.compactionRunId} is not null
        and ${table.settingsSnapshot} is not null
        and ${table.modelSnapshot} is not null
        and ${table.triggerModelSnapshot} is not null
        and ${table.recoveryIdentityDigest} is not null
        and ${table.recoveryIdentityDigest} ~ '^[0-9a-f]{64}$'
      ) or (
        ${table.kind} = 'checkpoint'
        and ${table.compactionRequestMessageId} is not null
        and ${table.summaryAssistantMessageId} is not null
        and ${table.failedAssistantMessageId} is null
        and ${table.failedAssistantErrorKind} is null
        and ${table.assistantMessageId} is null
        and ${table.toolId} is null
        and ${table.prunedAt} is null
        and ${table.compactionRunId} is not null
        and ${table.settingsSnapshot} is null
        and ${table.modelSnapshot} is null
        and ${table.triggerModelSnapshot} is null
        and ${table.recoveryIdentityDigest} is null
        and (
          (
            ${table.postCheckpointAction} = 'none'
            and ${table.replayMessageId} is null
            and ${table.continuationMessageId} is null
          )
          or (
            ${table.postCheckpointAction} = 'overflow-replay'
            and ${table.replayMessageId} is not null
            and ${table.continuationMessageId} is null
          )
          or (
            ${table.postCheckpointAction} = 'auto-continue'
            and ${table.replayMessageId} is null
            and ${table.continuationMessageId} is not null
          )
        )
      ) or (
        ${table.kind} = 'failed-compaction'
        and ${table.compactionRequestMessageId} is not null
        and ${table.summaryAssistantMessageId} is null
        and ${table.failedAssistantMessageId} is not null
        and ${table.failedAssistantErrorKind} is not null
        and ${table.assistantMessageId} is null
        and ${table.toolId} is null
        and ${table.prunedAt} is null
        and ${table.tailStartMessageId} is null
        and ${table.replayMessageId} is null
        and ${table.continuationMessageId} is null
        and ${table.postCheckpointAction} = 'none'
        and ${table.compactionRunId} is not null
        and ${table.settingsSnapshot} is null
        and ${table.modelSnapshot} is null
        and ${table.triggerModelSnapshot} is null
        and ${table.recoveryIdentityDigest} is null
      ) or (
        ${table.kind} = 'tool-pruned'
        and ${table.compactionRequestMessageId} is null
        and ${table.summaryAssistantMessageId} is null
        and ${table.failedAssistantMessageId} is null
        and ${table.failedAssistantErrorKind} is null
        and ${table.assistantMessageId} is not null
        and ${table.toolId} is not null
        and ${table.prunedAt} is not null
        and ${table.tailStartMessageId} is null
        and ${table.replayMessageId} is null
        and ${table.continuationMessageId} is null
        and ${table.postCheckpointAction} = 'none'
        and ${table.compactionRunId} is null
        and ${table.settingsSnapshot} is null
        and ${table.modelSnapshot} is null
        and ${table.triggerModelSnapshot} is null
        and ${table.recoveryIdentityDigest} is null
      )`,
    ),
    check(
      "issue_session_compaction_controls_sequence_check",
      sql`(${table.kind} = 'recovery-prompt' and ${table.seq} is null)
        or (${table.kind} <> 'recovery-prompt' and ${table.seq} is not null and ${table.seq} >= 0)`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [issueSessions.companyId, issueSessions.issueId, issueSessions.id],
      name: "issue_session_compaction_controls_scope_fk",
    }).onDelete("cascade"),
    // Referenced message ids are verified by the projector transaction. They
    // intentionally have no cascading FK because a committed revert preserves
    // this control audit row after removing its materialized message rows.
    foreignKey({
      columns: [table.sessionId, table.invalidatedByRevertEventId],
      foreignColumns: [issueSessionEvents.sessionId, issueSessionEvents.id],
      name: "issue_session_compaction_controls_revert_event_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sourceRunId,
        table.sourceRunKind,
      ],
      foreignColumns: [
        issueExecutionRuns.companyId,
        issueExecutionRuns.issueId,
        issueExecutionRuns.id,
        issueExecutionRuns.kind,
      ],
      name: "issue_session_compaction_controls_source_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sessionId,
        table.sourceRunId,
        table.sourceRefOrdinal,
        table.sourceRefId,
      ],
      foreignColumns: [
        issueExecutionRunRefs.companyId,
        issueExecutionRunRefs.issueId,
        issueExecutionRunRefs.sessionId,
        issueExecutionRunRefs.runId,
        issueExecutionRunRefs.refOrdinal,
        issueExecutionRunRefs.refId,
      ],
      name: "issue_session_compaction_controls_source_run_ref_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sessionId,
        table.latestFinishedAssistantMessageId,
      ],
      foreignColumns: [
        issueSessionMessages.companyId,
        issueSessionMessages.issueId,
        issueSessionMessages.sessionId,
        issueSessionMessages.id,
      ],
      name: "issue_session_compaction_controls_latest_assistant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.compactionRunId,
        table.compactionRunKind,
      ],
      foreignColumns: [
        issueExecutionRuns.companyId,
        issueExecutionRuns.issueId,
        issueExecutionRuns.id,
        issueExecutionRuns.kind,
      ],
      name: "issue_session_compaction_controls_compaction_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.compactionRunId,
        table.id,
        table.promptSettlementReferenceId,
        table.accountingId,
      ],
      foreignColumns: [
        acpPromptAccounting.companyId,
        acpPromptAccounting.issueId,
        acpPromptAccounting.runId,
        acpPromptAccounting.compactionControlId,
        acpPromptAccounting.promptSettlementReferenceId,
        acpPromptAccounting.id,
      ],
      name: "issue_session_compaction_controls_accounting_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.compactionRunId,
        table.id,
        table.accountingId,
        table.costEventId,
      ],
      foreignColumns: [
        costEvents.companyId,
        costEvents.issueId,
        costEvents.runId,
        costEvents.compactionControlId,
        costEvents.accountingId,
        costEvents.id,
      ],
      name: "issue_session_compaction_controls_cost_event_fk",
    }).onDelete("cascade"),
    index("issue_session_compaction_controls_session_seq_idx").on(
      table.sessionId,
      table.seq,
    ),
    uniqueIndex("issue_session_compaction_controls_recovery_identity_uq")
      .on(table.companyId, table.recoveryIdentityDigest)
      .where(sql`${table.kind} = 'recovery-prompt'`),
    unique("issue_session_compaction_controls_run_prompt_uq").on(
      table.companyId,
      table.issueId,
      table.id,
      table.compactionRunId,
    ),
    uniqueIndex("issue_session_compaction_controls_recovery_run_uq")
      .on(table.companyId, table.issueId, table.compactionRunId)
      .where(sql`${table.kind} = 'recovery-prompt'`),
    uniqueIndex("issue_session_compaction_controls_checkpoint_run_uq")
      .on(table.companyId, table.issueId, table.compactionRunId)
      .where(sql`${table.kind} = 'checkpoint'`),
    uniqueIndex("issue_session_compaction_controls_failed_run_uq")
      .on(table.companyId, table.issueId, table.compactionRunId)
      .where(sql`${table.kind} = 'failed-compaction'`),
    index("issue_session_compaction_controls_checkpoint_idx").on(
      table.sessionId,
      table.historyScopeKind,
      table.historyScopeId,
      table.audience,
      table.sourceHighWaterSeq,
    ),
    index("issue_session_compaction_controls_active_scope_idx").on(
      table.sessionId,
      table.disposition,
      table.kind,
      table.historyScopeKind,
      table.historyScopeId,
      table.audience,
      table.sourceHighWaterSeq,
    ),
    index("issue_session_compaction_controls_run_idx").on(
      table.companyId,
      table.compactionRunId,
    ),
  ],
);
