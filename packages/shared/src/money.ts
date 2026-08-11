import { z } from "zod";
import { addValidationDetail } from "./validation-details.js";

/**
 * Paperclip's closed AI budget/cost denomination catalog. The list is frozen
 * in source so database, JSON, OpenAPI, CLI, and UI validation cannot vary
 * with the host ICU build or silently acquire a new currency at runtime.
 */
export const BUDGET_CURRENCIES = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD",
  "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP",
  "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HRK", "HTG", "HUF", "IDR",
  "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS",
  "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR",
  "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP",
  "MRU", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO",
  "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN",
  "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG",
  "SEK", "SGD", "SHP", "SLE", "SLL", "SOS", "SRD", "SSP", "STN", "SVC",
  "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD",
  "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST",
  "XAF", "XCD", "XCG", "XDR", "XOF", "XPF", "XSU", "YER", "ZAR", "ZMW",
  "ZWG", "ZWL",
] as const;

export type BudgetCurrency = (typeof BUDGET_CURRENCIES)[number];

const budgetCurrencySet: ReadonlySet<string> = new Set(BUDGET_CURRENCIES);

export function isBudgetCurrency(value: unknown): value is BudgetCurrency {
  return typeof value === "string" && budgetCurrencySet.has(value);
}

export function parseBudgetCurrency(value: unknown): BudgetCurrency {
  if (!isBudgetCurrency(value)) {
    throw new TypeError("Budget currency must be an exact supported uppercase ISO-4217 code");
  }
  return value;
}

/** A canonical, nonnegative, non-exponent PostgreSQL numeric string. */
export type MoneyAmount = string & {
  readonly __paperclipMoneyAmount: "MoneyAmount";
};

const DECIMAL_INPUT_PATTERN = /^\d+(?:\.\d+)?$/;
export const MONEY_AMOUNT_PATTERN = "^(?:0|[1-9][0-9]*)(?:\\.[0-9]*[1-9])?$";
const CANONICAL_DECIMAL_PATTERN = new RegExp(MONEY_AMOUNT_PATTERN);

// PostgreSQL numeric's documented explicit-value limits.
const MAX_INTEGER_DIGITS = 131_072;
const MAX_FRACTION_DIGITS = 16_383;

function canonicalDecimal(value: string): string {
  if (value.length === 0 || value !== value.trim() || !DECIMAL_INPUT_PATTERN.test(value)) {
    throw new TypeError(
      "Money amount must be a nonnegative non-exponent decimal string",
    );
  }
  const [rawInteger, rawFraction = ""] = value.split(".");
  const integer = rawInteger!.replace(/^0+(?=\d)/, "");
  const fraction = rawFraction.replace(/0+$/, "");
  if (integer.length > MAX_INTEGER_DIGITS || fraction.length > MAX_FRACTION_DIGITS) {
    throw new RangeError("Money amount exceeds PostgreSQL numeric limits");
  }
  return fraction.length > 0 ? `${integer}.${fraction}` : integer;
}

/**
 * Canonicalizes a syntactically valid decimal at trusted ingestion seams.
 * Public JSON/API boundaries should use parseMoneyAmount and reject a value
 * whose bytes are not already canonical.
 */
export function canonicalizeMoneyAmount(value: string): MoneyAmount {
  return canonicalDecimal(value) as MoneyAmount;
}

export function parseMoneyAmount(value: unknown): MoneyAmount {
  if (typeof value !== "string") {
    throw new TypeError("Money amount must be a canonical decimal string");
  }
  const canonical = canonicalDecimal(value);
  if (canonical !== value || !CANONICAL_DECIMAL_PATTERN.test(value)) {
    throw new TypeError("Money amount must use canonical decimal-string form");
  }
  return value as MoneyAmount;
}

export function serializeMoneyAmount(value: MoneyAmount): string {
  return parseMoneyAmount(value);
}

interface DecimalParts {
  readonly digits: string;
  readonly scale: number;
}

function decimalParts(value: MoneyAmount): DecimalParts {
  const exact = parseMoneyAmount(value);
  const separator = exact.indexOf(".");
  if (separator === -1) return { digits: exact, scale: 0 };
  return {
    digits: exact.slice(0, separator) + exact.slice(separator + 1),
    scale: exact.length - separator - 1,
  };
}

function alignedDigits(value: DecimalParts, scale: number): string {
  return value.digits + "0".repeat(scale - value.scale);
}

export function compareMoneyAmounts(
  left: MoneyAmount,
  right: MoneyAmount,
): -1 | 0 | 1 {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftDigits = alignedDigits(leftParts, scale).replace(/^0+(?=\d)/, "");
  const rightDigits = alignedDigits(rightParts, scale).replace(/^0+(?=\d)/, "");
  if (leftDigits.length !== rightDigits.length) {
    return leftDigits.length < rightDigits.length ? -1 : 1;
  }
  return leftDigits < rightDigits ? -1 : leftDigits > rightDigits ? 1 : 0;
}

/**
 * Returns an exact-money ratio rounded down to two decimal percentage places.
 * Money stays integer-scaled throughout; only the dimensionless basis-point
 * result crosses into JavaScript number space.
 */
export function moneyAmountUtilizationPercent(
  observedAmount: MoneyAmount,
  limitAmount: MoneyAmount,
): number {
  if (compareMoneyAmounts(limitAmount, canonicalizeMoneyAmount("0")) === 0) {
    return 0;
  }
  const observed = decimalParts(observedAmount);
  const limit = decimalParts(limitAmount);
  const scale = Math.max(observed.scale, limit.scale);
  const observedUnits = BigInt(alignedDigits(observed, scale));
  const limitUnits = BigInt(alignedDigits(limit, scale));
  const basisPoints = (observedUnits * 10_000n) / limitUnits;
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(basisPoints > maximum ? maximum : basisPoints) / 100;
}

export function addMoneyAmounts(
  left: MoneyAmount,
  right: MoneyAmount,
): MoneyAmount {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const sum = (
    BigInt(alignedDigits(leftParts, scale)) +
    BigInt(alignedDigits(rightParts, scale))
  ).toString();
  if (scale === 0) return canonicalizeMoneyAmount(sum);
  const padded = sum.padStart(scale + 1, "0");
  return canonicalizeMoneyAmount(
    `${padded.slice(0, -scale)}.${padded.slice(-scale)}`,
  );
}

export function subtractMoneyAmounts(
  left: MoneyAmount,
  right: MoneyAmount,
): MoneyAmount {
  if (compareMoneyAmounts(left, right) < 0) {
    throw new RangeError("Money subtraction cannot produce a negative amount");
  }
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const difference = (
    BigInt(alignedDigits(leftParts, scale)) -
    BigInt(alignedDigits(rightParts, scale))
  ).toString();
  if (scale === 0) return canonicalizeMoneyAmount(difference);
  const padded = difference.padStart(scale + 1, "0");
  return canonicalizeMoneyAmount(
    `${padded.slice(0, -scale)}.${padded.slice(-scale)}`,
  );
}

/**
 * Converts the ACP SDK's JSON-number cost field exactly once at the wire
 * boundary. All persisted and public values use MoneyAmount strings.
 */
export function moneyAmountFromFiniteNumber(value: number): MoneyAmount {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("ACP cost amount must be finite and nonnegative");
  }
  const source = String(value).toLowerCase();
  if (!source.includes("e")) return canonicalizeMoneyAmount(source);
  const match = /^(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(source);
  if (!match) throw new TypeError("ACP cost amount is not a decimal number");
  const integer = match[1]!;
  const fraction = match[2] ?? "";
  const exponent = Number.parseInt(match[3]!, 10);
  const digits = integer + fraction;
  const decimalIndex = integer.length + exponent;
  const expanded =
    decimalIndex <= 0
      ? `0.${"0".repeat(-decimalIndex)}${digits}`
      : decimalIndex >= digits.length
        ? `${digits}${"0".repeat(decimalIndex - digits.length)}`
        : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return canonicalizeMoneyAmount(expanded);
}

export const budgetCurrencySchema = z.enum(BUDGET_CURRENCIES);

export const moneyAmountSchema: z.ZodType<
  MoneyAmount,
  z.ZodTypeDef,
  string
> = z.string().transform((value, context) => {
  try {
    return parseMoneyAmount(value);
  } catch (error) {
    addValidationDetail(context, {
      message: error instanceof Error ? error.message : "Invalid money amount",
    });
    return z.NEVER;
  }
});

export const BUDGET_CURRENCY_OPENAPI_SCHEMA = Object.freeze({
  type: "string",
  enum: BUDGET_CURRENCIES,
} as const);

export const MONEY_AMOUNT_OPENAPI_SCHEMA = Object.freeze({
  type: "string",
  pattern: MONEY_AMOUNT_PATTERN,
  example: "1250.75",
} as const);
