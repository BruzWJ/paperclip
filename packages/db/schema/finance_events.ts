import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { tasks } from "./tasks.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import {
  moneyAmountColumn,
  nonnegativeFiniteMoneyCheck,
} from "./money.js";

export const financeEvents = pgTable(
  "finance_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    taskId: uuid("task_id").references(() => tasks.id),
    projectId: uuid("project_id").references(() => projects.id),
    goalId: uuid("goal_id").references(() => goals.id),
    billingCode: text("billing_code"),
    description: text("description"),
    eventKind: text("event_kind").notNull(),
    direction: text("direction").notNull().default("debit"),
    biller: text("biller").notNull(),
    provider: text("provider"),
    executionAdapterType: text("execution_adapter_type"),
    pricingTier: text("pricing_tier"),
    region: text("region"),
    model: text("model"),
    quantity: integer("quantity"),
    unit: text("unit"),
    amount: moneyAmountColumn("amount").notNull(),
    currency: text("currency").notNull(),
    estimated: boolean("estimated").notNull().default(false),
    externalInvoiceId: text("external_invoice_id"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown> | null>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "finance_events_amount_check",
      nonnegativeFiniteMoneyCheck(table.amount),
    ),
    check(
      "finance_events_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "finance_events_direction_check",
      sql`${table.direction} in ('debit', 'credit')`,
    ),
    index("finance_events_company_occurred_idx").on(table.companyId, table.occurredAt),
    index("finance_events_company_biller_occurred_idx").on(
      table.companyId,
      table.biller,
      table.occurredAt,
    ),
    index("finance_events_company_kind_occurred_idx").on(
      table.companyId,
      table.eventKind,
      table.occurredAt,
    ),
    index("finance_events_company_direction_occurred_idx").on(
      table.companyId,
      table.direction,
      table.occurredAt,
    ),
  ],
);
