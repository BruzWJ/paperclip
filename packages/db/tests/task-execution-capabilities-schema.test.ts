import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  taskExecutionPromptCapabilities,
  taskExecutionSessions,
} from "../schema/task_execution_capabilities.js";
import {
  pluginRunContexts,
  runInterfaceToolCalls,
} from "../schema/run_interface_foundation.js";

const dialect = new PgDialect();

function columns(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function checkSql(
  table: Parameters<typeof getTableConfig>[0],
  name: string,
): string {
  const constraint = getTableConfig(table).checks.find(
    (candidate) => candidate.name === name,
  );
  expect(constraint).toBeDefined();
  return dialect.sqlToQuery(constraint!.value).sql;
}

function index(
  table: Parameters<typeof getTableConfig>[0],
  name: string,
) {
  const candidate = getTableConfig(table).indexes.find(
    (value) => value.config.name === name,
  );
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("canonical ACP carry correlation schema", () => {
  it("stores only the encrypted opaque carry correlation", () => {
    expect(getTableConfig(taskExecutionSessions).name).toBe(
      "task_execution_sessions",
    );
    expect(columns(taskExecutionSessions)).toEqual([
      "id",
      "company_id",
      "task_id",
      "ownership_epoch",
      "state",
      "target_agent_id",
      "adapter_config_identity",
      "workspace_identity",
      "lane_kind",
      "authorized_context_exposure_digest",
      "envelope_version",
      "codec_kind",
      "acp_wire_protocol_version",
      "protected_target_session",
      "protected_target_session_digest",
      "target_fingerprint",
      "correlation_generation",
      "last_protocol_settled_run_id",
      "last_protocol_settled_ref_id",
      "last_protocol_settled_ref_ordinal",
      "cost_cursor_state",
      "cost_cursor_amount",
      "cost_cursor_currency",
      "supersession_reason",
      "superseded_at",
      "created_at",
    ]);
    // PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: session_id, session_params, session_display_id, acp_session_id, native_correlation, credential, prompt, catalog, state_json, last_used_at, updated_at
    expect(columns(taskExecutionSessions)).not.toEqual(
      expect.arrayContaining([
        "session_id",
        "session_params",
        "session_display_id",
        "acp_session_id",
        "native_correlation",
        "credential",
        "prompt",
        "catalog",
        "state_json",
        "last_used_at",
        "updated_at",
      ]),
    );

    const shape = checkSql(
      taskExecutionSessions,
      "task_execution_sessions_shape_check",
    );
    expect(shape).toContain("in ('eligible', 'superseded')");
    expect(shape).toContain("in ('owner', 'consult')");

    const envelope = checkSql(
      taskExecutionSessions,
      "task_execution_sessions_envelope_check",
    );
    expect(envelope).toContain("= 'task-execution-native/v1'");
    expect(envelope).toContain("= 'acp-session/v1'");
    expect(envelope).toContain('"acp_wire_protocol_version" = 1');
  });

  it("uses one exact seven-field key for the eligible row", () => {
    const eligible = index(
      taskExecutionSessions,
      "task_execution_sessions_eligible_uq",
    );

    expect(eligible.config.unique).toBe(true);
    expect(
      eligible.config.columns.map((column) => (column as { name: string }).name),
    ).toEqual([
      "company_id",
      "task_id",
      "ownership_epoch",
      "target_agent_id",
      "adapter_config_identity",
      "workspace_identity",
      "lane_kind",
    ]);
    expect(
      eligible.config.where
        ? dialect.sqlToQuery(eligible.config.where).sql
        : null,
    ).toBe('"task_execution_sessions"."state" = \'eligible\'');
    expect(
      eligible.config.columns.map(
        (column) => (column as { name: string }).name,
      ),
    ).not.toContain("correlation_generation");
  });

  it("keeps supersession permanent and the settlement cursor typed", () => {
    const supersession = checkSql(
      taskExecutionSessions,
      "task_execution_sessions_supersession_check",
    );
    const cursor = checkSql(
      taskExecutionSessions,
      "task_execution_sessions_cost_cursor_check",
    );

    expect(supersession).toContain("= 'superseded'");
    expect(supersession).toContain('"supersession_reason"');
    expect(supersession).toContain('"superseded_at" is not null');
    expect(cursor).toContain("= 'unanchored'");
    expect(cursor).toContain("= 'known'");
    expect(cursor).toContain("= 'unavailable'");
    expect(cursor).toContain('"last_protocol_settled_run_id" is not null');
  });
});

describe("prompt capability generations", () => {
  it("binds one exact prompt, attempt, lease, process and authorization", () => {
    expect(getTableConfig(taskExecutionPromptCapabilities).name).toBe(
      "task_execution_prompt_capabilities",
    );
    expect(columns(taskExecutionPromptCapabilities)).toEqual([
      "company_id",
      "capability_connection_id",
      "capability_generation",
      "run_id",
      "run_batch_digest",
      "ref_id",
      "ref_ordinal",
      "attempt_id",
      "lease_id",
      "lease_generation",
      "worker_process_identity",
      "task_id",
      "ownership_epoch",
      "target_agent_id",
      "lane_kind",
      "execution_mode",
      "task_execution_authority_id",
      "consult_execution_id",
      "adapter_config_identity",
      "workspace_identity",
      "target_session_correlation_id",
      "effective_context_exposure_digest",
      "effective_tools_digest",
      "bearer_hash",
      "ingress_high_water",
      "classification_high_water",
      "state",
      "expires_at",
      "activated_at",
      "revocation_reason",
      "revoked_at",
      "created_at",
    ]);
    expect(columns(taskExecutionPromptCapabilities)).not.toEqual(
      expect.arrayContaining([
        "bearer",
        "token",
        "prompt",
        "catalog",
        "catalog_json",
        "acp_session_id",
        "session_id",
      ]),
    );

    const state = checkSql(
      taskExecutionPromptCapabilities,
      "task_execution_prompt_capabilities_state_check",
    );
    expect(state).toContain("= 'pending_setup'");
    expect(state).toContain("= 'active'");
    expect(state).toContain("= 'revoked'");
    expect(state).toContain('"target_session_correlation_id" is not null');
    const identity = checkSql(
      taskExecutionPromptCapabilities,
      "task_execution_prompt_capabilities_identity_check",
    );
    expect(identity).toContain("9007199254740991");
    expect(identity).toContain('"classification_high_water"');

    const liveRun = index(
      taskExecutionPromptCapabilities,
      "task_execution_prompt_capabilities_live_run_uq",
    );
    expect(liveRun.config.unique).toBe(true);
    expect(
      liveRun.config.where
        ? dialect.sqlToQuery(liveRun.config.where).sql
        : null,
    ).toBe(
      '"task_execution_prompt_capabilities"."state" in (\'pending_setup\', \'active\')',
    );
  });
});

describe("normalized plugin run contexts", () => {
  it("stores one hash-only child of the exact capability and tool call", () => {
    expect(columns(pluginRunContexts)).toEqual([
      "capability_connection_id",
      "capability_generation",
      "run_interface_tool_call_id",
      "plugin_installation_id",
      "handle_hash",
      "first_used_at",
      "created_at",
    ]);
    expect(columns(pluginRunContexts)).not.toEqual(
      expect.arrayContaining([
        "run_id",
        "task_id",
        "session_id",
        "task_execution_ref_id",
        "ownership_epoch",
        "execution_mode",
        "lease_id",
        "lease_generation",
        "status",
        "expires_at",
        "revocation_reason",
        "revoked_at",
        "updated_at",
        "token",
      ]),
    );

    const config = getTableConfig(pluginRunContexts);
    expect(config.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "plugin_run_contexts_capability_generation_fk",
        "plugin_run_contexts_exact_tool_call_fk",
      ]),
    );
    expect(config.uniqueConstraints.map((value) => value.getName())).toContain(
      "plugin_run_contexts_tool_call_uq",
    );
    expect(
      getTableConfig(pluginRunContexts).columns.find(
        (column) => column.name === "handle_hash",
      )?.primary,
    ).toBe(true);

    expect(columns(runInterfaceToolCalls)).toEqual(
      expect.arrayContaining([
        "capability_connection_id",
        "capability_generation",
        "ingress_ordinal",
        "classification",
        "mention_target_agent_id",
        "plugin_installation_id",
      ]),
    );
    expect(columns(runInterfaceToolCalls)).not.toEqual(
      expect.arrayContaining([
        "mention_admission_state",
        "mention_admission_started_at",
        "mention_admitted_at",
      ]),
    );
    // PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: run_interface_session_id
    expect(columns(runInterfaceToolCalls)).not.toContain(
      "run_interface_session_id",
    );
    expect(
      getTableConfig(runInterfaceToolCalls).foreignKeys.map((key) =>
        key.getName(),
      ),
    ).toEqual(
      expect.arrayContaining([
        "run_interface_tool_calls_capability_generation_fk",
      ]),
    );
    const identity = checkSql(
      runInterfaceToolCalls,
      "run_interface_tool_calls_identity_check",
    );
    expect(identity).toContain("9007199254740991");
    expect(identity).toContain("= 'ingress'");
    const status = checkSql(
      runInterfaceToolCalls,
      "run_interface_tool_calls_status_check",
    );
    expect(status).toContain("= 'failed'");
    expect(status).toContain("<> 'terminal_invalid'");
    expect(status).toContain('"error" is not null');
    expect(status).toContain('"completed_at" is not null');
  });
});
