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
import { goals } from "./goals.js";
import { companies } from "./companies.js";
import { issueExecutionRuns } from "./issue_execution_runs.js";
import { projectWorkspaces } from "./project_workspaces.js";
import type {
  AgentVisibleIssueStatus,
  ContextAccess,
  IssueCreatorKind,
  IssueDisposition,
  IssueOwnerKind,
  IssueStatus,
  SourceTrustMetadata,
  SystemCreatorSourceKind,
} from "@paperclipai/shared";

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id),
    projectWorkspaceId: uuid("project_workspace_id").references(() => projectWorkspaces.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id),
    parentId: uuid("parent_id"),
    /** Immutable parent epoch captured when this direct child is created. */
    parentOwnershipEpoch: integer("parent_ownership_epoch"),
    title: text("title"),
    request: text("request").notNull(),
    lifecycleStatus: text("lifecycle_status")
      .$type<AgentVisibleIssueStatus>()
      .notNull(),
    boardPresentationStatus: text("board_presentation_status")
      .$type<IssueStatus>()
      .notNull(),
    disposition: jsonb("disposition").$type<IssueDisposition | null>(),
    workMode: text("work_mode").notNull().default("standard"),
    harnessKind: text("harness_kind"),
    priority: text("priority").notNull().default("medium"),
    ownerKind: text("owner_kind").$type<IssueOwnerKind>().notNull(),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    ownerUserId: text("owner_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    ownerAssignmentSource: text("owner_assignment_source"),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    creatorKind: text("creator_kind").$type<IssueCreatorKind>().notNull(),
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
    contextAccessMask: jsonb("context_access_mask").$type<ContextAccess | null>(),
    escalatedFromAffectedIssueId: uuid("escalated_from_affected_issue_id").references(
      (): AnyPgColumn => issues.id,
      { onDelete: "restrict" },
    ),
    escalatedFromTriggeringRunId: uuid("escalated_from_triggering_run_id").references(
      (): AnyPgColumn => issueExecutionRuns.id,
      { onDelete: "restrict" },
    ),
    escalatedFromReason: text("escalated_from_reason"),
    affectedOwnershipEpoch: integer("affected_ownership_epoch"),
    responsibleUserId: text("responsible_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    issueNumber: integer("issue_number"),
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
    executionWorkspacePreference: text("execution_workspace_preference"),
    executionWorkspaceSettings: jsonb("execution_workspace_settings").$type<Record<string, unknown>>(),
    sourceTrust: jsonb("source_trust").$type<SourceTrustMetadata | null>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("issues_company_status_idx").on(
      table.companyId,
      table.lifecycleStatus,
    ),
    companyHarnessKindIdx: index("issues_company_harness_kind_idx").on(table.companyId, table.harnessKind),
    ownerStatusIdx: index("issues_company_owner_status_idx").on(
      table.companyId,
      table.ownerAgentId,
      table.lifecycleStatus,
    ),
    ownerUserStatusIdx: index("issues_company_owner_user_status_idx").on(
      table.companyId,
      table.ownerUserId,
      table.lifecycleStatus,
    ),
    responsibleUserIdx: index("issues_company_responsible_user_idx").on(table.companyId, table.responsibleUserId),
    parentIdx: index("issues_company_parent_idx").on(table.companyId, table.parentId),
    projectIdx: index("issues_company_project_idx").on(table.companyId, table.projectId),
    originIdx: index("issues_company_origin_idx").on(table.companyId, table.originKind, table.originId),
    projectWorkspaceIdx: index("issues_company_project_workspace_idx").on(table.companyId, table.projectWorkspaceId),
    dueMonitorIdx: index("issues_company_monitor_due_idx").on(table.companyId, table.monitorNextCheckAt),
    companyUpdatedIdx: index("issues_company_updated_idx").on(table.companyId, table.updatedAt),
    companyCreatedIdx: index("issues_company_created_idx").on(table.companyId, table.createdAt),
    openNormalizedTitleCreatedIdx: index("issues_open_normalized_title_created_idx")
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
    companyPriorityIdx: index("issues_company_priority_idx").on(table.companyId, table.priority),
    identifierIdx: uniqueIndex("issues_identifier_idx").on(table.identifier),
    titleSearchIdx: index("issues_title_search_idx").using("gin", table.title.op("gin_trgm_ops")),
    identifierSearchIdx: index("issues_identifier_search_idx").using("gin", table.identifier.op("gin_trgm_ops")),
    requestSearchIdx: index("issues_request_search_idx").using("gin", table.request.op("gin_trgm_ops")),
    companyIdUq: unique("issues_company_id_uq").on(table.companyId, table.id),
    parentEpochCheck: check(
      "issues_parent_epoch_check",
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
      name: "issues_parent_fk",
    }).onDelete("restrict"),
    lifecycleStatusCheck: check(
      "issues_lifecycle_status_check",
      sql`${table.lifecycleStatus} in ('open', 'blocked', 'done', 'cancelled')`,
    ),
    boardPresentationStatusCheck: check(
      "issues_board_presentation_status_check",
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
      "issues_lifecycle_disposition_check",
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
      "issues_canonical_contract_check",
      sql`btrim(${table.request}) <> ''
        and ${table.ownershipEpoch} > 0`,
    ),
    ownerShapeCheck: check(
      "issues_owner_shape_check",
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
            and ${table.escalatedFromAffectedIssueId} is not null
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
      "issues_creator_shape_check",
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
        and ${table.creatorSystemSourceKind} in ('watchdog', 'recovery', 'liveness')
        and ${table.creatorSystemSourceId} is not null
      )`,
    ),
    contextAccessMaskCheck: check(
      "issues_context_access_mask_check",
      sql`${table.contextAccessMask} is null
        or (
          jsonb_typeof(${table.contextAccessMask}) = 'object'
          and ${table.contextAccessMask} - array[
            'carry_context',
            'read_issue_comments',
            'read_issue_agent_run',
            'list_sub_issues',
            'read_sub_issue_comments',
            'read_sub_issue_agent_run',
            'list_company_issues',
            'read_company_issue_comments',
            'read_company_issue_agent_run'
          ]::text[] = '{}'::jsonb
          and not jsonb_path_exists(${table.contextAccessMask}, '$.* ? (@ != false)')
        )`,
    ),
    escalationShapeCheck: check(
      "issues_escalation_shape_check",
      sql`(
        ${table.escalatedFromAffectedIssueId} is null
        and ${table.escalatedFromTriggeringRunId} is null
        and ${table.escalatedFromReason} is null
        and ${table.affectedOwnershipEpoch} is null
        and ${table.creatorKind} <> 'system'
      ) or (
        ${table.escalatedFromAffectedIssueId} is not null
        and ${table.escalatedFromAffectedIssueId} <> ${table.id}
        and ${table.escalatedFromReason} is not null
        and ${table.affectedOwnershipEpoch} is not null
        and ${table.affectedOwnershipEpoch} > 0
        and ${table.creatorKind} = 'system'
        and ${table.parentId} is null
      )`,
    ),
  }),
);
