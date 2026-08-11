import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
  check,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { projects } from "./projects.js";
import { projectWorkspaces } from "./project_workspaces.js";
import { goals } from "./goals.js";
import { companies } from "./companies.js";
import { taskExecutionRuns } from "./task_execution_runs.js";
import type {
  AgentVisibleTaskStatus,
  TaskCreatorKind,
  TaskDisposition,
  TaskOwnerKind,
  TaskStatus,
  SourceTrustMetadata,
  SystemCreatorSourceKind,
} from "@paperclipai/shared";

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id),
    projectWorkspaceId: uuid("project_workspace_id").references(
      () => projectWorkspaces.id,
      { onDelete: "set null" },
    ),
    goalId: uuid("goal_id").references(() => goals.id),
    parentId: uuid("parent_id"),
    /** Immutable parent epoch captured when this direct child is created. */
    parentOwnershipEpoch: integer("parent_ownership_epoch"),
    title: text("title"),
    request: text("request").notNull(),
    lifecycleStatus: text("lifecycle_status")
      .$type<AgentVisibleTaskStatus>()
      .notNull(),
    boardPresentationStatus: text("board_presentation_status")
      .$type<TaskStatus>()
      .notNull(),
    disposition: jsonb("disposition").$type<TaskDisposition | null>(),
    workMode: text("work_mode").notNull().default("standard"),
    harnessKind: text("harness_kind"),
    priority: text("priority").notNull().default("medium"),
    ownerKind: text("owner_kind").$type<TaskOwnerKind>().notNull(),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    ownerUserId: text("owner_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    ownerAssignmentSource: text("owner_assignment_source"),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    creatorKind: text("creator_kind").$type<TaskCreatorKind>().notNull(),
    creatorAuthorityId: uuid("creator_authority_id"),
    creatorAdapterConfigRevisionId: uuid("creator_adapter_config_revision_id"),
    creatorUserId: text("creator_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    creatorPluginInstallationId: uuid("creator_plugin_installation_id"),
    creatorPluginKey: text("creator_plugin_key"),
    creatorCallbackKey: text("creator_callback_key"),
    creatorCallbackVersion: text("creator_callback_version"),
    creatorRoutineId: uuid("creator_routine_id"),
    creatorRoutineDispatchId: uuid("creator_routine_dispatch_id"),
    creatorSystemSourceKind: text("creator_system_source_kind")
      .$type<SystemCreatorSourceKind>(),
    creatorSystemSourceId: text("creator_system_source_id"),
    escalatedFromAffectedTaskId: uuid("escalated_from_affected_task_id").references(
      (): AnyPgColumn => tasks.id,
      { onDelete: "restrict" },
    ),
    escalatedFromTriggeringRunId: uuid("escalated_from_triggering_run_id").references(
      (): AnyPgColumn => taskExecutionRuns.id,
      { onDelete: "restrict" },
    ),
    escalatedFromReason: text("escalated_from_reason"),
    affectedOwnershipEpoch: integer("affected_ownership_epoch"),
    responsibleUserId: text("responsible_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    taskNumber: integer("task_number"),
    identifier: text("identifier"),
    originKind: text("origin_kind").notNull().default("manual"),
    originId: text("origin_id"),
    originRunId: text("origin_run_id"),
    originFingerprint: text("origin_fingerprint").notNull().default("default"),
    requestDepth: integer("request_depth").notNull().default(0),
    billingCode: text("billing_code"),
    executionPolicy: jsonb("execution_policy").$type<Record<string, unknown>>(),
    executionState: jsonb("execution_state").$type<Record<string, unknown>>(),
    monitorNextCheckAt: timestamp("monitor_next_check_at", { withTimezone: true }),
    monitorLastTriggeredAt: timestamp("monitor_last_triggered_at", { withTimezone: true }),
    monitorAttemptCount: integer("monitor_attempt_count").notNull().default(0),
    monitorNotes: text("monitor_notes"),
    monitorScheduledBy: text("monitor_scheduled_by"),
    sourceTrust: jsonb("source_trust").$type<SourceTrustMetadata | null>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("tasks_company_status_idx").on(
      table.companyId,
      table.lifecycleStatus,
    ),
    companyHarnessKindIdx: index("tasks_company_harness_kind_idx").on(table.companyId, table.harnessKind),
    ownerStatusIdx: index("tasks_company_owner_status_idx").on(
      table.companyId,
      table.ownerAgentId,
      table.lifecycleStatus,
    ),
    ownerUserStatusIdx: index("tasks_company_owner_user_status_idx").on(
      table.companyId,
      table.ownerUserId,
      table.lifecycleStatus,
    ),
    responsibleUserIdx: index("tasks_company_responsible_user_idx").on(table.companyId, table.responsibleUserId),
    parentIdx: index("tasks_company_parent_idx").on(table.companyId, table.parentId),
    projectIdx: index("tasks_company_project_idx").on(table.companyId, table.projectId),
    projectWorkspaceIdx: index("tasks_company_project_workspace_idx").on(
      table.companyId,
      table.projectWorkspaceId,
    ),
    originIdx: index("tasks_company_origin_idx").on(table.companyId, table.originKind, table.originId),
    dueMonitorIdx: index("tasks_company_monitor_due_idx").on(table.companyId, table.monitorNextCheckAt),
    companyUpdatedIdx: index("tasks_company_updated_idx").on(table.companyId, table.updatedAt),
    companyCreatedIdx: index("tasks_company_created_idx").on(table.companyId, table.createdAt),
    openNormalizedTitleCreatedIdx: index("tasks_open_normalized_title_created_idx")
      .on(
        table.companyId,
        table.parentId,
        sql`lower(regexp_replace(btrim(${table.title}), '\\s+', ' ', 'g'))`,
        table.createdAt,
      )
      .where(
        sql`${table.hiddenAt} is null
          and ${table.lifecycleStatus} in ('open', 'blocked')`,
      ),
    companyPriorityIdx: index("tasks_company_priority_idx").on(table.companyId, table.priority),
    identifierIdx: uniqueIndex("tasks_identifier_idx").on(table.identifier),
    titleSearchIdx: index("tasks_title_search_idx").using("gin", table.title.op("gin_trgm_ops")),
    identifierSearchIdx: index("tasks_identifier_search_idx").using("gin", table.identifier.op("gin_trgm_ops")),
    requestSearchIdx: index("tasks_request_search_idx").using("gin", table.request.op("gin_trgm_ops")),
    companyIdUq: unique("tasks_company_id_uq").on(table.companyId, table.id),
    parentEpochCheck: check(
      "tasks_parent_epoch_check",
      sql`(
        ${table.parentId} is null
        and ${table.parentOwnershipEpoch} is null
      ) or (
        ${table.parentId} is not null
        and ${table.parentOwnershipEpoch} > 0
      )`,
    ),
    parentFk: foreignKey({
      columns: [table.companyId, table.parentId],
      foreignColumns: [table.companyId, table.id],
      name: "tasks_parent_fk",
    }).onDelete("restrict"),
    lifecycleStatusCheck: check(
      "tasks_lifecycle_status_check",
      sql`${table.lifecycleStatus} in ('open', 'blocked', 'done', 'cancelled')`,
    ),
    boardPresentationStatusCheck: check(
      "tasks_board_presentation_status_check",
      sql`${table.boardPresentationStatus} in (
        'backlog',
        'todo',
        'in_progress',
        'in_review',
        'blocked',
        'done',
        'cancelled'
      )`,
    ),
    lifecycleDispositionCheck: check(
      "tasks_lifecycle_disposition_check",
      sql`(
          ${table.lifecycleStatus} in ('open', 'blocked')
          and ${table.disposition} is null
        )
        or (
          ${table.lifecycleStatus} in ('done', 'cancelled')
          and ${table.disposition} is not null
          and jsonb_typeof(${table.disposition}) = 'object'
          and ${table.disposition} ? 'message'
          and jsonb_typeof(${table.disposition} -> 'message') = 'string'
          and btrim(${table.disposition} ->> 'message') <> ''
          and ${table.disposition} - 'message' - 'structuredResult' = '{}'::jsonb
        )`,
    ),
    canonicalContractCheck: check(
      "tasks_canonical_contract_check",
      sql`btrim(${table.request}) <> ''
        and ${table.ownershipEpoch} > 0`,
    ),
    ownerShapeCheck: check(
      "tasks_owner_shape_check",
      sql`(
        ${table.ownerKind} = 'agent'
        and ${table.ownerAgentId} is not null
        and ${table.ownerUserId} is null
        and ${table.ownerAssignmentSource} is null
        and ${table.ownershipEpoch} > 0
      ) or (
        ${table.ownerKind} = 'user'
        and ${table.ownerAgentId} is null
        and ${table.ownerUserId} is not null
        and (
          (
            ${table.ownerAssignmentSource} = 'user_creator_withdrawal'
            and ${table.ownerUserId} = ${table.creatorUserId}
          )
          or (
            ${table.ownerAssignmentSource} is null
            and ${table.creatorKind} = 'system'
            and ${table.escalatedFromAffectedTaskId} is not null
          )
        )
        and ${table.ownershipEpoch} > 0
      ) or (
        ${table.ownerKind} = 'board'
        and ${table.ownerAgentId} is null
        and ${table.ownerUserId} is null
        and ${table.ownerAssignmentSource} is null
        and ${table.ownershipEpoch} > 0
        and ${table.creatorKind} = 'system'
      )`,
    ),
    creatorShapeCheck: check(
      "tasks_creator_shape_check",
      sql`(
        ${table.creatorKind} = 'agent-execution'
        and ${table.creatorAuthorityId} is not null
        and ${table.creatorAdapterConfigRevisionId} is not null
        and ${table.creatorUserId} is null
        and ${table.creatorPluginInstallationId} is null
        and ${table.creatorPluginKey} is null
        and ${table.creatorCallbackKey} is null
        and ${table.creatorCallbackVersion} is null
        and ${table.creatorRoutineId} is null
        and ${table.creatorRoutineDispatchId} is null
        and ${table.creatorSystemSourceKind} is null
        and ${table.creatorSystemSourceId} is null
      ) or (
        ${table.creatorKind} = 'user/board'
        and ${table.creatorAuthorityId} is null
        and ${table.creatorAdapterConfigRevisionId} is null
        and ${table.creatorPluginInstallationId} is null
        and ${table.creatorPluginKey} is null
        and ${table.creatorCallbackKey} is null
        and ${table.creatorCallbackVersion} is null
        and ${table.creatorRoutineId} is null
        and ${table.creatorRoutineDispatchId} is null
        and ${table.creatorSystemSourceKind} is null
        and ${table.creatorSystemSourceId} is null
      ) or (
        ${table.creatorKind} = 'plugin'
        and ${table.creatorAuthorityId} is null
        and ${table.creatorAdapterConfigRevisionId} is null
        and ${table.creatorUserId} is null
        and ${table.creatorPluginInstallationId} is not null
        and ${table.creatorPluginKey} is not null
        and ${table.creatorCallbackKey} is not null
        and ${table.creatorCallbackVersion} is not null
        and ${table.creatorRoutineId} is null
        and ${table.creatorRoutineDispatchId} is null
        and ${table.creatorSystemSourceKind} is null
        and ${table.creatorSystemSourceId} is null
      ) or (
        ${table.creatorKind} = 'routine'
        and ${table.creatorAuthorityId} is null
        and ${table.creatorAdapterConfigRevisionId} is null
        and ${table.creatorUserId} is null
        and ${table.creatorPluginInstallationId} is null
        and ${table.creatorPluginKey} is null
        and ${table.creatorCallbackKey} is null
        and ${table.creatorCallbackVersion} is null
        and ${table.creatorRoutineId} is not null
        and ${table.creatorRoutineDispatchId} is not null
        and ${table.creatorSystemSourceKind} is null
        and ${table.creatorSystemSourceId} is null
      ) or (
        ${table.creatorKind} = 'system'
        and ${table.creatorAuthorityId} is null
        and ${table.creatorAdapterConfigRevisionId} is null
        and ${table.creatorUserId} is null
        and ${table.creatorPluginInstallationId} is null
        and ${table.creatorPluginKey} is null
        and ${table.creatorCallbackKey} is null
        and ${table.creatorCallbackVersion} is null
        and ${table.creatorRoutineId} is null
        and ${table.creatorRoutineDispatchId} is null
        and ${table.creatorSystemSourceKind} is not null
        and ${table.creatorSystemSourceKind} in ('recovery', 'liveness')
        and ${table.creatorSystemSourceId} is not null
      )`,
    ),
    escalationShapeCheck: check(
      "tasks_escalation_shape_check",
      sql`(
        ${table.escalatedFromAffectedTaskId} is null
        and ${table.escalatedFromTriggeringRunId} is null
        and ${table.escalatedFromReason} is null
        and ${table.affectedOwnershipEpoch} is null
        and ${table.creatorKind} <> 'system'
      ) or (
        ${table.escalatedFromAffectedTaskId} is not null
        and ${table.escalatedFromAffectedTaskId} <> ${table.id}
        and ${table.escalatedFromReason} is not null
        and ${table.affectedOwnershipEpoch} is not null
        and ${table.affectedOwnershipEpoch} > 0
        and ${table.creatorKind} = 'system'
        and ${table.parentId} is null
      )`,
    ),
  }),
);
