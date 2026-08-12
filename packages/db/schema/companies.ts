import { sql } from "drizzle-orm";
import type { CompanyStatus, PauseReason } from "@paperclipai/shared";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import {
  budgetCurrencyColumn,
  moneyAmountColumn,
  nonnegativeFiniteMoneyCheck,
  supportedBudgetCurrencyCheck,
} from "./money.js";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").$type<CompanyStatus>().notNull().default("active"),
    pauseReason: text("pause_reason").$type<PauseReason>(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    taskPrefix: text("task_prefix").notNull().default("PAP"),
    taskCounter: integer("task_counter").notNull().default(0),
    budgetCurrency: budgetCurrencyColumn("budget_currency").notNull(),
    budgetMonthlyAmount: moneyAmountColumn("budget_monthly_amount").notNull(),
    attachmentMaxBytes: integer("attachment_max_bytes")
      .notNull()
      .default(10 * 1024 * 1024),
    defaultResponsibleUserId: text("default_responsible_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(false),
    sessionIntegrityState: text("session_integrity_state")
      .$type<
        "ready" | "archive_fenced" | "hard_delete_fenced"
      >()
      .notNull()
      .default("ready"),
    sessionIntegrityReadyAt: timestamp("session_integrity_ready_at", {
      withTimezone: true,
    }).defaultNow(),
    sessionLifecycleGeneration: bigint("session_lifecycle_generation", {
      mode: "number",
    })
      .notNull()
      .default(0),
    hardDeleteFencedAt: timestamp("hard_delete_fenced_at", { withTimezone: true }),
    brandColor: text("brand_color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "companies_budget_currency_check",
      supportedBudgetCurrencyCheck(table.budgetCurrency),
    ),
    check(
      "companies_budget_monthly_amount_check",
      nonnegativeFiniteMoneyCheck(table.budgetMonthlyAmount),
    ),
    check(
      "companies_session_integrity_state_check",
      sql`${table.sessionIntegrityState} in (
        'ready',
        'archive_fenced',
        'hard_delete_fenced'
      )`,
    ),
    check(
      "companies_session_integrity_ready_check",
      sql`(
        ${table.sessionIntegrityState} = 'ready'
        and ${table.sessionIntegrityReadyAt} is not null
      ) or (
        ${table.sessionIntegrityState} <> 'ready'
      )`,
    ),
    check(
      "companies_task_prefix_check",
      sql`${table.taskPrefix} ~ '^[A-Z][A-Z0-9]*$'`,
    ),
    check(
      "companies_task_counter_check",
      sql`${table.taskCounter} >= 0`,
    ),
    uniqueIndex("companies_task_prefix_idx").on(table.taskPrefix),
    unique("companies_id_budget_currency_uq").on(
      table.id,
      table.budgetCurrency,
    ),
    index("companies_session_integrity_idx").on(
      table.sessionIntegrityState,
      table.updatedAt,
    ),
  ],
);
