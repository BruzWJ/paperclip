import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: usage_json
import {
  taskExecutionAttempts,
  taskExecutionAttemptRetrySchedules,
  taskExecutionCancellationIntents,
  taskExecutionFinalizationPromptDependencies,
  taskExecutionFinalizations,
  taskExecutionLeases,
  taskExecutionRunControls,
  taskExecutionRunLivenessFacts,
  taskExecutionRunRefs,
  taskExecutionRuns,
} from "../schema/task_execution_runs.js";
import {
  taskExecutionHistoryViewMessages,
  taskExecutionHistoryViews,
  taskExecutionLanes,
  taskExecutionRefs,
} from "../schema/task_execution_runtime.js";

const dialect = new PgDialect();

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function checkSql(
  table: Parameters<typeof getTableConfig>[0],
  name: string,
): string {
  const schemaCheck = getTableConfig(table).checks.find(
    (candidate) => candidate.name === name,
  );
  expect(schemaCheck).toBeDefined();
  return dialect.sqlToQuery(schemaCheck!.value).sql;
}

describe("canonical task execution run schema", () => {
  it("keeps the run envelope closed and free of prompt or result mirrors", () => {
    const config = getTableConfig(taskExecutionRuns);
    const columns = columnNames(taskExecutionRuns);

    expect(config.name).toBe("task_execution_runs");
    expect(columns).toEqual([
      "id",
      "company_id",
      "task_id",
      "session_id",
      "execution_scope_id",
      "kind",
      "status",
      "ownership_epoch",
      "target_agent_id",
      "adapter_config_revision_id",
      "execution_workspace_binding_id",
      "execution_mode",
      "task_execution_authority_id",
      "consult_execution_id",
      "parent_run_id",
      "retry_of_run_id",
      "current_attempt_id",
      "current_lease_id",
      "cancellation_intent_id",
      "terminal_finalization_id",
      "started_at",
      "finished_at",
      "terminal_classification",
      "terminal_reason_code",
      "created_at",
      "updated_at",
    ]);
    expect(columns).not.toEqual(
      expect.arrayContaining([
        "ref_id",
        "compaction_control_id",
        "current_ref_id",
        "current_ordinal",
        "current_segment_ordinal",
        "payload",
        "result_json",
        "usage_json",
        "context_snapshot",
        "stdout_excerpt",
        "stderr_excerpt",
        "log_ref",
      ]),
    );
    expect(config.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "task_execution_runs_lane_fk",
        "task_execution_runs_current_attempt_id_task_execution_attempts_id_fk",
        "task_execution_runs_current_lease_id_task_execution_leases_id_fk",
        "task_execution_runs_cancellation_intent_id_task_execution_cancellation_intents_id_fk",
      ]),
    );
    const kind = checkSql(taskExecutionRuns, "task_execution_runs_kind_check");
    expect(kind).toContain("'productive'");
    expect(kind).toContain("'consult'");
    expect(kind).not.toContain("'compaction'");
    expect(taskExecutionRuns.targetAgentId.notNull).toBe(true);
    expect(taskExecutionRuns.executionMode.notNull).toBe(true);
  });

  it("owns immutable ordered membership and the closed settlement matrix", () => {
    const config = getTableConfig(taskExecutionRunRefs);
    const uniqueNames = config.uniqueConstraints.map((constraint) =>
      constraint.getName(),
    );
    const activeRef = config.indexes.find(
      (candidate) =>
        candidate.config.name === "task_execution_run_refs_active_ref_uq",
    );

    expect(config.name).toBe("task_execution_run_refs");
    expect(uniqueNames).toEqual(
      expect.arrayContaining([
        "task_execution_run_refs_run_ordinal_uq",
        "task_execution_run_refs_run_ref_uq",
        "task_execution_run_refs_run_ordinal_ref_uq",
      ]),
    );
    expect(activeRef?.config.unique).toBe(true);
    expect(
      config.columns.find((column) => column.name === "input_id")?.notNull,
    ).toBe(false);
    expect(
      activeRef?.config.columns.map(
        (column) => (column as { name: string }).name,
      ),
    ).toEqual(["company_id", "ref_id"]);
    expect(
      activeRef?.config.where
        ? dialect.sqlToQuery(activeRef.config.where).sql
        : null,
    ).toBe(
      '"task_execution_run_refs"."protocol_settlement_state" is null',
    );

    const matrix = checkSql(
      taskExecutionRunRefs,
      "task_execution_run_refs_settlement_matrix_check",
    );
    expect(matrix).toContain("= 'not_sent'");
    expect(matrix).toContain("= 'settled'");
    expect(matrix).toContain("= 'incomplete'");
    expect(matrix).toContain("= 'released_unsent'");
    expect(matrix).toContain("in ('failed', 'ambiguous', 'cancelled')");
    expect(matrix).toContain('"accounting_id" is not null');
    expect(matrix).toContain('"cost_event_id" is not null');
  });

  it("keeps the current-prompt control row to one run-ref pointer", () => {
    const config = getTableConfig(taskExecutionRunControls);

    expect(config.name).toBe("task_execution_run_controls");
    expect(columnNames(taskExecutionRunControls)).toEqual([
      "run_id",
      "current_ref_id",
      "current_ordinal",
    ]);
    expect(config.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      "task_execution_run_controls_current_member_fk",
    );
  });

  it("owns one exact same-target FIFO lane and leaves causal refs immutable", () => {
    const lane = getTableConfig(taskExecutionLanes);
    const refs = getTableConfig(taskExecutionRefs);

    expect(lane.name).toBe("task_execution_lanes");
    expect(columnNames(taskExecutionLanes)).toEqual([
      "company_id",
      "task_id",
      "ownership_epoch",
      "target_agent_id",
      "next_ordinal",
      "active_ordinal",
      "active_lease_generation",
      "active_lease_id",
      "created_at",
      "updated_at",
    ]);
    expect(
      lane.primaryKeys.flatMap((key) =>
        key.columns.map((column) => column.name),
      ),
    ).toEqual([
      "company_id",
      "task_id",
      "ownership_epoch",
      "target_agent_id",
    ]);
    expect(
      checkSql(taskExecutionLanes, "task_execution_lanes_active_lease_check"),
    ).toContain('"active_lease_generation" > 0');
    expect(
      checkSql(taskExecutionLanes, "task_execution_lanes_active_lease_check"),
    ).toContain('"active_lease_id" is not null');
    expect(
      checkSql(taskExecutionLanes, "task_execution_lanes_ordinal_check"),
    ).toContain("9007199254740991");
    expect(lane.indexes.map((index) => index.config.name)).toContain(
      "task_execution_lanes_active_lease_uq",
    );

    expect(columnNames(taskExecutionRefs)).toContain("lane_ordinal");
    expect(columnNames(taskExecutionRefs)).not.toEqual(
      expect.arrayContaining([
        "run_id",
        "lease_state",
        "lease_id",
        "lease_generation",
        "lease_owner",
        "leased_at",
        "lease_expires_at",
        "attempt_count",
        "retry_at",
        "terminal_at",
        "failure_reason",
      ]),
    );
    expect(refs.foreignKeys.map((key) => key.getName())).toContain(
      "task_execution_refs_lane_fk",
    );
    expect(refs.uniqueConstraints.map((key) => key.getName())).toContain(
      "task_execution_refs_lane_ordinal_uq",
    );
    const sourceKindShape = checkSql(
      taskExecutionRefs,
      "task_execution_refs_source_kind_check",
    );
    expect(
      [...sourceKindShape.matchAll(/'([^']+)'/g)].map((match) => match[1]),
    ).toEqual([
      "task_request",
      "task_reassignment",
      "mention_agent",
      "routine_dispatch",
      "task_update",
      "system_nudge",
    ]);
    const sourceShape = checkSql(
      taskExecutionRefs,
      "task_execution_refs_message_input_shape_check",
    );
    expect(sourceShape).toContain("= 'user'");
    expect(sourceShape).toContain("= 'synthetic'");
    expect(sourceShape).toContain('"input_id" is null');
    expect(sourceShape).toContain('"admitted_seq" is null');
    expect(sourceShape).toContain('"promoted_seq" is null');
    expect(sourceShape).toContain("9007199254740991");
    expect(
      checkSql(taskExecutionRefs, "task_execution_refs_lane_ordinal_check"),
    ).toContain("9007199254740991");
  });

  it("retains context-dial composition views without compaction checkpoints", () => {
    const viewColumns = columnNames(taskExecutionHistoryViews);
    expect(viewColumns).toEqual(
      expect.arrayContaining([
        "history_scope_kind",
        "history_scope_id",
        "composition_audience",
        "effective_dial_snapshot",
        "effective_dial_digest",
        "selected_record_ids",
        "lower_order_snapshot",
        "composition_preparation_id",
        "composition_bytes",
        "composition_hash",
      ]),
    );
    expect(viewColumns).not.toEqual(
      expect.arrayContaining([
        "compaction_settings_snapshot",
        "model_snapshot",
        "composition_checkpoint_control_id",
        "composition_tail_start_message_id",
        "active_execution_checkpoint_control_id",
        "active_execution_tail_start_message_id",
        "lowering_generation",
      ]),
    );
    const snapshot = checkSql(
      taskExecutionHistoryViews,
      "task_execution_history_views_snapshot_check",
    );
    expect(snapshot).toContain('"effective_dial_snapshot" is not null');
    expect(snapshot).toContain('"selected_record_ids" is not null');
    expect(snapshot).not.toContain("compaction_settings_snapshot");
    expect(snapshot).not.toContain("model_snapshot");

    const membership = checkSql(
      taskExecutionHistoryViewMessages,
      "task_execution_history_view_messages_kind_check",
    );
    expect(membership).toContain("'composition'");
    expect(membership).toContain("'source'");
    expect(membership).toContain("'execution'");
    expect(membership).not.toContain("checkpoint");
    expect(membership).not.toContain("retained-tail");
  });

  it("binds one typed attempt to one run-ref prompt", () => {
    const config = getTableConfig(taskExecutionAttempts);
    const names = config.foreignKeys.map((key) => key.getName());

    expect(config.name).toBe("task_execution_attempts");
    expect(columnNames(taskExecutionAttempts)).toEqual([
      "id",
      "company_id",
      "task_id",
      "session_id",
      "run_id",
      "run_kind",
      "session_operation",
      "ref_id",
      "ref_ordinal",
      "attempt_generation",
      "state",
      "started_at",
      "finished_at",
      "created_at",
    ]);
    const identity = checkSql(
      taskExecutionAttempts,
      "task_execution_attempts_prompt_identity_check",
    );
    expect(identity).not.toContain("= 'compaction'");
    expect(identity).toContain("in ('productive', 'consult')");
    expect(identity).toContain('"ref_ordinal" >= 0');
    expect(
      checkSql(
        taskExecutionAttempts,
        "task_execution_attempts_session_operation_check",
      ),
    ).not.toContain("'recovery_new'");
    expect(names).toEqual(
      expect.arrayContaining([
        "task_execution_attempts_run_fk",
        "task_execution_attempts_run_kind_fk",
        "task_execution_attempts_run_ref_fk",
      ]),
    );
    expect(config.indexes.filter((index) => index.config.unique)).toHaveLength(
      2,
    );
    const promptIdentity = config.indexes.find(
      (index) => index.config.name === "task_execution_attempts_prompt_uq",
    );
    expect(
      promptIdentity?.config.columns.map(
        (column) => (column as { name: string }).name,
      ),
    ).toContain("attempt_generation");
  });

  it("owns delayed pre-send retries outside the closed run envelope", () => {
    const config = getTableConfig(taskExecutionAttemptRetrySchedules);

    expect(config.name).toBe("task_execution_attempt_retry_schedules");
    expect(columnNames(taskExecutionAttemptRetrySchedules)).toEqual([
      "id",
      "company_id",
      "task_id",
      "run_id",
      "predecessor_attempt_id",
      "reason_code",
      "retry_at",
      "state",
      "successor_attempt_id",
      "claimed_at",
      "cancelled_at",
      "created_at",
    ]);
    expect(config.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "task_execution_attempt_retry_schedules_predecessor_fk",
        "task_execution_attempt_retry_schedules_successor_fk",
      ]),
    );
    expect(config.uniqueConstraints.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "task_execution_attempt_retry_schedules_predecessor_uq",
        "task_execution_attempt_retry_schedules_successor_uq",
      ]),
    );
    const stateShape = checkSql(
      taskExecutionAttemptRetrySchedules,
      "task_execution_attempt_retry_schedules_state_time_check",
    );
    expect(stateShape).toContain("= 'scheduled'");
    expect(stateShape).toContain("= 'claimed'");
    expect(stateShape).toContain("= 'cancelled'");
    expect(stateShape).toContain('"successor_attempt_id" is not null');
    expect(
      checkSql(
        taskExecutionAttemptRetrySchedules,
        "task_execution_attempt_retry_schedules_time_check",
      ),
    ).toContain('"retry_at" >= "task_execution_attempt_retry_schedules"."created_at"');
    expect(columnNames(taskExecutionRuns)).not.toContain("retry_at");
  });

  it("owns one lease for each prompt attempt", () => {
    const leases = getTableConfig(taskExecutionLeases);

    expect(leases.name).toBe("task_execution_leases");
    expect(leases.foreignKeys.map((key) => key.getName())).toContain(
      "task_execution_leases_attempt_fk",
    );
    expect(leases.uniqueConstraints.map((key) => key.getName())).toContain(
      "task_execution_leases_attempt_uq",
    );
  });

  it("owns cancellation only through the exact typed attempt", () => {
    const config = getTableConfig(taskExecutionCancellationIntents);
    const columns = columnNames(taskExecutionCancellationIntents);

    expect(config.name).toBe("task_execution_cancellation_intents");
    expect(columns).toEqual([
      "id",
      "company_id",
      "task_id",
      "run_id",
      "attempt_id",
      "lease_id",
      "reason_kind",
      "actor_kind",
      "actor_user_id",
      "actor_agent_id",
      "state",
      "requested_at",
      "acknowledged_at",
      "native_cancellation_settled_at",
      "completed_at",
      "failed_at",
      "failure_code",
      "created_at",
    ]);
    expect(columns).not.toEqual(
      expect.arrayContaining([
        "session_reset_id",
        "lifecycle_operation_id",
        "ref_id",
        "segment_ordinal",
        "compaction_control_id",
        "local_process_pid",
        "local_process_group_id",
        "dispatcher_lease_id",
      ]),
    );
    expect(config.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "task_execution_cancellation_intents_attempt_fk",
        "task_execution_cancellation_intents_lease_fk",
      ]),
    );
    expect(config.uniqueConstraints.map((key) => key.getName())).toContain(
      "task_execution_cancellation_intents_attempt_uq",
    );
    const reasons = checkSql(
      taskExecutionCancellationIntents,
      "task_execution_cancellation_intents_reason_check",
    );
    expect(reasons).toContain("'lifecycle'");
    expect(reasons).not.toContain("steering");
  });

  it("keeps liveness to the exact identity and five-field immutable fact", () => {
    expect(columnNames(taskExecutionRunLivenessFacts)).toEqual([
      "id",
      "company_id",
      "run_id",
      "liveness_state",
      "liveness_reason",
      "continuation_attempt",
      "last_useful_action_at",
      "next_action",
    ]);
    expect(
      getTableConfig(taskExecutionRunLivenessFacts).uniqueConstraints.map(
        (constraint) => constraint.getName(),
      ),
    ).toContain("task_execution_run_liveness_facts_run_uq");
  });

  it("keeps finalization reference-only and text-free", () => {
    const columns = columnNames(taskExecutionFinalizations);

    expect(getTableConfig(taskExecutionFinalizations).name).toBe(
      "task_execution_finalizations",
    );
    expect(columns).toEqual([
      "id",
      "company_id",
      "run_id",
      "finalization_identity_digest",
      "action",
      "terminal_session_event_id",
      "terminal_session_message_id",
      "progress_comment_id",
      "gateway_capability_connection_id",
      "gateway_capability_generation",
      "run_liveness_fact_id",
      "finalized_at",
      "created_at",
    ]);
    expect(columns).not.toEqual(
      expect.arrayContaining([
        "text",
        "body",
        "payload",
        "result",
        "result_json",
        "transcript",
        "context",
        "usage",
      ]),
    );
  });

  it("records one settled run-ref prompt per finalization dependency", () => {
    expect(columnNames(taskExecutionFinalizationPromptDependencies)).toEqual([
      "company_id",
      "task_id",
      "run_id",
      "finalization_id",
      "dependency_ordinal",
      "ref_id",
      "ref_ordinal",
      "protocol_settlement_state",
      "settlement_version",
      "accounting_id",
      "cost_event_id",
    ]);
    expect(
      getTableConfig(taskExecutionFinalizationPromptDependencies)
        .uniqueConstraints.map((constraint) => constraint.getName()),
    ).toContain(
      "task_execution_finalization_prompt_dependencies_prompt_uq",
    );
  });
});
