import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { pipelineCaseEvents } from "../schema/pipeline_case_events.js";
import {
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseDocuments,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineDocuments,
} from "../schema/pipeline_cases.js";
import {
  pipelines,
  pipelineStages,
  pipelineTransitions,
} from "../schema/pipelines.js";

const dialect = new PgDialect();
const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
const generatedMigrationSql = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(path.join(migrationsDirectory, name), "utf8"))
  .join("\n");
type Table = Parameters<typeof getTableConfig>[0];

function names(table: Table): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function uniqueIndexes(table: Table): string[] {
  return getTableConfig(table).indexes
    .filter((index) => index.config.unique)
    .map((index) => index.config.name!);
}

function checkSql(table: Table, name: string): string {
  const constraint = getTableConfig(table).checks.find(
    (candidate) => candidate.name === name,
  );
  expect(constraint).toBeDefined();
  return dialect.sqlToQuery(constraint!.value).sql;
}

describe("pipeline schema", () => {
  it("defines the canonical pipeline graph and case records", () => {
    expect(names(pipelines)).toEqual([
      "id",
      "company_id",
      "project_id",
      "key",
      "name",
      "description",
      "enforce_transitions",
      "created_by_user_id",
      "created_by_agent_id",
      "archived_at",
      "created_at",
      "updated_at",
    ]);
    expect(names(pipelineStages)).toEqual([
      "id",
      "pipeline_id",
      "key",
      "name",
      "kind",
      "position",
      "config",
      "created_at",
      "updated_at",
    ]);
    expect(names(pipelineTransitions)).toEqual([
      "id",
      "pipeline_id",
      "from_stage_id",
      "to_stage_id",
      "label",
      "created_at",
      "updated_at",
    ]);
    expect(names(pipelineCases)).toEqual(
      expect.arrayContaining([
        "company_id",
        "pipeline_id",
        "stage_id",
        "case_key",
        "parent_case_id",
        "version",
        "lease_owner_type",
        "terminal_kind",
        "child_count",
        "terminal_child_count",
      ]),
    );
  });

  it("encodes uniqueness and validation without executing SQL", () => {
    expect(uniqueIndexes(pipelines)).toContain("pipelines_company_key_uq");
    expect(uniqueIndexes(pipelineStages)).toContain(
      "pipeline_stages_pipeline_key_uq",
    );
    expect(uniqueIndexes(pipelineTransitions)).toContain(
      "pipeline_transitions_pipeline_edge_uq",
    );
    expect(uniqueIndexes(pipelineCases)).toEqual(
      expect.arrayContaining([
        "pipeline_cases_pipeline_case_key_uq",
        "pipeline_cases_parent_request_key_uq",
      ]),
    );
    expect(uniqueIndexes(pipelineCaseIssueLinks)).toContain(
      "pipeline_case_issue_links_case_issue_uq",
    );
    expect(uniqueIndexes(pipelineCaseBlockers)).toContain(
      "pipeline_case_blockers_case_blocked_by_uq",
    );
    expect(uniqueIndexes(pipelineDocuments)).toEqual(
      expect.arrayContaining([
        "pipeline_documents_company_pipeline_key_uq",
        "pipeline_documents_document_uq",
      ]),
    );
    expect(uniqueIndexes(pipelineCaseDocuments)).toEqual(
      expect.arrayContaining([
        "pipeline_case_documents_company_case_key_uq",
        "pipeline_case_documents_document_uq",
      ]),
    );
    expect(uniqueIndexes(pipelineAutomationExecutions)).toContain(
      "pipeline_automation_executions_idempotency_uq",
    );

    expect(checkSql(pipelineStages, "pipeline_stages_kind_check"))
      .toContain("in ('working', 'review', 'done', 'cancelled')");
    expect(checkSql(pipelineCaseBlockers, "pipeline_case_blockers_no_self_block_check"))
      .toContain("<>");
    expect(checkSql(pipelineCaseEvents, "pipeline_case_events_actor_type_check"))
      .toContain("in ('user', 'agent', 'system')");
    expect(checkSql(pipelineCaseEvents, "pipeline_case_events_agent_run_check"))
      .toContain('"run_id" is not null');
  });

  it("renders every pipeline table and closed check into the generated migration", () => {
    for (const table of [
      "pipelines",
      "pipeline_stages",
      "pipeline_transitions",
      "pipeline_cases",
      "pipeline_case_events",
      "pipeline_case_issue_links",
      "pipeline_case_blockers",
      "pipeline_documents",
      "pipeline_case_documents",
      "pipeline_automation_executions",
    ]) {
      expect(generatedMigrationSql).toContain(`CREATE TABLE "${table}"`);
    }
    for (const constraint of [
      "pipeline_stages_kind_check",
      "pipeline_cases_terminal_kind_check",
      "pipeline_case_blockers_no_self_block_check",
      "pipeline_case_events_type_check",
      "pipeline_case_events_actor_type_check",
      "pipeline_automation_executions_status_check",
    ]) {
      expect(generatedMigrationSql).toContain(`CONSTRAINT "${constraint}"`);
    }
  });
});
