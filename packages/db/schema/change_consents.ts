import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issueExecutionRuns } from "./issue_execution_runs.js";

export const changeConsents = pgTable(
  "change_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetKey: text("target_key").notNull(),
    displayedDiff: text("displayed_diff").notNull(),
    requestedByAgentId: uuid("requested_by_agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    sourceRunId: uuid("source_run_id").notNull().references(() => issueExecutionRuns.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("pending"),
    decisionReason: text("decision_reason"),
    decidedByBoardId: text("decided_by_board_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedByRunId: uuid("consumed_by_run_id").references(() => issueExecutionRuns.id, { onDelete: "restrict" }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("change_consents_target_key_check", sql`length(btrim(${table.targetKey})) > 0`),
    check("change_consents_displayed_diff_check", sql`length(btrim(${table.displayedDiff})) > 0`),
    check("change_consents_status_check", sql`${table.status} in ('pending', 'accepted', 'rejected', 'expired')`),
    check(
      "change_consents_decision_check",
      sql`(${table.status} in ('accepted', 'rejected') and ${table.decidedAt} is not null and ${table.decidedByBoardId} is not null)
        or (${table.status} in ('pending', 'expired'))`,
    ),
    check(
      "change_consents_consumption_check",
      sql`(${table.consumedAt} is null and ${table.consumedByRunId} is null)
        or (${table.status} = 'accepted' and ${table.consumedAt} is not null and ${table.consumedByRunId} is not null)`,
    ),
    check("change_consents_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    unique("change_consents_company_id_uq").on(table.companyId, table.id),
    index("change_consents_company_status_expiry_idx").on(table.companyId, table.status, table.expiresAt),
    index("change_consents_gate_lookup_idx").on(
      table.companyId,
      table.requestedByAgentId,
      table.targetKey,
      table.status,
      table.createdAt,
    ),
  ],
);
