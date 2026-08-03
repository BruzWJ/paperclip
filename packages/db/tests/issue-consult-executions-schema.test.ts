import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { issueConsultExecutions } from "../schema/issue_execution_runtime.js";

describe("issue consult execution schema", () => {
  it("allows ordered sibling consultations from one source ref to one target", () => {
    const indexes = getTableConfig(issueConsultExecutions).indexes;
    expect(indexes.map((index) => index.config.name)).not.toContain(
      "issue_consult_executions_active_source_target_uq",
    );
    expect(
      indexes.some(
        (index) =>
          index.config.name === "issue_consult_executions_chain_target_uq",
      ),
    ).toBe(false);
  });
});
