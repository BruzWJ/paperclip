CREATE TABLE "decision_training_examples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"notes_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision_outcome" text,
	"retention_policy" text DEFAULT 'scrub_deleted_comments_v1' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_execution_watchdog_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"evaluation_issue_id" uuid,
	"decision" text NOT NULL,
	"snoozed_until" timestamp with time zone,
	"reason" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_watchdog_decisions_decision_check" CHECK ("issue_execution_watchdog_decisions"."decision" in (
        'snooze',
        'continue',
        'dismissed_false_positive'
      )),
	CONSTRAINT "issue_execution_watchdog_decisions_snooze_check" CHECK ((
        "issue_execution_watchdog_decisions"."decision" = 'snooze'
        and "issue_execution_watchdog_decisions"."snoozed_until" is not null
        and "issue_execution_watchdog_decisions"."snoozed_until" > "issue_execution_watchdog_decisions"."created_at"
      ) or (
        "issue_execution_watchdog_decisions"."decision" in ('continue', 'dismissed_false_positive')
        and "issue_execution_watchdog_decisions"."snoozed_until" is null
      )),
	CONSTRAINT "issue_execution_watchdog_decisions_reason_check" CHECK ("issue_execution_watchdog_decisions"."reason" is null
        or length(btrim("issue_execution_watchdog_decisions"."reason")) between 1 and 4000),
	CONSTRAINT "issue_execution_watchdog_decisions_actor_check" CHECK ((
        "issue_execution_watchdog_decisions"."created_by_user_id" is not null
        and "issue_execution_watchdog_decisions"."created_by_agent_id" is null
        and "issue_execution_watchdog_decisions"."created_by_run_id" is null
      ) or (
        "issue_execution_watchdog_decisions"."created_by_user_id" is null
        and "issue_execution_watchdog_decisions"."created_by_agent_id" is not null
        and "issue_execution_watchdog_decisions"."created_by_run_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "local_execution_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"execution_workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"failure_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_execution_leases_company_run_uq" UNIQUE("company_id","run_id"),
	CONSTRAINT "local_execution_leases_status_check" CHECK ("local_execution_leases"."status" in ('active', 'released', 'failed')),
	CONSTRAINT "local_execution_leases_lifecycle_check" CHECK ((
        "local_execution_leases"."status" = 'active'
        and "local_execution_leases"."released_at" is null
        and "local_execution_leases"."failure_reason" is null
      ) or (
        "local_execution_leases"."status" = 'released'
        and "local_execution_leases"."released_at" is not null
        and "local_execution_leases"."failure_reason" is null
      ) or (
        "local_execution_leases"."status" = 'failed'
        and "local_execution_leases"."released_at" is not null
        and "local_execution_leases"."failure_reason" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "environment_leases" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "environments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_operations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP CONSTRAINT "agent_adapter_config_revisions_execution_target_driver_check";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP CONSTRAINT "execution_workspaces_class_check";--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_context_access_mask_check";--> statement-breakpoint
ALTER TABLE "routines" DROP CONSTRAINT "routines_context_access_mask_check";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP CONSTRAINT "agent_adapter_config_revisions_execution_environment_id_environments_id_fk";
--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP CONSTRAINT "execution_workspaces_source_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP CONSTRAINT "execution_workspaces_derived_from_execution_workspace_id_execution_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_work_products" DROP CONSTRAINT "issue_work_products_execution_workspace_id_execution_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_work_products" DROP CONSTRAINT "issue_work_products_runtime_service_id_workspace_runtime_services_id_fk";
--> statement-breakpoint
DROP TABLE "environment_leases" CASCADE;--> statement-breakpoint
DROP TABLE "environments" CASCADE;--> statement-breakpoint
DROP TABLE "workspace_operations" CASCADE;--> statement-breakpoint
DROP TABLE "workspace_runtime_services" CASCADE;--> statement-breakpoint
DROP INDEX "agent_adapter_config_revisions_environment_idx";--> statement-breakpoint
DROP INDEX "execution_workspaces_company_project_status_idx";--> statement-breakpoint
DROP INDEX "execution_workspaces_company_project_workspace_status_idx";--> statement-breakpoint
DROP INDEX "execution_workspaces_company_source_issue_idx";--> statement-breakpoint
DROP INDEX "issue_work_products_company_execution_workspace_type_idx";--> statement-breakpoint
DROP INDEX "project_workspaces_project_primary_idx";--> statement-breakpoint
DROP INDEX "project_workspaces_project_source_type_idx";--> statement-breakpoint
DROP INDEX "project_workspaces_company_shared_key_idx";--> statement-breakpoint
DROP INDEX "project_workspaces_project_remote_ref_idx";--> statement-breakpoint
ALTER TABLE "execution_workspaces" ALTER COLUMN "cwd" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "project_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "monitor_next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "monitor_last_triggered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "monitor_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "monitor_notes" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "monitor_scheduled_by" text;--> statement-breakpoint
ALTER TABLE "decision_training_examples" ADD CONSTRAINT "decision_training_examples_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_training_examples" ADD CONSTRAINT "decision_training_examples_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_training_examples" ADD CONSTRAINT "decision_training_examples_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_watchdog_decisions" ADD CONSTRAINT "issue_execution_watchdog_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_watchdog_decisions" ADD CONSTRAINT "issue_execution_watchdog_decisions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_watchdog_decisions" ADD CONSTRAINT "issue_execution_watchdog_decisions_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."issue_execution_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_watchdog_decisions" ADD CONSTRAINT "issue_execution_watchdog_decisions_evaluation_issue_fk" FOREIGN KEY ("company_id","evaluation_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_watchdog_decisions" ADD CONSTRAINT "issue_execution_watchdog_decisions_actor_agent_fk" FOREIGN KEY ("company_id","created_by_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_watchdog_decisions" ADD CONSTRAINT "issue_execution_watchdog_decisions_actor_run_fk" FOREIGN KEY ("company_id","created_by_run_id","created_by_agent_id") REFERENCES "public"."issue_execution_runs"("company_id","id","target_agent_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_execution_leases" ADD CONSTRAINT "local_execution_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_execution_leases" ADD CONSTRAINT "local_execution_leases_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_execution_leases" ADD CONSTRAINT "local_execution_leases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_execution_leases" ADD CONSTRAINT "local_execution_leases_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_training_examples_company_created_at_idx" ON "decision_training_examples" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "decision_training_examples_issue_idx" ON "decision_training_examples" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_training_examples_source_author_uq" ON "decision_training_examples" USING btree ("source_kind","source_id","created_by_user_id");--> statement-breakpoint
CREATE INDEX "issue_execution_watchdog_decisions_company_run_created_idx" ON "issue_execution_watchdog_decisions" USING btree ("company_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_execution_watchdog_decisions_company_run_snooze_idx" ON "issue_execution_watchdog_decisions" USING btree ("company_id","run_id","snoozed_until");--> statement-breakpoint
CREATE INDEX "local_execution_leases_company_status_idx" ON "local_execution_leases" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "local_execution_leases_company_execution_workspace_idx" ON "local_execution_leases" USING btree ("company_id","execution_workspace_id");--> statement-breakpoint
CREATE INDEX "local_execution_leases_company_issue_idx" ON "local_execution_leases" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "local_execution_leases_company_last_used_idx" ON "local_execution_leases" USING btree ("company_id","last_used_at");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_project_idx" ON "execution_workspaces" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_project_workspace_idx" ON "execution_workspaces" USING btree ("company_id","project_workspace_id");--> statement-breakpoint
CREATE INDEX "issues_company_project_workspace_idx" ON "issues" USING btree ("company_id","project_workspace_id");--> statement-breakpoint
CREATE INDEX "issues_company_monitor_due_idx" ON "issues" USING btree ("company_id","monitor_next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_workspaces_project_codebase_uq" ON "project_workspaces" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "execution_environment_id";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "execution_target_driver";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "execution_target_digest";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "workspace_class";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "source_issue_id";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "mode";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "strategy_type";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "base_ref";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "provider_type";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "provider_ref";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "derived_from_execution_workspace_id";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "opened_at";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "closed_at";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "cleanup_eligible_at";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "cleanup_reason";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "issue_execution_workspace_bindings" DROP COLUMN "binding_mode";--> statement-breakpoint
ALTER TABLE "issue_execution_workspace_bindings" DROP COLUMN "repository_locator";--> statement-breakpoint
ALTER TABLE "issue_execution_workspace_bindings" DROP COLUMN "repository_ref";--> statement-breakpoint
ALTER TABLE "issue_execution_workspace_bindings" DROP COLUMN "pull_request_selector";--> statement-breakpoint
ALTER TABLE "issue_work_products" DROP COLUMN "execution_workspace_id";--> statement-breakpoint
ALTER TABLE "issue_work_products" DROP COLUMN "runtime_service_id";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "context_access_mask";--> statement-breakpoint
ALTER TABLE "project_workspaces" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "project_workspaces" DROP COLUMN "source_type";--> statement-breakpoint
ALTER TABLE "project_workspaces" DROP COLUMN "repo_ref";--> statement-breakpoint
ALTER TABLE "project_workspaces" DROP COLUMN "default_ref";--> statement-breakpoint
ALTER TABLE "project_workspaces" DROP COLUMN "visibility";--> statement-breakpoint
ALTER TABLE "project_workspaces" DROP COLUMN "setup_command";--> statement-breakpoint
ALTER TABLE "project_workspaces" DROP COLUMN "cleanup_command";--> statement-breakpoint
ALTER TABLE "project_workspaces" DROP COLUMN "remote_provider";--> statement-breakpoint
ALTER TABLE "project_workspaces" DROP COLUMN "remote_workspace_ref";--> statement-breakpoint
ALTER TABLE "project_workspaces" DROP COLUMN "shared_workspace_key";--> statement-breakpoint
ALTER TABLE "project_workspaces" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "project_workspaces" DROP COLUMN "is_primary";--> statement-breakpoint
ALTER TABLE "routines" DROP COLUMN "context_access_mask";--> statement-breakpoint
UPDATE "agent_adapter_config_revisions" SET "acp_configuration" = "acp_configuration" - 'executionTargetSelector';--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check" CHECK (
        jsonb_typeof("agent_adapter_config_revisions"."acp_configuration") = 'object'
        and "agent_adapter_config_revisions"."acp_configuration" ?& array[
          'contractVersion',
          'launchProfile',
          'sessionConfigSelections',
          'model',
          'workspaceSelector',
          'companySkillPins',
          'skillChannel'
        ]::text[]
        and "agent_adapter_config_revisions"."acp_configuration" - array[
          'contractVersion',
          'launchProfile',
          'sessionConfigSelections',
          'model',
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
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'workspaceSelector') = 'object'
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'workspaceSelector') - 'kind' = '{}'::jsonb
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{workspaceSelector,kind}' = 'issue_execution_workspace'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'companySkillPins') = 'array'
        and "agent_adapter_config_revisions"."acp_configuration" ->> 'skillChannel' in ('isolated_skills_home', 'operator_native')
      );
