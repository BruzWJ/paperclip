import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schemaUrl = new URL(
  "../../../../packages/db/schema/issues.ts",
  import.meta.url,
);
const migrationsDirectory = fileURLToPath(
  new URL("../../../../packages/db/migrations/", import.meta.url),
);

async function readGeneratedMigrationSql(): Promise<string> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  return (await Promise.all(
    names.map((name) => readFile(path.join(migrationsDirectory, name), "utf8")),
  )).join("\n");
}

function normalized(source: string) {
  return source.replaceAll(/\s+/g, " ").trim();
}

describe("issue creator schema constraints", () => {
  it("defines the canonical escalation shape in the Drizzle schema", async () => {
    const source = normalized(await readFile(schemaUrl, "utf8"));

    expect(source).toContain('"issues_escalation_shape_check"');
    expect(source).toContain("creatorKind} <> 'system'");
    expect(source).toContain("creatorKind} = 'system'");
    expect(source).toContain("escalatedFromAffectedIssueId} is not null");
    expect(source).toContain("escalatedFromAffectedIssueId} <> ${table.id}");
    expect(source).toContain("escalatedFromReason} is not null");
    expect(source).toContain("affectedOwnershipEpoch} > 0");
    expect(source).toContain("parentId} is null");
  });

  it("keeps every escalation field absent for non-system creators", async () => {
    const source = normalized(await readFile(schemaUrl, "utf8"));

    expect(source).toContain(
      "escalatedFromAffectedIssueId} is null and ${table.escalatedFromTriggeringRunId} is null and ${table.escalatedFromReason} is null and ${table.affectedOwnershipEpoch} is null and ${table.creatorKind} <> 'system'",
    );
  });

  it("emits the named constraint into generated migrations", async () => {
    const migrations = normalized(await readGeneratedMigrationSql());

    expect(migrations).toContain(
      'CONSTRAINT "issues_escalation_shape_check" CHECK',
    );
    expect(migrations).toContain(
      '"issues"."escalated_from_affected_issue_id" is not null',
    );
    expect(migrations).toContain('"issues"."creator_kind" = \'system\'');
    expect(migrations).toContain('"issues"."parent_id" is null');
  });
});
