import { sql } from "drizzle-orm";
import {
  bigint,
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
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { taskExecutionRuns } from "./task_execution_runs.js";
import { tasks } from "./tasks.js";

export type TaskSessionModelRef = {
  id: string;
  providerID: string;
  variant?: string;
};

export type TaskSessionRevertState = {
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

type TaskSessionEventData = Record<string, unknown>;
type TaskSessionMessageData = Record<string, unknown>;
type TaskSessionPrompt = Record<string, unknown>;
type TaskSessionContextSnapshot = Record<
  string,
  {
    value: unknown;
    removed?: string;
  }
>;

export const taskSessions = pgTable(
  "task_sessions",
  {
    id: text("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    parentSessionId: text("parent_session_id"),
    projectId: text("project_id").notNull(),
    agent: text("agent"),
    model: jsonb("model").$type<TaskSessionModelRef>(),
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
    revert: jsonb("revert").$type<TaskSessionRevertState>(),
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
      "task_sessions_integrity_state_check",
      sql`${table.integrityState} in ('building', 'ready', 'archived', 'purge_fenced')`,
    ),
    check(
      "task_sessions_projected_event_seq_check",
      sql`${table.projectedEventSeq} >= -1`,
    ),
    check(
      "task_sessions_cost_and_tokens_check",
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
      "task_sessions_time_check",
      sql`${table.timeUpdated} >= ${table.timeCreated}
        and (${table.timeArchived} is null or ${table.timeArchived} >= ${table.timeCreated})`,
    ),
    check(
      "task_sessions_info_shape_check",
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
      name: "task_sessions_company_parent_fk",
    }).onDelete("restrict"),
    unique("task_sessions_company_id_uq").on(table.companyId, table.id),
    unique("task_sessions_scope_id_uq").on(table.companyId, table.taskId, table.id),
    uniqueIndex("task_sessions_company_task_uq").on(table.companyId, table.taskId),
    index("task_sessions_company_parent_idx").on(table.companyId, table.parentSessionId),
    index("task_sessions_company_integrity_idx").on(
      table.companyId,
      table.integrityState,
    ),
  ],
);

export const taskSessionEventSequences = pgTable(
  "task_session_event_sequences",
  {
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    sessionId: text("session_id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    ownerId: text("owner_id"),
  },
  (table) => [
    check("task_session_event_sequences_seq_check", sql`${table.seq} >= -1`),
    foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId],
      foreignColumns: [taskSessions.companyId, taskSessions.taskId, taskSessions.id],
      name: "task_session_event_sequences_scope_fk",
    }).onDelete("cascade"),
    unique("task_session_event_sequences_scope_uq").on(
      table.companyId,
      table.taskId,
      table.sessionId,
    ),
    index("task_session_event_sequences_owner_idx").on(table.ownerId),
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
export const taskSessionMessageIdAllocators = pgTable(
  "task_session_message_id_allocators",
  {
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    sessionId: text("session_id").primaryKey(),
    lastOrdinal: bigint("last_ordinal", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "task_session_message_id_allocators_ordinal_check",
      sql`${table.lastOrdinal} >= 0`,
    ),
    foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId],
      foreignColumns: [taskSessions.companyId, taskSessions.taskId, taskSessions.id],
      name: "task_session_message_id_allocators_scope_fk",
    }).onDelete("cascade"),
    unique("task_session_message_id_allocators_scope_uq").on(
      table.companyId,
      table.taskId,
      table.sessionId,
    ),
  ],
);

/**
 * A reservation is the durable, idempotent proof that a canonical V2 message
 * id was allocated. Keeping it after projection makes duplicate delivery and
 * crash recovery reuse the exact id instead of deriving a hash or timestamp.
 */
export const taskSessionMessageIdReservations = pgTable(
  "task_session_message_id_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    sessionId: text("session_id").notNull(),
    reservationKey: text("reservation_key").notNull(),
    ordinal: bigint("ordinal", { mode: "number" }).notNull(),
    messageId: text("message_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "task_session_message_id_reservations_value_check",
      sql`${table.ordinal} > 0
        and btrim(${table.reservationKey}) <> ''
        and length(${table.reservationKey}) <= 500
        and ${table.messageId} = (
          'msg_' || ${table.sessionId} || '_' || lpad(${table.ordinal}::text, 19, '0')
        )`,
    ),
    foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId],
      foreignColumns: [taskSessions.companyId, taskSessions.taskId, taskSessions.id],
      name: "task_session_message_id_reservations_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId],
      foreignColumns: [
        taskSessionMessageIdAllocators.companyId,
        taskSessionMessageIdAllocators.taskId,
        taskSessionMessageIdAllocators.sessionId,
      ],
      name: "task_session_message_id_reservations_allocator_fk",
    }).onDelete("cascade"),
    unique("task_session_message_id_reservations_scope_key_uq").on(
      table.companyId,
      table.taskId,
      table.sessionId,
      table.reservationKey,
    ),
    unique("task_session_message_id_reservations_scope_ordinal_uq").on(
      table.companyId,
      table.taskId,
      table.sessionId,
      table.ordinal,
    ),
    unique("task_session_message_id_reservations_scope_message_uq").on(
      table.companyId,
      table.taskId,
      table.sessionId,
      table.messageId,
    ),
    uniqueIndex("task_session_message_id_reservations_message_uq").on(
      table.messageId,
    ),
    index("task_session_message_id_reservations_scope_ordinal_idx").on(
      table.sessionId,
      table.ordinal,
    ),
  ],
);

export const taskSessionEvents = pgTable(
  "task_session_events",
  {
    id: text("id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    sessionId: text("session_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type<TaskSessionEventData>().notNull(),
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
      "task_session_events_type_check",
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
        'session.next.revert.staged.1',
        'session.next.revert.cleared.1',
        'session.next.revert.committed.1'
      )`,
    ),
    check(
      "task_session_events_data_check",
      sql`jsonb_typeof(${table.data}) = 'object'
        and not (${table.data} ? 'id')
        and not (${table.data} ? 'type')
        and not (${table.data} ? 'durable')
        and not (${table.data} ? 'metadata')`,
    ),
    check("task_session_events_seq_check", sql`${table.seq} >= 0`),
    check(
      "task_session_events_source_identity_check",
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
      columns: [table.companyId, table.taskId, table.sessionId],
      foreignColumns: [taskSessions.companyId, taskSessions.taskId, taskSessions.id],
      name: "task_session_events_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId],
      foreignColumns: [
        taskSessionEventSequences.companyId,
        taskSessionEventSequences.taskId,
        taskSessionEventSequences.sessionId,
      ],
      name: "task_session_events_sequence_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.runId],
      foreignColumns: [taskExecutionRuns.companyId, taskExecutionRuns.id],
      name: "task_session_events_company_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "task_session_events_company_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.agentId, table.adapterConfigRevisionId],
      foreignColumns: [
        agentAdapterConfigRevisions.companyId,
        agentAdapterConfigRevisions.agentId,
        agentAdapterConfigRevisions.id,
      ],
      name: "task_session_events_adapter_revision_fk",
    }).onDelete("restrict"),
    uniqueIndex("task_session_events_session_seq_uq").on(table.sessionId, table.seq),
    unique("task_session_events_session_event_uq").on(table.sessionId, table.id),
    uniqueIndex("task_session_events_source_identity_uq")
      .on(table.sessionId, table.sourceKind, table.immutableSourceKey)
      .where(sql`${table.sourceKind} is not null`),
    index("task_session_events_session_type_seq_idx").on(
      table.sessionId,
      table.type,
      table.seq,
    ),
    index("task_session_events_scope_run_idx").on(
      table.companyId,
      table.taskId,
      table.runId,
    ),
  ],
);

export const taskSessionMessages = pgTable(
  "task_session_messages",
  {
    id: text("id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
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
      >()
      .notNull(),
    data: jsonb("data").$type<TaskSessionMessageData>().notNull(),
    runId: uuid("run_id"),
    ownershipEpoch: integer("ownership_epoch"),
    agentId: uuid("agent_id"),
    adapterConfigRevisionId: uuid("adapter_config_revision_id"),
    timeCreated: timestamp("time_created", { withTimezone: true }).notNull().defaultNow(),
    timeUpdated: timestamp("time_updated", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "task_session_messages_type_check",
      sql`${table.type} in (
        'agent-switched',
        'model-switched',
        'user',
        'synthetic',
        'system',
        'shell',
        'assistant'
      )`,
    ),
    check(
      "task_session_messages_data_check",
      sql`jsonb_typeof(${table.data}) = 'object'
        and not (${table.data} ? 'id')
        and not (${table.data} ? 'type')`,
    ),
    check(
      "task_session_messages_time_check",
      sql`${table.timeUpdated} >= ${table.timeCreated}`,
    ),
    check("task_session_messages_seq_check", sql`${table.seq} >= 0`),
    check(
      "task_session_messages_model_state_seq_check",
      sql`${table.modelStateSeq} >= ${table.seq}`,
    ),
    foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId],
      foreignColumns: [taskSessions.companyId, taskSessions.taskId, taskSessions.id],
      name: "task_session_messages_scope_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId, table.id],
      foreignColumns: [
        taskSessionMessageIdReservations.companyId,
        taskSessionMessageIdReservations.taskId,
        taskSessionMessageIdReservations.sessionId,
        taskSessionMessageIdReservations.messageId,
      ],
      name: "task_session_messages_message_id_reservation_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.runId],
      foreignColumns: [taskExecutionRuns.companyId, taskExecutionRuns.id],
      name: "task_session_messages_company_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "task_session_messages_company_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.agentId, table.adapterConfigRevisionId],
      foreignColumns: [
        agentAdapterConfigRevisions.companyId,
        agentAdapterConfigRevisions.agentId,
        agentAdapterConfigRevisions.id,
      ],
      name: "task_session_messages_adapter_revision_fk",
    }).onDelete("restrict"),
    unique("task_session_messages_scope_id_uq").on(
      table.companyId,
      table.taskId,
      table.sessionId,
      table.id,
    ),
    uniqueIndex("task_session_messages_session_seq_uq").on(table.sessionId, table.seq),
    index("task_session_messages_session_type_seq_idx").on(
      table.sessionId,
      table.type,
      table.seq,
    ),
    index("task_session_messages_session_model_state_seq_idx").on(
      table.sessionId,
      table.modelStateSeq,
      table.seq,
    ),
    index("task_session_messages_time_created_idx").on(table.timeCreated),
    index("task_session_messages_scope_run_idx").on(
      table.companyId,
      table.taskId,
      table.runId,
    ),
  ],
);

export const taskSessionInputs = pgTable(
  "task_session_inputs",
  {
    id: text("id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    sessionId: text("session_id").notNull(),
    prompt: jsonb("prompt").$type<TaskSessionPrompt>().notNull(),
    delivery: text("delivery").$type<"steer" | "queue">().notNull(),
    admittedSeq: bigint("admitted_seq", { mode: "number" }).notNull(),
    promotedSeq: bigint("promoted_seq", { mode: "number" }),
    timeCreated: timestamp("time_created", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "task_session_inputs_delivery_check",
      sql`${table.delivery} in ('steer', 'queue')`,
    ),
    check(
      "task_session_inputs_promotion_check",
      sql`${table.admittedSeq} >= 0
        and (${table.promotedSeq} is null or ${table.promotedSeq} >= ${table.admittedSeq})`,
    ),
    check(
      "task_session_inputs_prompt_check",
      sql`jsonb_typeof(${table.prompt}) = 'object'`,
    ),
    foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId],
      foreignColumns: [taskSessions.companyId, taskSessions.taskId, taskSessions.id],
      name: "task_session_inputs_scope_fk",
    }).onDelete("cascade"),
    unique("task_session_inputs_scope_id_uq").on(
      table.companyId,
      table.taskId,
      table.sessionId,
      table.id,
    ),
    uniqueIndex("task_session_inputs_session_admitted_seq_uq").on(
      table.sessionId,
      table.admittedSeq,
    ),
    uniqueIndex("task_session_inputs_session_promoted_seq_uq")
      .on(table.sessionId, table.promotedSeq)
      .where(sql`${table.promotedSeq} is not null`),
    index("task_session_inputs_pending_delivery_idx").on(
      table.sessionId,
      table.delivery,
      table.promotedSeq,
      table.admittedSeq,
    ),
  ],
);

export const taskSessionInputDispositions = pgTable(
  "task_session_input_dispositions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
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
      "task_session_input_dispositions_state_check",
      sql`${table.state} in ('active', 'invalidated')`,
    ),
    check(
      "task_session_input_dispositions_invalidation_check",
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
      columns: [table.companyId, table.taskId, table.sessionId, table.inputId],
      foreignColumns: [
        taskSessionInputs.companyId,
        taskSessionInputs.taskId,
        taskSessionInputs.sessionId,
        taskSessionInputs.id,
      ],
      name: "task_session_input_dispositions_input_fk",
    }).onDelete("cascade"),
    uniqueIndex("task_session_input_dispositions_input_uq").on(table.inputId),
    index("task_session_input_dispositions_source_ref_idx").on(table.sourceRefId),
    index("task_session_input_dispositions_pending_idx").on(
      table.sessionId,
      table.state,
      table.inputId,
    ),
  ],
);

export const taskSessionContextEpochs = pgTable(
  "task_session_context_epochs",
  {
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    sessionId: text("session_id").primaryKey(),
    baseline: text("baseline"),
    snapshot: jsonb("snapshot").$type<TaskSessionContextSnapshot>(),
    baselineSeq: bigint("baseline_seq", { mode: "number" }),
    generation: integer("generation").notNull().default(0),
  },
  (table) => [
    check(
      "task_session_context_epochs_state_check",
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
      "task_session_context_epochs_generation_check",
      sql`${table.generation} >= 0`,
    ),
    foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId],
      foreignColumns: [taskSessions.companyId, taskSessions.taskId, taskSessions.id],
      name: "task_session_context_epochs_scope_fk",
    }).onDelete("cascade"),
    unique("task_session_context_epochs_scope_uq").on(
      table.companyId,
      table.taskId,
      table.sessionId,
    ),
    index("task_session_context_epochs_session_baseline_idx").on(
      table.sessionId,
      table.baselineSeq,
    ),
  ],
);

export const taskSessionSourceUserExecutions = pgTable(
  "task_session_source_user_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
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
      columns: [table.companyId, table.taskId, table.sessionId, table.messageId],
      foreignColumns: [
        taskSessionMessages.companyId,
        taskSessionMessages.taskId,
        taskSessionMessages.sessionId,
        taskSessionMessages.id,
      ],
      name: "task_session_source_user_executions_message_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.sourceAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "task_session_source_user_executions_agent_fk",
    }).onDelete("restrict"),
    uniqueIndex("task_session_source_user_executions_message_uq").on(table.messageId),
    unique("task_session_source_user_executions_scope_id_message_uq").on(
      table.companyId,
      table.taskId,
      table.sessionId,
      table.id,
      table.messageId,
    ),
    index("task_session_source_user_executions_model_idx").on(
      table.companyId,
      table.providerId,
      table.modelId,
    ),
  ],
);
