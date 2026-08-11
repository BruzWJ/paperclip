import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agentActionGrants } from "../schema/agent_runtime_grants.js";

const dialect = new PgDialect();

describe("agent action-grant schema", () => {
  it("persists only independently configurable action grants", () => {
    const constraint = getTableConfig(agentActionGrants).checks.find(
      (candidate) => candidate.name === "agent_action_grants_key_check",
    );
    expect(constraint).toBeDefined();

    const sql = dialect.sqlToQuery(constraint!.value).sql;
    expect(sql).toContain("'task_create'");
    expect(sql).toContain("'mention_board'");
    expect(sql).toContain("'agent_hire'");
    expect(sql).toContain("'agent_configure'");
    expect(sql).not.toContain("'task_assign'");
    expect(sql).not.toContain("'task_update'");
    expect(sql).not.toContain("'mention_agent'");
  });
});
