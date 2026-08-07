import {
  type AnyPgColumn,
  check,
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import type {
  AgentAdapterType,
  AgentStatus,
  PauseReason,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agentAdapterConfigRevisions } from "./agent_adapter_config_revisions.js";
import {
  moneyAmountColumn,
  nonnegativeFiniteMoneyCheck,
} from "./money.js";

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    title: text("title"),
    icon: text("icon"),
    status: text("status").$type<AgentStatus>().notNull().default("idle"),
    reportsTo: uuid("reports_to").references((): AnyPgColumn => agents.id),
    capabilities: text("capabilities"),
    adapterType: text("adapter_type").$type<AgentAdapterType>(),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>(),
    currentAdapterConfigRevisionId: uuid("current_adapter_config_revision_id").references(
      (): AnyPgColumn => agentAdapterConfigRevisions.id,
      { onDelete: "restrict" },
    ),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    budgetMonthlyAmount: moneyAmountColumn("budget_monthly_amount").notNull(),
    pauseReason: text("pause_reason").$type<PauseReason>(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    errorReason: text("error_reason"),
    instruction: text("instruction"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "agents_budget_monthly_amount_check",
      nonnegativeFiniteMoneyCheck(table.budgetMonthlyAmount),
    ),
    unique("agents_company_id_uq").on(table.companyId, table.id),
    index("agents_company_status_idx").on(table.companyId, table.status),
    index("agents_company_reports_to_idx").on(table.companyId, table.reportsTo),
    index("agents_current_adapter_config_revision_idx").on(
      table.companyId,
      table.currentAdapterConfigRevisionId,
    ),
  ],
);
