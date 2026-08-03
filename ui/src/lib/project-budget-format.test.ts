import { describe, expect, it } from "vitest";
import { parseMoneyAmount } from "@paperclipai/shared";
import { formatProjectBudget } from "./utils";

describe("formatProjectBudget", () => {
  it("renders a /mo suffix for monthly budgets", () => {
    expect(formatProjectBudget({ limitAmount: parseMoneyAmount("1200"), windowKind: "calendar_month_utc" }, "USD")).toBe("USD 1200/mo");
  });

  it("renders the bare amount for lifetime budgets", () => {
    expect(formatProjectBudget({ limitAmount: parseMoneyAmount("500"), windowKind: "lifetime" }, "EUR")).toBe("EUR 500");
  });

  it("formats sub-dollar amounts with cents", () => {
    expect(formatProjectBudget({ limitAmount: parseMoneyAmount("1.5"), windowKind: "lifetime" }, "JPY")).toBe("JPY 1.5");
  });
});
