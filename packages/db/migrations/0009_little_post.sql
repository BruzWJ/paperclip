ALTER TABLE "agent_company_tool_selections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_attachments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_documents" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_issue_links" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_labels" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cases" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_upstream_connections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_upstream_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connection_grants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "decision_training_examples" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "external_object_mentions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "external_objects" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_execution_watchdog_decisions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pipeline_automation_executions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pipeline_case_blockers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pipeline_case_documents" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pipeline_cases" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pipeline_documents" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pipeline_stages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pipeline_transitions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pipelines" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "smoke_run_steps" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "smoke_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "summary_slots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_access_audit_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_action_requests" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_applications" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_call_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_connection_installs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_connections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_gateway_rate_limit_counters" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_invocations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_oauth_states" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_policies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_profile_bindings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_profile_entries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_profiles" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_rate_limit_counters" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_runtime_metric_counters" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_stdio_command_templates" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_company_tool_selections" CASCADE;--> statement-breakpoint
DROP TABLE "case_attachments" CASCADE;--> statement-breakpoint
DROP TABLE "case_documents" CASCADE;--> statement-breakpoint
DROP TABLE "case_events" CASCADE;--> statement-breakpoint
DROP TABLE "case_issue_links" CASCADE;--> statement-breakpoint
DROP TABLE "case_labels" CASCADE;--> statement-breakpoint
DROP TABLE "cases" CASCADE;--> statement-breakpoint
DROP TABLE "cloud_upstream_connections" CASCADE;--> statement-breakpoint
DROP TABLE "cloud_upstream_runs" CASCADE;--> statement-breakpoint
DROP TABLE "connection_grants" CASCADE;--> statement-breakpoint
DROP TABLE "decision_training_examples" CASCADE;--> statement-breakpoint
DROP TABLE "environment_custom_image_setup_sessions" CASCADE;--> statement-breakpoint
DROP TABLE "environment_custom_image_templates" CASCADE;--> statement-breakpoint
DROP TABLE "external_object_mentions" CASCADE;--> statement-breakpoint
DROP TABLE "external_objects" CASCADE;--> statement-breakpoint
DROP TABLE "issue_execution_watchdog_decisions" CASCADE;--> statement-breakpoint
DROP TABLE "issue_watchdogs" CASCADE;--> statement-breakpoint
DROP TABLE "pipeline_automation_executions" CASCADE;--> statement-breakpoint
DROP TABLE "pipeline_case_blockers" CASCADE;--> statement-breakpoint
DROP TABLE "pipeline_case_documents" CASCADE;--> statement-breakpoint
DROP TABLE "pipeline_case_events" CASCADE;--> statement-breakpoint
DROP TABLE "pipeline_case_issue_links" CASCADE;--> statement-breakpoint
DROP TABLE "pipeline_cases" CASCADE;--> statement-breakpoint
DROP TABLE "pipeline_documents" CASCADE;--> statement-breakpoint
DROP TABLE "pipeline_stages" CASCADE;--> statement-breakpoint
DROP TABLE "pipeline_transitions" CASCADE;--> statement-breakpoint
DROP TABLE "pipelines" CASCADE;--> statement-breakpoint
DROP TABLE "smoke_run_steps" CASCADE;--> statement-breakpoint
DROP TABLE "smoke_runs" CASCADE;--> statement-breakpoint
DROP TABLE "summary_slots" CASCADE;--> statement-breakpoint
DROP TABLE "tool_access_audit_events" CASCADE;--> statement-breakpoint
DROP TABLE "tool_action_requests" CASCADE;--> statement-breakpoint
DROP TABLE "tool_applications" CASCADE;--> statement-breakpoint
DROP TABLE "tool_call_events" CASCADE;--> statement-breakpoint
DROP TABLE "tool_catalog_entries" CASCADE;--> statement-breakpoint
DROP TABLE "tool_connection_installs" CASCADE;--> statement-breakpoint
DROP TABLE "tool_connections" CASCADE;--> statement-breakpoint
DROP TABLE "tool_gateway_rate_limit_counters" CASCADE;--> statement-breakpoint
DROP TABLE "tool_invocations" CASCADE;--> statement-breakpoint
DROP TABLE "tool_mcp_gateway_tokens" CASCADE;--> statement-breakpoint
DROP TABLE "tool_mcp_gateways" CASCADE;--> statement-breakpoint
DROP TABLE "tool_oauth_states" CASCADE;--> statement-breakpoint
DROP TABLE "tool_policies" CASCADE;--> statement-breakpoint
DROP TABLE "tool_profile_bindings" CASCADE;--> statement-breakpoint
DROP TABLE "tool_profile_entries" CASCADE;--> statement-breakpoint
DROP TABLE "tool_profiles" CASCADE;--> statement-breakpoint
DROP TABLE "tool_rate_limit_counters" CASCADE;--> statement-breakpoint
DROP TABLE "tool_runtime_metric_counters" CASCADE;--> statement-breakpoint
DROP TABLE "tool_runtime_slots" CASCADE;--> statement-breakpoint
DROP TABLE "tool_stdio_command_templates" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check";--> statement-breakpoint
ALTER TABLE "document_annotation_comments" DROP CONSTRAINT "document_annotation_comments_exactly_one_owner_chk";--> statement-breakpoint
ALTER TABLE "document_annotation_threads" DROP CONSTRAINT "document_annotation_threads_exactly_one_owner_chk";--> statement-breakpoint
ALTER TABLE "issue_execution_refs" DROP CONSTRAINT "issue_execution_refs_source_kind_check";--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_creator_shape_check";--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" DROP CONSTRAINT "run_interface_tool_calls_plugin_binding_check";--> statement-breakpoint
ALTER TABLE "system_escalation_identities" DROP CONSTRAINT "system_escalation_identities_source_check";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP CONSTRAINT "agent_adapter_config_revisions_default_environment_id_environments_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_default_environment_id_environments_id_fk";
--> statement-breakpoint
ALTER TABLE "document_annotation_comments" DROP CONSTRAINT "document_annotation_comments_case_id_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "document_annotation_threads" DROP CONSTRAINT "document_annotation_threads_case_id_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "instance_settings" DROP CONSTRAINT "instance_settings_default_environment_id_environments_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_project_workspace_id_project_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "join_requests" DROP CONSTRAINT "join_requests_approved_environment_id_environments_id_fk";
--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" DROP CONSTRAINT "run_interface_tool_calls_company_tool_selection_id_agent_company_tool_selections_id_fk";
--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" DROP CONSTRAINT "run_interface_tool_calls_company_tool_selection_fk";
--> statement-breakpoint
DROP INDEX "agents_company_default_environment_idx";--> statement-breakpoint
DROP INDEX "document_annotation_comments_company_case_created_at_idx";--> statement-breakpoint
DROP INDEX "document_annotation_threads_company_case_status_idx";--> statement-breakpoint
DROP INDEX "issues_company_project_workspace_idx";--> statement-breakpoint
DROP INDEX "issues_company_monitor_due_idx";--> statement-breakpoint
DROP INDEX "agent_adapter_config_revisions_environment_idx";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD COLUMN "execution_environment_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_execution_environment_id_environments_id_fk" FOREIGN KEY ("execution_environment_id") REFERENCES "public"."environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_adapter_config_revisions_environment_idx" ON "agent_adapter_config_revisions" USING btree ("execution_environment_id");--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "default_environment_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "default_environment_id";--> statement-breakpoint
ALTER TABLE "document_annotation_comments" DROP COLUMN "case_id";--> statement-breakpoint
ALTER TABLE "document_annotation_threads" DROP COLUMN "case_id";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "default_environment_id";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "experimental";--> statement-breakpoint
ALTER TABLE "issue_execution_workspace_bindings" DROP COLUMN "environment_selector";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "project_workspace_id";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "monitor_next_check_at";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "monitor_last_triggered_at";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "monitor_attempt_count";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "monitor_notes";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "monitor_scheduled_by";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "execution_workspace_preference";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "execution_workspace_settings";--> statement-breakpoint
ALTER TABLE "join_requests" DROP COLUMN "approved_environment_id";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "execution_workspace_policy";--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" DROP COLUMN "company_tool_selection_id";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check" CHECK (
        jsonb_typeof("agent_adapter_config_revisions"."acp_configuration") = 'object'
        and "agent_adapter_config_revisions"."acp_configuration" ?& array[
          'contractVersion',
          'launchProfile',
          'sessionConfigSelections',
          'model',
          'executionTargetSelector',
          'workspaceSelector',
          'companySkillPins',
          'skillChannel'
        ]::text[]
        and "agent_adapter_config_revisions"."acp_configuration" - array[
          'contractVersion',
          'launchProfile',
          'sessionConfigSelections',
          'model',
          'executionTargetSelector',
          'workspaceSelector',
          'companySkillPins',
          'skillChannel'
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
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'executionTargetSelector') = 'object'
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'executionTargetSelector') ?& array[
          'environmentId', 'executionTargetDriver', 'executionTargetDigest'
        ]::text[]
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'executionTargetSelector') - array[
          'environmentId', 'executionTargetDriver', 'executionTargetDigest'
        ]::text[] = '{}'::jsonb
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{executionTargetSelector,environmentId}' = "agent_adapter_config_revisions"."execution_environment_id"::text
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{executionTargetSelector,executionTargetDriver}' = "agent_adapter_config_revisions"."execution_target_driver"
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{executionTargetSelector,executionTargetDigest}' = "agent_adapter_config_revisions"."execution_target_digest"
        and "agent_adapter_config_revisions"."execution_target_digest" ~ '^[0-9a-f]{64}$'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'workspaceSelector') = 'object'
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'workspaceSelector') - 'kind' = '{}'::jsonb
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{workspaceSelector,kind}' = 'issue_execution_workspace'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'companySkillPins') = 'array'
        and "agent_adapter_config_revisions"."acp_configuration" ->> 'skillChannel' in ('isolated_skills_home', 'operator_native')
      );--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_exactly_one_owner_chk" CHECK (num_nonnulls("document_annotation_comments"."issue_id", "document_annotation_comments"."routine_id") = 1);--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_exactly_one_owner_chk" CHECK (num_nonnulls("document_annotation_threads"."issue_id", "document_annotation_threads"."routine_id") = 1);--> statement-breakpoint
ALTER TABLE "issue_execution_refs" ADD CONSTRAINT "issue_execution_refs_source_kind_check" CHECK ("issue_execution_refs"."source_kind" in (
        'issue_request',
        'issue_reassignment',
        'issue_reopen',
        'human_comment_mention',
        'routine_dispatch',
        'issue_update',
        'consult_mention',
        'system_nudge',
        'termination_recovery',
        'agent_liveness_followup'
      ));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_creator_shape_check" CHECK ((
        "issues"."creator_kind" = 'agent-execution'
        and "issues"."creator_authority_id" is not null
        and "issues"."creator_adapter_config_revision_id" is not null
        and "issues"."creator_user_id" is null
        and "issues"."creator_plugin_installation_id" is null
        and "issues"."creator_plugin_key" is null
        and "issues"."creator_callback_key" is null
        and "issues"."creator_callback_version" is null
        and "issues"."creator_routine_id" is null
        and "issues"."creator_routine_dispatch_id" is null
        and "issues"."creator_system_source_kind" is null
        and "issues"."creator_system_source_id" is null
      ) or (
        "issues"."creator_kind" = 'user/board'
        and "issues"."creator_authority_id" is null
        and "issues"."creator_adapter_config_revision_id" is null
        and "issues"."creator_plugin_installation_id" is null
        and "issues"."creator_plugin_key" is null
        and "issues"."creator_callback_key" is null
        and "issues"."creator_callback_version" is null
        and "issues"."creator_routine_id" is null
        and "issues"."creator_routine_dispatch_id" is null
        and "issues"."creator_system_source_kind" is null
        and "issues"."creator_system_source_id" is null
      ) or (
        "issues"."creator_kind" = 'plugin'
        and "issues"."creator_authority_id" is null
        and "issues"."creator_adapter_config_revision_id" is null
        and "issues"."creator_user_id" is null
        and "issues"."creator_plugin_installation_id" is not null
        and "issues"."creator_plugin_key" is not null
        and "issues"."creator_callback_key" is not null
        and "issues"."creator_callback_version" is not null
        and "issues"."creator_routine_id" is null
        and "issues"."creator_routine_dispatch_id" is null
        and "issues"."creator_system_source_kind" is null
        and "issues"."creator_system_source_id" is null
      ) or (
        "issues"."creator_kind" = 'routine'
        and "issues"."creator_authority_id" is null
        and "issues"."creator_adapter_config_revision_id" is null
        and "issues"."creator_user_id" is null
        and "issues"."creator_plugin_installation_id" is null
        and "issues"."creator_plugin_key" is null
        and "issues"."creator_callback_key" is null
        and "issues"."creator_callback_version" is null
        and "issues"."creator_routine_id" is not null
        and "issues"."creator_routine_dispatch_id" is not null
        and "issues"."creator_system_source_kind" is null
        and "issues"."creator_system_source_id" is null
      ) or (
        "issues"."creator_kind" = 'system'
        and "issues"."creator_authority_id" is null
        and "issues"."creator_adapter_config_revision_id" is null
        and "issues"."creator_user_id" is null
        and "issues"."creator_plugin_installation_id" is null
        and "issues"."creator_plugin_key" is null
        and "issues"."creator_callback_key" is null
        and "issues"."creator_callback_version" is null
        and "issues"."creator_routine_id" is null
        and "issues"."creator_routine_dispatch_id" is null
        and "issues"."creator_system_source_kind" is not null
        and "issues"."creator_system_source_kind" in ('recovery', 'liveness')
        and "issues"."creator_system_source_id" is not null
      ));--> statement-breakpoint
ALTER TABLE "system_escalation_identities" ADD CONSTRAINT "system_escalation_identities_source_check" CHECK ("system_escalation_identities"."system_source" in ('recovery', 'liveness'));