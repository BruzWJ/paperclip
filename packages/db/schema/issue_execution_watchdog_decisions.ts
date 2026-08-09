import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { issueExecutionRuns } from "./issue_execution_runs.js";
import { issues } from "./issues.js";

export type IssueExecutionWatchdogDecision =
  | "snooze"
  | "continue"
  | "dismissed_false_positive";

/**
 * Append-only operator/recovery-owner decision about one canonical issue run.
 * The row contains references and decision audit only; evaluation/output data
 * stays in its canonical owners.
 */
export const issueExecutionWatchdogDecisions = pgTable(
  "issue_execution_watchdog_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    evaluationIssueId: uuid("evaluation_issue_id"),
    decision: text("decision")
      .$type<IssueExecutionWatchdogDecision>()
      .notNull(),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    reason: text("reason"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByUserId: text("created_by_user_id").references(
      () => authUsers.id,
      { onDelete: "restrict" },
    ),
    createdByRunId: uuid("created_by_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "issue_execution_watchdog_decisions_decision_check",
      sql`${table.decision} in (
        'snooze',
        'continue',
        'dismissed_false_positive'
      )`,
    ),
    check(
      "issue_execution_watchdog_decisions_snooze_check",
      sql`(
        ${table.decision} = 'snooze'
        and ${table.snoozedUntil} is not null
        and ${table.snoozedUntil} > ${table.createdAt}
      ) or (
        ${table.decision} in ('continue', 'dismissed_false_positive')
        and ${table.snoozedUntil} is null
      )`,
    ),
    check(
      "issue_execution_watchdog_decisions_reason_check",
      sql`${table.reason} is null
        or length(btrim(${table.reason})) between 1 and 4000`,
    ),
    check(
      "issue_execution_watchdog_decisions_actor_check",
      sql`(
        ${table.createdByUserId} is not null
        and ${table.createdByAgentId} is null
        and ${table.createdByRunId} is null
      ) or (
        ${table.createdByUserId} is null
        and ${table.createdByAgentId} is not null
        and ${table.createdByRunId} is not null
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.runId],
      foreignColumns: [issueExecutionRuns.companyId, issueExecutionRuns.id],
      name: "issue_execution_watchdog_decisions_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.evaluationIssueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "issue_execution_watchdog_decisions_evaluation_issue_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.companyId, table.createdByAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "issue_execution_watchdog_decisions_actor_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.createdByRunId,
        table.createdByAgentId,
      ],
      foreignColumns: [
        issueExecutionRuns.companyId,
        issueExecutionRuns.id,
        issueExecutionRuns.targetAgentId,
      ],
      name: "issue_execution_watchdog_decisions_actor_run_fk",
    }).onDelete("restrict"),
    index("issue_execution_watchdog_decisions_company_run_created_idx").on(
      table.companyId,
      table.runId,
      table.createdAt,
    ),
    index("issue_execution_watchdog_decisions_company_run_snooze_idx").on(
      table.companyId,
      table.runId,
      table.snoozedUntil,
    ),
  ],
);
