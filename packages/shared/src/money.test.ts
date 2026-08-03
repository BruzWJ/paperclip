import { describe, expect, it } from "vitest";
import {
  addMoneyAmounts,
  budgetCurrencySchema,
  canonicalizeMoneyAmount,
  compareMoneyAmounts,
  moneyAmountUtilizationPercent,
  moneyAmountFromFiniteNumber,
  moneyAmountSchema,
  parseBudgetCurrency,
  parseMoneyAmount,
  serializeMoneyAmount,
  subtractMoneyAmounts,
} from "./money.js";

describe("canonical money contract", () => {
  it("accepts only byte-exact supported uppercase budget currencies", () => {
    expect(parseBudgetCurrency("USD")).toBe("USD");
    expect(parseBudgetCurrency("EUR")).toBe("EUR");
    expect(budgetCurrencySchema.parse("XCG")).toBe("XCG");
    for (const value of ["usd", " USD", "USD ", "ZZZ", "", 12, null]) {
      expect(() => parseBudgetCurrency(value)).toThrow();
      expect(budgetCurrencySchema.safeParse(value).success).toBe(false);
    }
  });

  it("canonicalizes trusted decimal input without floating-point conversion", () => {
    expect(canonicalizeMoneyAmount("000000")).toBe("0");
    expect(canonicalizeMoneyAmount("00012.34000")).toBe("12.34");
    expect(canonicalizeMoneyAmount("0.0001000")).toBe("0.0001");
    expect(canonicalizeMoneyAmount("900719925474099312345678.0000000010")).toBe(
      "900719925474099312345678.000000001",
    );
  });

  it("rejects noncanonical public values, numbers, signs, and exponent notation", () => {
    for (const value of [
      "00",
      "01",
      "1.0",
      "1.2300",
      ".5",
      "1.",
      "+1",
      "-1",
      "1e3",
      " 1",
      "1 ",
      "",
      1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
    ]) {
      expect(() => parseMoneyAmount(value)).toThrow();
      expect(moneyAmountSchema.safeParse(value).success).toBe(false);
    }
    for (const value of ["0", "1", "1.25", "0.0001", "999999999999999999999.9"]) {
      expect(serializeMoneyAmount(parseMoneyAmount(value))).toBe(value);
      expect(moneyAmountSchema.parse(value)).toBe(value);
    }
  });

  it("compares and adds arbitrary precision values losslessly", () => {
    expect(
      compareMoneyAmounts(
        parseMoneyAmount("1.2"),
        canonicalizeMoneyAmount("1.20"),
      ),
    ).toBe(0);
    expect(compareMoneyAmounts(parseMoneyAmount("0.009"), parseMoneyAmount("0.01"))).toBe(-1);
    expect(compareMoneyAmounts(parseMoneyAmount("100000000000000000000"), parseMoneyAmount("9"))).toBe(1);
    expect(addMoneyAmounts(parseMoneyAmount("0.1"), parseMoneyAmount("0.2"))).toBe("0.3");
    expect(
      addMoneyAmounts(
        parseMoneyAmount("900719925474099312345678.000000001"),
        parseMoneyAmount("0.000000009"),
      ),
    ).toBe("900719925474099312345678.00000001");
    expect(addMoneyAmounts(parseMoneyAmount("1.99"), parseMoneyAmount("8.01"))).toBe("10");
    expect(subtractMoneyAmounts(parseMoneyAmount("10"), parseMoneyAmount("1.99"))).toBe("8.01");
    expect(() =>
      subtractMoneyAmounts(parseMoneyAmount("1"), parseMoneyAmount("1.01")),
    ).toThrow(/negative/);
  });

  it("converts the ACP wire number once into canonical decimal bytes", () => {
    expect(moneyAmountFromFiniteNumber(0)).toBe("0");
    expect(moneyAmountFromFiniteNumber(12.5)).toBe("12.5");
    expect(moneyAmountFromFiniteNumber(1e-7)).toBe("0.0000001");
    expect(moneyAmountFromFiniteNumber(1e21)).toBe("1000000000000000000000");
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => moneyAmountFromFiniteNumber(value)).toThrow();
    }
  });

  it("derives utilization without converting money through floating point", () => {
    expect(
      moneyAmountUtilizationPercent(
        parseMoneyAmount("1"),
        parseMoneyAmount("3"),
      ),
    ).toBe(33.33);
    expect(
      moneyAmountUtilizationPercent(
        parseMoneyAmount("900719925474099312345678.000000001"),
        parseMoneyAmount("900719925474099312345678.000000002"),
      ),
    ).toBe(99.99);
    expect(
      moneyAmountUtilizationPercent(
        parseMoneyAmount("12.5"),
        parseMoneyAmount("0"),
      ),
    ).toBe(0);
  });
});
