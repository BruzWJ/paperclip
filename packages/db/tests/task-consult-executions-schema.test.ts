import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { taskConsultExecutions } from "../schema/task_execution_runtime.js";

describe("task consult execution schema", () => {
  it("allows ordered sibling consultations from one source ref to one target", () => {
    const indexes = getTableConfig(taskConsultExecutions).indexes;
    expect(indexes.map((index) => index.config.name)).not.toContain(
      "task_consult_executions_active_source_target_uq",
    );
    expect(
      indexes.some(
        (index) =>
          index.config.name === "task_consult_executions_chain_target_uq",
      ),
    ).toBe(false);
  });
});
