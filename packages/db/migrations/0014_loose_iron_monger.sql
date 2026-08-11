ALTER TABLE "issue_execution_cancellation_intents" DROP CONSTRAINT "issue_execution_cancellation_intents_process_fk";
--> statement-breakpoint
ALTER TABLE "issue_execution_process_facts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "issue_execution_process_facts";--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" RENAME COLUMN "session_cancel_sent_at" TO "native_cancellation_settled_at";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check";--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" DROP CONSTRAINT "issue_execution_cancellation_intents_process_check";--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" DROP CONSTRAINT "issue_execution_cancellation_intents_reason_check";--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" DROP CONSTRAINT "issue_execution_cancellation_intents_time_check";--> statement-breakpoint
ALTER TABLE "issue_execution_runs" DROP CONSTRAINT "issue_execution_runs_process_exit_check";--> statement-breakpoint
ALTER TABLE "issue_execution_runs" DROP CONSTRAINT "issue_execution_runs_process_signal_check";--> statement-breakpoint
ALTER TABLE "issue_execution_runs" DROP CONSTRAINT "issue_execution_runs_terminal_shape_check";--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" DROP COLUMN "process_fact_id";--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" DROP COLUMN "process_termination_requested_at";--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" DROP COLUMN "process_terminated_at";--> statement-breakpoint
ALTER TABLE "issue_execution_runs" DROP COLUMN "process_exit_code";--> statement-breakpoint
ALTER TABLE "issue_execution_runs" DROP COLUMN "process_signal";--> statement-breakpoint
UPDATE "agent_adapter_config_revisions"
SET "acp_configuration" = "acp_configuration" - 'skillChannel'
WHERE "acp_configuration" ? 'skillChannel';--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check" CHECK (
        jsonb_typeof("agent_adapter_config_revisions"."acp_configuration") = 'object'
        and "agent_adapter_config_revisions"."acp_configuration" ?& array[
          'contractVersion',
          'launchProfile',
          'sessionConfigSelections',
          'model',
          'workspaceSelector',
          'companySkillPins'
        ]::text[]
        and "agent_adapter_config_revisions"."acp_configuration" - array[
          'contractVersion',
          'launchProfile',
          'sessionConfigSelections',
          'model',
          'workspaceSelector',
          'companySkillPins'
        ]::text[] = '{}'::jsonb
        and "agent_adapter_config_revisions"."acp_configuration" ->> 'contractVersion' = 'acpx-runtime/v1'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'launchProfile') = 'object'
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'launchProfile') ?& array[
          'registryName'
        ]::text[]
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'launchProfile') - array[
          'registryName'
        ]::text[] = '{}'::jsonb
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{launchProfile,registryName}') = 'string'
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,registryName}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,registryName}')
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,registryName}' <> ''
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'sessionConfigSelections') = 'array'
        and (
          jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'model') = 'null'
          or (
            jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'model') = 'object'
            and ("agent_adapter_config_revisions"."acp_configuration" -> 'model') ?& array[
              'id', 'label', 'value', 'limits'
            ]::text[]
            and ("agent_adapter_config_revisions"."acp_configuration" -> 'model') - array[
              'id', 'label', 'value', 'limits'
            ]::text[] = '{}'::jsonb
            and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,id}') = 'string'
            and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,label}') = 'string'
            and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,value}') = 'string'
            and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,id}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{model,id}')
            and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,id}' <> ''
            and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,label}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{model,label}')
            and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,label}' <> ''
            and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,value}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{model,value}')
            and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,value}' <> ''
            and (
              jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,limits}') = 'null'
              or (
                jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,limits}') = 'object'
                and ("agent_adapter_config_revisions"."acp_configuration" #> '{model,limits}') ?& array[
                  'contextTokenLimit', 'outputTokenLimit'
                ]::text[]
                and ("agent_adapter_config_revisions"."acp_configuration" #> '{model,limits}') - array[
                  'contextTokenLimit', 'inputTokenLimit', 'outputTokenLimit'
                ]::text[] = '{}'::jsonb
                and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,limits,contextTokenLimit}') = 'number'
                and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,limits,outputTokenLimit}') = 'number'
                and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,limits,contextTokenLimit}' ~ '^[1-9][0-9]*$'
                and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,limits,outputTokenLimit}' ~ '^[1-9][0-9]*$'
                and ("agent_adapter_config_revisions"."acp_configuration" #>> '{model,limits,outputTokenLimit}')::numeric <= ("agent_adapter_config_revisions"."acp_configuration" #>> '{model,limits,contextTokenLimit}')::numeric
                and (
                  not ("agent_adapter_config_revisions"."acp_configuration" #> '{model,limits}') ? 'inputTokenLimit'
                  or (
                    jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,limits,inputTokenLimit}') = 'number'
                    and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,limits,inputTokenLimit}' ~ '^[1-9][0-9]*$'
                    and ("agent_adapter_config_revisions"."acp_configuration" #>> '{model,limits,inputTokenLimit}')::numeric <= ("agent_adapter_config_revisions"."acp_configuration" #>> '{model,limits,contextTokenLimit}')::numeric
                  )
                )
              )
            )
          )
        )
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'workspaceSelector') = 'object'
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'workspaceSelector') - 'kind' = '{}'::jsonb
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{workspaceSelector,kind}' = 'issue_execution_workspace'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'companySkillPins') = 'array'
      );--> statement-breakpoint
UPDATE "issue_execution_cancellation_intents"
SET "reason_kind" = 'authority'
WHERE "reason_kind" = 'process_policy';--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" ADD CONSTRAINT "issue_execution_cancellation_intents_reason_check" CHECK ("issue_execution_cancellation_intents"."reason_kind" in (
        'lifecycle',
        'authority',
        'timeout',
        'lease_expired',
        'steering'
      ));--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" ADD CONSTRAINT "issue_execution_cancellation_intents_time_check" CHECK ("issue_execution_cancellation_intents"."requested_at" >= "issue_execution_cancellation_intents"."created_at"
        and (
          "issue_execution_cancellation_intents"."acknowledged_at" is null
          or "issue_execution_cancellation_intents"."acknowledged_at" >= "issue_execution_cancellation_intents"."requested_at"
        )
        and (
          "issue_execution_cancellation_intents"."native_cancellation_settled_at" is null
          or "issue_execution_cancellation_intents"."native_cancellation_settled_at" >= "issue_execution_cancellation_intents"."requested_at"
        )
        and (
          "issue_execution_cancellation_intents"."completed_at" is null
          or "issue_execution_cancellation_intents"."completed_at" >= "issue_execution_cancellation_intents"."requested_at"
        )
        and (
          "issue_execution_cancellation_intents"."failed_at" is null
          or "issue_execution_cancellation_intents"."failed_at" >= "issue_execution_cancellation_intents"."requested_at"
        ));--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_terminal_shape_check" CHECK ((
        "issue_execution_runs"."status" in ('queued', 'scheduled_retry', 'running')
        and "issue_execution_runs"."finished_at" is null
        and "issue_execution_runs"."terminal_classification" is null
        and "issue_execution_runs"."terminal_reason_code" is null
        and "issue_execution_runs"."terminal_finalization_id" is null
      ) or (
        "issue_execution_runs"."status" in (
          'succeeded',
          'interrupted',
          'failed',
          'cancelled',
          'timed_out'
        )
        and "issue_execution_runs"."finished_at" is not null
        and "issue_execution_runs"."terminal_classification" = "issue_execution_runs"."status"
        and "issue_execution_runs"."terminal_reason_code" is not null
        and length(btrim("issue_execution_runs"."terminal_reason_code")) between 1 and 200
        and "issue_execution_runs"."terminal_finalization_id" is not null
        and "issue_execution_runs"."current_attempt_id" is null
        and "issue_execution_runs"."current_lease_id" is null
      ));
