import type { IssueExecutionRunKind } from "@paperclipai/shared";
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentAdapterConfigRevisions } from "./agent_adapter_config_revisions.js";
import { agents } from "./agents.js";
import {
  issueExecutionAttempts,
  issueExecutionRunRefs,
  issueExecutionRuns,
} from "./issue_execution_runs.js";
import { issueSessions } from "./issue_sessions.js";

export type AcpPromptAccountingKind = "base" | "steering";

/**
 * The only stable ACP usage observation. Detailed provider token breakdowns
 * remain optional donor projections; this row records terminal occupancy only.
 */
export const acpPromptAccounting = pgTable(
  "acp_prompt_accounting",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    sessionId: text("session_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    runId: uuid("run_id").notNull(),
    runKind: text("run_kind").$type<IssueExecutionRunKind>().notNull(),
    promptKind: text("prompt_kind").$type<AcpPromptAccountingKind>().notNull(),
    refId: uuid("ref_id"),
    runOrdinal: integer("run_ordinal"),
    segmentOrdinal: integer("segment_ordinal"),
    attemptId: uuid("attempt_id").notNull(),
    adapterConfigRevisionId: uuid("adapter_config_revision_id").notNull(),
    selectedModelId: text("selected_model_id").notNull(),
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
      sql`(
        ${table.promptKind} = 'base'
        and ${table.runKind} in ('productive', 'consult')
        and ${table.refId} is not null
        and ${table.runOrdinal} is not null
        and ${table.runOrdinal} >= 0
        and ${table.segmentOrdinal} is not null
        and ${table.segmentOrdinal} = 0
      ) or (
        ${table.promptKind} = 'steering'
        and ${table.runKind} in ('productive', 'consult')
        and ${table.refId} is not null
        and ${table.runOrdinal} is not null
        and ${table.runOrdinal} >= 0
        and ${table.segmentOrdinal} is not null
        and ${table.segmentOrdinal} > 0
      )`,
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
      sql`length(btrim(${table.selectedModelId})) between 1 and 500
        and length(btrim(${table.terminalUsageReference})) between 1 and 500
        and length(btrim(${table.terminalStopReference})) between 1 and 500`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.sessionId],
      foreignColumns: [
        issueSessions.companyId,
        issueSessions.issueId,
        issueSessions.id,
      ],
      name: "acp_prompt_accounting_session_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.runId,
        table.runKind,
        table.adapterConfigRevisionId,
      ],
      foreignColumns: [
        issueExecutionRuns.companyId,
        issueExecutionRuns.issueId,
        issueExecutionRuns.id,
        issueExecutionRuns.kind,
        issueExecutionRuns.adapterConfigRevisionId,
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
        table.issueId,
        table.runId,
        table.attemptId,
        table.runKind,
        table.promptKind,
        table.runOrdinal,
        table.refId,
        table.segmentOrdinal,
      ],
      foreignColumns: [
        issueExecutionAttempts.companyId,
        issueExecutionAttempts.issueId,
        issueExecutionAttempts.runId,
        issueExecutionAttempts.id,
        issueExecutionAttempts.runKind,
        issueExecutionAttempts.promptKind,
        issueExecutionAttempts.refOrdinal,
        issueExecutionAttempts.refId,
        issueExecutionAttempts.segmentOrdinal,
      ],
      name: "acp_prompt_accounting_productive_attempt_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.sessionId,
        table.runId,
        table.runOrdinal,
        table.refId,
      ],
      foreignColumns: [
        issueExecutionRunRefs.companyId,
        issueExecutionRunRefs.issueId,
        issueExecutionRunRefs.sessionId,
        issueExecutionRunRefs.runId,
        issueExecutionRunRefs.refOrdinal,
        issueExecutionRunRefs.refId,
      ],
      name: "acp_prompt_accounting_run_ref_fk",
    }).onDelete("cascade"),
    unique("acp_prompt_accounting_scope_id_uq").on(
      table.companyId,
      table.issueId,
      table.runId,
      table.id,
    ),
    unique("acp_prompt_accounting_common_attribution_uq").on(
      table.companyId,
      table.issueId,
      table.agentId,
      table.runId,
      table.runKind,
      table.id,
    ),
    unique(
      "acp_prompt_accounting_productive_cost_attribution_uq",
    ).on(
      table.companyId,
      table.issueId,
      table.agentId,
      table.runId,
      table.runKind,
      table.refId,
      table.runOrdinal,
      table.segmentOrdinal,
      table.id,
    ),
    uniqueIndex("acp_prompt_accounting_productive_prompt_uq")
      .on(
        table.runId,
        table.refId,
        table.runOrdinal,
        table.segmentOrdinal,
      )
      .where(sql`${table.promptKind} in ('base', 'steering')`),
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
