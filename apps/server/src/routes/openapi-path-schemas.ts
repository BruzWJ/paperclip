import {
  ACP_COST_CURSOR_STATES,
  ACP_COST_UNAVAILABLE_REASONS,
  TASK_EXECUTION_RUN_KINDS,
  budgetCurrencySchema,
  canonicalUuidSchema,
  moneyAmountSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import {
  exactIsoDateTimeQueryParameterSchema,
  exactPositiveIntegerQueryParameterSchema,
} from "./openapi-catalog.js";

// ─── Costs ───────────────────────────────────────────────────────────────────

export const costRangeQuerySchema = z
  .object({
    from: exactIsoDateTimeQueryParameterSchema.optional(),
    to: exactIsoDateTimeQueryParameterSchema.optional(),
  })
  .strict();

export const costListQuerySchema = costRangeQuerySchema
  .extend({
    limit: exactPositiveIntegerQueryParameterSchema(500).optional(),
  })
  .strict();

export const costSummaryResponseSchema = z
  .object({
    companyId: canonicalUuidSchema,
    budgetCurrency: budgetCurrencySchema,
    knownSpendAmount: moneyAmountSchema,
    budgetMonthlyAmount: moneyAmountSchema,
    remainingAmount: moneyAmountSchema,
    utilizationPercent: z.number().nonnegative(),
    pricedPromptCount: z.number().int().nonnegative(),
    unpricedPromptCount: z.number().int().nonnegative(),
  })
  .strict();

export const costByAgentResponseSchema = z.array(
  z
    .object({
      agentId: canonicalUuidSchema,
      agentName: z.string().nullable(),
      agentStatus: z.string().nullable(),
      budgetCurrency: budgetCurrencySchema,
      knownCostAmount: moneyAmountSchema,
      pricedPromptCount: z.number().int().nonnegative(),
      unpricedPromptCount: z.number().int().nonnegative(),
    })
    .strict(),
);

export const costByProjectResponseSchema = z.array(
  z
    .object({
      projectId: canonicalUuidSchema.nullable(),
      projectName: z.string().nullable(),
      budgetCurrency: budgetCurrencySchema,
      knownCostAmount: moneyAmountSchema,
      pricedPromptCount: z.number().int().nonnegative(),
      unpricedPromptCount: z.number().int().nonnegative(),
    })
    .strict(),
);

export const taskCostSummaryResponseSchema = z
  .object({
    taskId: canonicalUuidSchema,
    taskCount: z.number().int().nonnegative(),
    includeDescendants: z.boolean(),
    budgetCurrency: budgetCurrencySchema,
    knownCostAmount: moneyAmountSchema,
    pricedPromptCount: z.number().int().nonnegative(),
    unpricedPromptCount: z.number().int().nonnegative(),
    runCount: z.number().int().nonnegative(),
    runtimeMs: z.number().nonnegative(),
  })
  .strict();

export const canonicalCostEventResponseSchema = z
  .object({
    id: canonicalUuidSchema,
    accountingId: canonicalUuidSchema,
    companyId: canonicalUuidSchema,
    taskId: canonicalUuidSchema,
    agentId: canonicalUuidSchema,
    runId: canonicalUuidSchema,
    runKind: z.enum(TASK_EXECUTION_RUN_KINDS),
    promptKind: z.enum(["base", "steering"]),
    refId: canonicalUuidSchema.nullable(),
    runOrdinal: z.number().int().nonnegative().nullable(),
    segmentOrdinal: z.number().int().nonnegative().nullable(),
    budgetCurrency: budgetCurrencySchema,
    kind: z.enum(["known", "unavailable"]),
    unavailableReason: z.enum(ACP_COST_UNAVAILABLE_REASONS).nullable(),
    observedCumulativeAmount: moneyAmountSchema.nullable(),
    observedCurrency: z.string().nullable(),
    knownDeltaAmount: moneyAmountSchema.nullable(),
    cursorBeforeState: z.enum(ACP_COST_CURSOR_STATES),
    cursorBeforeAmount: moneyAmountSchema.nullable(),
    cursorBeforeCurrency: budgetCurrencySchema.nullable(),
    cursorAfterState: z.enum(["known", "unavailable"]),
    cursorAfterAmount: moneyAmountSchema.nullable(),
    cursorAfterCurrency: budgetCurrencySchema.nullable(),
    occurredAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const financeSummaryRowResponseSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    debitAmount: moneyAmountSchema,
    creditAmount: moneyAmountSchema,
    netDirection: z.enum(["debit", "credit"]),
    netAmount: moneyAmountSchema,
    estimatedDebitAmount: moneyAmountSchema,
    eventCount: z.number().int().nonnegative(),
  })
  .strict();

export const financeEventResponseSchema = z
  .object({
    amount: moneyAmountSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .passthrough();

export const budgetPolicySummaryResponseSchema = z
  .object({
    budgetCurrency: budgetCurrencySchema,
    limitAmount: moneyAmountSchema,
    observedAmount: moneyAmountSchema,
    remainingAmount: moneyAmountSchema,
  })
  .passthrough();

export const budgetIncidentResponseSchema = z
  .object({
    budgetCurrency: budgetCurrencySchema,
    limitAmount: moneyAmountSchema,
    observedAmount: moneyAmountSchema,
  })
  .passthrough();

// ─── Plugins ──────────────────────────────────────────────────────────────────

export const pluginInstallationParams = z.object({
  pluginId: canonicalUuidSchema,
});
