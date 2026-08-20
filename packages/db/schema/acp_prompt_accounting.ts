import type { TaskExecutionRunKind } from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agentAdapterConfigRevisions } from "./agent_adapter_config_revisions.js";
import { agents } from "./agents.js";
import {
  taskExecutionAttempts,
  taskExecutionRunRefs,
  taskExecutionRuns,
} from "./task_execution_runs.js";
import { taskSessions } from "./task_sessions.js";

/**
 * The only stable ACP usage observation. Detailed provider token breakdowns
 * remain optional donor projections; this row records terminal occupancy only.
 */
export const acpPromptAccounting = pgTable(
  "acp_prompt_accounting",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    taskId: uuid("task_id").notNull(),
    sessionId: text("session_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    runId: uuid("run_id").notNull(),
    runKind: text("run_kind").$type<TaskExecutionRunKind>().notNull(),
    refId: uuid("ref_id"),
    runOrdinal: integer("run_ordinal"),
    attemptId: uuid("attempt_id").notNull(),
    adapterConfigRevisionId: uuid("adapter_config_revision_id").notNull(),
    selectedModelId: text("selected_model_id"),
    contextTokenLimit: bigint("context_token_limit", { mode: "number" }).notNull(),
    contextUsedTokens: bigint("context_used_tokens", { mode: "number" }).notNull(),
    contextWindowTokens: bigint("context_window_tokens", {
      mode: "number",
    }).notNull(),
    promptSettlementReferenceId: uuid(
      "prompt_settlement_reference_id",
    ).notNull(),
    terminalUsageReference: text("terminal_usage_reference").notNull(),
    terminalStopReference: text("terminal_stop_reference").notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "acp_prompt_accounting_prompt_identity_check",
      sql`${table.runKind} in ('productive', 'consult')
        and ${table.refId} is not null
        and ${table.runOrdinal} is not null
        and ${table.runOrdinal} >= 0`,
    ),
    check(
      "acp_prompt_accounting_context_occupancy_check",
      sql`${table.contextUsedTokens} >= 0
        and ${table.contextWindowTokens} > 0
        and ${table.contextTokenLimit} > 0
        and ${table.contextUsedTokens} <= ${table.contextWindowTokens}
        and ${table.contextWindowTokens} = ${table.contextTokenLimit}`,
    ),
    check(
      "acp_prompt_accounting_references_check",
      sql`(
          ${table.selectedModelId} is null
          or length(btrim(${table.selectedModelId})) between 1 and 500
        )
        and length(btrim(${table.terminalUsageReference})) between 1 and 500
        and length(btrim(${table.terminalStopReference})) between 1 and 500`,
    ),
    foreignKey({
      columns: [table.companyId, table.taskId, table.sessionId],
      foreignColumns: [
        taskSessions.companyId,
        taskSessions.taskId,
        taskSessions.id,
      ],
      name: "acp_prompt_accounting_session_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.runId,
        table.runKind,
        table.adapterConfigRevisionId,
      ],
      foreignColumns: [
        taskExecutionRuns.companyId,
        taskExecutionRuns.taskId,
        taskExecutionRuns.id,
        taskExecutionRuns.kind,
        taskExecutionRuns.adapterConfigRevisionId,
      ],
      name: "acp_prompt_accounting_run_revision_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "acp_prompt_accounting_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.agentId,
        table.adapterConfigRevisionId,
      ],
      foreignColumns: [
        agentAdapterConfigRevisions.companyId,
        agentAdapterConfigRevisions.agentId,
        agentAdapterConfigRevisions.id,
      ],
      name: "acp_prompt_accounting_adapter_revision_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.runId,
        table.attemptId,
        table.runKind,
        table.runOrdinal,
        table.refId,
      ],
      foreignColumns: [
        taskExecutionAttempts.companyId,
        taskExecutionAttempts.taskId,
        taskExecutionAttempts.runId,
        taskExecutionAttempts.id,
        taskExecutionAttempts.runKind,
        taskExecutionAttempts.refOrdinal,
        taskExecutionAttempts.refId,
      ],
      name: "acp_prompt_accounting_attempt_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.sessionId,
        table.runId,
        table.runOrdinal,
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
      name: "acp_prompt_accounting_run_ref_fk",
    }).onDelete("cascade"),
    unique("acp_prompt_accounting_scope_id_uq").on(
      table.companyId,
      table.taskId,
      table.runId,
      table.id,
    ),
    unique("acp_prompt_accounting_common_attribution_uq").on(
      table.companyId,
      table.taskId,
      table.agentId,
      table.runId,
      table.runKind,
      table.id,
    ),
    unique("acp_prompt_accounting_cost_attribution_uq").on(
      table.companyId,
      table.taskId,
      table.agentId,
      table.runId,
      table.runKind,
      table.refId,
      table.runOrdinal,
      table.id,
    ),
    unique("acp_prompt_accounting_prompt_uq").on(
      table.runId,
      table.refId,
      table.runOrdinal,
    ),
    index("acp_prompt_accounting_agent_settled_idx").on(
      table.companyId,
      table.agentId,
      table.settledAt,
    ),
    index("acp_prompt_accounting_run_idx").on(
      table.companyId,
      table.runId,
    ),
  ],
);

export type AcpPromptAccounting = typeof acpPromptAccounting.$inferSelect;
export type NewAcpPromptAccounting = typeof acpPromptAccounting.$inferInsert;
