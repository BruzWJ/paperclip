import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { issueExecutionWatchdogDecisions } from "../schema/issue_execution_watchdog_decisions.js";

const dialect = new PgDialect();

function checkSql(name: string): string {
  const candidate = getTableConfig(issueExecutionWatchdogDecisions).checks.find(
    (check) => check.name === name,
  );
  expect(candidate).toBeDefined();
  return dialect.sqlToQuery(candidate!.value).sql;
}

describe("issue execution watchdog decision schema", () => {
  it("keeps the decision vocabulary and snooze shape closed", () => {
    expect(
      checkSql("issue_execution_watchdog_decisions_decision_check"),
    ).toContain("'dismissed_false_positive'");

    const snooze = checkSql(
      "issue_execution_watchdog_decisions_snooze_check",
    );
    expect(snooze).toContain("= 'snooze'");
    expect(snooze).toContain("\"snoozed_until\" >");
    expect(snooze).toContain("in ('continue', 'dismissed_false_positive')");
  });

  it("requires exactly one audited actor and same-company run ownership", () => {
    const config = getTableConfig(issueExecutionWatchdogDecisions);
    const foreignKeyNames = config.foreignKeys.map((key) => key.getName());

    expect(
      checkSql("issue_execution_watchdog_decisions_actor_check"),
    ).toContain('"created_by_run_id" is not null');
    expect(foreignKeyNames).toEqual(
      expect.arrayContaining([
        "issue_execution_watchdog_decisions_run_fk",
        "issue_execution_watchdog_decisions_evaluation_issue_fk",
        "issue_execution_watchdog_decisions_actor_agent_fk",
        "issue_execution_watchdog_decisions_actor_run_fk",
      ]),
    );
  });

  it("stores only bounded decision audit facts", () => {
    expect(
      getTableConfig(issueExecutionWatchdogDecisions).columns.map(
        (column) => column.name,
      ),
    ).toEqual([
      "id",
      "company_id",
      "run_id",
      "evaluation_issue_id",
      "decision",
      "snoozed_until",
      "reason",
      "created_by_agent_id",
      "created_by_user_id",
      "created_by_run_id",
      "created_at",
    ]);
    expect(
      checkSql("issue_execution_watchdog_decisions_reason_check"),
    ).toContain("between 1 and 4000");
  });
});
