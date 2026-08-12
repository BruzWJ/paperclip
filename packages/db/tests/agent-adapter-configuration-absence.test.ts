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
  it("models an unconfigured agent only through a nullable revision reference", () => {
    expect(column("current_adapter_config_revision_id").notNull).toBe(false);
    expect(column("current_adapter_config_revision_id").default).toBeUndefined();
    expect(
      getTableConfig(agents).columns.map((candidate) => candidate.name),
    ).not.toEqual(
      expect.arrayContaining([
        "adapter_type",
        "adapter_config",
        "runtime_config",
      ]),
    );
  });

  it("renders that canonical ACPX cutover into the generated migrations", () => {
    const agentsTable = generatedMigrationSql.match(
      /CREATE TABLE "agents" \([\s\S]*?\n\);/,
    )?.[0];

    expect(agentsTable).toBeDefined();
    expect(agentsTable).toContain('"current_adapter_config_revision_id" uuid,');
    expect(agentsTable).not.toMatch(
      /"current_adapter_config_revision_id"[^\n]*NOT NULL/,
    );
    expect(generatedMigrationSql).toContain(
      'ALTER TABLE "agents" DROP COLUMN "adapter_type";',
    );
    expect(generatedMigrationSql).toContain(
      'ALTER TABLE "agents" DROP COLUMN "adapter_config";',
    );
    expect(generatedMigrationSql).toContain(
      'ALTER TABLE "agents" DROP COLUMN "runtime_config";',
    );
  });
});
