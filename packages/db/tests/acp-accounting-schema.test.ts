import type { MoneyAmount } from "@paperclipai/shared";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { acpPromptAccounting } from "../schema/acp_prompt_accounting.js";
import { agentRuntimeState } from "../schema/agent_runtime_state.js";
import { agents } from "../schema/agents.js";
import { budgetIncidents } from "../schema/budget_incidents.js";
import { budgetPolicies } from "../schema/budget_policies.js";
import { companies } from "../schema/companies.js";
import { costEvents } from "../schema/cost_events.js";
import { financeEvents } from "../schema/finance_events.js";
import { issueExecutionSessions } from "../schema/issue_execution_capabilities.js";
import {
  issueSessionEvents,
  issueSessionMessages,
} from "../schema/issue_sessions.js";

// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: usage_json, billed_cents

const dialect = new PgDialect();

function columns(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function checkSql(
  table: Parameters<typeof getTableConfig>[0],
  name: string,
): string {
  const constraint = getTableConfig(table).checks.find(
    (candidate) => candidate.name === name,
  );
  expect(constraint).toBeDefined();
  return dialect.sqlToQuery(constraint!.value).sql;
}

function foreignKeyNames(
  table: Parameters<typeof getTableConfig>[0],
): string[] {
  return getTableConfig(table).foreignKeys.map((foreignKey) =>
    foreignKey.getName(),
  );
}

function foreignKeyTargetNames(
  table: Parameters<typeof getTableConfig>[0],
): string[] {
  return getTableConfig(table).foreignKeys.map((foreignKey) =>
    getTableConfig(foreignKey.reference().foreignTable).name,
  );
}

function foreignKeyColumns(
  table: Parameters<typeof getTableConfig>[0],
  name: string,
): { columns: string[]; foreignColumns: string[] } {
  const foreignKey = getTableConfig(table).foreignKeys.find(
    (candidate) => candidate.getName() === name,
  );
  expect(foreignKey).toBeDefined();
  const reference = foreignKey!.reference();
  return {
    columns: reference.columns.map((column) => column.name),
    foreignColumns: reference.foreignColumns.map((column) => column.name),
  };
}

describe("canonical ACP prompt accounting schema", () => {
  it("owns only exact terminal occupancy and checked prompt identities", () => {
    expect(getTableConfig(acpPromptAccounting).name).toBe(
      "acp_prompt_accounting",
    );
    expect(columns(acpPromptAccounting)).toEqual([
      "id",
      "company_id",
      "issue_id",
      "session_id",
      "agent_id",
      "run_id",
      "run_kind",
      "prompt_kind",
      "ref_id",
      "run_ordinal",
      "segment_ordinal",
      "attempt_id",
      "adapter_config_revision_id",
      "selected_model_id",
      "context_token_limit",
      "context_used_tokens",
      "context_window_tokens",
      "prompt_settlement_reference_id",
      "terminal_usage_reference",
      "terminal_stop_reference",
      "settled_at",
      "created_at",
    ]);
    expect(columns(acpPromptAccounting)).not.toEqual(
      expect.arrayContaining([
        "input_tokens",
        "output_tokens",
        "cached_input_tokens",
        "reasoning_tokens",
        "usage_json",
        "provider",
        "biller",
        "cost_cents",
      ]),
    );

    const identity = checkSql(
      acpPromptAccounting,
      "acp_prompt_accounting_prompt_identity_check",
    );
    expect(identity).toContain("= 'base'");
    expect(identity).toContain("= 'steering'");
    expect(identity).not.toContain("= 'compaction'");
    expect(identity).toContain('"segment_ordinal" is not null');
    expect(identity).toContain('"segment_ordinal" = 0');
    expect(identity).toContain('"segment_ordinal" > 0');

    const occupancy = checkSql(
      acpPromptAccounting,
      "acp_prompt_accounting_context_occupancy_check",
    );
    expect(occupancy).toContain('"context_used_tokens" >= 0');
    expect(occupancy).toContain('"context_window_tokens" > 0');
    expect(occupancy).toContain(
      '"context_window_tokens" = "acp_prompt_accounting"."context_token_limit"',
    );

    const selectedModelId = getTableConfig(acpPromptAccounting).columns.find(
      (column) => column.name === "selected_model_id",
    );
    expect(selectedModelId?.notNull).toBe(false);
    expect(
      checkSql(acpPromptAccounting, "acp_prompt_accounting_references_check"),
    ).toContain('"selected_model_id" is null');

    expect(foreignKeyNames(acpPromptAccounting)).toEqual(
      expect.arrayContaining([
        "acp_prompt_accounting_session_fk",
        "acp_prompt_accounting_run_revision_fk",
        "acp_prompt_accounting_adapter_revision_fk",
        "acp_prompt_accounting_productive_attempt_fk",
        "acp_prompt_accounting_run_ref_fk",
      ]),
    );
    expect(
      foreignKeyColumns(
        acpPromptAccounting,
        "acp_prompt_accounting_productive_attempt_fk",
      ),
    ).toMatchObject({
      columns: expect.arrayContaining(["segment_ordinal"]),
      foreignColumns: expect.arrayContaining(["segment_ordinal"]),
    });
    expect(
      getTableConfig(acpPromptAccounting).indexes
        .filter((index) => index.config.unique)
        .map((index) => index.config.name),
    ).toEqual(
      expect.arrayContaining([
        "acp_prompt_accounting_productive_prompt_uq",
      ]),
    );
  });

  it("binds canonical Session event and message rows only to canonical runs", () => {
    expect(foreignKeyTargetNames(issueSessionEvents)).toContain(
      "issue_execution_runs",
    );
    expect(foreignKeyTargetNames(issueSessionMessages)).toContain(
      "issue_execution_runs",
    );
    expect(
      checkSql(issueSessionEvents, "issue_session_events_type_check"),
    ).not.toContain("session.next.compaction");
    expect(
      checkSql(issueSessionMessages, "issue_session_messages_type_check"),
    ).not.toContain("'compaction'");
  });
});

describe("canonical ACP cost transition schema", () => {
  it("is one-to-one with accounting and contains no provider or token ledger", () => {
    expect(columns(costEvents)).toEqual([
      "id",
      "accounting_id",
      "company_id",
      "issue_id",
      "agent_id",
      "run_id",
      "run_kind",
      "prompt_kind",
      "ref_id",
      "run_ordinal",
      "segment_ordinal",
      "budget_currency",
      "kind",
      "unavailable_reason",
      "observed_cumulative_amount",
      "observed_currency",
      "known_delta_amount",
      "cursor_before_state",
      "cursor_before_amount",
      "cursor_before_currency",
      "cursor_after_state",
      "cursor_after_amount",
      "cursor_after_currency",
      "occurred_at",
      "created_at",
    ]);
    // PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: heartbeat_run_id, provider, biller, billing_type, model, input_tokens, cached_input_tokens, output_tokens, cost_cents
    expect(columns(costEvents)).not.toEqual(
      expect.arrayContaining([
        "heartbeat_run_id",
        "provider",
        "biller",
        "billing_type",
        "model",
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "cost_cents",
      ]),
    );
    expect(
      getTableConfig(costEvents).uniqueConstraints.map((constraint) =>
        constraint.getName(),
      ),
    ).toContain("cost_events_accounting_uq");
    expect(foreignKeyNames(costEvents)).toEqual(
      expect.arrayContaining([
        "cost_events_accounting_id_acp_prompt_accounting_id_fk",
        "cost_events_company_budget_currency_fk",
        "cost_events_productive_accounting_fk",
      ]),
    );
  });

  it("pins every cursor transition and rejects PostgreSQL special numerics", () => {
    const transition = checkSql(costEvents, "cost_events_transition_check");
    for (const reason of [
      "absent",
      "malformed",
      "decreasing",
      "currency_mismatch",
      "reanchor_after_unavailable",
    ]) {
      expect(transition).toContain(`'${reason}'`);
    }
    expect(transition).toContain("= 'known'");
    expect(transition).toContain("= 'unavailable'");
    expect(transition).toContain('"unavailable_reason" is not null');
    expect(transition).toContain('"known_delta_amount"');
    expect(transition).toContain(
      '= "cost_events"."observed_cumulative_amount" - "cost_events"."cursor_before_amount"',
    );
    const amounts = checkSql(costEvents, "cost_events_amounts_check");
    expect(amounts).toContain("'NaN'::numeric");
    expect(amounts).toContain("'Infinity'::numeric");
    expect(amounts).toContain(
      "'^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'",
    );
    expect(
      checkSql(costEvents, "cost_events_cursor_before_check"),
    ).toContain('"cursor_before_currency" is not null');
    expect(
      checkSql(costEvents, "cost_events_cursor_after_check"),
    ).toContain('"cursor_after_currency" is not null');
  });

  it("keeps every persisted amount as branded decimal-string numeric", () => {
    expectTypeOf<
      (typeof costEvents.$inferSelect)["knownDeltaAmount"]
    >().toEqualTypeOf<MoneyAmount | null>();
    expectTypeOf<
      (typeof costEvents.$inferSelect)["observedCumulativeAmount"]
    >().toEqualTypeOf<MoneyAmount | null>();
    for (const name of [
      "observed_cumulative_amount",
      "known_delta_amount",
      "cursor_before_amount",
      "cursor_after_amount",
    ]) {
      expect(
        getTableConfig(costEvents).columns.find(
          (column) => column.name === name,
        )?.getSQLType(),
      ).toBe("numeric");
    }
    expectTypeOf<
      (typeof issueExecutionSessions.$inferSelect)["costCursorAmount"]
    >().toEqualTypeOf<MoneyAmount | null>();
    expect(foreignKeyNames(issueExecutionSessions)).toContain(
      "issue_execution_sessions_cost_cursor_currency_fk",
    );
  });
});

describe("canonical money owners and runtime aggregate", () => {
  it("uses one company currency and decimal limits without writable spend", () => {
    expect(columns(companies)).toEqual(
      expect.arrayContaining(["budget_currency", "budget_monthly_amount"]),
    );
    expect(columns(companies)).not.toEqual(
      expect.arrayContaining(["budget_monthly_cents", "spent_monthly_cents"]),
    );
    expect(companies.budgetCurrency.hasDefault).toBe(false);
    const companyCurrency = checkSql(
      companies,
      "companies_budget_currency_check",
    );
    expect(companyCurrency).toContain("'USD'");
    expect(companyCurrency).toContain("'XCG'");
    expect(companyCurrency).toContain("'ZWG'");
    expect(
      checkSql(companies, "companies_budget_monthly_amount_check"),
    ).toContain("'^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'");
    expectTypeOf<
      (typeof companies.$inferSelect)["budgetMonthlyAmount"]
    >().toEqualTypeOf<MoneyAmount>();
    expect(columns(agents)).toContain("budget_monthly_amount");
    expect(columns(agents)).not.toEqual(
      expect.arrayContaining([
        "budget_currency",
        "budget_monthly_cents",
        "spent_monthly_cents",
      ]),
    );
    expect(columns(budgetPolicies)).toContain("limit_amount");
    expect(columns(budgetPolicies)).not.toEqual(
      expect.arrayContaining(["metric", "amount", "billed_cents"]),
    );
    expect(columns(budgetIncidents)).toEqual(
      expect.arrayContaining(["limit_amount", "observed_amount"]),
    );
    expect(columns(budgetIncidents)).not.toEqual(
      expect.arrayContaining(["metric", "amount_limit", "amount_observed"]),
    );
  });

  it("isolates the finance ledger while using the same exact money boundary", () => {
    expect(columns(financeEvents)).toEqual(
      expect.arrayContaining(["amount", "currency"]),
    );
    // PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: amount_cents, heartbeat_run_id, cost_event_id
    expect(columns(financeEvents)).not.toEqual(
      expect.arrayContaining([
        "amount_cents",
        "heartbeat_run_id",
        "cost_event_id",
      ]),
    );
    expect(foreignKeyNames(financeEvents)).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("cost_events"),
      ]),
    );
    expectTypeOf<
      (typeof financeEvents.$inferSelect)["amount"]
    >().toEqualTypeOf<MoneyAmount>();
  });

  it("retains only typed occupancy, known cost and unpriced runtime facts", () => {
    expect(columns(agentRuntimeState)).toEqual([
      "agent_id",
      "company_id",
      "adapter_type",
      "last_run_id",
      "last_run_status",
      "last_context_used_tokens",
      "last_context_window_tokens",
      "peak_context_used_tokens",
      "aggregate_known_cost_amount",
      "unpriced_prompt_count",
      "last_error",
      "created_at",
      "updated_at",
    ]);
    expect(columns(agentRuntimeState)).not.toEqual(
      expect.arrayContaining([
        "session_id",
        "state_json",
        "total_input_tokens",
        "total_output_tokens",
        "total_cached_input_tokens",
        "total_cost_cents",
        "usage_json",
      ]),
    );
    expect(foreignKeyNames(agentRuntimeState)).toEqual(
      expect.arrayContaining([
        "agent_runtime_state_agent_fk",
        "agent_runtime_state_last_run_fk",
      ]),
    );
    expect(
      checkSql(
        agentRuntimeState,
        "agent_runtime_state_context_occupancy_check",
      ),
    ).toContain(
      '"last_context_used_tokens" <= "agent_runtime_state"."last_context_window_tokens"',
    );
    expect(
      checkSql(agentRuntimeState, "agent_runtime_state_last_run_check"),
    ).toContain('"last_run_status" is not null');
    expectTypeOf<
      (typeof agentRuntimeState.$inferSelect)["aggregateKnownCostAmount"]
    >().toEqualTypeOf<MoneyAmount>();
  });
});
