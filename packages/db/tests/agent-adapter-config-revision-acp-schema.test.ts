import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agentAdapterConfigRevisions } from "../schema/agent_adapter_config_revisions.js";

const dialect = new PgDialect();

describe("immutable ACP adapter revision schema", () => {
  it("requires one exact lowercase frontend artifact digest in the closed launch profile", () => {
    const constraint = getTableConfig(agentAdapterConfigRevisions).checks.find(
      (candidate) =>
        candidate.name ===
        "agent_adapter_config_revisions_acp_configuration_shape_check",
    );
    expect(constraint).toBeDefined();
    const sql = dialect.sqlToQuery(constraint!.value).sql;
    expect(sql).toContain("'frontendDigest'");
    expect(sql).toContain("'{launchProfile,frontendDigest}'");
    expect(sql).toContain("'targetNativeCli'");
    expect(sql).toContain("'{launchProfile,targetNativeCli}'");
    expect(sql).toContain("~ '^[0-9a-f]{64}$'");
  });
});
