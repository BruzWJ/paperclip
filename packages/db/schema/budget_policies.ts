import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";
import {
  moneyAmountColumn,
  nonnegativeFiniteMoneyCheck,
} from "./money.js";

export const budgetPolicies = pgTable(
  "budget_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    windowKind: text("window_kind").notNull(),
    limitAmount: moneyAmountColumn("limit_amount").notNull(),
    warnPercent: integer("warn_percent").notNull().default(80),
    hardStopEnabled: boolean("hard_stop_enabled").notNull().default(true),
    notifyEnabled: boolean("notify_enabled").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "budget_policies_limit_amount_check",
      nonnegativeFiniteMoneyCheck(table.limitAmount),
    ),
    check(
      "budget_policies_warn_percent_check",
      sql`${table.warnPercent} between 0 and 100`,
    ),
    index("budget_policies_company_scope_active_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
      table.isActive,
    ),
    index("budget_policies_company_window_idx").on(
      table.companyId,
      table.windowKind,
    ),
    uniqueIndex("budget_policies_company_scope_window_uq").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
      table.windowKind,
    ),
  ],
);
