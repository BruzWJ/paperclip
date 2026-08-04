import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agentAdapterConfigRevisions } from "../schema/agent_adapter_config_revisions.js";

const dialect = new PgDialect();

describe("immutable ACP adapter revision schema", () => {
  it("requires the ACPX runtime revision contract", () => {
    const constraint = getTableConfig(agentAdapterConfigRevisions).checks.find(
      (candidate) =>
        candidate.name ===
        "agent_adapter_config_revisions_acp_configuration_shape_check",
    );
    expect(constraint).toBeDefined();
    const sql = dialect.sqlToQuery(constraint!.value).sql;
    expect(sql).toContain("'acpx-runtime/v1'");
    expect(sql).not.toContain("'acp-subprocess/v1'");
  });

  it("persists only an ACPX registry name in the closed launch profile", () => {
    const constraint = getTableConfig(agentAdapterConfigRevisions).checks.find(
      (candidate) =>
        candidate.name ===
        "agent_adapter_config_revisions_acp_configuration_shape_check",
    );
    expect(constraint).toBeDefined();
    const sql = dialect.sqlToQuery(constraint!.value).sql;
    expect(sql).toContain("'registryName'");
    expect(sql).toContain("'{launchProfile,registryName}'");
    expect(sql).not.toContain("'targetNativeCli'");
    expect(sql).not.toContain("'command'");
    expect(sql).not.toContain("'args'");
    expect(sql).not.toContain("'frontendPackage'");
    expect(sql).not.toContain("'frontendVersion'");
    expect(sql).not.toContain("'frontendDigest'");
  });

  it("allows empty selections and a missing target model without widening other fields", () => {
    const constraint = getTableConfig(agentAdapterConfigRevisions).checks.find(
      (candidate) =>
        candidate.name ===
        "agent_adapter_config_revisions_acp_configuration_shape_check",
    );
    expect(constraint).toBeDefined();
    const sql = dialect.sqlToQuery(constraint!.value).sql;
    expect(sql).toContain("'{model,limits}'");
    expect(sql).toContain("= 'null'");
    expect(sql).not.toContain("jsonb_array_length");
  });
});
