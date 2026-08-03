import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  issueSessionContextEpochs,
  issueSessionEventSequences,
  issueSessionEvents,
  issueSessionInputDispositions,
  issueSessionInputs,
  issueSessionMessageIdAllocators,
  issueSessionMessageIdReservations,
  issueSessionMessages,
  issueSessions,
} from "../schema/issue_sessions.js";

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

function columns(table: Table): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function foreignKeys(table: Table): string[] {
  return getTableConfig(table).foreignKeys.map((key) => key.getName());
}

function checkSql(table: Table, name: string): string {
  const constraint = getTableConfig(table).checks.find(
    (candidate) => candidate.name === name,
  );
  expect(constraint).toBeDefined();
  return dialect.sqlToQuery(constraint!.value).sql;
}

describe("issue-session schema", () => {
  it("owns the canonical session, sequence, event, message, input, and context tables", () => {
    expect(columns(issueSessions)).toEqual([
      "id",
      "company_id",
      "issue_id",
      "parent_session_id",
      "project_id",
      "agent",
      "model",
      "cost",
      "tokens_input",
      "tokens_output",
      "tokens_reasoning",
      "tokens_cache_read",
      "tokens_cache_write",
      "title",
      "directory",
      "workspace_id",
      "subpath",
      "revert",
      "time_created",
      "time_updated",
      "time_archived",
      "projected_event_seq",
      "integrity_state",
      "migrated_at",
      "ref_admittable_at",
      "purge_fenced_at",
    ]);
    expect(columns(issueSessionEventSequences)).toEqual([
      "company_id",
      "issue_id",
      "session_id",
      "seq",
      "owner_id",
    ]);
    expect(columns(issueSessionEvents)).toEqual([
      "id",
      "company_id",
      "issue_id",
      "session_id",
      "seq",
      "type",
      "data",
      "run_id",
      "ownership_epoch",
      "agent_id",
      "adapter_config_revision_id",
      "source_kind",
      "source_id",
      "immutable_source_key",
      "source_record_id",
      "source_identity_digest",
      "created_at",
    ]);
    expect(columns(issueSessionMessages)).toEqual([
      "id",
      "company_id",
      "issue_id",
      "session_id",
      "seq",
      "model_state_seq",
      "type",
      "data",
      "run_id",
      "ownership_epoch",
      "agent_id",
      "adapter_config_revision_id",
      "time_created",
      "time_updated",
    ]);
    expect(columns(issueSessionInputs)).toEqual([
      "id",
      "company_id",
      "issue_id",
      "session_id",
      "prompt",
      "delivery",
      "admitted_seq",
      "promoted_seq",
      "time_created",
    ]);
    expect(columns(issueSessionContextEpochs)).toEqual([
      "company_id",
      "issue_id",
      "session_id",
      "baseline",
      "snapshot",
      "baseline_seq",
      "generation",
    ]);
  });

  it("defines deterministic message identifiers and immutable scoped records", () => {
    expect(columns(issueSessionMessageIdAllocators)).toEqual([
      "company_id",
      "issue_id",
      "session_id",
      "last_ordinal",
      "updated_at",
    ]);
    expect(columns(issueSessionMessageIdReservations)).toEqual([
      "id",
      "company_id",
      "issue_id",
      "session_id",
      "reservation_key",
      "ordinal",
      "message_id",
      "created_at",
    ]);
    expect(
      checkSql(
        issueSessionMessageIdReservations,
        "issue_session_message_id_reservations_value_check",
      ),
    ).toContain("lpad");
    expect(foreignKeys(issueSessionMessages)).toEqual(
      expect.arrayContaining([
        "issue_session_messages_scope_fk",
        "issue_session_messages_message_id_reservation_fk",
        "issue_session_messages_company_run_fk",
      ]),
    );
    expect(
      getTableConfig(issueSessionEvents).indexes
        .filter((index) => index.config.unique)
        .map((index) => index.config.name),
    ).toEqual(
      expect.arrayContaining([
        "issue_session_events_session_seq_uq",
        "issue_session_events_source_identity_uq",
      ]),
    );
  });

  it("keeps payload envelopes and queued-input disposition states closed", () => {
    const eventData = checkSql(
      issueSessionEvents,
      "issue_session_events_data_check",
    );
    expect(eventData).toContain("jsonb_typeof");
    expect(eventData).toContain("? 'id'");
    expect(eventData).toContain("? 'type'");
    expect(eventData).toContain("? 'durable'");
    expect(eventData).toContain("? 'metadata'");

    const inputState = checkSql(
      issueSessionInputDispositions,
      "issue_session_input_dispositions_invalidation_check",
    );
    expect(inputState).toContain("= 'active'");
    expect(inputState).toContain("= 'invalidated'");
    expect(inputState).toContain('"invalidation_reason" is not null');
    expect(checkSql(issueSessionInputs, "issue_session_inputs_delivery_check"))
      .toContain("in ('steer', 'queue')");
  });

  it("renders the same tables and constraints into the generated migration", () => {
    for (const table of [
      "issue_sessions",
      "issue_session_event_sequences",
      "issue_session_message_id_allocators",
      "issue_session_message_id_reservations",
      "issue_session_events",
      "issue_session_messages",
      "issue_session_inputs",
      "issue_session_input_dispositions",
      "issue_session_context_epochs",
    ]) {
      expect(generatedMigrationSql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(generatedMigrationSql).toContain(
      'CONSTRAINT "issue_session_input_dispositions_invalidation_check"',
    );
    expect(generatedMigrationSql).toContain(
      'CONSTRAINT "issue_session_messages_message_id_reservation_fk"',
    );
    expect(generatedMigrationSql).not.toContain('CREATE TABLE "issue_session_reverts"');
  });
});
