import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

function migrationFiles(): string[] {
  return readdirSync(migrationsDirectory)
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
}

function migrationSql(file: string): string {
  return readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
}

function quotedColumns(source: string): string[] {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

function keyIdentity(table: string, columns: readonly string[]): string {
  return `${table}(${columns.join(",")})`;
}

function referencedKeysUnavailableAtForeignKeyCreation(source: string): string[] {
  const uniqueTargets = new Set<string>();
  const invalidTargets: string[] = [];

  for (const statement of source
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const tableMatch = statement.match(
      /^CREATE TABLE "([^"]+)" \(([\s\S]*)\n\);$/,
    );
    if (tableMatch) {
      const table = tableMatch[1]!;
      const body = tableMatch[2]!;

      for (const inlinePrimaryKey of body.matchAll(
        /"([^"]+)"[^,\n]*PRIMARY KEY/g,
      )) {
        uniqueTargets.add(keyIdentity(table, [inlinePrimaryKey[1]!]));
      }

      for (const compositeKey of body.matchAll(
        /CONSTRAINT "[^"]+" (?:UNIQUE|PRIMARY KEY)\(([^)]+)\)/g,
      )) {
        uniqueTargets.add(keyIdentity(table, quotedColumns(compositeKey[1]!)));
      }
      continue;
    }

    const indexMatch = statement.match(
      /^CREATE UNIQUE INDEX "[^"]+" ON "([^"]+)"[^\(]*\(([^)]+)\)([\s\S]*);$/,
    );
    if (indexMatch) {
      if (!/\bWHERE\b/i.test(indexMatch[3]!)) {
        uniqueTargets.add(
          keyIdentity(indexMatch[1]!, quotedColumns(indexMatch[2]!)),
        );
      }
      continue;
    }

    const foreignKey = statement.match(
      /^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" FOREIGN KEY \(([^)]+)\) REFERENCES "public"\."([^"]+)"\(([^)]+)\)/,
    );
    if (!foreignKey) continue;
    const target = keyIdentity(
      foreignKey[4]!,
      quotedColumns(foreignKey[5]!),
    );
    if (!uniqueTargets.has(target)) {
      invalidTargets.push(`${foreignKey[1]}.${foreignKey[2]} -> ${target}`);
    }
  }

  return invalidTargets;
}

describe("generated PostgreSQL migration contract", () => {
  it("installs required extensions before the generated schema", () => {
    const files = migrationFiles();
    expect(files[0]).toBe("0000_extensions.sql");

    const extensionSql = migrationSql(files[0]!);
    expect(extensionSql).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    expect(extensionSql).toContain(
      "CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;",
    );

    const source = files.map(migrationSql).join("\n");
    expect(source.indexOf("CREATE EXTENSION IF NOT EXISTS pg_trgm;")).toBeLessThan(
      source.indexOf("gin_trgm_ops"),
    );
  });

  it("creates every exact non-partial unique target before its foreign key", () => {
    const source = migrationFiles()
      .map(migrationSql)
      .join("\n--> statement-breakpoint\n");
    expect(referencedKeysUnavailableAtForeignKeyCreation(source)).toEqual([]);
  });

  it("normalizes retained attempts before narrowing away compaction storage", () => {
    const source = migrationSql("0002_amused_warbird.sql");
    const normalizeRecovery = source.indexOf(
      `SET "session_operation" = 'new'`,
    );
    const deleteCompactionRuns = source.indexOf(
      `DELETE FROM "issue_execution_runs" WHERE "kind" = 'compaction'`,
    );
    const narrowRunKind = source.indexOf(
      `ADD CONSTRAINT "issue_execution_runs_kind_check"`,
    );
    const requireRunAgent = source.indexOf(
      `ALTER COLUMN "target_agent_id" SET NOT NULL`,
    );

    expect(normalizeRecovery).toBeGreaterThanOrEqual(0);
    expect(deleteCompactionRuns).toBeGreaterThan(normalizeRecovery);
    expect(narrowRunKind).toBeGreaterThan(deleteCompactionRuns);
    expect(requireRunAgent).toBeGreaterThan(deleteCompactionRuns);
    expect(source).toContain(
      `DELETE FROM "issue_session_events"\nWHERE "type" IN (`,
    );
    expect(source).toContain(
      `DELETE FROM "issue_session_messages"\nWHERE "type" = 'compaction'`,
    );
    expect(source).not.toContain(
      `DROP TABLE "issue_session_source_user_executions"`,
    );
  });

  it("normalizes persisted ACP launch facts to the ACPX registry identity before enforcing the new shape", () => {
    const source = migrationSql("0003_white_dorian_gray.sql");
    const normalizeLaunchProfile = source.indexOf(
      `UPDATE "agent_adapter_config_revisions"`,
    );
    const enforceNewShape = source.indexOf(
      `ADD CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check"`,
    );

    expect(normalizeLaunchProfile).toBeGreaterThanOrEqual(0);
    expect(enforceNewShape).toBeGreaterThan(normalizeLaunchProfile);
    expect(source).toContain(`jsonb_build_object(`);
    expect(source).toContain(`'registryName'`);
  });

  it("keeps the Board-mention index purge-safe", () => {
    const file = migrationFiles().find((entry) => entry.startsWith("0004_"));
    expect(file).toBeDefined();
    const source = migrationSql(file!);
    for (const constraint of [
      "issue_board_mentions_run_fk",
      "issue_board_mentions_comment_fk",
    ]) {
      expect(source).toMatch(
        new RegExp(`CONSTRAINT "${constraint}"[^;]*ON DELETE cascade`),
      );
    }
  });

  it("renames persisted context-access keys outside typed columns", () => {
    const file = migrationFiles().find((entry) => entry.startsWith("0004_"));
    expect(file).toBeDefined();
    const source = migrationSql(file!);
    expect(source).toContain(`UPDATE "routine_revisions"`);
    expect(source).toContain(`UPDATE "plugins" AS "plugin"`);
    expect(source).toContain(`UPDATE "plugin_managed_resources"`);
    expect(source).toContain(`'{issueTemplate,contextAccessMask}'`);
  });

});
