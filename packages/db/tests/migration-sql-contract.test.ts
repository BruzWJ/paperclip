import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
const canonicalRewriteMigration = "0002_unknown_big_bertha.sql";
const canonicalMentionMigration = "0003_big_scorpion.sql";

function migrationFiles(): string[] {
  return readdirSync(migrationsDirectory)
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
}

function migrationSql(file: string): string {
  return readFileSync(
    new URL(`../migrations/${file}`, import.meta.url),
    "utf8",
  );
}

function quotedColumns(source: string): string[] {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

function keyIdentity(table: string, columns: readonly string[]): string {
  return `${table}(${columns.join(",")})`;
}

function referencedKeysUnavailableAtForeignKeyCreation(
  source: string,
): string[] {
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
    const target = keyIdentity(foreignKey[4]!, quotedColumns(foreignKey[5]!));
    if (!uniqueTargets.has(target)) {
      invalidTargets.push(`${foreignKey[1]}.${foreignKey[2]} -> ${target}`);
    }
  }

  return invalidTargets;
}

describe("generated PostgreSQL migration contract", () => {
  it("contains the ordered generated migration chain", () => {
    const files = migrationFiles();
    expect(files).toEqual([
      "0000_extensions.sql",
      "0001_melodic_lila_cheney.sql",
      canonicalRewriteMigration,
      canonicalMentionMigration,
    ]);

    const extensionSql = migrationSql(files[0]!);
    const publicSchemaAt = extensionSql.indexOf(
      "CREATE SCHEMA IF NOT EXISTS public;",
    );
    const trigramExtensionAt = extensionSql.indexOf(
      "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;",
    );
    const fuzzyExtensionAt = extensionSql.indexOf(
      "CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA public;",
    );

    expect(publicSchemaAt).toBeGreaterThanOrEqual(0);
    expect(trigramExtensionAt).toBeGreaterThan(publicSchemaAt);
    expect(fuzzyExtensionAt).toBeGreaterThan(trigramExtensionAt);
    expect(extensionSql).toContain(
      "CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA public;",
    );

    const source = files.map(migrationSql).join("\n");
    expect(trigramExtensionAt).toBeLessThan(source.indexOf("gin_trgm_ops"));
  });

  it("creates every exact non-partial unique target before its foreign key", () => {
    const source = migrationFiles()
      .map(migrationSql)
      .join("\n--> statement-breakpoint\n");
    expect(referencedKeysUnavailableAtForeignKeyCreation(source)).toEqual([]);
  });

  it("canonicalizes persisted mention sources without rewriting their stable identity", () => {
    const source = migrationSql(canonicalMentionMigration);
    const constraintDroppedAt = source.indexOf(
      'DROP CONSTRAINT "task_execution_refs_source_kind_check"',
    );
    const eventsUpdatedAt = source.indexOf(
      'UPDATE "task_session_events"\nSET "source_kind" = \'mention_agent\'',
    );
    const refsUpdatedAt = source.indexOf(
      'UPDATE "task_execution_refs"\nSET "source_kind" = \'mention_agent\'',
    );
    const constraintAddedAt = source.indexOf(
      'ADD CONSTRAINT "task_execution_refs_source_kind_check"',
    );

    expect(constraintDroppedAt).toBeGreaterThanOrEqual(0);
    expect(eventsUpdatedAt).toBeGreaterThan(constraintDroppedAt);
    expect(refsUpdatedAt).toBeGreaterThan(eventsUpdatedAt);
    expect(constraintAddedAt).toBeGreaterThan(refsUpdatedAt);
    expect(
      source.match(
        /WHERE "source_kind" IN \('human_comment_mention', 'consult_mention'\)/g,
      ),
    ).toHaveLength(2);
    expect(source).not.toMatch(
      /SET\s+"(?:source_identity_digest|source_id|id|immutable_source_key|source_record_id|history_view_id|execution_scope_id|execution_lineage_id|comment_id|disposition_id|message_id|reservation_key)"/,
    );
    expect(source).not.toMatch(
      /UPDATE "(?:task_session_message_id_reservations|task_execution_history_views|task_comments|task_session_input_dispositions)"/,
    );
    expect(source.slice(constraintAddedAt)).toContain("'mention_agent'");
    expect(source.slice(constraintAddedAt)).not.toContain(
      "'human_comment_mention'",
    );
    expect(source.slice(constraintAddedAt)).not.toContain("'consult_mention'");
  });

  it("deletes retired skill-test tasks instead of preserving them as ordinary work", () => {
    const source = migrationSql(canonicalRewriteMigration);
    const skillTablesDroppedAt = source.indexOf(
      'DROP TABLE "company_skills" CASCADE;',
    );
    const taskDeletionAt = source.indexOf(
      'DELETE FROM "tasks"\nWHERE "harness_kind" = \'skill_test\'\n   OR "work_mode" = \'skill_test\';',
    );
    const harnessColumnDroppedAt = source.indexOf(
      'ALTER TABLE "tasks" DROP COLUMN "harness_kind";',
    );

    expect(skillTablesDroppedAt).toBeGreaterThanOrEqual(0);
    expect(taskDeletionAt).toBeGreaterThan(skillTablesDroppedAt);
    expect(harnessColumnDroppedAt).toBeGreaterThan(taskDeletionAt);
    expect(source).not.toMatch(/UPDATE "tasks"[\s\S]*?skill_test/);
  });

  it("drops the retired parallel agent configuration revision table", () => {
    const source = migrationSql(canonicalRewriteMigration);
    expect(source).toContain('DROP TABLE "agent_config_revisions" CASCADE;');
  });

  it("canonicalizes immutable ACP model values before enforcing their closed shape", () => {
    const source = migrationSql(canonicalRewriteMigration);
    const legacyShapeDroppedAt = source.indexOf(
      'DROP CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check"',
    );
    const configurationCanonicalizedAt = source.indexOf(
      "\"acp_configuration\" - 'companySkillPins' - 'workspaceSelector'",
    );
    const closedShapeAddedAt = source.indexOf(
      'ADD CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check"',
    );

    expect(legacyShapeDroppedAt).toBeGreaterThanOrEqual(0);
    expect(configurationCanonicalizedAt).toBeGreaterThan(legacyShapeDroppedAt);
    expect(closedShapeAddedAt).toBeGreaterThan(configurationCanonicalizedAt);
    expect(source).toContain(
      "(\"acp_configuration\" -> 'model') - 'id' - 'limits'",
    );
    expect(source).toContain("'value', 'label'");
    expect(source).not.toContain("'value', 'label', 'limits'");
    expect(source).not.toContain("'{model,id}'");
  });

  it("drops every mirrored and synthetic adapter configuration column", () => {
    const source = migrationSql(canonicalRewriteMigration);
    for (const statement of [
      'ALTER TABLE "agents" DROP COLUMN "adapter_type";',
      'ALTER TABLE "agents" DROP COLUMN "adapter_config";',
      'ALTER TABLE "agents" DROP COLUMN "runtime_config";',
      'ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "adapter_type";',
      'ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "implementation_identity";',
      'ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "adapter_config_schema_version";',
      'ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "normalized_config";',
      'ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "runtime_config";',
      'ALTER TABLE "agent_runtime_state" DROP COLUMN "adapter_type";',
    ]) {
      expect(source).toContain(statement);
    }
  });

  it("normalizes retired runtime-only agent statuses to idle", () => {
    const source = migrationSql(canonicalRewriteMigration);
    expect(source).toContain(
      'UPDATE "agents"\nSET "status" = \'idle\',\n    "updated_at" = now()\nWHERE "status" IN (\'active\', \'running\');',
    );
  });

  it("canonicalizes persisted human roles before enforcing principal-specific roles", () => {
    const source = migrationSql(canonicalRewriteMigration);
    const canonicalizedAt = source.indexOf(
      'UPDATE "company_memberships"\nSET "membership_role" = \'operator\'',
    );
    const constraintAt = source.indexOf(
      'ADD CONSTRAINT "company_memberships_principal_role_check"',
    );
    const notNullAt = source.indexOf(
      'ALTER COLUMN "membership_role" SET NOT NULL',
    );
    expect(canonicalizedAt).toBeGreaterThanOrEqual(0);
    expect(notNullAt).toBeGreaterThan(canonicalizedAt);
    expect(constraintAt).toBeGreaterThan(notNullAt);
    expect(source).toContain(
      "\"membership_role\" in ('owner', 'admin', 'operator', 'viewer')",
    );
    expect(source).toContain("\"membership_role\" = 'member'");
  });

  it("cleans invalid project and routine metadata before closed checks", () => {
    const source = migrationSql(canonicalRewriteMigration);
    const projectCleanupAt = source.indexOf(
      'UPDATE "projects"\nSET "color" = NULL',
    );
    const routineCleanupAt = source.indexOf('DELETE FROM "routine_runs"');
    const projectCheckAt = source.indexOf(
      'ADD CONSTRAINT "projects_color_check"',
    );
    const sourceCheckAt = source.indexOf(
      'ADD CONSTRAINT "routine_runs_source_check"',
    );
    const statusCheckAt = source.indexOf(
      'ADD CONSTRAINT "routine_runs_status_check"',
    );
    expect(projectCleanupAt).toBeGreaterThanOrEqual(0);
    expect(routineCleanupAt).toBeGreaterThan(projectCleanupAt);
    expect(projectCheckAt).toBeGreaterThan(projectCleanupAt);
    expect(sourceCheckAt).toBeGreaterThan(routineCleanupAt);
    expect(statusCheckAt).toBeGreaterThan(sourceCheckAt);
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
    expect(source).toContain('CONSTRAINT "agent_action_grants_key_check"');
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
