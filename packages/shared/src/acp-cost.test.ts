import { describe, expect, it } from "vitest";
import { parseBudgetCurrency, parseMoneyAmount } from "./money.js";
import { settleAcpPromptCost, type AcpCostCursor } from "./acp-cost.js";

const USD = parseBudgetCurrency("USD");

describe("ACP cumulative prompt cost", () => {
  it("bills a matching first observation from an unanchored zero origin", () => {
    expect(
      settleAcpPromptCost({
        budgetCurrency: USD,
        cursorBefore: { state: "unanchored" },
        observation: { amount: 1.25, currency: "USD" },
      }),
    ).toEqual({
      kind: "known",
      unavailableReason: null,
      observedCumulativeAmount: "1.25",
      observedCurrency: "USD",
      knownDeltaAmount: "1.25",
      cursorAfter: { state: "known", amount: "1.25", currency: "USD" },
    });
  });

  it("preserves an exact known zero and computes a resumed delta", () => {
    expect(
      settleAcpPromptCost({
        budgetCurrency: USD,
        cursorBefore: { state: "unanchored" },
        observation: { amount: 0, currency: "USD" },
      }).knownDeltaAmount,
    ).toBe("0");
    expect(
      settleAcpPromptCost({
        budgetCurrency: USD,
        cursorBefore: {
          state: "known",
          amount: parseMoneyAmount("9007199254740992.1"),
          currency: USD,
        },
        observation: { amount: 9_007_199_254_740_994, currency: "USD" },
      }).knownDeltaAmount,
    ).toBe("1.9");
  });

  it.each([
    {
      label: "absent",
      cursorBefore: { state: "known", amount: parseMoneyAmount("1"), currency: USD } as AcpCostCursor,
      observation: null,
      reason: "absent",
      observedCumulativeAmount: null,
      observedCurrency: null,
    },
    {
      label: "malformed",
      cursorBefore: { state: "unanchored" } as AcpCostCursor,
      observation: { amount: -1, currency: "USD" },
      reason: "malformed",
      observedCumulativeAmount: null,
      observedCurrency: null,
    },
    {
      label: "currency mismatch",
      cursorBefore: { state: "unanchored" } as AcpCostCursor,
      observation: { amount: 2, currency: "usd" },
      reason: "currency_mismatch",
      observedCumulativeAmount: "2",
      observedCurrency: "usd",
    },
    {
      label: "decreasing",
      cursorBefore: { state: "known", amount: parseMoneyAmount("3"), currency: USD } as AcpCostCursor,
      observation: { amount: 2.5, currency: "USD" },
      reason: "decreasing",
      observedCumulativeAmount: "2.5",
      observedCurrency: "USD",
    },
  ] as const)("records $label as unavailable", (fixture) => {
    expect(
      settleAcpPromptCost({
        budgetCurrency: USD,
        cursorBefore: fixture.cursorBefore,
        observation: fixture.observation,
      }),
    ).toMatchObject({
      kind: "unavailable",
      unavailableReason: fixture.reason,
      knownDeltaAmount: null,
      observedCumulativeAmount: fixture.observedCumulativeAmount,
      observedCurrency: fixture.observedCurrency,
      cursorAfter: { state: "unavailable" },
    });
  });

  it("uses one unpriced matching observation to re-anchor an unavailable cursor", () => {
    expect(
      settleAcpPromptCost({
        budgetCurrency: USD,
        cursorBefore: { state: "unavailable" },
        observation: { amount: 8.5, currency: "USD" },
      }),
    ).toEqual({
      kind: "unavailable",
      unavailableReason: "reanchor_after_unavailable",
      observedCumulativeAmount: "8.5",
      observedCurrency: "USD",
      knownDeltaAmount: null,
      cursorAfter: { state: "known", amount: "8.5", currency: "USD" },
    });
  });

  it("rejects a corrupt persisted known cursor instead of treating it as fresh", () => {
    expect(() =>
      settleAcpPromptCost({
        budgetCurrency: USD,
        cursorBefore: {
          state: "known",
          amount: parseMoneyAmount("1"),
          currency: parseBudgetCurrency("EUR"),
        },
        observation: { amount: 2, currency: "USD" },
      }),
    ).toThrow(/does not match company budget currency/);
  });
});
