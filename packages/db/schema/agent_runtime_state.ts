import type { TaskExecutionRunStatus } from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { taskExecutionRuns } from "./task_execution_runs.js";
import {
  moneyAmountColumn,
  nonnegativeFiniteMoneyCheck,
} from "./money.js";

/**
 * Agent-scoped operational facts only. Conversational continuity remains in
 * the task Session graph and opaque ACP target correlation.
 */
export const agentRuntimeState = pgTable(
  "agent_runtime_state",
  {
    agentId: uuid("agent_id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    lastRunId: uuid("last_run_id"),
    lastRunStatus: text("last_run_status").$type<TaskExecutionRunStatus>(),
    lastContextUsedTokens: bigint("last_context_used_tokens", {
      mode: "number",
    }),
    lastContextWindowTokens: bigint("last_context_window_tokens", {
      mode: "number",
    }),
    peakContextUsedTokens: bigint("peak_context_used_tokens", {
      mode: "number",
    })
      .notNull()
      .default(0),
    aggregateKnownCostAmount: moneyAmountColumn(
      "aggregate_known_cost_amount",
    )
      .notNull()
      .default(sql`'0'::numeric`),
    unpricedPromptCount: bigint("unpriced_prompt_count", { mode: "number" })
      .notNull()
      .default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "agent_runtime_state_last_run_check",
      sql`(
        ${table.lastRunId} is null
        and ${table.lastRunStatus} is null
      ) or (
        ${table.lastRunId} is not null
        and ${table.lastRunStatus} is not null
        and ${table.lastRunStatus} in (
          'queued',
          'scheduled_retry',
          'running',
          'succeeded',
          'interrupted',
          'failed',
          'cancelled',
          'timed_out'
        )
      )`,
    ),
    check(
      "agent_runtime_state_context_occupancy_check",
      sql`(
        ${table.lastContextUsedTokens} is null
        and ${table.lastContextWindowTokens} is null
      ) or (
        ${table.lastContextUsedTokens} is not null
        and ${table.lastContextUsedTokens} >= 0
        and ${table.lastContextWindowTokens} is not null
        and ${table.lastContextWindowTokens} > 0
        and ${table.lastContextUsedTokens} <= ${table.lastContextWindowTokens}
        and ${table.peakContextUsedTokens} >= ${table.lastContextUsedTokens}
      )`,
    ),
    check(
      "agent_runtime_state_aggregates_check",
      sql`${table.peakContextUsedTokens} >= 0
        and ${table.unpricedPromptCount} >= 0
        and ${nonnegativeFiniteMoneyCheck(table.aggregateKnownCostAmount)}`,
    ),
    check(
      "agent_runtime_state_time_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "agent_runtime_state_agent_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.lastRunId],
      foreignColumns: [taskExecutionRuns.companyId, taskExecutionRuns.id],
      name: "agent_runtime_state_last_run_fk",
    }).onDelete("restrict"),
    index("agent_runtime_state_company_agent_idx").on(
      table.companyId,
      table.agentId,
    ),
    index("agent_runtime_state_company_updated_idx").on(
      table.companyId,
      table.updatedAt,
    ),
    index("agent_runtime_state_company_last_run_idx").on(
      table.companyId,
      table.lastRunId,
    ),
  ],
);
