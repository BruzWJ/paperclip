import { describe, expect, it, vi } from "vitest";
import { costService } from "../services/costs.js";

function sequenceDb(results: readonly unknown[][]) {
  const pending = [...results];
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    then: vi.fn(
      (resolve: (value: unknown[]) => unknown) =>
        Promise.resolve(resolve(pending.shift() ?? [])),
    ),
  };
  return { select: vi.fn(() => chain) };
}

describe("canonical monthly AI spend projection", () => {
  it("derives exact company spend from known cost deltas without a stored spend field", async () => {
    const db = sequenceDb([
      [{ budgetCurrency: "EUR", budgetMonthlyAmount: "1000.25" }],
      [{ knownAmount: "125.125", pricedPromptCount: 2, unpricedPromptCount: 1 }],
    ]);

    await expect(costService(db as never).summary("company-1")).resolves.toEqual({
      companyId: "company-1",
      budgetCurrency: "EUR",
      knownSpendAmount: "125.125",
      budgetMonthlyAmount: "1000.25",
      remainingAmount: "875.125",
      utilizationPercent: 12.5,
      pricedPromptCount: 2,
      unpricedPromptCount: 1,
    });
  });

  it("preserves exact known zero and reports unavailable prompts separately", async () => {
    const db = sequenceDb([
      [{ budgetCurrency: "USD", budgetMonthlyAmount: "0" }],
      [{ knownAmount: "0", pricedPromptCount: 1, unpricedPromptCount: 3 }],
    ]);

    const summary = await costService(db as never).summary("company-2");
    expect(summary.knownSpendAmount).toBe("0");
    expect(summary.remainingAmount).toBe("0");
    expect(summary.utilizationPercent).toBe(0);
    expect(summary.pricedPromptCount).toBe(1);
    expect(summary.unpricedPromptCount).toBe(3);
  });
});
