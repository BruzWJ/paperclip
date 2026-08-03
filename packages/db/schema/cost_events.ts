import type {
  AcpCostCursorState,
  AcpCostUnavailableReason,
  IssueExecutionRunKind,
} from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import {
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
import {
  acpPromptAccounting,
  type AcpPromptAccountingKind,
} from "./acp_prompt_accounting.js";
import { companies } from "./companies.js";
import {
  budgetCurrencyColumn,
  moneyAmountColumn,
  nonnegativeFiniteMoneyCheck,
} from "./money.js";

export type AcpPromptCostKind = "known" | "unavailable";

/** One immutable cumulative-cost cursor transition for one settled ACP prompt. */
export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountingId: uuid("accounting_id")
      .notNull()
      .references(() => acpPromptAccounting.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    runId: uuid("run_id").notNull(),
    runKind: text("run_kind").$type<IssueExecutionRunKind>().notNull(),
    promptKind: text("prompt_kind").$type<AcpPromptAccountingKind>().notNull(),
    refId: uuid("ref_id"),
    runOrdinal: integer("run_ordinal"),
    segmentOrdinal: integer("segment_ordinal"),
    budgetCurrency: budgetCurrencyColumn("budget_currency").notNull(),
    kind: text("kind").$type<AcpPromptCostKind>().notNull(),
    unavailableReason: text("unavailable_reason").$type<
      AcpCostUnavailableReason
    >(),
    observedCumulativeAmount: moneyAmountColumn(
      "observed_cumulative_amount",
    ),
    observedCurrency: text("observed_currency"),
    knownDeltaAmount: moneyAmountColumn("known_delta_amount"),
    cursorBeforeState: text("cursor_before_state")
      .$type<AcpCostCursorState>()
      .notNull(),
    cursorBeforeAmount: moneyAmountColumn("cursor_before_amount"),
    cursorBeforeCurrency: budgetCurrencyColumn("cursor_before_currency"),
    cursorAfterState: text("cursor_after_state")
      .$type<"known" | "unavailable">()
      .notNull(),
    cursorAfterAmount: moneyAmountColumn("cursor_after_amount"),
    cursorAfterCurrency: budgetCurrencyColumn("cursor_after_currency"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "cost_events_prompt_identity_check",
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
      "cost_events_amounts_check",
      sql`(${table.observedCumulativeAmount} is null
          or (${nonnegativeFiniteMoneyCheck(table.observedCumulativeAmount)}))
        and (${table.knownDeltaAmount} is null
          or (${nonnegativeFiniteMoneyCheck(table.knownDeltaAmount)}))
        and (${table.cursorBeforeAmount} is null
          or (${nonnegativeFiniteMoneyCheck(table.cursorBeforeAmount)}))
        and (${table.cursorAfterAmount} is null
          or (${nonnegativeFiniteMoneyCheck(table.cursorAfterAmount)}))`,
    ),
    check(
      "cost_events_observed_pair_check",
      sql`(
        ${table.observedCumulativeAmount} is null
        and ${table.observedCurrency} is null
      ) or (
        ${table.observedCumulativeAmount} is not null
        and ${table.observedCurrency} is not null
        and length(${table.observedCurrency}) > 0
        and ${table.observedCurrency} = btrim(${table.observedCurrency})
      )`,
    ),
    check(
      "cost_events_cursor_before_check",
      sql`(
        ${table.cursorBeforeState} = 'unanchored'
        and ${table.cursorBeforeAmount} is null
        and ${table.cursorBeforeCurrency} is null
      ) or (
        ${table.cursorBeforeState} = 'known'
        and ${table.cursorBeforeAmount} is not null
        and ${table.cursorBeforeCurrency} is not null
        and ${table.cursorBeforeCurrency} = ${table.budgetCurrency}
      ) or (
        ${table.cursorBeforeState} = 'unavailable'
        and ${table.cursorBeforeAmount} is null
        and ${table.cursorBeforeCurrency} is null
      )`,
    ),
    check(
      "cost_events_cursor_after_check",
      sql`(
        ${table.cursorAfterState} = 'known'
        and ${table.cursorAfterAmount} is not null
        and ${table.cursorAfterCurrency} is not null
        and ${table.cursorAfterCurrency} = ${table.budgetCurrency}
      ) or (
        ${table.cursorAfterState} = 'unavailable'
        and ${table.cursorAfterAmount} is null
        and ${table.cursorAfterCurrency} is null
      )`,
    ),
    check(
      "cost_events_transition_check",
      sql`(
        ${table.kind} = 'known'
        and ${table.unavailableReason} is null
        and ${table.observedCumulativeAmount} is not null
        and ${table.observedCurrency} = ${table.budgetCurrency}
        and ${table.knownDeltaAmount} is not null
        and ${table.cursorAfterState} = 'known'
        and ${table.cursorAfterAmount} = ${table.observedCumulativeAmount}
        and (
          (
            ${table.cursorBeforeState} = 'unanchored'
            and ${table.knownDeltaAmount} = ${table.observedCumulativeAmount}
          ) or (
            ${table.cursorBeforeState} = 'known'
            and ${table.observedCumulativeAmount} >= ${table.cursorBeforeAmount}
            and ${table.knownDeltaAmount}
              = ${table.observedCumulativeAmount} - ${table.cursorBeforeAmount}
          )
        )
      ) or (
        ${table.kind} = 'unavailable'
        and ${table.unavailableReason} is not null
        and ${table.unavailableReason} in (
          'absent',
          'malformed',
          'decreasing',
          'currency_mismatch',
          'reanchor_after_unavailable'
        )
        and ${table.knownDeltaAmount} is null
        and (
          (
            ${table.unavailableReason} in ('absent', 'malformed')
            and ${table.observedCumulativeAmount} is null
            and ${table.observedCurrency} is null
            and ${table.cursorAfterState} = 'unavailable'
          ) or (
            ${table.unavailableReason} = 'decreasing'
            and ${table.cursorBeforeState} = 'known'
            and ${table.observedCumulativeAmount} is not null
            and ${table.observedCurrency} = ${table.budgetCurrency}
            and ${table.observedCumulativeAmount} < ${table.cursorBeforeAmount}
            and ${table.cursorAfterState} = 'unavailable'
          ) or (
            ${table.unavailableReason} = 'currency_mismatch'
            and ${table.observedCumulativeAmount} is not null
            and ${table.observedCurrency} is not null
            and ${table.observedCurrency} <> ${table.budgetCurrency}
            and ${table.cursorAfterState} = 'unavailable'
          ) or (
            ${table.unavailableReason} = 'reanchor_after_unavailable'
            and ${table.cursorBeforeState} = 'unavailable'
            and ${table.observedCumulativeAmount} is not null
            and ${table.observedCurrency} = ${table.budgetCurrency}
            and ${table.cursorAfterState} = 'known'
            and ${table.cursorAfterAmount} = ${table.observedCumulativeAmount}
          )
        )
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.budgetCurrency],
      foreignColumns: [companies.id, companies.budgetCurrency],
      name: "cost_events_company_budget_currency_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.agentId,
        table.runId,
        table.runKind,
        table.refId,
        table.runOrdinal,
        table.segmentOrdinal,
        table.accountingId,
      ],
      foreignColumns: [
        acpPromptAccounting.companyId,
        acpPromptAccounting.issueId,
        acpPromptAccounting.agentId,
        acpPromptAccounting.runId,
        acpPromptAccounting.runKind,
        acpPromptAccounting.refId,
        acpPromptAccounting.runOrdinal,
        acpPromptAccounting.segmentOrdinal,
        acpPromptAccounting.id,
      ],
      name: "cost_events_productive_accounting_fk",
    }).onDelete("restrict"),
    unique("cost_events_accounting_uq").on(table.accountingId),
    index("cost_events_company_occurred_idx").on(
      table.companyId,
      table.occurredAt,
    ),
    index("cost_events_company_agent_occurred_idx").on(
      table.companyId,
      table.agentId,
      table.occurredAt,
    ),
    index("cost_events_run_idx").on(table.companyId, table.runId),
    index("cost_events_known_company_idx")
      .on(table.companyId, table.occurredAt)
      .where(sql`${table.kind} = 'known'`),
  ],
);

export type CostEvent = typeof costEvents.$inferSelect;
export type NewCostEvent = typeof costEvents.$inferInsert;
