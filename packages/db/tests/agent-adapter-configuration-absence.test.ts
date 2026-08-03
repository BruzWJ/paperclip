import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agents } from "../schema/agents.js";

function column(name: string) {
  const match = getTableConfig(agents).columns.find(
    (candidate) => candidate.name === name,
  );
  if (!match) throw new Error(`Missing agents.${name}`);
  return match;
}

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
const generatedMigrationSql = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(path.join(migrationsDirectory, name), "utf8"))
  .join("\n");

describe("agent adapter configuration absence", () => {
  it("models an unconfigured agent as nullable columns without defaults", () => {
    for (const name of ["adapter_type", "adapter_config"]) {
      expect(column(name).notNull).toBe(false);
      expect(column(name).default).toBeUndefined();
    }
    expect(column("current_adapter_config_revision_id").notNull).toBe(false);
    expect(column("current_adapter_config_revision_id").default).toBeUndefined();
  });

  it("renders that nullable contract into the generated migration", () => {
    const agentsTable = generatedMigrationSql.match(
      /CREATE TABLE "agents" \([\s\S]*?\n\);/,
    )?.[0];

    expect(agentsTable).toBeDefined();
    expect(agentsTable).toContain('"adapter_type" text,');
    expect(agentsTable).toContain('"adapter_config" jsonb,');
    expect(agentsTable).toContain('"current_adapter_config_revision_id" uuid,');
    expect(agentsTable).not.toMatch(/"adapter_type"[^\n]*NOT NULL/);
    expect(agentsTable).not.toMatch(/"adapter_config"[^\n]*NOT NULL/);
    expect(agentsTable).not.toMatch(
      /"current_adapter_config_revision_id"[^\n]*NOT NULL/,
    );
  });
});
