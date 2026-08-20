DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "cost_events"
    WHERE "prompt_kind" = 'steering'
  ) OR EXISTS (
    SELECT 1
    FROM "acp_prompt_accounting"
    WHERE "prompt_kind" = 'steering'
  ) THEN
    RAISE EXCEPTION 'cannot retire active-run steering while historical steering cost/accounting rows exist; export or migrate those rows, then remove them explicitly before retrying'
      USING ERRCODE = '55000';
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "task_execution_runs" AS "run"
    WHERE
      "run"."status" IN ('queued', 'scheduled_retry', 'running')
      AND (
        EXISTS (
          SELECT 1
          FROM "task_execution_prompt_segments" AS "segment"
          WHERE "segment"."run_id" = "run"."id"
        )
        OR EXISTS (
          SELECT 1
          FROM "task_execution_attempts" AS "attempt"
          WHERE
            "attempt"."run_id" = "run"."id"
            AND "attempt"."prompt_kind" = 'steering'
        )
        OR EXISTS (
          SELECT 1
          FROM "task_execution_sessions" AS "correlation"
          WHERE
            "correlation"."run_id" = "run"."id"
            AND "correlation"."purpose" = 'active_run_steering'
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM "task_execution_attempts"
    WHERE
      "prompt_kind" = 'steering'
      AND "state" IN ('pending', 'leased', 'running')
  ) OR EXISTS (
    SELECT 1
    FROM "task_execution_prompt_segments"
    WHERE "protocol_settlement_state" IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM "task_execution_sessions"
    WHERE
      "purpose" = 'active_run_steering'
      AND "state" = 'current'
  ) OR EXISTS (
    SELECT 1
    FROM "task_execution_prompt_capabilities"
    WHERE
      "segment_ordinal" > 0
      AND "state" IN ('pending_setup', 'active')
  ) OR EXISTS (
    SELECT 1
    FROM "task_execution_cancellation_intents"
    WHERE
      "reason_kind" = 'steering'
      AND "state" IN ('requested', 'acknowledged')
  ) OR EXISTS (
    SELECT 1
    FROM "task_session_inputs"
    WHERE
      "delivery" = 'steer'
      AND "promoted_seq" IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot retire active-run steering while steering work is active'
      USING ERRCODE = '55000';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "task_board_reopen_commands" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_creator_withdrawal_commands" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_segments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "task_board_reopen_commands" CASCADE;--> statement-breakpoint
DROP TABLE "task_creator_withdrawal_commands" CASCADE;--> statement-breakpoint
UPDATE "task_comment_projection_sources"
SET
  "steering_target_run_id" = NULL,
  "ref_id" = NULL,
  "ref_ordinal" = NULL,
  "segment_ordinal" = NULL
WHERE "steering_target_run_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "task_execution_finalization_prompt_dependencies"
WHERE "prompt_kind" = 'steering';--> statement-breakpoint
DELETE FROM "task_execution_prompt_capabilities" AS "capability"
WHERE
  "capability"."segment_ordinal" > 0
  OR "capability"."target_session_correlation_id" IN (
    SELECT "correlation"."id"
    FROM "task_execution_sessions" AS "correlation"
    WHERE "correlation"."purpose" = 'active_run_steering'
  );--> statement-breakpoint
UPDATE "task_execution_runs" AS "run"
SET "cancellation_intent_id" = NULL
WHERE "run"."cancellation_intent_id" IN (
  SELECT "intent"."id"
  FROM "task_execution_cancellation_intents" AS "intent"
  WHERE "intent"."reason_kind" = 'steering'
);--> statement-breakpoint
UPDATE "task_execution_run_controls"
SET
  "current_ref_id" = NULL,
  "current_ordinal" = NULL,
  "current_segment_ordinal" = NULL
WHERE "current_segment_ordinal" > 0;--> statement-breakpoint
UPDATE "task_execution_prompt_segments"
SET
  "attempt_id" = NULL,
  "capability_connection_id" = NULL,
  "capability_generation" = NULL,
  "cancellation_intent_id" = NULL;--> statement-breakpoint
DELETE FROM "task_execution_cancellation_intents"
WHERE "reason_kind" = 'steering';--> statement-breakpoint
DELETE FROM "task_execution_prompt_segments";--> statement-breakpoint
DELETE FROM "task_execution_attempts"
WHERE "prompt_kind" = 'steering';--> statement-breakpoint
DELETE FROM "task_execution_sessions"
WHERE "purpose" = 'active_run_steering';--> statement-breakpoint
DELETE FROM "task_session_inputs" AS "input"
WHERE
  "input"."delivery" = 'steer'
  AND NOT EXISTS (
    SELECT 1
    FROM "task_execution_refs" AS "ref"
    WHERE
      "ref"."company_id" = "input"."company_id"
      AND "ref"."task_id" = "input"."task_id"
      AND "ref"."session_id" = "input"."session_id"
      AND "ref"."input_id" = "input"."id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "task_execution_run_refs" AS "member"
    WHERE
      "member"."company_id" = "input"."company_id"
      AND "member"."task_id" = "input"."task_id"
      AND "member"."session_id" = "input"."session_id"
      AND "member"."input_id" = "input"."id"
  );--> statement-breakpoint
UPDATE "task_session_events"
SET "data" = "data" - 'delivery'
WHERE
  "type" = 'session.next.prompted.1'
  AND "data" ? 'delivery';--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" DROP CONSTRAINT "acp_prompt_accounting_productive_cost_attribution_uq";--> statement-breakpoint
ALTER TABLE "task_execution_attempts" DROP CONSTRAINT "task_execution_attempts_accounting_productive_uq";--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" DROP CONSTRAINT "acp_prompt_accounting_prompt_identity_check";--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT "cost_events_prompt_identity_check";--> statement-breakpoint
ALTER TABLE "task_comment_projection_sources" DROP CONSTRAINT "task_comment_projection_sources_steering_segment_shape_check";--> statement-breakpoint
ALTER TABLE "task_execution_attempts" DROP CONSTRAINT "task_execution_attempts_prompt_kind_check";--> statement-breakpoint
ALTER TABLE "task_execution_attempts" DROP CONSTRAINT "task_execution_attempts_session_operation_check";--> statement-breakpoint
ALTER TABLE "task_execution_attempts" DROP CONSTRAINT "task_execution_attempts_prompt_identity_check";--> statement-breakpoint
ALTER TABLE "task_execution_cancellation_intents" DROP CONSTRAINT "task_execution_cancellation_intents_reason_check";--> statement-breakpoint
ALTER TABLE "task_execution_finalization_prompt_dependencies" DROP CONSTRAINT "task_execution_finalization_prompt_dependencies_identity_check";--> statement-breakpoint
ALTER TABLE "task_execution_prompt_capabilities" DROP CONSTRAINT "task_execution_prompt_capabilities_identity_check";--> statement-breakpoint
ALTER TABLE "task_execution_refs" DROP CONSTRAINT "task_execution_refs_source_kind_check";--> statement-breakpoint
ALTER TABLE "task_execution_run_controls" DROP CONSTRAINT "task_execution_run_controls_current_prompt_shape_check";--> statement-breakpoint
ALTER TABLE "task_execution_sessions" DROP CONSTRAINT "task_execution_sessions_purpose_shape_check";--> statement-breakpoint
ALTER TABLE "task_execution_sessions" DROP CONSTRAINT "task_execution_sessions_supersession_check";--> statement-breakpoint
ALTER TABLE "task_execution_sessions" DROP CONSTRAINT "task_execution_sessions_digest_check";--> statement-breakpoint
ALTER TABLE "task_execution_sessions" DROP CONSTRAINT "task_execution_sessions_last_settled_prompt_check";--> statement-breakpoint
ALTER TABLE "task_session_inputs" DROP CONSTRAINT "task_session_inputs_delivery_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_owner_shape_check";--> statement-breakpoint
UPDATE "task_session_events"
SET "source_kind" = 'task_update'
WHERE "source_kind" = 'task_reopen';--> statement-breakpoint
UPDATE "task_execution_history_views"
SET
  "state" = 'invalidated',
  "invalidation_reason" = 'retired_task_reopen',
  "invalidated_at" = now(),
  "updated_at" = now()
WHERE
  "ref_id" IN (
    SELECT "ref"."id"
    FROM "task_execution_refs" AS "ref"
    WHERE
      "ref"."source_kind" = 'task_reopen'
      AND "ref"."disposition" = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM "task_execution_run_refs" AS "member"
        INNER JOIN "task_execution_runs" AS "run"
          ON "run"."id" = "member"."run_id"
          AND "run"."company_id" = "member"."company_id"
          AND "run"."task_id" = "member"."task_id"
        WHERE
          "member"."ref_id" = "ref"."id"
          AND "run"."status" IN ('queued', 'running', 'scheduled_retry')
      )
  )
  AND "state" IN ('empty', 'preparing', 'current');--> statement-breakpoint
UPDATE "task_session_input_dispositions"
SET
  "state" = 'invalidated',
  "invalidation_reason" = 'retired_task_reopen',
  "invalidated_at" = now(),
  "invalidated_by_source_kind" = 'task_execution_authority_revocation',
  "invalidated_by_source_id" = 'retired_task_reopen'
WHERE
  "source_ref_id" IN (
    SELECT "ref"."id"
    FROM "task_execution_refs" AS "ref"
    WHERE
      "ref"."source_kind" = 'task_reopen'
      AND "ref"."disposition" = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM "task_execution_run_refs" AS "member"
        INNER JOIN "task_execution_runs" AS "run"
          ON "run"."id" = "member"."run_id"
          AND "run"."company_id" = "member"."company_id"
          AND "run"."task_id" = "member"."task_id"
        WHERE
          "member"."ref_id" = "ref"."id"
          AND "run"."status" IN ('queued', 'running', 'scheduled_retry')
      )
  )
  AND "state" = 'active';--> statement-breakpoint
UPDATE "task_execution_refs" AS "ref"
SET
  "disposition" = 'invalidated',
  "invalidation_reason" = COALESCE("invalidation_reason", 'retired_task_reopen'),
  "updated_at" = now()
WHERE
  "ref"."source_kind" = 'task_reopen'
  AND "ref"."disposition" = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM "task_execution_run_refs" AS "member"
    INNER JOIN "task_execution_runs" AS "run"
      ON "run"."id" = "member"."run_id"
      AND "run"."company_id" = "member"."company_id"
      AND "run"."task_id" = "member"."task_id"
    WHERE
      "member"."ref_id" = "ref"."id"
      AND "run"."status" IN ('queued', 'running', 'scheduled_retry')
  );--> statement-breakpoint
UPDATE "task_execution_refs"
SET "source_kind" = 'task_update'
WHERE "source_kind" = 'task_reopen';--> statement-breakpoint
UPDATE "tasks"
SET
  "owner_kind" = 'board',
  "owner_user_id" = NULL
WHERE "owner_assignment_source" = 'user_creator_withdrawal';--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" DROP CONSTRAINT "acp_prompt_accounting_productive_attempt_fk";
--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT "cost_events_productive_accounting_fk";
--> statement-breakpoint
ALTER TABLE "task_comment_projection_sources" DROP CONSTRAINT "task_comment_projection_sources_steering_segment_fk";
--> statement-breakpoint
ALTER TABLE "task_execution_attempts" DROP CONSTRAINT "task_execution_attempts_base_member_fk";
--> statement-breakpoint
ALTER TABLE "task_execution_attempts" DROP CONSTRAINT "task_execution_attempts_steering_segment_fk";
--> statement-breakpoint
ALTER TABLE "task_execution_sessions" DROP CONSTRAINT "task_execution_sessions_steering_target_scope_fk";
--> statement-breakpoint
ALTER TABLE "task_execution_sessions" DROP CONSTRAINT "task_execution_sessions_current_run_ref_fk";
--> statement-breakpoint
DROP TABLE "task_execution_prompt_segments";--> statement-breakpoint
DROP INDEX "acp_prompt_accounting_productive_prompt_uq";--> statement-breakpoint
DROP INDEX "task_execution_attempts_base_prompt_uq";--> statement-breakpoint
DROP INDEX "task_execution_attempts_steering_prompt_uq";--> statement-breakpoint
DROP INDEX "task_execution_finalization_prompt_dependencies_base_uq";--> statement-breakpoint
DROP INDEX "task_execution_finalization_prompt_dependencies_steering_uq";--> statement-breakpoint
DROP INDEX "task_execution_sessions_current_carry_uq";--> statement-breakpoint
DROP INDEX "task_execution_sessions_current_steering_uq";--> statement-breakpoint
DROP INDEX "task_execution_sessions_carry_generation_uq";--> statement-breakpoint
DROP INDEX "task_execution_sessions_steering_generation_uq";--> statement-breakpoint
DROP INDEX "task_session_inputs_pending_delivery_idx";--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ALTER COLUMN "lane_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ALTER COLUMN "authorized_context_exposure_digest" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_execution_attempts" ADD CONSTRAINT "task_execution_attempts_accounting_productive_uq" UNIQUE("company_id","task_id","run_id","id","run_kind","ref_ordinal","ref_id");--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_cost_attribution_uq" UNIQUE("company_id","task_id","agent_id","run_id","run_kind","ref_id","run_ordinal","id");--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_attempt_fk" FOREIGN KEY ("company_id","task_id","run_id","attempt_id","run_kind","run_ordinal","ref_id") REFERENCES "public"."task_execution_attempts"("company_id","task_id","run_id","id","run_kind","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_accounting_scope_fk" FOREIGN KEY ("company_id","task_id","agent_id","run_id","run_kind","ref_id","run_ordinal","accounting_id") REFERENCES "public"."acp_prompt_accounting"("company_id","task_id","agent_id","run_id","run_kind","ref_id","run_ordinal","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_attempts" ADD CONSTRAINT "task_execution_attempts_run_ref_fk" FOREIGN KEY ("company_id","task_id","session_id","run_id","ref_ordinal","ref_id") REFERENCES "public"."task_execution_run_refs"("company_id","task_id","session_id","run_id","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_attempts_prompt_uq" ON "task_execution_attempts" USING btree ("run_id","ref_ordinal","ref_id","attempt_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_sessions_eligible_uq" ON "task_execution_sessions" USING btree ("company_id","task_id","ownership_epoch","target_agent_id","adapter_config_identity","workspace_identity","lane_kind") WHERE "task_execution_sessions"."state" = 'eligible';--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_sessions_generation_uq" ON "task_execution_sessions" USING btree ("company_id","task_id","ownership_epoch","target_agent_id","adapter_config_identity","workspace_identity","lane_kind","correlation_generation");--> statement-breakpoint
CREATE INDEX "task_session_inputs_pending_idx" ON "task_session_inputs" USING btree ("session_id","promoted_seq","admitted_seq");--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" DROP COLUMN "prompt_kind";--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" DROP COLUMN "segment_ordinal";--> statement-breakpoint
ALTER TABLE "cost_events" DROP COLUMN "prompt_kind";--> statement-breakpoint
ALTER TABLE "cost_events" DROP COLUMN "segment_ordinal";--> statement-breakpoint
ALTER TABLE "task_comment_projection_sources" DROP COLUMN "steering_target_run_id";--> statement-breakpoint
ALTER TABLE "task_comment_projection_sources" DROP COLUMN "ref_id";--> statement-breakpoint
ALTER TABLE "task_comment_projection_sources" DROP COLUMN "ref_ordinal";--> statement-breakpoint
ALTER TABLE "task_comment_projection_sources" DROP COLUMN "segment_ordinal";--> statement-breakpoint
ALTER TABLE "task_execution_attempts" DROP COLUMN "prompt_kind";--> statement-breakpoint
ALTER TABLE "task_execution_attempts" DROP COLUMN "segment_ordinal";--> statement-breakpoint
ALTER TABLE "task_execution_attempts" DROP COLUMN "steering_segment_ordinal";--> statement-breakpoint
ALTER TABLE "task_execution_finalization_prompt_dependencies" DROP COLUMN "prompt_kind";--> statement-breakpoint
ALTER TABLE "task_execution_finalization_prompt_dependencies" DROP COLUMN "segment_ordinal";--> statement-breakpoint
ALTER TABLE "task_execution_prompt_capabilities" DROP COLUMN "segment_ordinal";--> statement-breakpoint
ALTER TABLE "task_execution_run_controls" DROP COLUMN "current_segment_ordinal";--> statement-breakpoint
ALTER TABLE "task_execution_sessions" DROP COLUMN "purpose";--> statement-breakpoint
ALTER TABLE "task_execution_sessions" DROP COLUMN "run_id";--> statement-breakpoint
ALTER TABLE "task_execution_sessions" DROP COLUMN "current_ref_id";--> statement-breakpoint
ALTER TABLE "task_execution_sessions" DROP COLUMN "current_ref_ordinal";--> statement-breakpoint
ALTER TABLE "task_execution_sessions" DROP COLUMN "current_segment_ordinal";--> statement-breakpoint
ALTER TABLE "task_execution_sessions" DROP COLUMN "last_protocol_settled_segment_ordinal";--> statement-breakpoint
ALTER TABLE "task_session_inputs" DROP COLUMN "delivery";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "owner_assignment_source";--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_prompt_uq" UNIQUE("run_id","ref_id","run_ordinal");--> statement-breakpoint
ALTER TABLE "task_execution_finalization_prompt_dependencies" ADD CONSTRAINT "task_execution_finalization_prompt_dependencies_prompt_uq" UNIQUE("finalization_id","ref_id");--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_prompt_identity_check" CHECK ("acp_prompt_accounting"."run_kind" in ('productive', 'consult')
        and "acp_prompt_accounting"."ref_id" is not null
        and "acp_prompt_accounting"."run_ordinal" is not null
        and "acp_prompt_accounting"."run_ordinal" >= 0);--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_prompt_identity_check" CHECK ("cost_events"."run_kind" in ('productive', 'consult')
        and "cost_events"."ref_id" is not null
        and "cost_events"."run_ordinal" is not null
        and "cost_events"."run_ordinal" >= 0);--> statement-breakpoint
ALTER TABLE "task_execution_attempts" ADD CONSTRAINT "task_execution_attempts_session_operation_check" CHECK ("task_execution_attempts"."session_operation" in ('new', 'resume'));--> statement-breakpoint
ALTER TABLE "task_execution_attempts" ADD CONSTRAINT "task_execution_attempts_prompt_identity_check" CHECK ("task_execution_attempts"."run_kind" in ('productive', 'consult')
        and "task_execution_attempts"."ref_id" is not null
        and "task_execution_attempts"."ref_ordinal" is not null
        and "task_execution_attempts"."ref_ordinal" >= 0);--> statement-breakpoint
ALTER TABLE "task_execution_cancellation_intents" ADD CONSTRAINT "task_execution_cancellation_intents_reason_check" CHECK ("task_execution_cancellation_intents"."reason_kind" in (
        'lifecycle',
        'authority',
        'timeout',
        'lease_expired'
      ));--> statement-breakpoint
ALTER TABLE "task_execution_finalization_prompt_dependencies" ADD CONSTRAINT "task_execution_finalization_prompt_dependencies_identity_check" CHECK ("task_execution_finalization_prompt_dependencies"."ref_id" is not null
        and "task_execution_finalization_prompt_dependencies"."ref_ordinal" is not null
        and "task_execution_finalization_prompt_dependencies"."ref_ordinal" >= 0);--> statement-breakpoint
ALTER TABLE "task_execution_prompt_capabilities" ADD CONSTRAINT "task_execution_prompt_capabilities_identity_check" CHECK ("task_execution_prompt_capabilities"."capability_generation" > 0
        and "task_execution_prompt_capabilities"."ownership_epoch" > 0
        and "task_execution_prompt_capabilities"."ref_ordinal" >= 0
        and "task_execution_prompt_capabilities"."lease_generation" > 0
        and "task_execution_prompt_capabilities"."run_batch_digest" ~ '^[0-9a-f]{64}$'
        and "task_execution_prompt_capabilities"."effective_context_exposure_digest" ~ '^[0-9a-f]{64}$'
        and "task_execution_prompt_capabilities"."effective_tools_digest" ~ '^[0-9a-f]{64}$'
        and "task_execution_prompt_capabilities"."bearer_hash" ~ '^[0-9a-f]{64}$'
        and "task_execution_prompt_capabilities"."ingress_high_water" >= -1
        and "task_execution_prompt_capabilities"."ingress_high_water" <= 9007199254740991
        and "task_execution_prompt_capabilities"."classification_high_water" >= -1
        and "task_execution_prompt_capabilities"."classification_high_water" <= 9007199254740991
        and "task_execution_prompt_capabilities"."classification_high_water" <= "task_execution_prompt_capabilities"."ingress_high_water");--> statement-breakpoint
ALTER TABLE "task_execution_refs" ADD CONSTRAINT "task_execution_refs_source_kind_check" CHECK ("task_execution_refs"."source_kind" in (
        'task_request',
        'task_reassignment',
        'mention_agent',
        'routine_dispatch',
        'task_update',
        'system_nudge'
      ));--> statement-breakpoint
ALTER TABLE "task_execution_run_controls" ADD CONSTRAINT "task_execution_run_controls_current_prompt_shape_check" CHECK ((
        "task_execution_run_controls"."current_ref_id" is null
        and "task_execution_run_controls"."current_ordinal" is null
      ) or (
        "task_execution_run_controls"."current_ref_id" is not null
        and "task_execution_run_controls"."current_ordinal" is not null
        and "task_execution_run_controls"."current_ordinal" >= 0
      ));--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ADD CONSTRAINT "task_execution_sessions_shape_check" CHECK ("task_execution_sessions"."state" in ('eligible', 'superseded')
        and "task_execution_sessions"."lane_kind" in ('owner', 'consult'));--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ADD CONSTRAINT "task_execution_sessions_supersession_check" CHECK ((
        "task_execution_sessions"."state" = 'eligible'
        and "task_execution_sessions"."supersession_reason" is null
        and "task_execution_sessions"."superseded_at" is null
      ) or (
        "task_execution_sessions"."state" = 'superseded'
        and "task_execution_sessions"."supersession_reason" is not null
        and length(btrim("task_execution_sessions"."supersession_reason")) between 1 and 200
        and "task_execution_sessions"."superseded_at" is not null
        and "task_execution_sessions"."superseded_at" >= "task_execution_sessions"."created_at"
      ));--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ADD CONSTRAINT "task_execution_sessions_digest_check" CHECK ("task_execution_sessions"."protected_target_session_digest" ~ '^[0-9a-f]{64}$'
        and "task_execution_sessions"."target_fingerprint" ~ '^[0-9a-f]{64}$'
        and "task_execution_sessions"."authorized_context_exposure_digest" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ADD CONSTRAINT "task_execution_sessions_last_settled_prompt_check" CHECK ((
        "task_execution_sessions"."last_protocol_settled_run_id" is null
        and "task_execution_sessions"."last_protocol_settled_ref_id" is null
        and "task_execution_sessions"."last_protocol_settled_ref_ordinal" is null
      ) or (
        "task_execution_sessions"."last_protocol_settled_run_id" is not null
        and "task_execution_sessions"."last_protocol_settled_ref_id" is not null
        and "task_execution_sessions"."last_protocol_settled_ref_ordinal" is not null
        and "task_execution_sessions"."last_protocol_settled_ref_ordinal" >= 0
      ));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_shape_check" CHECK ((
        "tasks"."owner_kind" = 'agent'
        and "tasks"."owner_agent_id" is not null
        and "tasks"."owner_user_id" is null
        and "tasks"."ownership_epoch" > 0
      ) or (
        "tasks"."owner_kind" = 'user'
        and "tasks"."owner_agent_id" is null
        and "tasks"."owner_user_id" is not null
        and "tasks"."creator_kind" = 'system'
        and "tasks"."escalated_from_affected_task_id" is not null
        and "tasks"."ownership_epoch" > 0
      ) or (
        "tasks"."owner_kind" = 'board'
        and "tasks"."owner_agent_id" is null
        and "tasks"."owner_user_id" is null
        and "tasks"."ownership_epoch" > 0
        and "tasks"."creator_kind" in ('system', 'user/board')
      ));
