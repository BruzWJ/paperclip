import {
  compareMoneyAmounts,
  moneyAmountFromFiniteNumber,
  parseMoneyAmount,
  subtractMoneyAmounts,
  type BudgetCurrency,
  type MoneyAmount,
} from "./money.js";

export const ACP_COST_UNAVAILABLE_REASONS = [
  "absent",
  "malformed",
  "decreasing",
  "currency_mismatch",
  "reanchor_after_unavailable",
] as const;

export type AcpCostUnavailableReason =
  (typeof ACP_COST_UNAVAILABLE_REASONS)[number];

export type AcpCostCursor =
  | { readonly state: "unanchored" }
  | {
      readonly state: "known";
      readonly amount: MoneyAmount;
      readonly currency: BudgetCurrency;
    }
  | { readonly state: "unavailable" };

export interface AcpReportedCumulativeCost {
  readonly amount: number;
  readonly currency: string;
}
interface AcpCostObservationAudit {
  readonly observedCumulativeAmount: MoneyAmount | null;
  readonly observedCurrency: string | null;
}

export type AcpCostSettlement =
  | (AcpCostObservationAudit & {
      readonly kind: "known";
      readonly unavailableReason: null;
      readonly knownDeltaAmount: MoneyAmount;
      readonly cursorAfter: Extract<AcpCostCursor, { state: "known" }>;
    })
  | (AcpCostObservationAudit & {
      readonly kind: "unavailable";
      readonly unavailableReason: AcpCostUnavailableReason;
      readonly knownDeltaAmount: null;
      readonly cursorAfter: Exclude<AcpCostCursor, { state: "unanchored" }>;
    });

function unavailable(input: {
  reason: AcpCostUnavailableReason;
  observedCumulativeAmount?: MoneyAmount | null;
  observedCurrency?: string | null;
  cursorAfter?: Exclude<AcpCostCursor, { state: "unanchored" }>;
}): AcpCostSettlement {
  return {
    kind: "unavailable",
    unavailableReason: input.reason,
    knownDeltaAmount: null,
    observedCumulativeAmount: input.observedCumulativeAmount ?? null,
    observedCurrency: input.observedCurrency ?? null,
    cursorAfter: input.cursorAfter ?? { state: "unavailable" },
  };
}

/**
 * Applies the one canonical cumulative ACP-cost transition after a prompt has
 * already supplied a valid stop plus terminal occupancy. Incomplete prompts
 * never call this function and therefore create no cost event or cursor move.
 */
export function settleAcpPromptCost(input: {
  readonly budgetCurrency: BudgetCurrency;
  readonly cursorBefore: AcpCostCursor;
  readonly observation: AcpReportedCumulativeCost | null;
}): AcpCostSettlement {
  if (input.cursorBefore.state === "known") {
    parseMoneyAmount(input.cursorBefore.amount);
    if (input.cursorBefore.currency !== input.budgetCurrency) {
      throw new Error("Known ACP cost cursor does not match company budget currency");
    }
  }
  if (input.observation === null) {
    return unavailable({ reason: "absent" });
  }
  const { amount, currency } = input.observation;
  let observedAmount: MoneyAmount;
  try {
    if (
      typeof currency !== "string" ||
      currency.length === 0 ||
      currency !== currency.trim()
    ) {
      throw new TypeError("invalid currency");
    }
    observedAmount = moneyAmountFromFiniteNumber(amount);
  } catch {
    return unavailable({ reason: "malformed" });
  }
  if (currency !== input.budgetCurrency) {
    return unavailable({
      reason: "currency_mismatch",
      observedCumulativeAmount: observedAmount,
      observedCurrency: currency,
    });
  }
  const cursorAfter = {
    state: "known" as const,
    amount: observedAmount,
    currency: input.budgetCurrency,
  };
  if (input.cursorBefore.state === "unavailable") {
    return unavailable({
      reason: "reanchor_after_unavailable",
      observedCumulativeAmount: observedAmount,
      observedCurrency: currency,
      cursorAfter,
    });
  }
  if (input.cursorBefore.state === "unanchored") {
    return {
      kind: "known",
      unavailableReason: null,
      observedCumulativeAmount: observedAmount,
      observedCurrency: currency,
      knownDeltaAmount: observedAmount,
      cursorAfter,
    };
  }
  if (compareMoneyAmounts(observedAmount, input.cursorBefore.amount) < 0) {
    return unavailable({
      reason: "decreasing",
      observedCumulativeAmount: observedAmount,
      observedCurrency: currency,
    });
  }
  return {
    kind: "known",
    unavailableReason: null,
    observedCumulativeAmount: observedAmount,
    observedCurrency: currency,
    knownDeltaAmount: subtractMoneyAmounts(
      observedAmount,
      input.cursorBefore.amount,
    ),
    cursorAfter,
  };
}
