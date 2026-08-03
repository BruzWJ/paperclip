import {
  BUDGET_CURRENCIES,
  type BudgetCurrency,
  type MoneyAmount,
} from "@paperclipai/shared";
import { sql, type SQLWrapper } from "drizzle-orm";
import { numeric, text } from "drizzle-orm/pg-core";

const budgetCurrencyCatalogSql = sql.raw(
  BUDGET_CURRENCIES.map((currency) => `'${currency}'`).join(", "),
);
const canonicalMoneyAmountPatternSql = sql.raw(
  "'^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'",
);

/** PostgreSQL numeric column that remains an exact decimal string in TypeScript. */
export function moneyAmountColumn(name: string) {
  return numeric(name, { mode: "string" }).$type<MoneyAmount>();
}

/** Closed, byte-exact company budget denomination. */
export function budgetCurrencyColumn(name: string) {
  return text(name).$type<BudgetCurrency>();
}

export function supportedBudgetCurrencyCheck(column: SQLWrapper) {
  return sql`${column} in (${budgetCurrencyCatalogSql})`;
}

/** PostgreSQL numeric admits special values; canonical MoneyAmount does not. */
export function nonnegativeFiniteMoneyCheck(column: SQLWrapper) {
  return sql`${column} >= 0
    and ${column} not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and ${column}::text ~ ${canonicalMoneyAmountPatternSql}`;
}
