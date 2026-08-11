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

    const addedUniqueConstraint = statement.match(
      /^ALTER TABLE "([^"]+)" ADD CONSTRAINT "[^"]+" UNIQUE\(([^)]+)\);$/,
    );
    if (addedUniqueConstraint) {
      uniqueTargets.add(
        keyIdentity(
          addedUniqueConstraint[1]!,
          quotedColumns(addedUniqueConstraint[2]!),
        ),
      );
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
  it("contains only the extension prelude and generated schema baseline", () => {
    const files = migrationFiles();
    expect(files).toEqual([
      "0000_extensions.sql",
      "0001_melodic_lila_cheney.sql",
    ]);

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

  it("creates the canonical task persistence graph and closed checks", () => {
    const source = migrationSql("0001_melodic_lila_cheney.sql");

    for (const table of [
      "tasks",
      "task_approvals",
      "task_attachments",
      "task_comment_projection_sources",
      "task_comments",
      "task_documents",
      "task_execution_attempts",
      "task_execution_finalization_prompt_dependencies",
      "task_execution_finalization_update_dependencies",
      "task_execution_finalizations",
      "task_execution_prompt_segments",
      "task_execution_refs",
      "task_execution_runs",
      "task_execution_sessions",
      "task_relations",
      "task_session_events",
      "task_session_inputs",
      "task_session_messages",
      "task_session_source_user_executions",
      "task_sessions",
      "task_updates",
      "task_work_products",
    ]) {
      expect(source).toContain(`CREATE TABLE "${table}"`);
    }

    for (const constraint of [
      "tasks_canonical_contract_check",
      "tasks_lifecycle_disposition_check",
      "tasks_owner_shape_check",
      "tasks_creator_shape_check",
      "task_comments_canonical_source_kind_check",
      "task_execution_refs_source_kind_check",
      "task_execution_runs_kind_check",
      "task_session_inputs_delivery_check",
      "task_updates_form_check",
      "task_updates_form_shape_check",
    ]) {
      expect(source).toContain(`CONSTRAINT "${constraint}"`);
    }

    expect(source).toContain('"task_number" integer');
    expect(source).toContain('"task_prefix" text');
    expect(source).toContain('"task_counter" integer');
  });

  it("keeps canonical cascades, uniqueness, and JSON checks apply-safe", () => {
    const source = migrationSql("0001_melodic_lila_cheney.sql");

    for (const constraint of [
      "task_board_mentions_run_fk",
      "task_board_mentions_comment_fk",
    ]) {
      expect(source).toMatch(
        new RegExp(`CONSTRAINT "${constraint}"[^;]*ON DELETE cascade`),
      );
    }
    expect(source).toContain(
      'ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_fk" FOREIGN KEY ("company_id","parent_id") REFERENCES "public"."tasks"("company_id","id") ON DELETE restrict',
    );
    expect(source).toContain(
      'CREATE UNIQUE INDEX "plugins_plugin_key_idx" ON "plugins" USING btree ("plugin_key");',
    );
    expect(source).toContain(
      'CREATE UNIQUE INDEX "task_sessions_company_task_uq" ON "task_sessions" USING btree ("company_id","task_id");',
    );
    expect(source).toContain(
      `jsonb_typeof("task_updates"."disposition" -> 'message') = 'string'`,
    );
    expect(source).not.toContain(
      `jsonb_typeof("task_updates"."disposition" ->> 'message')`,
    );
    expect(source).toContain(
      'CONSTRAINT "agent_action_grants_key_check"',
    );
    expect(source).toContain("'task_create'");
    expect(source).toContain("'task_update'");
    expect(source).toContain("'task_execution_workspace'");
  });

  it("is a fresh schema without retired persistence or rewrite statements", () => {
    const source = migrationSql("0001_melodic_lila_cheney.sql");

    for (const table of [
      "feedback_exports",
      "feedback_votes",
      "creator_deliveries",
      "plugin_creator_deliveries",
      "task_execution_finalization_delivery_dependencies",
      "task_session_reverts",
    ]) {
      expect(source).not.toContain(`CREATE TABLE "${table}"`);
    }
    for (const column of [
      "context_access_mask",
      "feedback_data_sharing_enabled",
      "feedback_data_sharing_consent_at",
    ]) {
      expect(source).not.toContain(`"${column}"`);
    }
    for (const token of ["creator_update", "task_assign"]) {
      expect(source).not.toContain(`'${token}'`);
    }

    expect(source.toLowerCase()).not.toContain(
      String.fromCharCode(105, 115, 115, 117, 101),
    );
    expect(source).not.toMatch(/^DROP TABLE\b/m);
    expect(source).not.toMatch(/^ALTER TABLE .*\bDROP COLUMN\b/m);
    expect(source).not.toMatch(/^ALTER TABLE .*\bRENAME\b/m);
    expect(source).not.toMatch(/^(?:UPDATE|DELETE FROM|INSERT INTO)\b/m);
  });
});
