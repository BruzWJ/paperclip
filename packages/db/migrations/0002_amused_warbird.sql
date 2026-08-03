UPDATE "issue_execution_attempts"
SET "session_operation" = 'new'
WHERE "session_operation" = 'recovery_new';--> statement-breakpoint
DELETE FROM "issue_execution_history_view_messages"
WHERE "membership_kind" IN (
  'checkpoint-request',
  'checkpoint-summary',
  'retained-tail',
  'post-checkpoint-input'
);--> statement-breakpoint
DELETE FROM "issue_session_recovery_selection_members";--> statement-breakpoint
DELETE FROM "issue_session_recovery_selections";--> statement-breakpoint
DELETE FROM "issue_session_productive_turn_settlements";--> statement-breakpoint
DELETE FROM "issue_session_assistant_sources";--> statement-breakpoint
DELETE FROM "issue_session_completed_tool_sources";--> statement-breakpoint
DELETE FROM "issue_session_error_tool_sources";--> statement-breakpoint
UPDATE "issue_execution_runs"
SET
  "status" = 'queued',
  "current_attempt_id" = NULL,
  "current_lease_id" = NULL,
  "cancellation_intent_id" = NULL,
  "terminal_finalization_id" = NULL,
  "finished_at" = NULL,
  "terminal_classification" = NULL,
  "terminal_reason_code" = NULL,
  "process_exit_code" = NULL,
  "process_signal" = NULL
WHERE "kind" = 'compaction';--> statement-breakpoint
DELETE FROM "issue_execution_finalization_prompt_dependencies"
WHERE "prompt_kind" = 'compaction'
  OR "compaction_control_id" IS NOT NULL
  OR "run_id" IN (
    SELECT "id" FROM "issue_execution_runs" WHERE "kind" = 'compaction'
  );--> statement-breakpoint
DELETE FROM "issue_execution_finalizations"
WHERE "run_id" IN (
  SELECT "id" FROM "issue_execution_runs" WHERE "kind" = 'compaction'
);--> statement-breakpoint
DELETE FROM "acp_prompt_accounting"
WHERE "prompt_kind" = 'compaction'
  OR "run_kind" = 'compaction'
  OR "run_id" IN (
    SELECT "id" FROM "issue_execution_runs" WHERE "kind" = 'compaction'
  );--> statement-breakpoint
DELETE FROM "cost_events"
WHERE "prompt_kind" = 'compaction'
  OR "run_kind" = 'compaction'
  OR "run_id" IN (
    SELECT "id" FROM "issue_execution_runs" WHERE "kind" = 'compaction'
  );--> statement-breakpoint
DELETE FROM "issue_session_compaction_controls";--> statement-breakpoint
DELETE FROM "issue_session_events"
WHERE "type" IN (
  'session.next.compaction.started.1',
  'session.next.compaction.ended.1'
)
OR "run_id" IN (
  SELECT "id" FROM "issue_execution_runs" WHERE "kind" = 'compaction'
);--> statement-breakpoint
DELETE FROM "issue_session_messages"
WHERE "type" = 'compaction'
OR "run_id" IN (
  SELECT "id" FROM "issue_execution_runs" WHERE "kind" = 'compaction'
);--> statement-breakpoint
UPDATE "activity_log"
SET "run_id" = NULL
WHERE "run_id" IN (
  SELECT "id" FROM "issue_execution_runs" WHERE "kind" = 'compaction'
);--> statement-breakpoint
UPDATE "agent_runtime_state"
SET "last_run_id" = NULL, "last_run_status" = NULL
WHERE "last_run_id" IN (
  SELECT "id" FROM "issue_execution_runs" WHERE "kind" = 'compaction'
);--> statement-breakpoint
DELETE FROM "issue_execution_runs" WHERE "kind" = 'compaction';--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" DROP CONSTRAINT "acp_prompt_accounting_compaction_attempt_fk";--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" DROP CONSTRAINT "acp_prompt_accounting_compaction_prompt_fk";--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT "cost_events_compaction_accounting_fk";--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" DROP CONSTRAINT "issue_execution_attempts_compaction_control_fk";--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_prompt_dependencies" DROP CONSTRAINT "issue_execution_finalization_prompt_dependencies_compaction_fk";--> statement-breakpoint
ALTER TABLE "issue_session_assistant_sources" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_session_compaction_controls" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_session_completed_tool_sources" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_session_error_tool_sources" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_session_productive_turn_settlements" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_session_recovery_selection_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_session_recovery_selections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "issue_session_recovery_selection_members";--> statement-breakpoint
DROP TABLE "issue_session_recovery_selections";--> statement-breakpoint
DROP TABLE "issue_session_productive_turn_settlements";--> statement-breakpoint
DROP TABLE "issue_session_assistant_sources";--> statement-breakpoint
DROP TABLE "issue_session_completed_tool_sources";--> statement-breakpoint
DROP TABLE "issue_session_error_tool_sources";--> statement-breakpoint
DROP TABLE "issue_session_compaction_controls";--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" DROP CONSTRAINT "acp_prompt_accounting_compaction_cost_attribution_uq";--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" DROP CONSTRAINT "acp_prompt_accounting_compaction_settlement_owner_uq";--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT "cost_events_compaction_settlement_owner_uq";--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" DROP CONSTRAINT "issue_execution_attempts_accounting_compaction_uq";--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" DROP CONSTRAINT "acp_prompt_accounting_prompt_identity_check";--> statement-breakpoint
ALTER TABLE "companies" DROP CONSTRAINT "companies_session_compaction_check";--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT "cost_events_compaction_cursor_check";--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT "cost_events_prompt_identity_check";--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" DROP CONSTRAINT "issue_execution_attempts_prompt_kind_check";--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" DROP CONSTRAINT "issue_execution_attempts_session_operation_check";--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" DROP CONSTRAINT "issue_execution_attempts_prompt_identity_check";--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_prompt_dependencies" DROP CONSTRAINT "issue_execution_finalization_prompt_dependencies_identity_check";--> statement-breakpoint
ALTER TABLE "issue_execution_history_view_messages" DROP CONSTRAINT "issue_execution_history_view_messages_kind_check";--> statement-breakpoint
ALTER TABLE "issue_execution_history_views" DROP CONSTRAINT "issue_execution_history_views_live_checkpoint_check";--> statement-breakpoint
ALTER TABLE "issue_execution_history_views" DROP CONSTRAINT "issue_execution_history_views_snapshot_check";--> statement-breakpoint
ALTER TABLE "issue_execution_runs" DROP CONSTRAINT "issue_execution_runs_compaction_scope_kind_check";--> statement-breakpoint
ALTER TABLE "issue_execution_runs" DROP CONSTRAINT "issue_execution_runs_kind_check";--> statement-breakpoint
ALTER TABLE "issue_execution_runs" DROP CONSTRAINT "issue_execution_runs_mode_check";--> statement-breakpoint
ALTER TABLE "issue_execution_runs" DROP CONSTRAINT "issue_execution_runs_kind_shape_check";--> statement-breakpoint
ALTER TABLE "issue_session_events" DROP CONSTRAINT "issue_session_events_type_check";--> statement-breakpoint
ALTER TABLE "issue_session_messages" DROP CONSTRAINT "issue_session_messages_type_check";--> statement-breakpoint
ALTER TABLE "issue_execution_runs" DROP CONSTRAINT "issue_execution_runs_trigger_fk";
--> statement-breakpoint
DROP INDEX "acp_prompt_accounting_compaction_prompt_uq";--> statement-breakpoint
DROP INDEX "issue_execution_attempts_compaction_prompt_uq";--> statement-breakpoint
DROP INDEX "issue_execution_finalization_prompt_dependencies_compaction_uq";--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ALTER COLUMN "target_agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ALTER COLUMN "execution_mode" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" DROP COLUMN "compaction_control_id";--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "session_compaction";--> statement-breakpoint
ALTER TABLE "cost_events" DROP COLUMN "compaction_control_id";--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" DROP COLUMN "compaction_control_id";--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_prompt_dependencies" DROP COLUMN "compaction_control_id";--> statement-breakpoint
ALTER TABLE "issue_execution_history_views" DROP COLUMN "compaction_settings_snapshot";--> statement-breakpoint
ALTER TABLE "issue_execution_history_views" DROP COLUMN "model_snapshot";--> statement-breakpoint
ALTER TABLE "issue_execution_history_views" DROP COLUMN "composition_checkpoint_control_id";--> statement-breakpoint
ALTER TABLE "issue_execution_history_views" DROP COLUMN "composition_tail_start_message_id";--> statement-breakpoint
ALTER TABLE "issue_execution_history_views" DROP COLUMN "active_execution_checkpoint_control_id";--> statement-breakpoint
ALTER TABLE "issue_execution_history_views" DROP COLUMN "active_execution_tail_start_message_id";--> statement-breakpoint
ALTER TABLE "issue_execution_history_views" DROP COLUMN "lowering_generation";--> statement-breakpoint
ALTER TABLE "issue_execution_runs" DROP COLUMN "compaction_scope_kind";--> statement-breakpoint
ALTER TABLE "issue_execution_runs" DROP COLUMN "triggered_by_run_id";--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_prompt_identity_check" CHECK ((
        "acp_prompt_accounting"."prompt_kind" = 'base'
        and "acp_prompt_accounting"."run_kind" in ('productive', 'consult')
        and "acp_prompt_accounting"."ref_id" is not null
        and "acp_prompt_accounting"."run_ordinal" is not null
        and "acp_prompt_accounting"."run_ordinal" >= 0
        and "acp_prompt_accounting"."segment_ordinal" is not null
        and "acp_prompt_accounting"."segment_ordinal" = 0
      ) or (
        "acp_prompt_accounting"."prompt_kind" = 'steering'
        and "acp_prompt_accounting"."run_kind" in ('productive', 'consult')
        and "acp_prompt_accounting"."ref_id" is not null
        and "acp_prompt_accounting"."run_ordinal" is not null
        and "acp_prompt_accounting"."run_ordinal" >= 0
        and "acp_prompt_accounting"."segment_ordinal" is not null
        and "acp_prompt_accounting"."segment_ordinal" > 0
      ));--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_prompt_identity_check" CHECK ((
        "cost_events"."prompt_kind" = 'base'
        and "cost_events"."run_kind" in ('productive', 'consult')
        and "cost_events"."ref_id" is not null
        and "cost_events"."run_ordinal" is not null
        and "cost_events"."run_ordinal" >= 0
        and "cost_events"."segment_ordinal" is not null
        and "cost_events"."segment_ordinal" = 0
      ) or (
        "cost_events"."prompt_kind" = 'steering'
        and "cost_events"."run_kind" in ('productive', 'consult')
        and "cost_events"."ref_id" is not null
        and "cost_events"."run_ordinal" is not null
        and "cost_events"."run_ordinal" >= 0
        and "cost_events"."segment_ordinal" is not null
        and "cost_events"."segment_ordinal" > 0
      ));--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" ADD CONSTRAINT "issue_execution_attempts_prompt_kind_check" CHECK ("issue_execution_attempts"."prompt_kind" in ('base', 'steering'));--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" ADD CONSTRAINT "issue_execution_attempts_session_operation_check" CHECK ("issue_execution_attempts"."session_operation" in (
        'new',
        'resume',
        'steer_resume'
      )
      and (
        "issue_execution_attempts"."prompt_kind" <> 'base'
        or "issue_execution_attempts"."session_operation" <> 'steer_resume'
      ));--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" ADD CONSTRAINT "issue_execution_attempts_prompt_identity_check" CHECK ((
        "issue_execution_attempts"."prompt_kind" = 'base'
        and "issue_execution_attempts"."run_kind" in ('productive', 'consult')
        and "issue_execution_attempts"."ref_id" is not null
        and "issue_execution_attempts"."ref_ordinal" is not null
        and "issue_execution_attempts"."ref_ordinal" >= 0
        and "issue_execution_attempts"."segment_ordinal" is not null
        and "issue_execution_attempts"."segment_ordinal" = 0
        and "issue_execution_attempts"."steering_segment_ordinal" is null
      ) or (
        "issue_execution_attempts"."prompt_kind" = 'steering'
        and "issue_execution_attempts"."run_kind" in ('productive', 'consult')
        and "issue_execution_attempts"."ref_id" is not null
        and "issue_execution_attempts"."ref_ordinal" is not null
        and "issue_execution_attempts"."ref_ordinal" >= 0
        and "issue_execution_attempts"."segment_ordinal" is not null
        and "issue_execution_attempts"."segment_ordinal" > 0
        and "issue_execution_attempts"."steering_segment_ordinal" = "issue_execution_attempts"."segment_ordinal"
      ));--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_prompt_dependencies" ADD CONSTRAINT "issue_execution_finalization_prompt_dependencies_identity_check" CHECK ((
        "issue_execution_finalization_prompt_dependencies"."prompt_kind" = 'base'
        and "issue_execution_finalization_prompt_dependencies"."ref_id" is not null
        and "issue_execution_finalization_prompt_dependencies"."ref_ordinal" is not null
        and "issue_execution_finalization_prompt_dependencies"."ref_ordinal" >= 0
        and "issue_execution_finalization_prompt_dependencies"."segment_ordinal" = 0
      ) or (
        "issue_execution_finalization_prompt_dependencies"."prompt_kind" = 'steering'
        and "issue_execution_finalization_prompt_dependencies"."ref_id" is not null
        and "issue_execution_finalization_prompt_dependencies"."ref_ordinal" is not null
        and "issue_execution_finalization_prompt_dependencies"."ref_ordinal" >= 0
        and "issue_execution_finalization_prompt_dependencies"."segment_ordinal" is not null
        and "issue_execution_finalization_prompt_dependencies"."segment_ordinal" > 0
      ));--> statement-breakpoint
ALTER TABLE "issue_execution_history_view_messages" ADD CONSTRAINT "issue_execution_history_view_messages_kind_check" CHECK ("issue_execution_history_view_messages"."membership_kind" in (
        'composition',
        'source',
        'execution'
      ));--> statement-breakpoint
ALTER TABLE "issue_execution_history_views" ADD CONSTRAINT "issue_execution_history_views_snapshot_check" CHECK ((
        "issue_execution_history_views"."state" <> 'current'
      ) or (
        "issue_execution_history_views"."effective_dial_snapshot" is not null
        and "issue_execution_history_views"."effective_dial_digest" is not null
        and "issue_execution_history_views"."selected_record_ids" is not null
        and "issue_execution_history_views"."lower_order_snapshot" is not null
      ));--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_kind_check" CHECK ("issue_execution_runs"."kind" in ('productive', 'consult'));--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_mode_check" CHECK ("issue_execution_runs"."execution_mode" in ('owner', 'consult'));--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_kind_shape_check" CHECK ((
        "issue_execution_runs"."kind" = 'productive'
        and "issue_execution_runs"."target_agent_id" is not null
        and "issue_execution_runs"."execution_mode" = 'owner'
        and "issue_execution_runs"."issue_execution_authority_id" is not null
        and "issue_execution_runs"."consult_execution_id" is null
        and "issue_execution_runs"."parent_run_id" is null
      ) or (
        "issue_execution_runs"."kind" = 'consult'
        and "issue_execution_runs"."target_agent_id" is not null
        and "issue_execution_runs"."execution_mode" = 'consult'
        and "issue_execution_runs"."issue_execution_authority_id" is null
        and "issue_execution_runs"."consult_execution_id" is not null
        and "issue_execution_runs"."parent_run_id" is not null
      ));--> statement-breakpoint
ALTER TABLE "issue_session_events" ADD CONSTRAINT "issue_session_events_type_check" CHECK ("issue_session_events"."type" in (
        'session.next.agent.switched.1',
        'session.next.model.switched.1',
        'session.next.moved.1',
        'session.next.prompted.1',
        'session.next.prompt.admitted.1',
        'session.next.context.updated.1',
        'session.next.synthetic.1',
        'session.next.shell.started.1',
        'session.next.shell.ended.1',
        'session.next.step.started.1',
        'session.next.step.ended.3',
        'session.next.step.failed.2',
        'session.next.text.started.1',
        'session.next.text.ended.1',
        'session.next.reasoning.started.1',
        'session.next.reasoning.ended.1',
        'session.next.tool.input.started.1',
        'session.next.tool.input.ended.1',
        'session.next.tool.called.1',
        'session.next.tool.progress.1',
        'session.next.tool.success.1',
        'session.next.tool.failed.1',
        'session.next.retried.1',
        'session.next.revert.staged.1',
        'session.next.revert.cleared.1',
        'session.next.revert.committed.1'
      ));--> statement-breakpoint
ALTER TABLE "issue_session_messages" ADD CONSTRAINT "issue_session_messages_type_check" CHECK ("issue_session_messages"."type" in (
        'agent-switched',
        'model-switched',
        'user',
        'synthetic',
        'system',
        'shell',
        'assistant'
      ));
