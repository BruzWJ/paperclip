import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { taskUpdates } from "../schema/task_creator_edge.js";

const dialect = new PgDialect();

function checkSql(name: string): string {
  const constraint = getTableConfig(taskUpdates).checks.find(
    (candidate) => candidate.name === name,
  );
  expect(constraint).toBeDefined();
  return dialect.sqlToQuery(constraint!.value).sql;
}

describe("canonical task-update schema", () => {
  it("allows creator message-only updates from every creator kind while reserving lifecycle changes for agent executions", () => {
    const form = checkSql("task_updates_form_check");
    expect(form).toContain("'owner'");
    expect(form).toContain("'creator'");

    const shape = checkSql("task_updates_form_shape_check");
    expect(shape).toContain('"status" in (\'open\', \'blocked\')');
    expect(shape).toContain('"status" in (\'done\', \'cancelled\')');
    expect(shape).toContain('"form" = \'owner\'');
    expect(shape).toContain('"source_kind" = \'agent-execution\'');
    expect(shape).toContain('"form" <> \'creator\'');
    expect(shape).toContain('"disposition" is null');
    expect(shape).toContain('"disposition" is not null');
  });
});
