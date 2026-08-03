CREATE TABLE "acp_prompt_accounting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"run_kind" text NOT NULL,
	"prompt_kind" text NOT NULL,
	"ref_id" uuid,
	"run_ordinal" integer,
	"segment_ordinal" integer,
	"compaction_control_id" uuid,
	"attempt_id" uuid NOT NULL,
	"adapter_config_revision_id" uuid NOT NULL,
	"selected_model_id" text NOT NULL,
	"context_token_limit" bigint NOT NULL,
	"context_used_tokens" bigint NOT NULL,
	"context_window_tokens" bigint NOT NULL,
	"prompt_settlement_reference_id" uuid NOT NULL,
	"terminal_usage_reference" text NOT NULL,
	"terminal_stop_reference" text NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acp_prompt_accounting_scope_id_uq" UNIQUE("company_id","issue_id","run_id","id"),
	CONSTRAINT "acp_prompt_accounting_common_attribution_uq" UNIQUE("company_id","issue_id","agent_id","run_id","run_kind","id"),
	CONSTRAINT "acp_prompt_accounting_productive_cost_attribution_uq" UNIQUE("company_id","issue_id","agent_id","run_id","run_kind","ref_id","run_ordinal","segment_ordinal","id"),
	CONSTRAINT "acp_prompt_accounting_compaction_cost_attribution_uq" UNIQUE("company_id","issue_id","agent_id","run_id","run_kind","compaction_control_id","id"),
	CONSTRAINT "acp_prompt_accounting_compaction_settlement_owner_uq" UNIQUE("company_id","issue_id","run_id","compaction_control_id","prompt_settlement_reference_id","id"),
	CONSTRAINT "acp_prompt_accounting_prompt_identity_check" CHECK ((
        "acp_prompt_accounting"."prompt_kind" = 'base'
        and "acp_prompt_accounting"."run_kind" in ('productive', 'consult')
        and "acp_prompt_accounting"."ref_id" is not null
        and "acp_prompt_accounting"."run_ordinal" is not null
        and "acp_prompt_accounting"."run_ordinal" >= 0
        and "acp_prompt_accounting"."segment_ordinal" is not null
        and "acp_prompt_accounting"."segment_ordinal" = 0
        and "acp_prompt_accounting"."compaction_control_id" is null
      ) or (
        "acp_prompt_accounting"."prompt_kind" = 'steering'
        and "acp_prompt_accounting"."run_kind" in ('productive', 'consult')
        and "acp_prompt_accounting"."ref_id" is not null
        and "acp_prompt_accounting"."run_ordinal" is not null
        and "acp_prompt_accounting"."run_ordinal" >= 0
        and "acp_prompt_accounting"."segment_ordinal" is not null
        and "acp_prompt_accounting"."segment_ordinal" > 0
        and "acp_prompt_accounting"."compaction_control_id" is null
      ) or (
        "acp_prompt_accounting"."prompt_kind" = 'compaction'
        and "acp_prompt_accounting"."run_kind" = 'compaction'
        and "acp_prompt_accounting"."ref_id" is null
        and "acp_prompt_accounting"."run_ordinal" is null
        and "acp_prompt_accounting"."segment_ordinal" is null
        and "acp_prompt_accounting"."compaction_control_id" is not null
      )),
	CONSTRAINT "acp_prompt_accounting_context_occupancy_check" CHECK ("acp_prompt_accounting"."context_used_tokens" >= 0
        and "acp_prompt_accounting"."context_window_tokens" > 0
        and "acp_prompt_accounting"."context_token_limit" > 0
        and "acp_prompt_accounting"."context_used_tokens" <= "acp_prompt_accounting"."context_window_tokens"
        and "acp_prompt_accounting"."context_window_tokens" = "acp_prompt_accounting"."context_token_limit"),
	CONSTRAINT "acp_prompt_accounting_references_check" CHECK (length(btrim("acp_prompt_accounting"."selected_model_id")) between 1 and 500
        and length(btrim("acp_prompt_accounting"."terminal_usage_reference")) between 1 and 500
        and length(btrim("acp_prompt_accounting"."terminal_stop_reference")) between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"responsible_user_id" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_action_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"granted_by_agent_id" uuid,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_action_grants_key_check" CHECK ("agent_action_grants"."key" in (
        'issue_create',
        'issue_assign',
        'issue_update',
        'mention_agent',
        'agent_hire',
        'agent_configure'
      ))
);
--> statement-breakpoint
CREATE TABLE "agent_adapter_config_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"adapter_type" text NOT NULL,
	"implementation_identity" jsonb NOT NULL,
	"adapter_config_schema_version" text NOT NULL,
	"default_environment_id" uuid NOT NULL,
	"execution_target_driver" text NOT NULL,
	"execution_target_digest" text NOT NULL,
	"normalized_config" jsonb NOT NULL,
	"runtime_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acp_configuration" jsonb NOT NULL,
	"digest" text NOT NULL,
	"parent_revision_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_adapter_config_revisions_scope_id_uq" UNIQUE("company_id","agent_id","id"),
	CONSTRAINT "agent_adapter_config_revisions_execution_target_driver_check" CHECK ("agent_adapter_config_revisions"."execution_target_driver" in ('local', 'ssh', 'sandbox', 'plugin')),
	CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check" CHECK (
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
        and "agent_adapter_config_revisions"."acp_configuration" ->> 'contractVersion' = 'acp-subprocess/v1'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'launchProfile') = 'object'
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'launchProfile') ?& array[
          'registryName',
          'targetNativeCli',
          'command',
          'args',
          'frontendPackage',
          'frontendVersion',
          'frontendDigest'
        ]::text[]
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'launchProfile') - array[
          'registryName',
          'targetNativeCli',
          'command',
          'args',
          'frontendPackage',
          'frontendVersion',
          'frontendDigest'
        ]::text[] = '{}'::jsonb
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{launchProfile,registryName}') = 'string'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{launchProfile,targetNativeCli}') = 'string'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{launchProfile,command}') = 'string'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{launchProfile,args}') = 'array'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{launchProfile,frontendPackage}') = 'string'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{launchProfile,frontendVersion}') = 'string'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{launchProfile,frontendDigest}') = 'string'
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,registryName}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,registryName}')
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,registryName}' <> ''
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,targetNativeCli}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,targetNativeCli}')
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,targetNativeCli}' <> ''
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,command}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,command}')
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,command}' <> ''
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,frontendPackage}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,frontendPackage}')
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,frontendPackage}' <> ''
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,frontendVersion}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,frontendVersion}')
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,frontendVersion}' <> ''
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{launchProfile,frontendDigest}' ~ '^[0-9a-f]{64}$'
        and case
          when jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'sessionConfigSelections') = 'array'
          then jsonb_array_length("agent_adapter_config_revisions"."acp_configuration" -> 'sessionConfigSelections') > 0
          else false
        end
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'model') = 'object'
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'model') ?& array[
          'id', 'label', 'value', 'limits'
        ]::text[]
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'model') - array[
          'id', 'label', 'value', 'limits'
        ]::text[] = '{}'::jsonb
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,id}') = 'string'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,label}') = 'string'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,value}') = 'string'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,limits}') = 'object'
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,id}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{model,id}')
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,id}' <> ''
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,label}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{model,label}')
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,label}' <> ''
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,value}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{model,value}')
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,value}' <> ''
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
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'executionTargetSelector') = 'object'
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'executionTargetSelector') ?& array[
          'defaultEnvironmentId', 'executionTargetDriver', 'executionTargetDigest'
        ]::text[]
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'executionTargetSelector') - array[
          'defaultEnvironmentId', 'executionTargetDriver', 'executionTargetDigest'
        ]::text[] = '{}'::jsonb
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{executionTargetSelector,defaultEnvironmentId}' = "agent_adapter_config_revisions"."default_environment_id"::text
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{executionTargetSelector,executionTargetDriver}' = "agent_adapter_config_revisions"."execution_target_driver"
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{executionTargetSelector,executionTargetDigest}' = "agent_adapter_config_revisions"."execution_target_digest"
        and "agent_adapter_config_revisions"."execution_target_digest" ~ '^[0-9a-f]{64}$'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'workspaceSelector') = 'object'
        and ("agent_adapter_config_revisions"."acp_configuration" -> 'workspaceSelector') - 'kind' = '{}'::jsonb
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{workspaceSelector,kind}' = 'issue_execution_workspace'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'companySkillPins') = 'array'
        and "agent_adapter_config_revisions"."acp_configuration" ->> 'skillChannel' in ('isolated_skills_home', 'operator_native')
      )
);
--> statement-breakpoint
CREATE TABLE "agent_company_tool_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_install_id" uuid NOT NULL,
	"catalog_entry_id" uuid NOT NULL,
	"catalog_version_hash" text NOT NULL,
	"status" text DEFAULT 'selected' NOT NULL,
	"selected_by_kind" text NOT NULL,
	"selected_by_agent_id" uuid,
	"selected_by_user_id" text,
	"selected_by_plugin_installation_id" uuid,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by_kind" text,
	"revoked_by_agent_id" uuid,
	"revoked_by_user_id" text,
	"revoked_by_plugin_installation_id" uuid,
	"revocation_reason" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_company_tool_selections_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "agent_company_tool_selections_status_check" CHECK ("agent_company_tool_selections"."status" in ('selected', 'revoked')),
	CONSTRAINT "agent_company_tool_selections_selected_actor_check" CHECK ((
        "agent_company_tool_selections"."selected_by_kind" = 'user'
        and "agent_company_tool_selections"."selected_by_user_id" is not null
        and "agent_company_tool_selections"."selected_by_agent_id" is null
        and "agent_company_tool_selections"."selected_by_plugin_installation_id" is null
      ) or (
        "agent_company_tool_selections"."selected_by_kind" = 'agent'
        and "agent_company_tool_selections"."selected_by_agent_id" is not null
        and "agent_company_tool_selections"."selected_by_user_id" is null
        and "agent_company_tool_selections"."selected_by_plugin_installation_id" is null
      ) or (
        "agent_company_tool_selections"."selected_by_kind" = 'plugin'
        and "agent_company_tool_selections"."selected_by_plugin_installation_id" is not null
        and "agent_company_tool_selections"."selected_by_agent_id" is null
        and "agent_company_tool_selections"."selected_by_user_id" is null
      ) or (
        "agent_company_tool_selections"."selected_by_kind" = 'migration'
        and "agent_company_tool_selections"."selected_by_agent_id" is null
        and "agent_company_tool_selections"."selected_by_user_id" is null
        and "agent_company_tool_selections"."selected_by_plugin_installation_id" is null
      )),
	CONSTRAINT "agent_company_tool_selections_revocation_check" CHECK ((
        "agent_company_tool_selections"."status" = 'selected'
        and "agent_company_tool_selections"."revoked_by_kind" is null
        and "agent_company_tool_selections"."revoked_by_agent_id" is null
        and "agent_company_tool_selections"."revoked_by_user_id" is null
        and "agent_company_tool_selections"."revoked_by_plugin_installation_id" is null
        and "agent_company_tool_selections"."revocation_reason" is null
        and "agent_company_tool_selections"."revoked_at" is null
      ) or (
        "agent_company_tool_selections"."status" = 'revoked'
        and "agent_company_tool_selections"."revoked_by_kind" is not null
        and "agent_company_tool_selections"."revocation_reason" is not null
        and "agent_company_tool_selections"."revoked_at" is not null
        and (
          (
            "agent_company_tool_selections"."revoked_by_kind" = 'user'
            and "agent_company_tool_selections"."revoked_by_user_id" is not null
            and "agent_company_tool_selections"."revoked_by_agent_id" is null
            and "agent_company_tool_selections"."revoked_by_plugin_installation_id" is null
          ) or (
            "agent_company_tool_selections"."revoked_by_kind" = 'agent'
            and "agent_company_tool_selections"."revoked_by_agent_id" is not null
            and "agent_company_tool_selections"."revoked_by_user_id" is null
            and "agent_company_tool_selections"."revoked_by_plugin_installation_id" is null
          ) or (
            "agent_company_tool_selections"."revoked_by_kind" = 'plugin'
            and "agent_company_tool_selections"."revoked_by_plugin_installation_id" is not null
            and "agent_company_tool_selections"."revoked_by_agent_id" is null
            and "agent_company_tool_selections"."revoked_by_user_id" is null
          ) or (
            "agent_company_tool_selections"."revoked_by_kind" = 'migration'
            and "agent_company_tool_selections"."revoked_by_agent_id" is null
            and "agent_company_tool_selections"."revoked_by_user_id" is null
            and "agent_company_tool_selections"."revoked_by_plugin_installation_id" is null
          )
        )
      ))
);
--> statement-breakpoint
CREATE TABLE "agent_config_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"source" text DEFAULT 'patch' NOT NULL,
	"rolled_back_from_revision_id" uuid,
	"changed_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"before_config" jsonb NOT NULL,
	"after_config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_context_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"granted_by_agent_id" uuid,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_context_grants_key_check" CHECK ("agent_context_grants"."key" in (
        'carry_context',
        'read_issue_comments',
        'read_issue_agent_run',
        'list_sub_issues',
        'read_sub_issue_comments',
        'read_sub_issue_agent_run',
        'list_company_issues',
        'read_company_issue_comments',
        'read_company_issue_agent_run'
      ))
);
--> statement-breakpoint
CREATE TABLE "agent_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state" text DEFAULT 'joined' NOT NULL,
	"starred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_mention_reach_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"granted_by_agent_id" uuid,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_mention_reach_grants_key_check" CHECK ("agent_mention_reach_grants"."key" in ('mention_any_descendant', 'mention_any_ancestor'))
);
--> statement-breakpoint
CREATE TABLE "agent_runtime_state" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"last_run_id" uuid,
	"last_run_status" text,
	"last_context_used_tokens" bigint,
	"last_context_window_tokens" bigint,
	"peak_context_used_tokens" bigint DEFAULT 0 NOT NULL,
	"aggregate_known_cost_amount" numeric DEFAULT '0'::numeric NOT NULL,
	"unpriced_prompt_count" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runtime_state_adapter_type_check" CHECK (length(btrim("agent_runtime_state"."adapter_type")) between 1 and 200),
	CONSTRAINT "agent_runtime_state_last_run_check" CHECK ((
        "agent_runtime_state"."last_run_id" is null
        and "agent_runtime_state"."last_run_status" is null
      ) or (
        "agent_runtime_state"."last_run_id" is not null
        and "agent_runtime_state"."last_run_status" is not null
        and "agent_runtime_state"."last_run_status" in (
          'queued',
          'scheduled_retry',
          'running',
          'succeeded',
          'interrupted',
          'failed',
          'cancelled',
          'timed_out'
        )
      )),
	CONSTRAINT "agent_runtime_state_context_occupancy_check" CHECK ((
        "agent_runtime_state"."last_context_used_tokens" is null
        and "agent_runtime_state"."last_context_window_tokens" is null
      ) or (
        "agent_runtime_state"."last_context_used_tokens" is not null
        and "agent_runtime_state"."last_context_used_tokens" >= 0
        and "agent_runtime_state"."last_context_window_tokens" is not null
        and "agent_runtime_state"."last_context_window_tokens" > 0
        and "agent_runtime_state"."last_context_used_tokens" <= "agent_runtime_state"."last_context_window_tokens"
        and "agent_runtime_state"."peak_context_used_tokens" >= "agent_runtime_state"."last_context_used_tokens"
      )),
	CONSTRAINT "agent_runtime_state_aggregates_check" CHECK ("agent_runtime_state"."peak_context_used_tokens" >= 0
        and "agent_runtime_state"."unpriced_prompt_count" >= 0
        and "agent_runtime_state"."aggregate_known_cost_amount" >= 0
    and "agent_runtime_state"."aggregate_known_cost_amount" not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and "agent_runtime_state"."aggregate_known_cost_amount"::text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'),
	CONSTRAINT "agent_runtime_state_time_check" CHECK ("agent_runtime_state"."updated_at" >= "agent_runtime_state"."created_at")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"icon" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"reports_to" uuid,
	"capabilities" text,
	"adapter_type" text,
	"adapter_config" jsonb,
	"current_adapter_config_revision_id" uuid,
	"runtime_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_environment_id" uuid,
	"budget_monthly_amount" numeric NOT NULL,
	"pause_reason" text,
	"paused_at" timestamp with time zone,
	"error_reason" text,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "agents_budget_monthly_amount_check" CHECK ("agents"."budget_monthly_amount" >= 0
    and "agents"."budget_monthly_amount" not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and "agents"."budget_monthly_amount"::text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$')
);
--> statement-breakpoint
CREATE TABLE "approval_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"decision_note" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"original_filename" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "board_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"window_kind" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"threshold_type" text NOT NULL,
	"limit_amount" numeric NOT NULL,
	"observed_amount" numeric NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"approval_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_incidents_amounts_check" CHECK ("budget_incidents"."limit_amount" >= 0
    and "budget_incidents"."limit_amount" not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and "budget_incidents"."limit_amount"::text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'
        and "budget_incidents"."observed_amount" >= 0
    and "budget_incidents"."observed_amount" not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and "budget_incidents"."observed_amount"::text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$')
);
--> statement-breakpoint
CREATE TABLE "budget_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"window_kind" text NOT NULL,
	"limit_amount" numeric NOT NULL,
	"warn_percent" integer DEFAULT 80 NOT NULL,
	"hard_stop_enabled" boolean DEFAULT true NOT NULL,
	"notify_enabled" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_policies_limit_amount_check" CHECK ("budget_policies"."limit_amount" >= 0
    and "budget_policies"."limit_amount" not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and "budget_policies"."limit_amount"::text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'),
	CONSTRAINT "budget_policies_warn_percent_check" CHECK ("budget_policies"."warn_percent" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "case_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" text,
	"actor_agent_id" uuid,
	"run_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_events_kind_check" CHECK ("case_events"."kind" in (
        'created',
        'updated',
        'fields_changed',
        'status_changed',
        'issue_linked',
        'issue_unlinked',
        'document_revised',
        'child_linked',
        'attachment_added',
        'label_added',
        'label_removed'
      )),
	CONSTRAINT "case_events_actor_type_check" CHECK ("case_events"."actor_type" in ('user', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE "case_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_issue_links_role_check" CHECK ("case_issue_links"."role" in ('origin', 'work', 'reference'))
);
--> statement-breakpoint
CREATE TABLE "case_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"case_number" integer NOT NULL,
	"identifier" text NOT NULL,
	"case_type" text NOT NULL,
	"key" text,
	"title" text NOT NULL,
	"summary" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parent_case_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_status_check" CHECK ("cases"."status" in ('draft', 'in_progress', 'in_review', 'approved', 'done', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "change_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"target_key" text NOT NULL,
	"displayed_diff" text NOT NULL,
	"requested_by_agent_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision_reason" text,
	"decided_by_board_id" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_by_run_id" uuid,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_consents_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "change_consents_target_key_check" CHECK (length(btrim("change_consents"."target_key")) > 0),
	CONSTRAINT "change_consents_displayed_diff_check" CHECK (length(btrim("change_consents"."displayed_diff")) > 0),
	CONSTRAINT "change_consents_status_check" CHECK ("change_consents"."status" in ('pending', 'accepted', 'rejected', 'expired')),
	CONSTRAINT "change_consents_decision_check" CHECK (("change_consents"."status" in ('accepted', 'rejected') and "change_consents"."decided_at" is not null and "change_consents"."decided_by_board_id" is not null)
        or ("change_consents"."status" in ('pending', 'expired'))),
	CONSTRAINT "change_consents_consumption_check" CHECK (("change_consents"."consumed_at" is null and "change_consents"."consumed_by_run_id" is null)
        or ("change_consents"."status" = 'accepted' and "change_consents"."consumed_at" is not null and "change_consents"."consumed_by_run_id" is not null)),
	CONSTRAINT "change_consents_expiry_check" CHECK ("change_consents"."expires_at" > "change_consents"."created_at")
);
--> statement-breakpoint
CREATE TABLE "cli_auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_hash" text NOT NULL,
	"command" text NOT NULL,
	"client_name" text,
	"requested_access" text DEFAULT 'board' NOT NULL,
	"requested_company_id" uuid,
	"pending_key_hash" text NOT NULL,
	"pending_key_name" text NOT NULL,
	"approved_by_user_id" text,
	"board_api_key_id" uuid,
	"approved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_upstream_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"remote_url" text NOT NULL,
	"source_instance_id" text NOT NULL,
	"source_instance_fingerprint" text NOT NULL,
	"source_public_key" text NOT NULL,
	"private_key_pem" text NOT NULL,
	"token_status" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"authorized_global_user_id" text,
	"access_token" text,
	"token_id" text,
	"token_expires_at" timestamp with time zone,
	"target_stack_id" text NOT NULL,
	"target_stack_slug" text,
	"target_stack_display_name" text,
	"target_company_id" text NOT NULL,
	"target_origin" text NOT NULL,
	"target_primary_host" text NOT NULL,
	"target_product" text NOT NULL,
	"target_schema_major" integer NOT NULL,
	"target_max_chunk_bytes" integer NOT NULL,
	"pending_state" text,
	"pending_code_verifier" text,
	"pending_redirect_uri" text,
	"pending_token_url" text,
	"last_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_upstream_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"remote_run_id" text,
	"status" text NOT NULL,
	"active_step" text NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"retry_of_run_id" uuid,
	"summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"target_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"pause_reason" text,
	"paused_at" timestamp with time zone,
	"issue_prefix" text DEFAULT 'PAP' NOT NULL,
	"issue_counter" integer DEFAULT 0 NOT NULL,
	"budget_currency" text NOT NULL,
	"budget_monthly_amount" numeric NOT NULL,
	"attachment_max_bytes" integer DEFAULT 10485760 NOT NULL,
	"default_responsible_user_id" text,
	"require_board_approval_for_new_agents" boolean DEFAULT false NOT NULL,
	"feedback_data_sharing_enabled" boolean DEFAULT false NOT NULL,
	"feedback_data_sharing_consent_at" timestamp with time zone,
	"feedback_data_sharing_consent_by_user_id" text,
	"feedback_data_sharing_terms_version" text,
	"session_compaction" jsonb,
	"session_integrity_state" text DEFAULT 'ready' NOT NULL,
	"session_integrity_ready_at" timestamp with time zone DEFAULT now(),
	"session_lifecycle_generation" bigint DEFAULT 0 NOT NULL,
	"hard_delete_fenced_at" timestamp with time zone,
	"brand_color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_id_budget_currency_uq" UNIQUE("id","budget_currency"),
	CONSTRAINT "companies_budget_currency_check" CHECK ("companies"."budget_currency" in ('AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY', 'COP', 'CRC', 'CUC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HRK', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SLL', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'UYU', 'UZS', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XCG', 'XDR', 'XOF', 'XPF', 'XSU', 'YER', 'ZAR', 'ZMW', 'ZWG', 'ZWL')),
	CONSTRAINT "companies_budget_monthly_amount_check" CHECK ("companies"."budget_monthly_amount" >= 0
    and "companies"."budget_monthly_amount" not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and "companies"."budget_monthly_amount"::text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'),
	CONSTRAINT "companies_session_integrity_state_check" CHECK ("companies"."session_integrity_state" in (
        'ready',
        'archive_fenced',
        'hard_delete_fenced'
      )),
	CONSTRAINT "companies_session_integrity_ready_check" CHECK ((
        "companies"."session_integrity_state" = 'ready'
        and "companies"."session_integrity_ready_at" is not null
      ) or (
        "companies"."session_integrity_state" <> 'ready'
      )),
	CONSTRAINT "companies_session_compaction_check" CHECK ("companies"."session_compaction" is null
        or (
          jsonb_typeof("companies"."session_compaction") = 'object'
          and "companies"."session_compaction"
            - 'auto'
            - 'prune'
            - 'reserved'
            - 'tail_turns'
            - 'preserve_recent_tokens'
            - 'modelRef' = '{}'::jsonb
          and (
            not ("companies"."session_compaction" ? 'auto')
            or jsonb_typeof("companies"."session_compaction" -> 'auto') = 'boolean'
          )
          and (
            not ("companies"."session_compaction" ? 'prune')
            or jsonb_typeof("companies"."session_compaction" -> 'prune') = 'boolean'
          )
          and (
            not ("companies"."session_compaction" ? 'reserved')
            or (
              jsonb_typeof("companies"."session_compaction" -> 'reserved') = 'number'
              and ("companies"."session_compaction" ->> 'reserved') ~ '^(0|[1-9][0-9]*)$'
            )
          )
          and (
            not ("companies"."session_compaction" ? 'tail_turns')
            or (
              jsonb_typeof("companies"."session_compaction" -> 'tail_turns') = 'number'
              and ("companies"."session_compaction" ->> 'tail_turns') ~ '^(0|[1-9][0-9]*)$'
            )
          )
          and (
            not ("companies"."session_compaction" ? 'preserve_recent_tokens')
            or (
              jsonb_typeof("companies"."session_compaction" -> 'preserve_recent_tokens') = 'number'
              and ("companies"."session_compaction" ->> 'preserve_recent_tokens') ~ '^(0|[1-9][0-9]*)$'
            )
          )
          and (
            not ("companies"."session_compaction" ? 'modelRef')
            or (
              jsonb_typeof("companies"."session_compaction" -> 'modelRef') = 'string'
              and btrim("companies"."session_compaction" ->> 'modelRef') <> ''
              and length(btrim("companies"."session_compaction" ->> 'modelRef')) <= 500
            )
          )
        ))
);
--> statement-breakpoint
CREATE TABLE "company_logos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_user_id" text,
	"principal_agent_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"membership_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_memberships_principal_shape_check" CHECK ((
        "company_memberships"."principal_type" = 'user'
        and "company_memberships"."principal_user_id" is not null
        and "company_memberships"."principal_agent_id" is null
      ) or (
        "company_memberships"."principal_type" = 'agent'
        and "company_memberships"."principal_user_id" is null
        and "company_memberships"."principal_agent_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "company_secret_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"config_path" text NOT NULL,
	"version_selector" text DEFAULT 'latest' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"label" text,
	"projection_class" text DEFAULT 'unclassified' NOT NULL,
	"projection_allowlist_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_secret_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health_status" text,
	"health_checked_at" timestamp with time zone,
	"health_message" text,
	"health_details" jsonb,
	"disabled_at" timestamp with time zone,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_secret_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"material" jsonb NOT NULL,
	"value_sha256" text NOT NULL,
	"provider_version_ref" text,
	"status" text DEFAULT 'current' NOT NULL,
	"fingerprint_sha256" text NOT NULL,
	"rotation_job_id" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "company_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope" text DEFAULT 'company' NOT NULL,
	"owner_user_id" text,
	"user_secret_definition_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'local_encrypted' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"managed_mode" text DEFAULT 'paperclip_managed' NOT NULL,
	"external_ref" text,
	"provider_config_id" uuid,
	"provider_metadata" jsonb,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"description" text,
	"last_resolved_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_secrets_scope_shape_check" CHECK ((
        "company_secrets"."scope" = 'company'
        and "company_secrets"."owner_user_id" is null
        and "company_secrets"."user_secret_definition_id" is null
      ) or (
        "company_secrets"."scope" = 'user'
        and "company_secrets"."owner_user_id" is not null
        and "company_secrets"."user_secret_definition_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "company_session_lifecycle_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"operation" text NOT NULL,
	"status" text DEFAULT 'fenced' NOT NULL,
	"fence_token" text NOT NULL,
	"session_graph_snapshot" jsonb NOT NULL,
	"failure_reason" text,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"fenced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelling_at" timestamp with time zone,
	"purge_ready_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_session_lifecycle_operations_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "company_session_lifecycle_operations_operation_check" CHECK ("company_session_lifecycle_operations"."operation" in ('archive', 'hard_delete')),
	CONSTRAINT "company_session_lifecycle_operations_status_check" CHECK ("company_session_lifecycle_operations"."status" in ('fenced', 'cancelling', 'purge_ready', 'completed', 'failed')),
	CONSTRAINT "company_session_lifecycle_operations_terminal_time_check" CHECK ((
        "company_session_lifecycle_operations"."status" = 'completed'
        and "company_session_lifecycle_operations"."completed_at" is not null
        and "company_session_lifecycle_operations"."failed_at" is null
      ) or (
        "company_session_lifecycle_operations"."status" = 'failed'
        and "company_session_lifecycle_operations"."failed_at" is not null
        and "company_session_lifecycle_operations"."completed_at" is null
        and "company_session_lifecycle_operations"."failure_reason" is not null
      ) or "company_session_lifecycle_operations"."status" in ('fenced', 'cancelling', 'purge_ready'))
);
--> statement-breakpoint
CREATE TABLE "company_skill_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"company_skill_id" uuid NOT NULL,
	"parent_comment_id" uuid,
	"author_agent_id" uuid,
	"author_user_id" text,
	"body" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_skill_policies" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"revision" integer NOT NULL,
	"default_effect" text NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_skill_stars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"company_skill_id" uuid NOT NULL,
	"agent_id" uuid,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_skill_test_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"created_by" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_skill_test_run_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"body" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_skill_test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"input_id" uuid,
	"input_snapshot" text NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_config_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issue_id" uuid NOT NULL,
	"template_id" text,
	"template_name" text,
	"template_body" text,
	"rendered_template_body" text,
	"harness_issue_request" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"output_document_key" text DEFAULT 'output' NOT NULL,
	"output_snapshot" text DEFAULT '' NOT NULL,
	"error" text,
	"deleted_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"harness_issue_expires_at" timestamp with time zone,
	"harness_issue_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"company_skill_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"label" text,
	"file_inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_skill_versions_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "company_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"folder_id" uuid,
	"key" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"markdown" text NOT NULL,
	"source_type" text DEFAULT 'local_path' NOT NULL,
	"source_locator" text,
	"source_ref" text,
	"trust_level" text DEFAULT 'markdown_only' NOT NULL,
	"compatibility" text DEFAULT 'compatible' NOT NULL,
	"file_inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"icon_url" text,
	"color" text,
	"tagline" text,
	"author_name" text,
	"homepage_url" text,
	"categories" text[] DEFAULT '{}' NOT NULL,
	"sharing_scope" text DEFAULT 'company' NOT NULL,
	"public_share_token" text,
	"forked_from_skill_id" uuid,
	"forked_from_company_id" uuid,
	"star_count" integer DEFAULT 0 NOT NULL,
	"install_count" integer DEFAULT 0 NOT NULL,
	"fork_count" integer DEFAULT 0 NOT NULL,
	"current_version_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_skills_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "company_user_sidebar_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"project_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_user_id" text,
	"provider_tenant" jsonb,
	"credential_secret_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_agent_id" uuid,
	"revoked_by_user_id" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_grants_kind_check" CHECK ("connection_grants"."kind" in ('workspace', 'user')),
	CONSTRAINT "connection_grants_status_check" CHECK ("connection_grants"."status" in ('active', 'revoked', 'expired', 'needs_reauthorization')),
	CONSTRAINT "connection_grants_subject_check" CHECK (("connection_grants"."kind" = 'user' and "connection_grants"."subject_user_id" is not null) or ("connection_grants"."kind" = 'workspace' and "connection_grants"."subject_user_id" is null)),
	CONSTRAINT "connection_grants_default_check" CHECK ("connection_grants"."is_default" = false or "connection_grants"."kind" = 'workspace')
);
--> statement-breakpoint
CREATE TABLE "cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accounting_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"run_kind" text NOT NULL,
	"prompt_kind" text NOT NULL,
	"ref_id" uuid,
	"run_ordinal" integer,
	"segment_ordinal" integer,
	"compaction_control_id" uuid,
	"budget_currency" text NOT NULL,
	"kind" text NOT NULL,
	"unavailable_reason" text,
	"observed_cumulative_amount" numeric,
	"observed_currency" text,
	"known_delta_amount" numeric,
	"cursor_before_state" text NOT NULL,
	"cursor_before_amount" numeric,
	"cursor_before_currency" text,
	"cursor_after_state" text NOT NULL,
	"cursor_after_amount" numeric,
	"cursor_after_currency" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_events_accounting_uq" UNIQUE("accounting_id"),
	CONSTRAINT "cost_events_compaction_settlement_owner_uq" UNIQUE("company_id","issue_id","run_id","compaction_control_id","accounting_id","id"),
	CONSTRAINT "cost_events_prompt_identity_check" CHECK ((
        "cost_events"."prompt_kind" = 'base'
        and "cost_events"."run_kind" in ('productive', 'consult')
        and "cost_events"."ref_id" is not null
        and "cost_events"."run_ordinal" is not null
        and "cost_events"."run_ordinal" >= 0
        and "cost_events"."segment_ordinal" is not null
        and "cost_events"."segment_ordinal" = 0
        and "cost_events"."compaction_control_id" is null
      ) or (
        "cost_events"."prompt_kind" = 'steering'
        and "cost_events"."run_kind" in ('productive', 'consult')
        and "cost_events"."ref_id" is not null
        and "cost_events"."run_ordinal" is not null
        and "cost_events"."run_ordinal" >= 0
        and "cost_events"."segment_ordinal" is not null
        and "cost_events"."segment_ordinal" > 0
        and "cost_events"."compaction_control_id" is null
      ) or (
        "cost_events"."prompt_kind" = 'compaction'
        and "cost_events"."run_kind" = 'compaction'
        and "cost_events"."ref_id" is null
        and "cost_events"."run_ordinal" is null
        and "cost_events"."segment_ordinal" is null
        and "cost_events"."compaction_control_id" is not null
      )),
	CONSTRAINT "cost_events_amounts_check" CHECK (("cost_events"."observed_cumulative_amount" is null
          or ("cost_events"."observed_cumulative_amount" >= 0
    and "cost_events"."observed_cumulative_amount" not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and "cost_events"."observed_cumulative_amount"::text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'))
        and ("cost_events"."known_delta_amount" is null
          or ("cost_events"."known_delta_amount" >= 0
    and "cost_events"."known_delta_amount" not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and "cost_events"."known_delta_amount"::text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'))
        and ("cost_events"."cursor_before_amount" is null
          or ("cost_events"."cursor_before_amount" >= 0
    and "cost_events"."cursor_before_amount" not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and "cost_events"."cursor_before_amount"::text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'))
        and ("cost_events"."cursor_after_amount" is null
          or ("cost_events"."cursor_after_amount" >= 0
    and "cost_events"."cursor_after_amount" not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and "cost_events"."cursor_after_amount"::text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'))),
	CONSTRAINT "cost_events_observed_pair_check" CHECK ((
        "cost_events"."observed_cumulative_amount" is null
        and "cost_events"."observed_currency" is null
      ) or (
        "cost_events"."observed_cumulative_amount" is not null
        and "cost_events"."observed_currency" is not null
        and length("cost_events"."observed_currency") > 0
        and "cost_events"."observed_currency" = btrim("cost_events"."observed_currency")
      )),
	CONSTRAINT "cost_events_cursor_before_check" CHECK ((
        "cost_events"."cursor_before_state" = 'unanchored'
        and "cost_events"."cursor_before_amount" is null
        and "cost_events"."cursor_before_currency" is null
      ) or (
        "cost_events"."cursor_before_state" = 'known'
        and "cost_events"."cursor_before_amount" is not null
        and "cost_events"."cursor_before_currency" is not null
        and "cost_events"."cursor_before_currency" = "cost_events"."budget_currency"
      ) or (
        "cost_events"."cursor_before_state" = 'unavailable'
        and "cost_events"."cursor_before_amount" is null
        and "cost_events"."cursor_before_currency" is null
      )),
	CONSTRAINT "cost_events_cursor_after_check" CHECK ((
        "cost_events"."cursor_after_state" = 'known'
        and "cost_events"."cursor_after_amount" is not null
        and "cost_events"."cursor_after_currency" is not null
        and "cost_events"."cursor_after_currency" = "cost_events"."budget_currency"
      ) or (
        "cost_events"."cursor_after_state" = 'unavailable'
        and "cost_events"."cursor_after_amount" is null
        and "cost_events"."cursor_after_currency" is null
      )),
	CONSTRAINT "cost_events_transition_check" CHECK ((
        "cost_events"."kind" = 'known'
        and "cost_events"."unavailable_reason" is null
        and "cost_events"."observed_cumulative_amount" is not null
        and "cost_events"."observed_currency" = "cost_events"."budget_currency"
        and "cost_events"."known_delta_amount" is not null
        and "cost_events"."cursor_after_state" = 'known'
        and "cost_events"."cursor_after_amount" = "cost_events"."observed_cumulative_amount"
        and (
          (
            "cost_events"."cursor_before_state" = 'unanchored'
            and "cost_events"."known_delta_amount" = "cost_events"."observed_cumulative_amount"
          ) or (
            "cost_events"."cursor_before_state" = 'known'
            and "cost_events"."observed_cumulative_amount" >= "cost_events"."cursor_before_amount"
            and "cost_events"."known_delta_amount"
              = "cost_events"."observed_cumulative_amount" - "cost_events"."cursor_before_amount"
          )
        )
      ) or (
        "cost_events"."kind" = 'unavailable'
        and "cost_events"."unavailable_reason" is not null
        and "cost_events"."unavailable_reason" in (
          'absent',
          'malformed',
          'decreasing',
          'currency_mismatch',
          'reanchor_after_unavailable'
        )
        and "cost_events"."known_delta_amount" is null
        and (
          (
            "cost_events"."unavailable_reason" in ('absent', 'malformed')
            and "cost_events"."observed_cumulative_amount" is null
            and "cost_events"."observed_currency" is null
            and "cost_events"."cursor_after_state" = 'unavailable'
          ) or (
            "cost_events"."unavailable_reason" = 'decreasing'
            and "cost_events"."cursor_before_state" = 'known'
            and "cost_events"."observed_cumulative_amount" is not null
            and "cost_events"."observed_currency" = "cost_events"."budget_currency"
            and "cost_events"."observed_cumulative_amount" < "cost_events"."cursor_before_amount"
            and "cost_events"."cursor_after_state" = 'unavailable'
          ) or (
            "cost_events"."unavailable_reason" = 'currency_mismatch'
            and "cost_events"."observed_cumulative_amount" is not null
            and "cost_events"."observed_currency" is not null
            and "cost_events"."observed_currency" <> "cost_events"."budget_currency"
            and "cost_events"."cursor_after_state" = 'unavailable'
          ) or (
            "cost_events"."unavailable_reason" = 'reanchor_after_unavailable'
            and "cost_events"."cursor_before_state" = 'unavailable'
            and "cost_events"."observed_cumulative_amount" is not null
            and "cost_events"."observed_currency" = "cost_events"."budget_currency"
            and "cost_events"."cursor_after_state" = 'known'
            and "cost_events"."cursor_after_amount" = "cost_events"."observed_cumulative_amount"
          )
        )
      )),
	CONSTRAINT "cost_events_compaction_cursor_check" CHECK ("cost_events"."run_kind" <> 'compaction'
        or "cost_events"."cursor_before_state" = 'unanchored')
);
--> statement-breakpoint
CREATE TABLE "creator_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"creator_edge_id" uuid NOT NULL,
	"issue_update_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_ref" jsonb NOT NULL,
	"direction" text NOT NULL,
	"counterpart_execution_key" text NOT NULL,
	"committed_sequence" integer NOT NULL,
	"delivery_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"first_queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"held_since" timestamp with time zone,
	"hold_reason" text,
	"first_attempt_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"first_leased_at" timestamp with time zone,
	"leased_at" timestamp with time zone,
	"lease_owner" text,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"last_failure" text,
	"delivered_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"terminal_reason" text,
	"counterpart_ref_id" uuid,
	"fallback_audit" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_deliveries_scope_id_uq" UNIQUE("company_id","issue_id","ownership_epoch","id"),
	CONSTRAINT "creator_deliveries_company_issue_id_uq" UNIQUE("company_id","issue_id","id"),
	CONSTRAINT "creator_deliveries_recipient_kind_check" CHECK ("creator_deliveries"."recipient_kind" in ('agent-execution', 'user/board', 'plugin', 'routine', 'system')),
	CONSTRAINT "creator_deliveries_direction_check" CHECK ("creator_deliveries"."direction" in ('to_creator', 'to_owner')),
	CONSTRAINT "creator_deliveries_committed_sequence_check" CHECK ("creator_deliveries"."committed_sequence" >= 0),
	CONSTRAINT "creator_deliveries_state_check" CHECK ("creator_deliveries"."state" in (
        'pending',
        'leased',
        'retryable',
        'delivered',
        'exhausted',
        'permanently_unreceivable'
      )),
	CONSTRAINT "creator_deliveries_terminal_check" CHECK ((
        "creator_deliveries"."state" = 'delivered'
        and "creator_deliveries"."delivered_at" is not null
        and "creator_deliveries"."terminal_at" is not null
      ) or (
        "creator_deliveries"."state" in ('exhausted', 'permanently_unreceivable')
        and "creator_deliveries"."terminal_at" is not null
        and "creator_deliveries"."terminal_reason" is not null
      ) or "creator_deliveries"."state" in ('pending', 'leased', 'retryable'))
);
--> statement-breakpoint
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
CREATE TABLE "document_annotation_anchor_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"from_revision_id" uuid,
	"from_revision_number" integer,
	"to_revision_id" uuid,
	"to_revision_number" integer NOT NULL,
	"previous_anchor" jsonb NOT NULL,
	"next_anchor" jsonb,
	"anchor_state" text NOT NULL,
	"anchor_confidence" text NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_annotation_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"issue_id" uuid,
	"routine_id" uuid,
	"case_id" uuid,
	"document_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_type" text NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"created_by_run_id" uuid,
	"issue_comment_id" uuid,
	"source_trust" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_annotation_comments_exactly_one_owner_chk" CHECK (num_nonnulls("document_annotation_comments"."issue_id", "document_annotation_comments"."routine_id", "document_annotation_comments"."case_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "document_annotation_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid,
	"routine_id" uuid,
	"case_id" uuid,
	"document_id" uuid NOT NULL,
	"document_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"anchor_state" text DEFAULT 'active' NOT NULL,
	"original_revision_id" uuid,
	"original_revision_number" integer NOT NULL,
	"current_revision_id" uuid,
	"current_revision_number" integer NOT NULL,
	"selected_text" text NOT NULL,
	"prefix_text" text DEFAULT '' NOT NULL,
	"suffix_text" text DEFAULT '' NOT NULL,
	"normalized_start" integer NOT NULL,
	"normalized_end" integer NOT NULL,
	"markdown_start" integer NOT NULL,
	"markdown_end" integer NOT NULL,
	"anchor_confidence" text DEFAULT 'exact' NOT NULL,
	"anchor_selector" jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"resolved_by_agent_id" uuid,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_annotation_threads_exactly_one_owner_chk" CHECK (num_nonnulls("document_annotation_threads"."issue_id", "document_annotation_threads"."routine_id", "document_annotation_threads"."case_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "document_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"title" text,
	"format" text DEFAULT 'markdown' NOT NULL,
	"body" text NOT NULL,
	"change_summary" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"source_issue_comment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text,
	"format" text DEFAULT 'markdown' NOT NULL,
	"latest_body" text NOT NULL,
	"latest_revision_id" uuid,
	"latest_revision_number" integer DEFAULT 1 NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"locked_at" timestamp with time zone,
	"locked_by_agent_id" uuid,
	"locked_by_user_id" text,
	"source_trust" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_custom_image_setup_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"template_id" uuid,
	"promoted_template_id" uuid,
	"provider" text NOT NULL,
	"provider_lease_id" text,
	"environment_lease_id" uuid,
	"status" text DEFAULT 'starting' NOT NULL,
	"started_by_user_id" text,
	"started_by_agent_id" uuid,
	"base_template_ref" text,
	"expires_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"failure_reason" text,
	"connection_summary" jsonb,
	"connection_secret_ref" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_custom_image_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"template_kind" text DEFAULT 'unknown' NOT NULL,
	"template_ref" text NOT NULL,
	"source_template_ref" text,
	"source_environment_config_fingerprint" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"captured_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"superseded_by_template_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"execution_workspace_id" uuid,
	"issue_id" uuid,
	"run_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"lease_policy" text DEFAULT 'ephemeral' NOT NULL,
	"provider" text,
	"provider_lease_id" text,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"failure_reason" text,
	"cleanup_status" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_leases_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "environment_leases_company_id_run_uq" UNIQUE("company_id","id","run_id")
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"driver" text DEFAULT 'local' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"env_vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"project_workspace_id" uuid,
	"workspace_class" text DEFAULT 'project' NOT NULL,
	"source_issue_id" uuid,
	"mode" text NOT NULL,
	"strategy_type" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cwd" text,
	"repo_url" text,
	"base_ref" text,
	"branch_name" text,
	"provider_type" text DEFAULT 'local_fs' NOT NULL,
	"provider_ref" text,
	"derived_from_execution_workspace_id" uuid,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"cleanup_eligible_at" timestamp with time zone,
	"cleanup_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_workspaces_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "execution_workspaces_class_check" CHECK ((
        "execution_workspaces"."workspace_class" = 'project'
        and "execution_workspaces"."project_id" is not null
      ) or (
        "execution_workspaces"."workspace_class" = 'projectless'
        and "execution_workspaces"."project_id" is null
        and "execution_workspaces"."project_workspace_id" is null
        and "execution_workspaces"."cwd" is not null
        and left("execution_workspaces"."cwd", 1) = '/'
      ))
);
--> statement-breakpoint
CREATE TABLE "external_object_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_record_id" uuid,
	"document_key" text,
	"property_key" text,
	"matched_text_redacted" text,
	"sanitized_display_url" text,
	"canonical_identity_hash" text,
	"canonical_identity" jsonb,
	"object_id" uuid,
	"provider_key" text,
	"detector_key" text,
	"object_type" text,
	"confidence" text DEFAULT 'exact' NOT NULL,
	"created_by_plugin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"plugin_id" uuid,
	"object_type" text NOT NULL,
	"external_id" text NOT NULL,
	"sanitized_canonical_url" text,
	"canonical_identity_hash" text,
	"display_key" text,
	"icon_key" text,
	"display_title" text,
	"status_key" text,
	"status_label" text,
	"status_icon_key" text,
	"status_category" text DEFAULT 'unknown' NOT NULL,
	"status_tone" text DEFAULT 'neutral' NOT NULL,
	"liveness" text DEFAULT 'unknown' NOT NULL,
	"is_terminal" boolean DEFAULT false NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"remote_version" text,
	"etag" text,
	"last_resolved_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"next_refresh_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"feedback_vote_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"project_id" uuid,
	"author_user_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"vote" text NOT NULL,
	"status" text DEFAULT 'local_only' NOT NULL,
	"destination" text,
	"export_id" text,
	"consent_version" text,
	"schema_version" text DEFAULT 'paperclip-feedback-envelope-v2' NOT NULL,
	"bundle_version" text DEFAULT 'paperclip-feedback-bundle-v2' NOT NULL,
	"payload_version" text DEFAULT 'paperclip-feedback-v1' NOT NULL,
	"payload_digest" text,
	"payload_snapshot" jsonb,
	"target_summary" jsonb NOT NULL,
	"redaction_summary" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"exported_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"vote" text NOT NULL,
	"reason" text,
	"shared_with_labs" boolean DEFAULT false NOT NULL,
	"shared_at" timestamp with time zone,
	"consent_version" text,
	"redaction_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"issue_id" uuid,
	"project_id" uuid,
	"goal_id" uuid,
	"billing_code" text,
	"description" text,
	"event_kind" text NOT NULL,
	"direction" text DEFAULT 'debit' NOT NULL,
	"biller" text NOT NULL,
	"provider" text,
	"execution_adapter_type" text,
	"pricing_tier" text,
	"region" text,
	"model" text,
	"quantity" integer,
	"unit" text,
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"estimated" boolean DEFAULT false NOT NULL,
	"external_invoice_id" text,
	"metadata_json" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_events_amount_check" CHECK ("finance_events"."amount" >= 0
    and "finance_events"."amount" not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and "finance_events"."amount"::text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'),
	CONSTRAINT "finance_events_currency_check" CHECK ("finance_events"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_events_direction_check" CHECK ("finance_events"."direction" in ('debit', 'credit'))
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"system_key" text,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"level" text DEFAULT 'issue' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"parent_id" uuid,
	"owner_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"item_key" text NOT NULL,
	"kind" text DEFAULT 'dismiss' NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snoozed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'default' NOT NULL,
	"default_environment_id" uuid,
	"general" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"creator_delivery" jsonb,
	"experimental" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_settings_creator_delivery_check" CHECK ("instance_settings"."creator_delivery" is null
        or (
          jsonb_typeof("instance_settings"."creator_delivery") = 'object'
          and ("instance_settings"."creator_delivery" ->> 'maxRetryAttempts')::integer > 0
          and ("instance_settings"."creator_delivery" ->> 'retryBaseDelayMs')::integer > 0
          and ("instance_settings"."creator_delivery" ->> 'retryMaxDelayMs')::integer
            >= ("instance_settings"."creator_delivery" ->> 'retryBaseDelayMs')::integer
          and ("instance_settings"."creator_delivery" ->> 'pausedOrBudgetStoppedStalenessMs')::integer > 0
        ))
);
--> statement-breakpoint
CREATE TABLE "instance_user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'instance_admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"invite_type" text DEFAULT 'company_join' NOT NULL,
	"token_hash" text NOT NULL,
	"allowed_join_types" text DEFAULT 'both' NOT NULL,
	"defaults_payload" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"invited_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_source_check" CHECK ("invites"."source" IN ('board_api', 'plugin_host', 'bootstrap_admin_cli')),
	CONSTRAINT "invites_source_principal_check" CHECK ((
        ("invites"."source" = 'board_api' AND "invites"."invited_by_user_id" IS NOT NULL)
        OR
        ("invites"."source" IN ('plugin_host', 'bootstrap_admin_cli') AND "invites"."invited_by_user_id" IS NULL)
      )),
	CONSTRAINT "invites_bootstrap_shape_check" CHECK ((
        (
          "invites"."source" = 'bootstrap_admin_cli'
          AND "invites"."invite_type" = 'bootstrap_admin'
          AND "invites"."company_id" IS NULL
          AND "invites"."allowed_join_types" = 'human'
        )
        OR
        (
          "invites"."source" <> 'bootstrap_admin_cli'
          AND "invites"."invite_type" = 'company_join'
          AND "invites"."company_id" IS NOT NULL
        )
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_approvals" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"linked_by_agent_id" uuid,
	"linked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_approvals_pk" PRIMARY KEY("issue_id","approval_id")
);
--> statement-breakpoint
CREATE TABLE "issue_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"issue_comment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_board_lifecycle_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"actor_user_id" text NOT NULL,
	"subtype" text NOT NULL,
	"source_command_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "issue_board_lifecycle_commands_source_issue_uq" UNIQUE("company_id","issue_id","source_command_id"),
	CONSTRAINT "issue_board_lifecycle_commands_idempotency_issue_uq" UNIQUE("company_id","issue_id","idempotency_key"),
	CONSTRAINT "issue_board_lifecycle_commands_epoch_check" CHECK ("issue_board_lifecycle_commands"."ownership_epoch" > 0),
	CONSTRAINT "issue_board_lifecycle_commands_actor_check" CHECK (length(btrim("issue_board_lifecycle_commands"."actor_user_id")) > 0),
	CONSTRAINT "issue_board_lifecycle_commands_subtype_check" CHECK ("issue_board_lifecycle_commands"."subtype" in (
        'execution_policy_configure',
        'execution_policy_decision',
        'tree_control_pause',
        'tree_control_resume',
        'tree_control_cancel',
        'tree_control_restore',
        'tree_control_release'
      )),
	CONSTRAINT "issue_board_lifecycle_commands_idempotency_check" CHECK (length(btrim("issue_board_lifecycle_commands"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "issue_board_reopen_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"identity_digest" text NOT NULL,
	"prior_status" text NOT NULL,
	"prior_disposition" jsonb NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"branch" text NOT NULL,
	"preserved_owner_kind" text NOT NULL,
	"continuity_fence_generation" integer NOT NULL,
	"creator_edge_id" uuid NOT NULL,
	"execution_ref_id" uuid,
	"system_escalation_identity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_board_reopen_commands_actor_check" CHECK (length(btrim("issue_board_reopen_commands"."actor_user_id")) > 0),
	CONSTRAINT "issue_board_reopen_commands_reason_check" CHECK (length(btrim("issue_board_reopen_commands"."reason")) > 0),
	CONSTRAINT "issue_board_reopen_commands_prior_status_check" CHECK ("issue_board_reopen_commands"."prior_status" in ('done', 'cancelled')),
	CONSTRAINT "issue_board_reopen_commands_epoch_check" CHECK ("issue_board_reopen_commands"."ownership_epoch" > 0
        and "issue_board_reopen_commands"."continuity_fence_generation" > 0),
	CONSTRAINT "issue_board_reopen_commands_branch_check" CHECK ((
        "issue_board_reopen_commands"."branch" = 'agent_execution'
        and "issue_board_reopen_commands"."preserved_owner_kind" = 'agent'
        and "issue_board_reopen_commands"."execution_ref_id" is not null
        and "issue_board_reopen_commands"."system_escalation_identity_id" is null
      ) or (
        "issue_board_reopen_commands"."branch" = 'board_only'
        and "issue_board_reopen_commands"."preserved_owner_kind" in ('user', 'board')
        and "issue_board_reopen_commands"."execution_ref_id" is null
        and "issue_board_reopen_commands"."system_escalation_identity_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_board_user_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"actor_user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"identity_digest" text NOT NULL,
	"mention_target_agent_id" uuid,
	"comment_id" uuid NOT NULL,
	"execution_ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_board_user_comments_actor_check" CHECK (length(btrim("issue_board_user_comments"."actor_user_id")) > 0),
	CONSTRAINT "issue_board_user_comments_epoch_check" CHECK ("issue_board_user_comments"."ownership_epoch" > 0),
	CONSTRAINT "issue_board_user_comments_mention_shape_check" CHECK ((
        "issue_board_user_comments"."mention_target_agent_id" is null
        and "issue_board_user_comments"."execution_ref_id" is null
      ) or (
        "issue_board_user_comments"."mention_target_agent_id" is not null
        and "issue_board_user_comments"."execution_ref_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_comment_projection_sources" (
	"comment_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"message_id" text NOT NULL,
	"run_id" uuid,
	"steering_target_run_id" uuid,
	"reply_to_comment_id" uuid,
	"reply_to_projected_event_seq" bigint,
	"thread_root_comment_id" uuid,
	"thread_root_projected_event_seq" bigint,
	"ref_id" uuid,
	"ref_ordinal" integer,
	"segment_ordinal" integer,
	"terminal_session_message_id" text,
	"admitted_event_seq" bigint,
	"promoted_event_seq" bigint,
	"projected_event_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_comment_projection_sources_kind_check" CHECK ("issue_comment_projection_sources"."source_kind" in (
        'issue_request',
        'human_comment',
        'harness_delivery',
        'system_control',
        'run_output',
        'run_progress',
        'issue_update',
        'plugin_withdrawal'
      )),
	CONSTRAINT "issue_comment_projection_sources_run_check" CHECK ((
        "issue_comment_projection_sources"."source_kind" in ('run_output', 'run_progress')
        and "issue_comment_projection_sources"."run_id" is not null
      ) or (
        "issue_comment_projection_sources"."source_kind" not in ('run_output', 'run_progress')
      )),
	CONSTRAINT "issue_comment_projection_sources_reply_shape_check" CHECK ((
        "issue_comment_projection_sources"."reply_to_comment_id" is null
        and "issue_comment_projection_sources"."reply_to_projected_event_seq" is null
        and "issue_comment_projection_sources"."thread_root_comment_id" is null
        and "issue_comment_projection_sources"."thread_root_projected_event_seq" is null
      ) or (
        "issue_comment_projection_sources"."reply_to_comment_id" is not null
        and "issue_comment_projection_sources"."reply_to_projected_event_seq" is not null
        and "issue_comment_projection_sources"."thread_root_comment_id" is not null
        and "issue_comment_projection_sources"."thread_root_projected_event_seq" is not null
      )),
	CONSTRAINT "issue_comment_projection_sources_reply_order_check" CHECK ("issue_comment_projection_sources"."reply_to_projected_event_seq" is null
        or "issue_comment_projection_sources"."reply_to_projected_event_seq" < "issue_comment_projection_sources"."projected_event_seq"),
	CONSTRAINT "issue_comment_projection_sources_steering_segment_shape_check" CHECK ((
        "issue_comment_projection_sources"."steering_target_run_id" is null
        and "issue_comment_projection_sources"."ref_id" is null
        and "issue_comment_projection_sources"."ref_ordinal" is null
        and "issue_comment_projection_sources"."segment_ordinal" is null
      ) or (
        "issue_comment_projection_sources"."steering_target_run_id" is not null
        and "issue_comment_projection_sources"."ref_id" is not null
        and "issue_comment_projection_sources"."ref_ordinal" is not null
        and "issue_comment_projection_sources"."ref_ordinal" >= 0
        and "issue_comment_projection_sources"."segment_ordinal" is not null
        and "issue_comment_projection_sources"."segment_ordinal" > 0
      )),
	CONSTRAINT "issue_comment_projection_sources_terminal_dependency_check" CHECK ("issue_comment_projection_sources"."terminal_session_message_id" is null
        or "issue_comment_projection_sources"."source_kind" = 'run_progress'),
	CONSTRAINT "issue_comment_projection_sources_sequence_check" CHECK (("issue_comment_projection_sources"."admitted_event_seq" is null
          or "issue_comment_projection_sources"."projected_event_seq" = "issue_comment_projection_sources"."admitted_event_seq")
        and (
          "issue_comment_projection_sources"."promoted_event_seq" is null
          or "issue_comment_projection_sources"."admitted_event_seq" is null
          or "issue_comment_projection_sources"."promoted_event_seq" >= "issue_comment_projection_sources"."admitted_event_seq"
        ))
);
--> statement-breakpoint
CREATE TABLE "issue_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"author_plugin_installation_id" uuid,
	"author_plugin_key" text,
	"author_type" text NOT NULL,
	"run_id" uuid,
	"session_id" text NOT NULL,
	"canonical_source_kind" text NOT NULL,
	"canonical_source_id" text NOT NULL,
	"canonical_message_id" text NOT NULL,
	"admitted_event_seq" bigint NOT NULL,
	"promoted_event_seq" bigint,
	"projected_event_seq" bigint NOT NULL,
	"reply_to_comment_id" uuid,
	"reply_to_projected_event_seq" bigint,
	"thread_root_comment_id" uuid,
	"thread_root_projected_event_seq" bigint,
	"body" text NOT NULL,
	"presentation" jsonb,
	"metadata" jsonb,
	"source_trust" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_comments_projected_identity_uq" UNIQUE("company_id","issue_id","id","projected_event_seq"),
	CONSTRAINT "issue_comments_scope_identity_uq" UNIQUE("company_id","issue_id","id"),
	CONSTRAINT "issue_comments_run_identity_uq" UNIQUE("company_id","issue_id","run_id","id"),
	CONSTRAINT "issue_comments_reply_identity_uq" UNIQUE("company_id","issue_id","id","reply_to_comment_id"),
	CONSTRAINT "issue_comments_canonical_source_kind_check" CHECK ("issue_comments"."canonical_source_kind" in (
        'issue_request',
        'human_comment',
        'harness_delivery',
        'system_control',
        'run_output',
        'run_progress',
        'issue_update',
        'plugin_withdrawal'
      )),
	CONSTRAINT "issue_comments_author_shape_check" CHECK ((
        "issue_comments"."author_type" = 'agent'
        and "issue_comments"."author_agent_id" is not null
        and "issue_comments"."author_user_id" is null
        and "issue_comments"."author_plugin_installation_id" is null
        and "issue_comments"."author_plugin_key" is null
      ) or (
        "issue_comments"."author_type" = 'user'
        and "issue_comments"."author_agent_id" is null
        and "issue_comments"."author_user_id" is not null
        and "issue_comments"."author_plugin_installation_id" is null
        and "issue_comments"."author_plugin_key" is null
      ) or (
        "issue_comments"."author_type" = 'plugin'
        and "issue_comments"."author_agent_id" is null
        and "issue_comments"."author_user_id" is null
        and "issue_comments"."author_plugin_installation_id" is not null
        and "issue_comments"."author_plugin_key" is not null
      ) or (
        "issue_comments"."author_type" = 'system'
        and "issue_comments"."author_agent_id" is null
        and "issue_comments"."author_user_id" is null
        and "issue_comments"."author_plugin_installation_id" is null
        and "issue_comments"."author_plugin_key" is null
      )),
	CONSTRAINT "issue_comments_run_shape_check" CHECK ((
        "issue_comments"."author_type" = 'agent'
        and "issue_comments"."run_id" is not null
      ) or (
        "issue_comments"."author_type" in ('user', 'plugin', 'system')
        and "issue_comments"."run_id" is null
      )),
	CONSTRAINT "issue_comments_reply_shape_check" CHECK ((
        "issue_comments"."reply_to_comment_id" is null
        and "issue_comments"."reply_to_projected_event_seq" is null
        and "issue_comments"."thread_root_comment_id" is null
        and "issue_comments"."thread_root_projected_event_seq" is null
      ) or (
        "issue_comments"."reply_to_comment_id" is not null
        and "issue_comments"."reply_to_projected_event_seq" is not null
        and "issue_comments"."thread_root_comment_id" is not null
        and "issue_comments"."thread_root_projected_event_seq" is not null
      )),
	CONSTRAINT "issue_comments_reply_order_check" CHECK ("issue_comments"."reply_to_projected_event_seq" is null
        or "issue_comments"."reply_to_projected_event_seq" < "issue_comments"."projected_event_seq"),
	CONSTRAINT "issue_comments_canonical_projection_sequence_check" CHECK ("issue_comments"."projected_event_seq" = "issue_comments"."admitted_event_seq"
        and (
          "issue_comments"."promoted_event_seq" is null
          or "issue_comments"."promoted_event_seq" >= "issue_comments"."admitted_event_seq"
        ))
);
--> statement-breakpoint
CREATE TABLE "issue_consult_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"source_run_id" uuid NOT NULL,
	"source_ref_id" uuid NOT NULL,
	"caller_execution_scope_id" uuid NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"adapter_config_revision_id" uuid NOT NULL,
	"chain_token" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"close_reason" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_consult_executions_scope_id_uq" UNIQUE("company_id","issue_id","session_id","id"),
	CONSTRAINT "issue_consult_executions_lane_identity_uq" UNIQUE("company_id","issue_id","ownership_epoch","target_agent_id","id"),
	CONSTRAINT "issue_consult_executions_state_check" CHECK ("issue_consult_executions"."state" in ('active', 'completed', 'cancelled', 'revoked')),
	CONSTRAINT "issue_consult_executions_close_check" CHECK ((
        "issue_consult_executions"."state" = 'active'
        and "issue_consult_executions"."closed_at" is null
        and "issue_consult_executions"."close_reason" is null
      ) or (
        "issue_consult_executions"."state" <> 'active'
        and "issue_consult_executions"."closed_at" is not null
        and "issue_consult_executions"."close_reason" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_create_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_creator_edge_receivability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"admission_version" integer DEFAULT 1 NOT NULL,
	"creator_kind" text NOT NULL,
	"endpoint_kind" text NOT NULL,
	"endpoint_id" text,
	"endpoint_snapshot" jsonb NOT NULL,
	"endpoint_tombstone" jsonb,
	"state" text DEFAULT 'receivable' NOT NULL,
	"terminal_reason" text,
	"terminal_source_kind" text,
	"terminal_source_id" text,
	"terminal_audit" jsonb,
	"terminalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_creator_edge_receivability_scope_id_uq" UNIQUE("company_id","issue_id","ownership_epoch","id"),
	CONSTRAINT "issue_creator_edge_receivability_admission_identity_uq" UNIQUE("company_id","issue_id","ownership_epoch","id","admission_version"),
	CONSTRAINT "issue_creator_edge_receivability_epoch_uq" UNIQUE("company_id","issue_id","ownership_epoch"),
	CONSTRAINT "issue_creator_edge_receivability_creator_kind_check" CHECK ("issue_creator_edge_receivability"."creator_kind" in ('agent-execution', 'user/board', 'plugin', 'routine', 'system')),
	CONSTRAINT "issue_creator_edge_receivability_endpoint_kind_check" CHECK ("issue_creator_edge_receivability"."endpoint_kind" in ('agent-execution', 'user/board', 'plugin', 'routine', 'system')
        and "issue_creator_edge_receivability"."endpoint_kind" = "issue_creator_edge_receivability"."creator_kind"),
	CONSTRAINT "issue_creator_edge_receivability_state_check" CHECK ("issue_creator_edge_receivability"."state" in ('receivable', 'terminal')),
	CONSTRAINT "issue_creator_edge_receivability_admission_version_check" CHECK ("issue_creator_edge_receivability"."admission_version" > 0),
	CONSTRAINT "issue_creator_edge_receivability_terminal_check" CHECK ((
        "issue_creator_edge_receivability"."state" = 'receivable'
        and "issue_creator_edge_receivability"."terminal_reason" is null
        and "issue_creator_edge_receivability"."terminalized_at" is null
      ) or (
        "issue_creator_edge_receivability"."state" = 'terminal'
        and "issue_creator_edge_receivability"."terminal_reason" is not null
        and "issue_creator_edge_receivability"."terminal_source_kind" is not null
        and "issue_creator_edge_receivability"."terminal_source_id" is not null
        and "issue_creator_edge_receivability"."terminalized_at" is not null
      )),
	CONSTRAINT "issue_creator_edge_receivability_terminal_reason_check" CHECK ("issue_creator_edge_receivability"."terminal_reason" is null or "issue_creator_edge_receivability"."terminal_reason" in (
        'delivery_exhausted',
        'paused_or_budget_staleness',
        'creator_execution_superseded',
        'agent_terminated',
        'agent_deleted',
        'plugin_disabled',
        'plugin_uninstalled',
        'routine_deleted'
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_creator_withdrawal_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"outgoing_ownership_epoch" integer NOT NULL,
	"resulting_ownership_epoch" integer NOT NULL,
	"resulting_creator_edge_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"actor_plugin_installation_id" uuid,
	"actor_plugin_key" text,
	"plugin_withdrawal_operation_id" uuid,
	"issue_update_id" uuid,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "issue_creator_withdrawal_commands_epoch_uq" UNIQUE("company_id","issue_id","outgoing_ownership_epoch"),
	CONSTRAINT "issue_creator_withdrawal_commands_epoch_check" CHECK ("issue_creator_withdrawal_commands"."outgoing_ownership_epoch" > 0
        and "issue_creator_withdrawal_commands"."resulting_ownership_epoch" =
          "issue_creator_withdrawal_commands"."outgoing_ownership_epoch" + 1),
	CONSTRAINT "issue_creator_withdrawal_commands_actor_check" CHECK ((
        "issue_creator_withdrawal_commands"."actor_kind" = 'user'
        and "issue_creator_withdrawal_commands"."actor_user_id" is not null
        and "issue_creator_withdrawal_commands"."resulting_creator_edge_id" is not null
        and "issue_creator_withdrawal_commands"."actor_plugin_installation_id" is null
        and "issue_creator_withdrawal_commands"."actor_plugin_key" is null
        and "issue_creator_withdrawal_commands"."plugin_withdrawal_operation_id" is null
        and "issue_creator_withdrawal_commands"."issue_update_id" is null
      ) or (
        "issue_creator_withdrawal_commands"."actor_kind" = 'plugin'
        and "issue_creator_withdrawal_commands"."actor_user_id" is null
        and "issue_creator_withdrawal_commands"."resulting_creator_edge_id" is null
        and "issue_creator_withdrawal_commands"."actor_plugin_installation_id" is not null
        and "issue_creator_withdrawal_commands"."actor_plugin_key" is not null
        and length(btrim("issue_creator_withdrawal_commands"."actor_plugin_key")) > 0
        and "issue_creator_withdrawal_commands"."plugin_withdrawal_operation_id" is not null
        and "issue_creator_withdrawal_commands"."issue_update_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_execution_attempt_retry_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"predecessor_attempt_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"retry_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"successor_attempt_id" uuid,
	"claimed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_attempt_retry_schedules_predecessor_uq" UNIQUE("predecessor_attempt_id"),
	CONSTRAINT "issue_execution_attempt_retry_schedules_successor_uq" UNIQUE("successor_attempt_id"),
	CONSTRAINT "issue_execution_attempt_retry_schedules_scope_id_uq" UNIQUE("company_id","issue_id","run_id","id"),
	CONSTRAINT "issue_execution_attempt_retry_schedules_reason_check" CHECK (length(btrim("issue_execution_attempt_retry_schedules"."reason_code")) between 1 and 200),
	CONSTRAINT "issue_execution_attempt_retry_schedules_state_check" CHECK ("issue_execution_attempt_retry_schedules"."state" in ('scheduled', 'claimed', 'cancelled')),
	CONSTRAINT "issue_execution_attempt_retry_schedules_state_time_check" CHECK ((
        "issue_execution_attempt_retry_schedules"."state" = 'scheduled'
        and "issue_execution_attempt_retry_schedules"."successor_attempt_id" is null
        and "issue_execution_attempt_retry_schedules"."claimed_at" is null
        and "issue_execution_attempt_retry_schedules"."cancelled_at" is null
      ) or (
        "issue_execution_attempt_retry_schedules"."state" = 'claimed'
        and "issue_execution_attempt_retry_schedules"."successor_attempt_id" is not null
        and "issue_execution_attempt_retry_schedules"."claimed_at" is not null
        and "issue_execution_attempt_retry_schedules"."cancelled_at" is null
      ) or (
        "issue_execution_attempt_retry_schedules"."state" = 'cancelled'
        and "issue_execution_attempt_retry_schedules"."successor_attempt_id" is null
        and "issue_execution_attempt_retry_schedules"."claimed_at" is null
        and "issue_execution_attempt_retry_schedules"."cancelled_at" is not null
      )),
	CONSTRAINT "issue_execution_attempt_retry_schedules_time_check" CHECK ("issue_execution_attempt_retry_schedules"."retry_at" >= "issue_execution_attempt_retry_schedules"."created_at"
        and (
          "issue_execution_attempt_retry_schedules"."claimed_at" is null
          or "issue_execution_attempt_retry_schedules"."claimed_at" >= "issue_execution_attempt_retry_schedules"."created_at"
        )
        and (
          "issue_execution_attempt_retry_schedules"."cancelled_at" is null
          or "issue_execution_attempt_retry_schedules"."cancelled_at" >= "issue_execution_attempt_retry_schedules"."created_at"
        ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"run_kind" text NOT NULL,
	"prompt_kind" text NOT NULL,
	"session_operation" text NOT NULL,
	"ref_id" uuid,
	"ref_ordinal" integer,
	"segment_ordinal" integer,
	"steering_segment_ordinal" integer,
	"compaction_control_id" uuid,
	"attempt_generation" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_attempts_scope_id_uq" UNIQUE("company_id","issue_id","run_id","id"),
	CONSTRAINT "issue_execution_attempts_accounting_productive_uq" UNIQUE("company_id","issue_id","run_id","id","run_kind","prompt_kind","ref_ordinal","ref_id","segment_ordinal"),
	CONSTRAINT "issue_execution_attempts_accounting_compaction_uq" UNIQUE("company_id","issue_id","run_id","id","run_kind","prompt_kind","compaction_control_id"),
	CONSTRAINT "issue_execution_attempts_prompt_kind_check" CHECK ("issue_execution_attempts"."prompt_kind" in ('base', 'steering', 'compaction')),
	CONSTRAINT "issue_execution_attempts_session_operation_check" CHECK ("issue_execution_attempts"."session_operation" in (
        'new',
        'resume',
        'recovery_new',
        'steer_resume'
      )
      and (
        "issue_execution_attempts"."prompt_kind" <> 'compaction'
        or "issue_execution_attempts"."session_operation" = 'new'
      )
      and (
        "issue_execution_attempts"."prompt_kind" <> 'base'
        or "issue_execution_attempts"."session_operation" <> 'steer_resume'
      )),
	CONSTRAINT "issue_execution_attempts_state_check" CHECK ("issue_execution_attempts"."state" in (
        'pending',
        'leased',
        'running',
        'settled',
        'failed',
        'cancelled'
      )),
	CONSTRAINT "issue_execution_attempts_generation_check" CHECK ("issue_execution_attempts"."attempt_generation" > 0),
	CONSTRAINT "issue_execution_attempts_prompt_identity_check" CHECK ((
        "issue_execution_attempts"."prompt_kind" = 'base'
        and "issue_execution_attempts"."run_kind" in ('productive', 'consult')
        and "issue_execution_attempts"."ref_id" is not null
        and "issue_execution_attempts"."ref_ordinal" is not null
        and "issue_execution_attempts"."ref_ordinal" >= 0
        and "issue_execution_attempts"."segment_ordinal" is not null
        and "issue_execution_attempts"."segment_ordinal" = 0
        and "issue_execution_attempts"."steering_segment_ordinal" is null
        and "issue_execution_attempts"."compaction_control_id" is null
      ) or (
        "issue_execution_attempts"."prompt_kind" = 'steering'
        and "issue_execution_attempts"."run_kind" in ('productive', 'consult')
        and "issue_execution_attempts"."ref_id" is not null
        and "issue_execution_attempts"."ref_ordinal" is not null
        and "issue_execution_attempts"."ref_ordinal" >= 0
        and "issue_execution_attempts"."segment_ordinal" is not null
        and "issue_execution_attempts"."segment_ordinal" > 0
        and "issue_execution_attempts"."steering_segment_ordinal" = "issue_execution_attempts"."segment_ordinal"
        and "issue_execution_attempts"."compaction_control_id" is null
      ) or (
        "issue_execution_attempts"."prompt_kind" = 'compaction'
        and "issue_execution_attempts"."run_kind" = 'compaction'
        and "issue_execution_attempts"."ref_id" is null
        and "issue_execution_attempts"."ref_ordinal" is null
        and "issue_execution_attempts"."segment_ordinal" is null
        and "issue_execution_attempts"."steering_segment_ordinal" is null
        and "issue_execution_attempts"."compaction_control_id" is not null
      )),
	CONSTRAINT "issue_execution_attempts_time_check" CHECK ((
        (
          "issue_execution_attempts"."state" in ('pending', 'leased')
          and "issue_execution_attempts"."started_at" is null
          and "issue_execution_attempts"."finished_at" is null
        ) or (
          "issue_execution_attempts"."state" = 'running'
          and "issue_execution_attempts"."started_at" is not null
          and "issue_execution_attempts"."finished_at" is null
        ) or (
          "issue_execution_attempts"."state" in ('settled', 'failed', 'cancelled')
          and "issue_execution_attempts"."finished_at" is not null
        )
      )
      and (
        "issue_execution_attempts"."started_at" is null
        or "issue_execution_attempts"."started_at" >= "issue_execution_attempts"."created_at"
      )
      and (
        "issue_execution_attempts"."finished_at" is null
        or "issue_execution_attempts"."finished_at" >= coalesce("issue_execution_attempts"."started_at", "issue_execution_attempts"."created_at")
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_authorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"agent_id" uuid NOT NULL,
	"audit_adapter_config_revision_id" uuid NOT NULL,
	"state" text DEFAULT 'current' NOT NULL,
	"revocation_reason" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_authorities_scope_id_uq" UNIQUE("company_id","issue_id","ownership_epoch","agent_id","id"),
	CONSTRAINT "issue_execution_authorities_company_issue_id_uq" UNIQUE("company_id","issue_id","id"),
	CONSTRAINT "issue_execution_authorities_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "issue_execution_authorities_state_check" CHECK ("issue_execution_authorities"."state" in ('current', 'revoked')),
	CONSTRAINT "issue_execution_authorities_revocation_check" CHECK ((
        "issue_execution_authorities"."state" = 'current'
        and "issue_execution_authorities"."revocation_reason" is null
        and "issue_execution_authorities"."revoked_at" is null
      ) or (
        "issue_execution_authorities"."state" = 'revoked'
        and "issue_execution_authorities"."revocation_reason" is not null
        and "issue_execution_authorities"."revoked_at" is not null
      )),
	CONSTRAINT "issue_execution_authorities_epoch_check" CHECK ("issue_execution_authorities"."ownership_epoch" > 0)
);
--> statement-breakpoint
CREATE TABLE "issue_execution_cancellation_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"lease_id" uuid,
	"process_fact_id" uuid,
	"reason_kind" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"actor_agent_id" uuid,
	"state" text DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"session_cancel_sent_at" timestamp with time zone,
	"process_termination_requested_at" timestamp with time zone,
	"process_terminated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_cancellation_intents_attempt_uq" UNIQUE("attempt_id"),
	CONSTRAINT "issue_execution_cancellation_intents_scope_id_uq" UNIQUE("company_id","issue_id","run_id","attempt_id","id"),
	CONSTRAINT "issue_execution_cancellation_intents_reason_check" CHECK ("issue_execution_cancellation_intents"."reason_kind" in (
        'lifecycle',
        'authority',
        'timeout',
        'lease_expired',
        'process_policy',
        'steering'
      )),
	CONSTRAINT "issue_execution_cancellation_intents_actor_check" CHECK ((
        "issue_execution_cancellation_intents"."actor_kind" = 'system'
        and "issue_execution_cancellation_intents"."actor_user_id" is null
        and "issue_execution_cancellation_intents"."actor_agent_id" is null
      ) or (
        "issue_execution_cancellation_intents"."actor_kind" = 'user'
        and "issue_execution_cancellation_intents"."actor_user_id" is not null
        and "issue_execution_cancellation_intents"."actor_agent_id" is null
      ) or (
        "issue_execution_cancellation_intents"."actor_kind" = 'agent'
        and "issue_execution_cancellation_intents"."actor_user_id" is null
        and "issue_execution_cancellation_intents"."actor_agent_id" is not null
      )),
	CONSTRAINT "issue_execution_cancellation_intents_state_check" CHECK ("issue_execution_cancellation_intents"."state" in ('requested', 'acknowledged', 'completed', 'failed')),
	CONSTRAINT "issue_execution_cancellation_intents_state_time_check" CHECK ((
        "issue_execution_cancellation_intents"."state" = 'requested'
        and "issue_execution_cancellation_intents"."acknowledged_at" is null
        and "issue_execution_cancellation_intents"."completed_at" is null
        and "issue_execution_cancellation_intents"."failed_at" is null
        and "issue_execution_cancellation_intents"."failure_code" is null
      ) or (
        "issue_execution_cancellation_intents"."state" = 'acknowledged'
        and "issue_execution_cancellation_intents"."acknowledged_at" is not null
        and "issue_execution_cancellation_intents"."completed_at" is null
        and "issue_execution_cancellation_intents"."failed_at" is null
        and "issue_execution_cancellation_intents"."failure_code" is null
      ) or (
        "issue_execution_cancellation_intents"."state" = 'completed'
        and "issue_execution_cancellation_intents"."acknowledged_at" is not null
        and "issue_execution_cancellation_intents"."completed_at" is not null
        and "issue_execution_cancellation_intents"."failed_at" is null
        and "issue_execution_cancellation_intents"."failure_code" is null
      ) or (
        "issue_execution_cancellation_intents"."state" = 'failed'
        and "issue_execution_cancellation_intents"."completed_at" is null
        and "issue_execution_cancellation_intents"."failed_at" is not null
        and "issue_execution_cancellation_intents"."failure_code" is not null
        and length(btrim("issue_execution_cancellation_intents"."failure_code")) between 1 and 200
      )),
	CONSTRAINT "issue_execution_cancellation_intents_process_check" CHECK ((
        "issue_execution_cancellation_intents"."process_fact_id" is null
        and "issue_execution_cancellation_intents"."process_termination_requested_at" is null
        and "issue_execution_cancellation_intents"."process_terminated_at" is null
      ) or (
        "issue_execution_cancellation_intents"."process_fact_id" is not null
        and "issue_execution_cancellation_intents"."lease_id" is not null
        and "issue_execution_cancellation_intents"."process_termination_requested_at" is not null
        and (
          "issue_execution_cancellation_intents"."process_terminated_at" is null
          or "issue_execution_cancellation_intents"."process_terminated_at" >= "issue_execution_cancellation_intents"."process_termination_requested_at"
        )
        and (
          "issue_execution_cancellation_intents"."state" <> 'completed'
          or "issue_execution_cancellation_intents"."process_terminated_at" is not null
        )
      )),
	CONSTRAINT "issue_execution_cancellation_intents_time_check" CHECK ("issue_execution_cancellation_intents"."requested_at" >= "issue_execution_cancellation_intents"."created_at"
        and (
          "issue_execution_cancellation_intents"."acknowledged_at" is null
          or "issue_execution_cancellation_intents"."acknowledged_at" >= "issue_execution_cancellation_intents"."requested_at"
        )
        and (
          "issue_execution_cancellation_intents"."session_cancel_sent_at" is null
          or "issue_execution_cancellation_intents"."session_cancel_sent_at" >= "issue_execution_cancellation_intents"."requested_at"
        )
        and (
          "issue_execution_cancellation_intents"."completed_at" is null
          or "issue_execution_cancellation_intents"."completed_at" >= "issue_execution_cancellation_intents"."requested_at"
        )
        and (
          "issue_execution_cancellation_intents"."failed_at" is null
          or "issue_execution_cancellation_intents"."failed_at" >= "issue_execution_cancellation_intents"."requested_at"
        ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"stage_type" text NOT NULL,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"outcome" text NOT NULL,
	"body" text NOT NULL,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_execution_finalization_delivery_dependencies" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"finalization_id" uuid NOT NULL,
	"dependency_ordinal" integer NOT NULL,
	"issue_update_id" uuid NOT NULL,
	"creator_delivery_id" uuid NOT NULL,
	CONSTRAINT "issue_execution_finalization_delivery_dependencies_pk" PRIMARY KEY("finalization_id","dependency_ordinal"),
	CONSTRAINT "issue_execution_finalization_delivery_dependencies_update_uq" UNIQUE("finalization_id","issue_update_id"),
	CONSTRAINT "issue_execution_finalization_delivery_dependencies_delivery_uq" UNIQUE("finalization_id","creator_delivery_id"),
	CONSTRAINT "issue_execution_finalization_delivery_dependencies_ordinal_check" CHECK ("issue_execution_finalization_delivery_dependencies"."dependency_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "issue_execution_finalization_prompt_dependencies" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"finalization_id" uuid NOT NULL,
	"dependency_ordinal" integer NOT NULL,
	"prompt_kind" text NOT NULL,
	"ref_id" uuid,
	"ref_ordinal" integer,
	"segment_ordinal" integer,
	"compaction_control_id" uuid,
	"protocol_settlement_state" text NOT NULL,
	"settlement_version" integer NOT NULL,
	"accounting_id" uuid,
	"cost_event_id" uuid,
	CONSTRAINT "issue_execution_finalization_prompt_dependencies_pk" PRIMARY KEY("finalization_id","dependency_ordinal"),
	CONSTRAINT "issue_execution_finalization_prompt_dependencies_ordinal_check" CHECK ("issue_execution_finalization_prompt_dependencies"."dependency_ordinal" >= 0
        and "issue_execution_finalization_prompt_dependencies"."settlement_version" > 0),
	CONSTRAINT "issue_execution_finalization_prompt_dependencies_identity_check" CHECK ((
        "issue_execution_finalization_prompt_dependencies"."prompt_kind" = 'base'
        and "issue_execution_finalization_prompt_dependencies"."ref_id" is not null
        and "issue_execution_finalization_prompt_dependencies"."ref_ordinal" is not null
        and "issue_execution_finalization_prompt_dependencies"."ref_ordinal" >= 0
        and "issue_execution_finalization_prompt_dependencies"."segment_ordinal" = 0
        and "issue_execution_finalization_prompt_dependencies"."compaction_control_id" is null
      ) or (
        "issue_execution_finalization_prompt_dependencies"."prompt_kind" = 'steering'
        and "issue_execution_finalization_prompt_dependencies"."ref_id" is not null
        and "issue_execution_finalization_prompt_dependencies"."ref_ordinal" is not null
        and "issue_execution_finalization_prompt_dependencies"."ref_ordinal" >= 0
        and "issue_execution_finalization_prompt_dependencies"."segment_ordinal" is not null
        and "issue_execution_finalization_prompt_dependencies"."segment_ordinal" > 0
        and "issue_execution_finalization_prompt_dependencies"."compaction_control_id" is null
      ) or (
        "issue_execution_finalization_prompt_dependencies"."prompt_kind" = 'compaction'
        and "issue_execution_finalization_prompt_dependencies"."ref_id" is null
        and "issue_execution_finalization_prompt_dependencies"."ref_ordinal" is null
        and "issue_execution_finalization_prompt_dependencies"."segment_ordinal" is null
        and "issue_execution_finalization_prompt_dependencies"."compaction_control_id" is not null
      )),
	CONSTRAINT "issue_execution_finalization_prompt_dependencies_settlement_check" CHECK ((
        "issue_execution_finalization_prompt_dependencies"."protocol_settlement_state" = 'settled'
        and "issue_execution_finalization_prompt_dependencies"."accounting_id" is not null
        and "issue_execution_finalization_prompt_dependencies"."cost_event_id" is not null
      ) or (
        "issue_execution_finalization_prompt_dependencies"."protocol_settlement_state" in ('not_sent', 'incomplete')
        and "issue_execution_finalization_prompt_dependencies"."accounting_id" is null
        and "issue_execution_finalization_prompt_dependencies"."cost_event_id" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_finalization_stale_check_outbox" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"finalization_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "issue_execution_finalization_stale_check_outbox_epoch_check" CHECK ("issue_execution_finalization_stale_check_outbox"."ownership_epoch" > 0),
	CONSTRAINT "issue_execution_finalization_stale_check_outbox_time_check" CHECK ("issue_execution_finalization_stale_check_outbox"."processed_at" is null
        or "issue_execution_finalization_stale_check_outbox"."processed_at" >= "issue_execution_finalization_stale_check_outbox"."created_at")
);
--> statement-breakpoint
CREATE TABLE "issue_execution_finalization_update_dependencies" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"finalization_id" uuid NOT NULL,
	"dependency_ordinal" integer NOT NULL,
	"issue_update_id" uuid NOT NULL,
	CONSTRAINT "issue_execution_finalization_update_dependencies_pk" PRIMARY KEY("finalization_id","dependency_ordinal"),
	CONSTRAINT "issue_execution_finalization_update_dependencies_update_uq" UNIQUE("finalization_id","issue_update_id"),
	CONSTRAINT "issue_execution_finalization_update_dependencies_ordinal_check" CHECK ("issue_execution_finalization_update_dependencies"."dependency_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "issue_execution_finalizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"finalization_identity_digest" text NOT NULL,
	"action" text NOT NULL,
	"terminal_session_event_id" text,
	"terminal_session_message_id" text,
	"progress_comment_id" uuid,
	"gateway_capability_connection_id" uuid,
	"gateway_capability_generation" integer,
	"run_liveness_fact_id" uuid,
	"finalized_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_finalizations_run_uq" UNIQUE("run_id"),
	CONSTRAINT "issue_execution_finalizations_company_run_id_uq" UNIQUE("company_id","run_id","id"),
	CONSTRAINT "issue_execution_finalizations_action_check" CHECK ("issue_execution_finalizations"."action" in (
        'comment_only',
        'updates_committed',
        'no_conversational_output'
      )),
	CONSTRAINT "issue_execution_finalizations_identity_digest_check" CHECK (length("issue_execution_finalizations"."finalization_identity_digest") = 64
        and "issue_execution_finalizations"."finalization_identity_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "issue_execution_finalizations_gateway_revocation_check" CHECK ((
        "issue_execution_finalizations"."gateway_capability_connection_id" is null
        and "issue_execution_finalizations"."gateway_capability_generation" is null
      ) or (
        "issue_execution_finalizations"."gateway_capability_connection_id" is not null
        and "issue_execution_finalizations"."gateway_capability_generation" is not null
        and "issue_execution_finalizations"."gateway_capability_generation" > 0
      )),
	CONSTRAINT "issue_execution_finalizations_reference_shape_check" CHECK ((
        "issue_execution_finalizations"."action" = 'comment_only'
        and "issue_execution_finalizations"."terminal_session_event_id" is not null
        and "issue_execution_finalizations"."terminal_session_message_id" is not null
        and "issue_execution_finalizations"."progress_comment_id" is not null
      ) or (
        "issue_execution_finalizations"."action" = 'updates_committed'
        and "issue_execution_finalizations"."terminal_session_event_id" is not null
        and "issue_execution_finalizations"."terminal_session_message_id" is null
        and "issue_execution_finalizations"."progress_comment_id" is not null
      ) or (
        "issue_execution_finalizations"."action" = 'no_conversational_output'
        and "issue_execution_finalizations"."terminal_session_message_id" is null
      )),
	CONSTRAINT "issue_execution_finalizations_time_check" CHECK ("issue_execution_finalizations"."finalized_at" >= "issue_execution_finalizations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "issue_execution_history_view_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"history_view_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"lower_order" integer NOT NULL,
	"membership_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_history_view_messages_kind_check" CHECK ("issue_execution_history_view_messages"."membership_kind" in (
        'composition',
        'source',
        'execution',
        'checkpoint-request',
        'checkpoint-summary',
        'retained-tail',
        'post-checkpoint-input'
      )),
	CONSTRAINT "issue_execution_history_view_messages_order_check" CHECK ("issue_execution_history_view_messages"."lower_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "issue_execution_history_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"execution_lineage_id" uuid NOT NULL,
	"state" text DEFAULT 'empty' NOT NULL,
	"composition_depth" text DEFAULT 'none' NOT NULL,
	"source_high_water_seq" bigint NOT NULL,
	"context_epoch" integer NOT NULL,
	"context_epoch_baseline_seq" bigint NOT NULL,
	"history_scope_kind" text,
	"history_scope_id" text,
	"composition_audience" text,
	"effective_dial_snapshot" jsonb,
	"effective_dial_digest" text,
	"compaction_settings_snapshot" jsonb,
	"model_snapshot" jsonb,
	"selected_record_ids" jsonb,
	"lower_order_snapshot" jsonb,
	"composition_preparation_id" uuid,
	"composition_bytes" text,
	"composition_hash" text,
	"composition_checkpoint_control_id" uuid,
	"composition_tail_start_message_id" text,
	"active_execution_checkpoint_control_id" uuid,
	"active_execution_tail_start_message_id" text,
	"lowering_generation" integer DEFAULT 0 NOT NULL,
	"source_message_id" text NOT NULL,
	"source_input_id" text,
	"source_admitted_seq" bigint,
	"source_promoted_seq" bigint,
	"invalidation_reason" text,
	"invalidated_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_history_views_scope_id_uq" UNIQUE("company_id","issue_id","session_id","id"),
	CONSTRAINT "issue_execution_history_views_scope_ref_id_lineage_context_uq" UNIQUE("company_id","issue_id","session_id","ref_id","id","execution_lineage_id","context_epoch"),
	CONSTRAINT "issue_execution_history_views_state_check" CHECK ("issue_execution_history_views"."state" in ('empty', 'preparing', 'current', 'invalidated', 'terminal')),
	CONSTRAINT "issue_execution_history_views_depth_check" CHECK ("issue_execution_history_views"."composition_depth" in ('none', 'comments', 'turns')),
	CONSTRAINT "issue_execution_history_views_scope_check" CHECK ((
        "issue_execution_history_views"."state" in ('empty', 'invalidated', 'terminal')
      ) or (
        "issue_execution_history_views"."history_scope_kind" in (
          'execution-lineage',
          'turns-composition',
          'comments-composition'
        )
        and "issue_execution_history_views"."history_scope_id" is not null
        and (
          ("issue_execution_history_views"."composition_depth" = 'none' and "issue_execution_history_views"."composition_audience" is null)
          or ("issue_execution_history_views"."composition_depth" = 'comments' and "issue_execution_history_views"."composition_audience" = 'comments')
          or ("issue_execution_history_views"."composition_depth" = 'turns' and "issue_execution_history_views"."composition_audience" = 'turns')
        )
      )),
	CONSTRAINT "issue_execution_history_views_snapshot_check" CHECK ((
        "issue_execution_history_views"."state" <> 'current'
      ) or (
        "issue_execution_history_views"."effective_dial_snapshot" is not null
        and "issue_execution_history_views"."effective_dial_digest" is not null
        and "issue_execution_history_views"."compaction_settings_snapshot" is not null
        and "issue_execution_history_views"."model_snapshot" is not null
        and "issue_execution_history_views"."selected_record_ids" is not null
        and "issue_execution_history_views"."lower_order_snapshot" is not null
      )),
	CONSTRAINT "issue_execution_history_views_composition_check" CHECK ((
        "issue_execution_history_views"."composition_depth" = 'none'
        and "issue_execution_history_views"."composition_bytes" is null
        and "issue_execution_history_views"."composition_hash" is null
        and "issue_execution_history_views"."composition_preparation_id" is null
      ) or (
        "issue_execution_history_views"."composition_depth" in ('comments', 'turns')
        and (
          "issue_execution_history_views"."state" in ('empty', 'preparing')
          or (
            "issue_execution_history_views"."composition_bytes" is not null
            and "issue_execution_history_views"."composition_hash" is not null
            and "issue_execution_history_views"."composition_preparation_id" is not null
          )
        )
      )),
	CONSTRAINT "issue_execution_history_views_live_checkpoint_check" CHECK ("issue_execution_history_views"."lowering_generation" >= 0
        and (
          (
            "issue_execution_history_views"."active_execution_checkpoint_control_id" is null
            and "issue_execution_history_views"."active_execution_tail_start_message_id" is null
            and "issue_execution_history_views"."lowering_generation" = 0
          )
          or (
            "issue_execution_history_views"."active_execution_checkpoint_control_id" is not null
            and "issue_execution_history_views"."lowering_generation" > 0
          )
        ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_lanes" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"next_ordinal" bigint DEFAULT 0 NOT NULL,
	"active_ordinal" bigint,
	"active_lease_generation" integer,
	"active_lease_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_lanes_pk" PRIMARY KEY("company_id","issue_id","ownership_epoch","target_agent_id"),
	CONSTRAINT "issue_execution_lanes_epoch_check" CHECK ("issue_execution_lanes"."ownership_epoch" > 0),
	CONSTRAINT "issue_execution_lanes_ordinal_check" CHECK ("issue_execution_lanes"."next_ordinal" between 0 and 9007199254740991
        and (
          "issue_execution_lanes"."active_ordinal" is null
          or (
            "issue_execution_lanes"."active_ordinal" between 0 and 9007199254740991
            and "issue_execution_lanes"."active_ordinal" < "issue_execution_lanes"."next_ordinal"
          )
        )),
	CONSTRAINT "issue_execution_lanes_active_lease_check" CHECK ((
        "issue_execution_lanes"."active_ordinal" is null
        and "issue_execution_lanes"."active_lease_generation" is null
        and "issue_execution_lanes"."active_lease_id" is null
      ) or (
        "issue_execution_lanes"."active_ordinal" is not null
        and "issue_execution_lanes"."active_lease_generation" is not null
        and "issue_execution_lanes"."active_lease_generation" > 0
        and "issue_execution_lanes"."active_lease_id" is not null
      )),
	CONSTRAINT "issue_execution_lanes_time_check" CHECK ("issue_execution_lanes"."updated_at" >= "issue_execution_lanes"."created_at")
);
--> statement-breakpoint
CREATE TABLE "issue_execution_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"lease_generation" integer NOT NULL,
	"worker_id" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_leases_attempt_uq" UNIQUE("attempt_id"),
	CONSTRAINT "issue_execution_leases_scope_id_uq" UNIQUE("company_id","issue_id","run_id","attempt_id","id"),
	CONSTRAINT "issue_execution_leases_generation_check" CHECK ("issue_execution_leases"."lease_generation" > 0),
	CONSTRAINT "issue_execution_leases_worker_check" CHECK (length(btrim("issue_execution_leases"."worker_id")) between 1 and 200),
	CONSTRAINT "issue_execution_leases_state_check" CHECK ("issue_execution_leases"."state" in ('active', 'released', 'expired', 'revoked')),
	CONSTRAINT "issue_execution_leases_state_time_check" CHECK ((
        (
          "issue_execution_leases"."state" = 'active'
          and "issue_execution_leases"."released_at" is null
        ) or (
          "issue_execution_leases"."state" in ('released', 'expired', 'revoked')
          and "issue_execution_leases"."released_at" is not null
        )
      )
      and "issue_execution_leases"."expires_at" > "issue_execution_leases"."acquired_at"
      and (
        "issue_execution_leases"."renewed_at" is null
        or "issue_execution_leases"."renewed_at" >= "issue_execution_leases"."acquired_at"
      )
      and (
        "issue_execution_leases"."released_at" is null
        or "issue_execution_leases"."released_at" >= "issue_execution_leases"."acquired_at"
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_process_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"process_id" integer NOT NULL,
	"process_group_id" integer NOT NULL,
	"supervisor_locator" text NOT NULL,
	"state" text DEFAULT 'starting' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"exit_code" integer,
	"exit_signal" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_process_facts_attempt_uq" UNIQUE("attempt_id"),
	CONSTRAINT "issue_execution_process_facts_lease_uq" UNIQUE("lease_id"),
	CONSTRAINT "issue_execution_process_facts_scope_id_uq" UNIQUE("company_id","issue_id","run_id","attempt_id","id"),
	CONSTRAINT "issue_execution_process_facts_identity_check" CHECK ("issue_execution_process_facts"."process_id" > 0
        and "issue_execution_process_facts"."process_group_id" > 0
        and length(btrim("issue_execution_process_facts"."supervisor_locator")) between 1 and 500),
	CONSTRAINT "issue_execution_process_facts_state_check" CHECK ("issue_execution_process_facts"."state" in ('starting', 'running', 'exited', 'terminated', 'lost')),
	CONSTRAINT "issue_execution_process_facts_terminal_check" CHECK ((
        "issue_execution_process_facts"."state" in ('starting', 'running')
        and "issue_execution_process_facts"."settled_at" is null
        and "issue_execution_process_facts"."exit_code" is null
        and "issue_execution_process_facts"."exit_signal" is null
      ) or (
        "issue_execution_process_facts"."state" in ('exited', 'terminated')
        and "issue_execution_process_facts"."settled_at" is not null
        and (
          (
            "issue_execution_process_facts"."exit_code" is not null
            and "issue_execution_process_facts"."exit_code" between 0 and 255
            and "issue_execution_process_facts"."exit_signal" is null
          ) or (
            "issue_execution_process_facts"."exit_code" is null
            and "issue_execution_process_facts"."exit_signal" is not null
            and length("issue_execution_process_facts"."exit_signal") between 1 and 32
            and "issue_execution_process_facts"."exit_signal" ~ '^SIG[A-Z0-9]+$'
          )
        )
      ) or (
        "issue_execution_process_facts"."state" = 'lost'
        and "issue_execution_process_facts"."settled_at" is not null
        and "issue_execution_process_facts"."exit_code" is null
        and "issue_execution_process_facts"."exit_signal" is null
      )),
	CONSTRAINT "issue_execution_process_facts_time_check" CHECK ("issue_execution_process_facts"."started_at" >= "issue_execution_process_facts"."created_at"
        and (
          "issue_execution_process_facts"."settled_at" is null
          or "issue_execution_process_facts"."settled_at" >= "issue_execution_process_facts"."started_at"
        ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_prompt_capabilities" (
	"company_id" uuid NOT NULL,
	"capability_connection_id" uuid NOT NULL,
	"capability_generation" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"run_batch_digest" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"ref_ordinal" integer NOT NULL,
	"segment_ordinal" integer NOT NULL,
	"attempt_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"lease_generation" integer NOT NULL,
	"worker_process_identity" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"lane_kind" text NOT NULL,
	"execution_mode" text NOT NULL,
	"issue_execution_authority_id" uuid,
	"consult_execution_id" uuid,
	"adapter_config_identity" uuid NOT NULL,
	"workspace_identity" uuid NOT NULL,
	"target_session_correlation_id" uuid,
	"effective_context_exposure_digest" text NOT NULL,
	"effective_tools_digest" text NOT NULL,
	"bearer_hash" text NOT NULL,
	"ingress_high_water" bigint DEFAULT -1 NOT NULL,
	"classification_high_water" bigint DEFAULT -1 NOT NULL,
	"state" text DEFAULT 'pending_setup' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"revocation_reason" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_prompt_capabilities_pk" PRIMARY KEY("capability_connection_id","capability_generation"),
	CONSTRAINT "issue_execution_prompt_capabilities_company_pair_uq" UNIQUE("company_id","capability_connection_id","capability_generation"),
	CONSTRAINT "issue_execution_prompt_capabilities_connection_uq" UNIQUE("capability_connection_id"),
	CONSTRAINT "issue_execution_prompt_capabilities_run_generation_uq" UNIQUE("run_id","capability_generation"),
	CONSTRAINT "issue_execution_prompt_capabilities_identity_check" CHECK ("issue_execution_prompt_capabilities"."capability_generation" > 0
        and "issue_execution_prompt_capabilities"."ownership_epoch" > 0
        and "issue_execution_prompt_capabilities"."ref_ordinal" >= 0
        and "issue_execution_prompt_capabilities"."segment_ordinal" >= 0
        and "issue_execution_prompt_capabilities"."lease_generation" > 0
        and "issue_execution_prompt_capabilities"."run_batch_digest" ~ '^[0-9a-f]{64}$'
        and "issue_execution_prompt_capabilities"."effective_context_exposure_digest" ~ '^[0-9a-f]{64}$'
        and "issue_execution_prompt_capabilities"."effective_tools_digest" ~ '^[0-9a-f]{64}$'
        and "issue_execution_prompt_capabilities"."bearer_hash" ~ '^[0-9a-f]{64}$'
        and "issue_execution_prompt_capabilities"."ingress_high_water" >= -1
        and "issue_execution_prompt_capabilities"."ingress_high_water" <= 9007199254740991
        and "issue_execution_prompt_capabilities"."classification_high_water" >= -1
        and "issue_execution_prompt_capabilities"."classification_high_water" <= 9007199254740991
        and "issue_execution_prompt_capabilities"."classification_high_water" <= "issue_execution_prompt_capabilities"."ingress_high_water"),
	CONSTRAINT "issue_execution_prompt_capabilities_mode_check" CHECK ((
        "issue_execution_prompt_capabilities"."lane_kind" = 'owner'
        and "issue_execution_prompt_capabilities"."execution_mode" = 'owner'
        and "issue_execution_prompt_capabilities"."issue_execution_authority_id" is not null
        and "issue_execution_prompt_capabilities"."consult_execution_id" is null
      ) or (
        "issue_execution_prompt_capabilities"."lane_kind" = 'consult'
        and "issue_execution_prompt_capabilities"."execution_mode" = 'consult'
        and "issue_execution_prompt_capabilities"."issue_execution_authority_id" is null
        and "issue_execution_prompt_capabilities"."consult_execution_id" is not null
      )),
	CONSTRAINT "issue_execution_prompt_capabilities_state_check" CHECK ((
        "issue_execution_prompt_capabilities"."state" = 'pending_setup'
        and "issue_execution_prompt_capabilities"."activated_at" is null
        and "issue_execution_prompt_capabilities"."revocation_reason" is null
        and "issue_execution_prompt_capabilities"."revoked_at" is null
      ) or (
        "issue_execution_prompt_capabilities"."state" = 'active'
        and "issue_execution_prompt_capabilities"."target_session_correlation_id" is not null
        and "issue_execution_prompt_capabilities"."activated_at" is not null
        and "issue_execution_prompt_capabilities"."revocation_reason" is null
        and "issue_execution_prompt_capabilities"."revoked_at" is null
      ) or (
        "issue_execution_prompt_capabilities"."state" = 'revoked'
        and "issue_execution_prompt_capabilities"."revocation_reason" is not null
        and length(btrim("issue_execution_prompt_capabilities"."revocation_reason")) between 1 and 200
        and "issue_execution_prompt_capabilities"."revoked_at" is not null
        and (
          "issue_execution_prompt_capabilities"."activated_at" is null
          or "issue_execution_prompt_capabilities"."revoked_at" >= "issue_execution_prompt_capabilities"."activated_at"
        )
      )),
	CONSTRAINT "issue_execution_prompt_capabilities_time_check" CHECK ("issue_execution_prompt_capabilities"."expires_at" > "issue_execution_prompt_capabilities"."created_at"
        and (
          "issue_execution_prompt_capabilities"."activated_at" is null
          or "issue_execution_prompt_capabilities"."activated_at" >= "issue_execution_prompt_capabilities"."created_at"
        )
        and (
          "issue_execution_prompt_capabilities"."revoked_at" is null
          or "issue_execution_prompt_capabilities"."revoked_at" >= "issue_execution_prompt_capabilities"."created_at"
        ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_prompt_segments" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"ref_id" uuid NOT NULL,
	"ref_ordinal" integer NOT NULL,
	"segment_ordinal" integer NOT NULL,
	"source_comment_id" uuid NOT NULL,
	"source_ref_id" uuid,
	"source_message_id" text NOT NULL,
	"source_input_id" text,
	"resume_source_correlation_id" uuid NOT NULL,
	"target_session_generation" integer,
	"attempt_id" uuid,
	"capability_connection_id" uuid,
	"capability_generation" integer,
	"cancellation_intent_id" uuid,
	"steering_state" text DEFAULT 'requested' NOT NULL,
	"prompt_transmission_phase" text DEFAULT 'not_transmitted' NOT NULL,
	"outcome" text,
	"outcome_reference_id" uuid,
	"protocol_settlement_state" text,
	"accounting_id" uuid,
	"cost_event_id" uuid,
	"settlement_version" integer DEFAULT 0 NOT NULL,
	"settled_at" timestamp with time zone,
	"terminal_session_message_id" text,
	"resumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_prompt_segments_run_ordinal_ref_segment_uq" UNIQUE("run_id","ref_ordinal","ref_id","segment_ordinal"),
	CONSTRAINT "issue_execution_prompt_segments_run_ref_segment_uq" UNIQUE("run_id","ref_id","segment_ordinal"),
	CONSTRAINT "issue_execution_prompt_segments_scope_prompt_uq" UNIQUE("company_id","issue_id","session_id","run_id","ref_ordinal","ref_id","segment_ordinal"),
	CONSTRAINT "issue_execution_prompt_segments_positive_ordinal_check" CHECK ("issue_execution_prompt_segments"."ref_ordinal" >= 0 and "issue_execution_prompt_segments"."segment_ordinal" > 0),
	CONSTRAINT "issue_execution_prompt_segments_generation_check" CHECK (("issue_execution_prompt_segments"."target_session_generation" is null
          or "issue_execution_prompt_segments"."target_session_generation" > 0)
        and ("issue_execution_prompt_segments"."capability_generation" is null
          or "issue_execution_prompt_segments"."capability_generation" > 0)),
	CONSTRAINT "issue_execution_prompt_segments_source_input_check" CHECK ("issue_execution_prompt_segments"."source_input_id" is null
        or "issue_execution_prompt_segments"."source_input_id" = "issue_execution_prompt_segments"."source_message_id"),
	CONSTRAINT "issue_execution_prompt_segments_attempt_capability_check" CHECK ((
        "issue_execution_prompt_segments"."attempt_id" is null
        and "issue_execution_prompt_segments"."capability_connection_id" is null
        and "issue_execution_prompt_segments"."capability_generation" is null
      ) or (
        "issue_execution_prompt_segments"."attempt_id" is not null
        and "issue_execution_prompt_segments"."capability_connection_id" is not null
        and "issue_execution_prompt_segments"."capability_generation" is not null
      )),
	CONSTRAINT "issue_execution_prompt_segments_steering_state_check" CHECK ("issue_execution_prompt_segments"."steering_state" in (
        'requested',
        'sent',
        'protocol_settled',
        'rebound',
        'resumed'
      )),
	CONSTRAINT "issue_execution_prompt_segments_resumed_at_check" CHECK ("issue_execution_prompt_segments"."resumed_at" is null or (
        "issue_execution_prompt_segments"."resumed_at" > "issue_execution_prompt_segments"."created_at"
        and (
          "issue_execution_prompt_segments"."steering_state" = 'resumed'
          or (
            "issue_execution_prompt_segments"."steering_state" = 'protocol_settled'
            and "issue_execution_prompt_segments"."protocol_settlement_state" is not null
          )
        )
      )),
	CONSTRAINT "issue_execution_prompt_segments_transmission_check" CHECK ("issue_execution_prompt_segments"."prompt_transmission_phase" in ('not_transmitted', 'transmitted')),
	CONSTRAINT "issue_execution_prompt_segments_outcome_check" CHECK ("issue_execution_prompt_segments"."outcome" is null
        or "issue_execution_prompt_segments"."outcome" in (
          'released_unsent',
          'succeeded',
          'refused',
          'failed',
          'ambiguous',
          'cancelled'
        )),
	CONSTRAINT "issue_execution_prompt_segments_protocol_settlement_state_check" CHECK ("issue_execution_prompt_segments"."protocol_settlement_state" is null
        or "issue_execution_prompt_segments"."protocol_settlement_state" in ('not_sent', 'settled', 'incomplete')),
	CONSTRAINT "issue_execution_prompt_segments_terminal_message_check" CHECK ((
        "issue_execution_prompt_segments"."protocol_settlement_state" = 'settled'
        and "issue_execution_prompt_segments"."terminal_session_message_id" is not null
      ) or (
        "issue_execution_prompt_segments"."protocol_settlement_state" is distinct from 'settled'
        and "issue_execution_prompt_segments"."terminal_session_message_id" is null
      )),
	CONSTRAINT "issue_execution_prompt_segments_settlement_matrix_check" CHECK ((
        "issue_execution_prompt_segments"."protocol_settlement_state" is null
        and "issue_execution_prompt_segments"."outcome" is null
        and "issue_execution_prompt_segments"."outcome_reference_id" is null
        and "issue_execution_prompt_segments"."accounting_id" is null
        and "issue_execution_prompt_segments"."cost_event_id" is null
        and "issue_execution_prompt_segments"."settlement_version" = 0
        and "issue_execution_prompt_segments"."settled_at" is null
      ) or (
        "issue_execution_prompt_segments"."protocol_settlement_state" = 'not_sent'
        and "issue_execution_prompt_segments"."prompt_transmission_phase" = 'not_transmitted'
        and "issue_execution_prompt_segments"."outcome" = 'released_unsent'
        and "issue_execution_prompt_segments"."outcome_reference_id" is not null
        and "issue_execution_prompt_segments"."accounting_id" is null
        and "issue_execution_prompt_segments"."cost_event_id" is null
        and "issue_execution_prompt_segments"."settlement_version" > 0
        and "issue_execution_prompt_segments"."settled_at" is not null
      ) or (
        "issue_execution_prompt_segments"."protocol_settlement_state" = 'incomplete'
        and "issue_execution_prompt_segments"."prompt_transmission_phase" = 'transmitted'
        and "issue_execution_prompt_segments"."outcome" in ('failed', 'ambiguous', 'cancelled')
        and "issue_execution_prompt_segments"."outcome_reference_id" is not null
        and "issue_execution_prompt_segments"."accounting_id" is null
        and "issue_execution_prompt_segments"."cost_event_id" is null
        and "issue_execution_prompt_segments"."settlement_version" > 0
        and "issue_execution_prompt_segments"."settled_at" is not null
      ) or (
        "issue_execution_prompt_segments"."protocol_settlement_state" = 'settled'
        and "issue_execution_prompt_segments"."prompt_transmission_phase" = 'transmitted'
        and "issue_execution_prompt_segments"."outcome" in ('succeeded', 'refused', 'failed', 'cancelled')
        and "issue_execution_prompt_segments"."outcome_reference_id" is not null
        and "issue_execution_prompt_segments"."accounting_id" is not null
        and "issue_execution_prompt_segments"."cost_event_id" is not null
        and "issue_execution_prompt_segments"."settlement_version" > 0
        and "issue_execution_prompt_segments"."settled_at" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"previous_ownership_epoch" integer,
	"execution_scope_id" uuid NOT NULL,
	"execution_lineage_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"message_kind" text NOT NULL,
	"source_message_id" text NOT NULL,
	"exact_message" text NOT NULL,
	"delivery_idempotency_key" text NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"lane_ordinal" bigint NOT NULL,
	"issue_execution_authority_id" uuid,
	"consult_execution_id" uuid,
	"adapter_config_revision_id" uuid NOT NULL,
	"context_epoch" integer NOT NULL,
	"history_view_id" uuid NOT NULL,
	"admission_high_water_seq" bigint NOT NULL,
	"input_id" text,
	"admitted_seq" bigint,
	"promoted_seq" bigint,
	"counterpart_issue_id" uuid,
	"counterpart_authority_id" uuid,
	"counterpart_ownership_epoch" integer,
	"consult_caller_ref_id" uuid,
	"consult_chain_token" text,
	"disposition" text DEFAULT 'active' NOT NULL,
	"invalidation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_refs_scope_id_uq" UNIQUE("company_id","issue_id","session_id","id"),
	CONSTRAINT "issue_execution_refs_company_issue_id_uq" UNIQUE("company_id","issue_id","id"),
	CONSTRAINT "issue_execution_refs_company_issue_epoch_id_uq" UNIQUE("company_id","issue_id","ownership_epoch","id"),
	CONSTRAINT "issue_execution_refs_lane_ordinal_uq" UNIQUE("company_id","issue_id","ownership_epoch","target_agent_id","lane_ordinal"),
	CONSTRAINT "issue_execution_refs_scope_epoch_id_uq" UNIQUE("company_id","issue_id","session_id","id","ownership_epoch"),
	CONSTRAINT "issue_execution_refs_liveness_identity_uq" UNIQUE("company_id","issue_id","ownership_epoch","id","target_agent_id","mode"),
	CONSTRAINT "issue_execution_refs_mode_check" CHECK ("issue_execution_refs"."mode" in ('owner', 'consult')),
	CONSTRAINT "issue_execution_refs_source_kind_check" CHECK ("issue_execution_refs"."source_kind" in (
        'issue_request',
        'issue_reassignment',
        'issue_reopen',
        'board_chat',
        'human_comment_mention',
        'routine_dispatch',
        'creator_update',
        'consult_mention',
        'system_nudge',
        'termination_recovery',
        'agent_liveness_followup'
      )),
	CONSTRAINT "issue_execution_refs_previous_epoch_check" CHECK ((
        "issue_execution_refs"."source_kind" = 'issue_reassignment'
        and "issue_execution_refs"."previous_ownership_epoch" > 0
        and "issue_execution_refs"."previous_ownership_epoch" = "issue_execution_refs"."ownership_epoch" - 1
      ) or (
        "issue_execution_refs"."source_kind" <> 'issue_reassignment'
        and "issue_execution_refs"."previous_ownership_epoch" is null
      )),
	CONSTRAINT "issue_execution_refs_message_kind_check" CHECK ("issue_execution_refs"."message_kind" in ('user', 'synthetic')),
	CONSTRAINT "issue_execution_refs_message_input_shape_check" CHECK ((
        "issue_execution_refs"."message_kind" = 'user'
        and "issue_execution_refs"."input_id" is not null
        and "issue_execution_refs"."admitted_seq" is not null
        and "issue_execution_refs"."admitted_seq" between 0 and 9007199254740991
        and (
          "issue_execution_refs"."promoted_seq" is null
          or "issue_execution_refs"."promoted_seq" between "issue_execution_refs"."admitted_seq" and 9007199254740991
        )
      ) or (
        "issue_execution_refs"."message_kind" = 'synthetic'
        and "issue_execution_refs"."input_id" is null
        and "issue_execution_refs"."admitted_seq" is null
        and "issue_execution_refs"."promoted_seq" is null
      )),
	CONSTRAINT "issue_execution_refs_disposition_check" CHECK ("issue_execution_refs"."disposition" in ('active', 'invalidated', 'terminal')),
	CONSTRAINT "issue_execution_refs_lane_ordinal_check" CHECK ("issue_execution_refs"."lane_ordinal" between 0 and 9007199254740991),
	CONSTRAINT "issue_execution_refs_mode_binding_check" CHECK ((
        "issue_execution_refs"."mode" = 'owner'
        and "issue_execution_refs"."issue_execution_authority_id" is not null
        and "issue_execution_refs"."consult_execution_id" is null
      ) or (
        "issue_execution_refs"."mode" = 'consult'
        and "issue_execution_refs"."issue_execution_authority_id" is null
        and "issue_execution_refs"."consult_execution_id" is not null
      )),
	CONSTRAINT "issue_execution_refs_counterpart_check" CHECK ((
        "issue_execution_refs"."counterpart_issue_id" is null
        and "issue_execution_refs"."counterpart_authority_id" is null
        and "issue_execution_refs"."counterpart_ownership_epoch" is null
      ) or (
        "issue_execution_refs"."counterpart_issue_id" is not null
        and "issue_execution_refs"."counterpart_authority_id" is not null
        and "issue_execution_refs"."counterpart_ownership_epoch" is not null
      )),
	CONSTRAINT "issue_execution_refs_consult_chain_check" CHECK ((
        "issue_execution_refs"."mode" = 'owner'
        and "issue_execution_refs"."consult_caller_ref_id" is null
        and "issue_execution_refs"."consult_chain_token" is null
      ) or (
        "issue_execution_refs"."mode" = 'consult'
        and "issue_execution_refs"."consult_caller_ref_id" is not null
        and "issue_execution_refs"."consult_chain_token" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_run_controls" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"current_ref_id" uuid,
	"current_ordinal" integer,
	"current_segment_ordinal" integer,
	CONSTRAINT "issue_execution_run_controls_current_prompt_shape_check" CHECK ((
        "issue_execution_run_controls"."current_ref_id" is null
        and "issue_execution_run_controls"."current_ordinal" is null
        and "issue_execution_run_controls"."current_segment_ordinal" is null
      ) or (
        "issue_execution_run_controls"."current_ref_id" is not null
        and "issue_execution_run_controls"."current_ordinal" is not null
        and "issue_execution_run_controls"."current_ordinal" >= 0
        and "issue_execution_run_controls"."current_segment_ordinal" is not null
        and "issue_execution_run_controls"."current_segment_ordinal" >= 0
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_run_liveness_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"liveness_state" text NOT NULL,
	"liveness_reason" text NOT NULL,
	"continuation_attempt" integer NOT NULL,
	"last_useful_action_at" timestamp with time zone,
	"next_action" text,
	CONSTRAINT "issue_execution_run_liveness_facts_run_uq" UNIQUE("run_id"),
	CONSTRAINT "issue_execution_run_liveness_facts_run_id_uq" UNIQUE("run_id","id"),
	CONSTRAINT "issue_execution_run_liveness_facts_state_check" CHECK ("issue_execution_run_liveness_facts"."liveness_state" in (
        'completed',
        'advanced',
        'plan_only',
        'empty_response',
        'blocked',
        'failed',
        'needs_followup'
      )),
	CONSTRAINT "issue_execution_run_liveness_facts_payload_check" CHECK (length(btrim("issue_execution_run_liveness_facts"."liveness_reason")) between 1 and 500
        and "issue_execution_run_liveness_facts"."continuation_attempt" >= 0
        and (
          "issue_execution_run_liveness_facts"."next_action" is null
          or length(btrim("issue_execution_run_liveness_facts"."next_action")) between 1 and 500
        ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_run_refs" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"ref_id" uuid NOT NULL,
	"ref_ordinal" integer NOT NULL,
	"admission_order" bigint NOT NULL,
	"batch_digest" text NOT NULL,
	"input_id" text,
	"prompt_transmission_phase" text DEFAULT 'not_transmitted' NOT NULL,
	"outcome" text,
	"outcome_reference_id" uuid,
	"protocol_settlement_state" text,
	"accounting_id" uuid,
	"cost_event_id" uuid,
	"settlement_version" integer DEFAULT 0 NOT NULL,
	"attempt_id" uuid,
	"capability_connection_id" uuid,
	"capability_generation" integer,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_run_refs_run_ordinal_uq" UNIQUE("run_id","ref_ordinal"),
	CONSTRAINT "issue_execution_run_refs_run_ref_uq" UNIQUE("run_id","ref_id"),
	CONSTRAINT "issue_execution_run_refs_run_ordinal_ref_uq" UNIQUE("run_id","ref_ordinal","ref_id"),
	CONSTRAINT "issue_execution_run_refs_prompt_identity_uq" UNIQUE("run_id","ref_ordinal","ref_id","batch_digest"),
	CONSTRAINT "issue_execution_run_refs_scope_member_uq" UNIQUE("company_id","issue_id","session_id","run_id","ref_ordinal","ref_id"),
	CONSTRAINT "issue_execution_run_refs_company_issue_run_ordinal_ref_uq" UNIQUE("company_id","issue_id","run_id","ref_ordinal","ref_id"),
	CONSTRAINT "issue_execution_run_refs_ordinal_check" CHECK ("issue_execution_run_refs"."ref_ordinal" >= 0 and "issue_execution_run_refs"."admission_order" >= 0),
	CONSTRAINT "issue_execution_run_refs_batch_digest_check" CHECK (length("issue_execution_run_refs"."batch_digest") = 64
        and "issue_execution_run_refs"."batch_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "issue_execution_run_refs_transmission_check" CHECK ("issue_execution_run_refs"."prompt_transmission_phase" in ('not_transmitted', 'transmitted')),
	CONSTRAINT "issue_execution_run_refs_outcome_check" CHECK ("issue_execution_run_refs"."outcome" is null
        or "issue_execution_run_refs"."outcome" in (
          'released_unsent',
          'succeeded',
          'refused',
          'failed',
          'ambiguous',
          'cancelled'
        )),
	CONSTRAINT "issue_execution_run_refs_protocol_settlement_state_check" CHECK ("issue_execution_run_refs"."protocol_settlement_state" is null
        or "issue_execution_run_refs"."protocol_settlement_state" in ('not_sent', 'settled', 'incomplete')),
	CONSTRAINT "issue_execution_run_refs_settlement_matrix_check" CHECK ((
        "issue_execution_run_refs"."protocol_settlement_state" is null
        and "issue_execution_run_refs"."outcome" is null
        and "issue_execution_run_refs"."outcome_reference_id" is null
        and "issue_execution_run_refs"."accounting_id" is null
        and "issue_execution_run_refs"."cost_event_id" is null
        and "issue_execution_run_refs"."settlement_version" = 0
        and "issue_execution_run_refs"."settled_at" is null
      ) or (
        "issue_execution_run_refs"."protocol_settlement_state" = 'not_sent'
        and "issue_execution_run_refs"."prompt_transmission_phase" = 'not_transmitted'
        and "issue_execution_run_refs"."outcome" = 'released_unsent'
        and "issue_execution_run_refs"."outcome_reference_id" is not null
        and "issue_execution_run_refs"."accounting_id" is null
        and "issue_execution_run_refs"."cost_event_id" is null
        and "issue_execution_run_refs"."settlement_version" > 0
        and "issue_execution_run_refs"."settled_at" is not null
      ) or (
        "issue_execution_run_refs"."protocol_settlement_state" = 'incomplete'
        and "issue_execution_run_refs"."prompt_transmission_phase" = 'transmitted'
        and "issue_execution_run_refs"."outcome" in ('failed', 'ambiguous', 'cancelled')
        and "issue_execution_run_refs"."outcome_reference_id" is not null
        and "issue_execution_run_refs"."accounting_id" is null
        and "issue_execution_run_refs"."cost_event_id" is null
        and "issue_execution_run_refs"."settlement_version" > 0
        and "issue_execution_run_refs"."settled_at" is not null
      ) or (
        "issue_execution_run_refs"."protocol_settlement_state" = 'settled'
        and "issue_execution_run_refs"."prompt_transmission_phase" = 'transmitted'
        and "issue_execution_run_refs"."outcome" in ('succeeded', 'refused', 'failed', 'cancelled')
        and "issue_execution_run_refs"."outcome_reference_id" is not null
        and "issue_execution_run_refs"."accounting_id" is not null
        and "issue_execution_run_refs"."cost_event_id" is not null
        and "issue_execution_run_refs"."settlement_version" > 0
        and "issue_execution_run_refs"."settled_at" is not null
      )),
	CONSTRAINT "issue_execution_run_refs_capability_generation_check" CHECK ((
        "issue_execution_run_refs"."attempt_id" is null
        and "issue_execution_run_refs"."capability_connection_id" is null
        and "issue_execution_run_refs"."capability_generation" is null
      ) or (
        "issue_execution_run_refs"."attempt_id" is not null
        and "issue_execution_run_refs"."capability_connection_id" is not null
        and "issue_execution_run_refs"."capability_generation" is not null
        and "issue_execution_run_refs"."capability_generation" > 0
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"execution_scope_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"target_agent_id" uuid,
	"adapter_config_revision_id" uuid NOT NULL,
	"execution_workspace_binding_id" uuid NOT NULL,
	"execution_mode" text,
	"issue_execution_authority_id" uuid,
	"consult_execution_id" uuid,
	"compaction_scope_kind" text,
	"parent_run_id" uuid,
	"retry_of_run_id" uuid,
	"triggered_by_run_id" uuid,
	"current_attempt_id" uuid,
	"current_lease_id" uuid,
	"cancellation_intent_id" uuid,
	"terminal_finalization_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"terminal_classification" text,
	"terminal_reason_code" text,
	"process_exit_code" integer,
	"process_signal" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_runs_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "issue_execution_runs_company_issue_id_uq" UNIQUE("company_id","issue_id","id"),
	CONSTRAINT "issue_execution_runs_scope_id_uq" UNIQUE("company_id","issue_id","session_id","id"),
	CONSTRAINT "issue_execution_runs_company_issue_id_kind_uq" UNIQUE("company_id","issue_id","id","kind"),
	CONSTRAINT "issue_execution_runs_epoch_id_uq" UNIQUE("company_id","issue_id","ownership_epoch","id"),
	CONSTRAINT "issue_execution_runs_liveness_identity_uq" UNIQUE("company_id","issue_id","ownership_epoch","id","target_agent_id","execution_mode"),
	CONSTRAINT "issue_execution_runs_company_id_target_agent_uq" UNIQUE("company_id","id","target_agent_id"),
	CONSTRAINT "issue_execution_runs_accounting_revision_uq" UNIQUE("company_id","issue_id","id","kind","adapter_config_revision_id"),
	CONSTRAINT "issue_execution_runs_native_target_scope_uq" UNIQUE("company_id","issue_id","ownership_epoch","id","target_agent_id","adapter_config_revision_id","execution_workspace_binding_id"),
	CONSTRAINT "issue_execution_runs_prompt_scope_uq" UNIQUE("company_id","issue_id","ownership_epoch","id","target_agent_id","adapter_config_revision_id","execution_workspace_binding_id","execution_mode"),
	CONSTRAINT "issue_execution_runs_kind_check" CHECK ("issue_execution_runs"."kind" in ('productive', 'consult', 'compaction')),
	CONSTRAINT "issue_execution_runs_status_check" CHECK ("issue_execution_runs"."status" in (
        'queued',
        'scheduled_retry',
        'running',
        'succeeded',
        'interrupted',
        'failed',
        'cancelled',
        'timed_out'
      )),
	CONSTRAINT "issue_execution_runs_epoch_check" CHECK ("issue_execution_runs"."ownership_epoch" > 0),
	CONSTRAINT "issue_execution_runs_mode_check" CHECK ("issue_execution_runs"."execution_mode" is null
        or "issue_execution_runs"."execution_mode" in ('owner', 'consult')),
	CONSTRAINT "issue_execution_runs_compaction_scope_kind_check" CHECK ("issue_execution_runs"."compaction_scope_kind" is null
        or "issue_execution_runs"."compaction_scope_kind" in ('turns-recovery', 'comments-recovery')),
	CONSTRAINT "issue_execution_runs_kind_shape_check" CHECK ((
        "issue_execution_runs"."kind" = 'productive'
        and "issue_execution_runs"."target_agent_id" is not null
        and "issue_execution_runs"."execution_mode" = 'owner'
        and "issue_execution_runs"."issue_execution_authority_id" is not null
        and "issue_execution_runs"."consult_execution_id" is null
        and "issue_execution_runs"."compaction_scope_kind" is null
        and "issue_execution_runs"."parent_run_id" is null
        and "issue_execution_runs"."triggered_by_run_id" is null
      ) or (
        "issue_execution_runs"."kind" = 'consult'
        and "issue_execution_runs"."target_agent_id" is not null
        and "issue_execution_runs"."execution_mode" = 'consult'
        and "issue_execution_runs"."issue_execution_authority_id" is null
        and "issue_execution_runs"."consult_execution_id" is not null
        and "issue_execution_runs"."compaction_scope_kind" is null
        and "issue_execution_runs"."parent_run_id" is not null
        and "issue_execution_runs"."triggered_by_run_id" is null
      ) or (
        "issue_execution_runs"."kind" = 'compaction'
        and "issue_execution_runs"."target_agent_id" is null
        and "issue_execution_runs"."execution_mode" is null
        and "issue_execution_runs"."issue_execution_authority_id" is null
        and "issue_execution_runs"."consult_execution_id" is null
        and "issue_execution_runs"."compaction_scope_kind" is not null
        and "issue_execution_runs"."parent_run_id" is not null
        and "issue_execution_runs"."triggered_by_run_id" is not null
        and "issue_execution_runs"."parent_run_id" = "issue_execution_runs"."triggered_by_run_id"
      )),
	CONSTRAINT "issue_execution_runs_current_attempt_lease_check" CHECK ((
        "issue_execution_runs"."current_attempt_id" is null
        and "issue_execution_runs"."current_lease_id" is null
      ) or (
        "issue_execution_runs"."current_attempt_id" is not null
        and "issue_execution_runs"."current_lease_id" is not null
      )),
	CONSTRAINT "issue_execution_runs_terminal_shape_check" CHECK ((
        "issue_execution_runs"."status" in ('queued', 'scheduled_retry', 'running')
        and "issue_execution_runs"."finished_at" is null
        and "issue_execution_runs"."terminal_classification" is null
        and "issue_execution_runs"."terminal_reason_code" is null
        and "issue_execution_runs"."terminal_finalization_id" is null
        and "issue_execution_runs"."process_exit_code" is null
        and "issue_execution_runs"."process_signal" is null
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
      )),
	CONSTRAINT "issue_execution_runs_time_check" CHECK ("issue_execution_runs"."updated_at" >= "issue_execution_runs"."created_at"
        and (
          "issue_execution_runs"."started_at" is null
          or "issue_execution_runs"."started_at" >= "issue_execution_runs"."created_at"
        )
        and (
          "issue_execution_runs"."finished_at" is null
          or "issue_execution_runs"."started_at" is null
          or "issue_execution_runs"."finished_at" >= "issue_execution_runs"."started_at"
        )),
	CONSTRAINT "issue_execution_runs_process_exit_check" CHECK ("issue_execution_runs"."process_exit_code" is null
        or "issue_execution_runs"."process_exit_code" between 0 and 255
        and not (
          "issue_execution_runs"."process_exit_code" is not null
          and "issue_execution_runs"."process_signal" is not null
        )),
	CONSTRAINT "issue_execution_runs_process_signal_check" CHECK ("issue_execution_runs"."process_signal" is null
        or (
          length("issue_execution_runs"."process_signal") between 1 and 32
          and "issue_execution_runs"."process_signal" ~ '^SIG[A-Z0-9]+$'
        ))
);
--> statement-breakpoint
CREATE TABLE "issue_execution_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"purpose" text NOT NULL,
	"state" text NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"adapter_config_identity" uuid NOT NULL,
	"workspace_identity" uuid NOT NULL,
	"lane_kind" text,
	"run_id" uuid,
	"current_ref_id" uuid,
	"current_ref_ordinal" integer,
	"current_segment_ordinal" integer,
	"authorized_context_exposure_digest" text,
	"envelope_version" text DEFAULT 'issue-execution-native/v1' NOT NULL,
	"codec_kind" text DEFAULT 'acp-session/v1' NOT NULL,
	"acp_wire_protocol_version" integer DEFAULT 1 NOT NULL,
	"protected_target_session" text NOT NULL,
	"protected_target_session_digest" text NOT NULL,
	"target_fingerprint" text NOT NULL,
	"correlation_generation" integer NOT NULL,
	"last_protocol_settled_run_id" uuid,
	"last_protocol_settled_ref_id" uuid,
	"last_protocol_settled_ref_ordinal" integer,
	"last_protocol_settled_segment_ordinal" integer,
	"cost_cursor_state" text DEFAULT 'unanchored' NOT NULL,
	"cost_cursor_amount" numeric,
	"cost_cursor_currency" text,
	"supersession_reason" text,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_sessions_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "issue_execution_sessions_epoch_generation_check" CHECK ("issue_execution_sessions"."ownership_epoch" > 0
        and "issue_execution_sessions"."correlation_generation" > 0),
	CONSTRAINT "issue_execution_sessions_purpose_shape_check" CHECK ((
        "issue_execution_sessions"."purpose" = 'carry'
        and "issue_execution_sessions"."state" in ('eligible', 'superseded')
        and "issue_execution_sessions"."lane_kind" is not null
        and "issue_execution_sessions"."lane_kind" in ('owner', 'consult')
        and "issue_execution_sessions"."run_id" is null
        and "issue_execution_sessions"."current_ref_id" is null
        and "issue_execution_sessions"."current_ref_ordinal" is null
        and "issue_execution_sessions"."current_segment_ordinal" is null
        and "issue_execution_sessions"."authorized_context_exposure_digest" is not null
      ) or (
        "issue_execution_sessions"."purpose" = 'active_run_steering'
        and "issue_execution_sessions"."state" in ('current', 'superseded')
        and "issue_execution_sessions"."lane_kind" is null
        and "issue_execution_sessions"."run_id" is not null
        and "issue_execution_sessions"."current_ref_id" is not null
        and "issue_execution_sessions"."current_ref_ordinal" is not null
        and "issue_execution_sessions"."current_ref_ordinal" >= 0
        and "issue_execution_sessions"."current_segment_ordinal" is not null
        and "issue_execution_sessions"."current_segment_ordinal" >= 0
        and "issue_execution_sessions"."authorized_context_exposure_digest" is null
      )),
	CONSTRAINT "issue_execution_sessions_supersession_check" CHECK ((
        "issue_execution_sessions"."state" in ('eligible', 'current')
        and "issue_execution_sessions"."supersession_reason" is null
        and "issue_execution_sessions"."superseded_at" is null
      ) or (
        "issue_execution_sessions"."state" = 'superseded'
        and "issue_execution_sessions"."supersession_reason" is not null
        and length(btrim("issue_execution_sessions"."supersession_reason")) between 1 and 200
        and "issue_execution_sessions"."superseded_at" is not null
        and "issue_execution_sessions"."superseded_at" >= "issue_execution_sessions"."created_at"
      )),
	CONSTRAINT "issue_execution_sessions_envelope_check" CHECK ("issue_execution_sessions"."envelope_version" = 'issue-execution-native/v1'
        and "issue_execution_sessions"."codec_kind" = 'acp-session/v1'
        and "issue_execution_sessions"."acp_wire_protocol_version" = 1
        and length(btrim("issue_execution_sessions"."protected_target_session")) > 0
        and "issue_execution_sessions"."protected_target_session" like 'pcnc.v1.%'),
	CONSTRAINT "issue_execution_sessions_digest_check" CHECK ("issue_execution_sessions"."protected_target_session_digest" ~ '^[0-9a-f]{64}$'
        and "issue_execution_sessions"."target_fingerprint" ~ '^[0-9a-f]{64}$'
        and (
          "issue_execution_sessions"."authorized_context_exposure_digest" is null
          or "issue_execution_sessions"."authorized_context_exposure_digest" ~ '^[0-9a-f]{64}$'
        )),
	CONSTRAINT "issue_execution_sessions_last_settled_prompt_check" CHECK ((
        "issue_execution_sessions"."last_protocol_settled_run_id" is null
        and "issue_execution_sessions"."last_protocol_settled_ref_id" is null
        and "issue_execution_sessions"."last_protocol_settled_ref_ordinal" is null
        and "issue_execution_sessions"."last_protocol_settled_segment_ordinal" is null
      ) or (
        "issue_execution_sessions"."last_protocol_settled_run_id" is not null
        and "issue_execution_sessions"."last_protocol_settled_ref_id" is not null
        and "issue_execution_sessions"."last_protocol_settled_ref_ordinal" is not null
        and "issue_execution_sessions"."last_protocol_settled_ref_ordinal" >= 0
        and "issue_execution_sessions"."last_protocol_settled_segment_ordinal" is not null
        and "issue_execution_sessions"."last_protocol_settled_segment_ordinal" >= 0
      )),
	CONSTRAINT "issue_execution_sessions_cost_cursor_check" CHECK ((
        "issue_execution_sessions"."cost_cursor_state" = 'unanchored'
        and "issue_execution_sessions"."cost_cursor_amount" is null
        and "issue_execution_sessions"."cost_cursor_currency" is null
        and "issue_execution_sessions"."last_protocol_settled_run_id" is null
      ) or (
        "issue_execution_sessions"."cost_cursor_state" = 'known'
        and "issue_execution_sessions"."cost_cursor_amount" is not null
        and "issue_execution_sessions"."cost_cursor_amount" >= 0
    and "issue_execution_sessions"."cost_cursor_amount" not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and "issue_execution_sessions"."cost_cursor_amount"::text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'
        and "issue_execution_sessions"."cost_cursor_currency" is not null
        and "issue_execution_sessions"."last_protocol_settled_run_id" is not null
      ) or (
        "issue_execution_sessions"."cost_cursor_state" = 'unavailable'
        and "issue_execution_sessions"."cost_cursor_amount" is null
        and "issue_execution_sessions"."cost_cursor_currency" is null
        and "issue_execution_sessions"."last_protocol_settled_run_id" is not null
      ))
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
CREATE TABLE "issue_execution_workspace_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"execution_workspace_id" uuid NOT NULL,
	"binding_mode" text NOT NULL,
	"absolute_cwd" text NOT NULL,
	"repository_locator" text,
	"repository_ref" text,
	"pull_request_selector" text,
	"environment_selector" text,
	"bound_by_agent_id" uuid,
	"bound_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_execution_workspace_bindings_scope_epoch_id_uq" UNIQUE("company_id","issue_id","session_id","ownership_epoch","id"),
	CONSTRAINT "issue_execution_workspace_bindings_identity_uq" UNIQUE("company_id","issue_id","ownership_epoch","id"),
	CONSTRAINT "issue_execution_workspace_bindings_epoch_check" CHECK ("issue_execution_workspace_bindings"."ownership_epoch" > 0),
	CONSTRAINT "issue_execution_workspace_bindings_absolute_cwd_check" CHECK (left("issue_execution_workspace_bindings"."absolute_cwd", 1) = '/')
);
--> statement-breakpoint
CREATE TABLE "issue_inbox_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"archived_by_actor_type" text DEFAULT 'user' NOT NULL,
	"archived_by_agent_id" uuid,
	"archived_by_run_id" uuid,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_inbox_archives_archived_by_actor_type_check" CHECK ("issue_inbox_archives"."archived_by_actor_type" in ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "issue_labels" (
	"issue_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_labels_pk" PRIMARY KEY("issue_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "issue_liveness_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"frontier_finalization_id" uuid NOT NULL,
	"creator_edge_id" uuid NOT NULL,
	"creator_edge_admission_version" integer NOT NULL,
	"stale_target_agent_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"source_mode" text NOT NULL,
	"source_comment_id" uuid NOT NULL,
	"followup_system_reply_comment_id" uuid,
	"followup_ref_id" uuid,
	"followup_run_id" uuid,
	"followup_finalization_id" uuid,
	"accepted_action_kind" text,
	"accepted_action_source_id" text,
	"accepted_action_committed_at" timestamp with time zone,
	"superseded_before_attention_at" timestamp with time zone,
	"board_attention_emitted_at" timestamp with time zone,
	"board_attention_reason" text,
	"exit_action_kind" text,
	"exit_action_source_id" text,
	"exit_action_committed_at" timestamp with time zone,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_liveness_reconciliations_frontier_uq" UNIQUE("company_id","issue_id","ownership_epoch","frontier_finalization_id"),
	CONSTRAINT "issue_liveness_reconciliations_epoch_version_check" CHECK ("issue_liveness_reconciliations"."ownership_epoch" > 0
        and "issue_liveness_reconciliations"."creator_edge_admission_version" > 0),
	CONSTRAINT "issue_liveness_reconciliations_source_mode_check" CHECK ("issue_liveness_reconciliations"."source_mode" in ('owner', 'consult')),
	CONSTRAINT "issue_liveness_reconciliations_followup_chain_check" CHECK (("issue_liveness_reconciliations"."followup_ref_id" is null
          or "issue_liveness_reconciliations"."followup_system_reply_comment_id" is not null)
        and ("issue_liveness_reconciliations"."followup_run_id" is null
          or "issue_liveness_reconciliations"."followup_ref_id" is not null)
        and ("issue_liveness_reconciliations"."followup_finalization_id" is null
          or "issue_liveness_reconciliations"."followup_run_id" is not null)),
	CONSTRAINT "issue_liveness_reconciliations_accepted_action_tuple_check" CHECK ((
        "issue_liveness_reconciliations"."accepted_action_kind" is null
        and "issue_liveness_reconciliations"."accepted_action_source_id" is null
        and "issue_liveness_reconciliations"."accepted_action_committed_at" is null
      ) or (
        "issue_liveness_reconciliations"."accepted_action_kind" is not null
        and "issue_liveness_reconciliations"."accepted_action_source_id" is not null
        and length(btrim("issue_liveness_reconciliations"."accepted_action_source_id")) between 1 and 500
        and "issue_liveness_reconciliations"."accepted_action_committed_at" is not null
        and "issue_liveness_reconciliations"."accepted_action_committed_at" > "issue_liveness_reconciliations"."admitted_at"
      )),
	CONSTRAINT "issue_liveness_reconciliations_accepted_action_kind_check" CHECK ("issue_liveness_reconciliations"."accepted_action_kind" is null or "issue_liveness_reconciliations"."accepted_action_kind" in (
        'authenticated_human_comment',
        'issue_create_child',
        'mention_agent',
        'issue_assign',
        'issue_update',
        'creator_withdrawal',
        'board_lifecycle_command',
        'board_reopen'
      )),
	CONSTRAINT "issue_liveness_reconciliations_attention_tuple_check" CHECK ((
        "issue_liveness_reconciliations"."board_attention_emitted_at" is null
        and "issue_liveness_reconciliations"."board_attention_reason" is null
      ) or (
        "issue_liveness_reconciliations"."board_attention_emitted_at" is not null
        and "issue_liveness_reconciliations"."board_attention_emitted_at" >= "issue_liveness_reconciliations"."admitted_at"
        and "issue_liveness_reconciliations"."board_attention_reason" in (
          'agent_no_action',
          'agent_followup_failed',
          'agent_unavailable'
        )
      )),
	CONSTRAINT "issue_liveness_reconciliations_supersession_time_check" CHECK ("issue_liveness_reconciliations"."superseded_before_attention_at" is null
        or "issue_liveness_reconciliations"."superseded_before_attention_at" >= "issue_liveness_reconciliations"."admitted_at"),
	CONSTRAINT "issue_liveness_reconciliations_exit_action_tuple_check" CHECK ((
        "issue_liveness_reconciliations"."exit_action_kind" is null
        and "issue_liveness_reconciliations"."exit_action_source_id" is null
        and "issue_liveness_reconciliations"."exit_action_committed_at" is null
      ) or (
        "issue_liveness_reconciliations"."exit_action_kind" is not null
        and "issue_liveness_reconciliations"."exit_action_source_id" is not null
        and length(btrim("issue_liveness_reconciliations"."exit_action_source_id")) between 1 and 500
        and "issue_liveness_reconciliations"."exit_action_committed_at" is not null
        and "issue_liveness_reconciliations"."board_attention_emitted_at" is not null
        and "issue_liveness_reconciliations"."exit_action_committed_at" > "issue_liveness_reconciliations"."board_attention_emitted_at"
      )),
	CONSTRAINT "issue_liveness_reconciliations_exit_action_kind_check" CHECK ("issue_liveness_reconciliations"."exit_action_kind" is null or "issue_liveness_reconciliations"."exit_action_kind" in (
        'authenticated_human_comment',
        'issue_create_child',
        'mention_agent',
        'issue_assign',
        'issue_update',
        'creator_withdrawal',
        'board_lifecycle_command',
        'board_reopen'
      )),
	CONSTRAINT "issue_liveness_reconciliations_initial_settlement_check" CHECK (not (
          "issue_liveness_reconciliations"."accepted_action_kind" is not null
          and "issue_liveness_reconciliations"."superseded_before_attention_at" is not null
        )
        and not (
          "issue_liveness_reconciliations"."accepted_action_kind" is not null
          and "issue_liveness_reconciliations"."board_attention_emitted_at" is not null
        )
        and not (
          "issue_liveness_reconciliations"."superseded_before_attention_at" is not null
          and "issue_liveness_reconciliations"."board_attention_emitted_at" is not null
        )
        and (
          "issue_liveness_reconciliations"."followup_finalization_id" is null
          or "issue_liveness_reconciliations"."accepted_action_kind" is not null
          or "issue_liveness_reconciliations"."superseded_before_attention_at" is not null
          or "issue_liveness_reconciliations"."board_attention_emitted_at" is not null
        )),
	CONSTRAINT "issue_liveness_reconciliations_incomplete_followup_check" CHECK (not (
        "issue_liveness_reconciliations"."followup_system_reply_comment_id" is not null
        and "issue_liveness_reconciliations"."followup_finalization_id" is null
      ) or (
        "issue_liveness_reconciliations"."accepted_action_kind" is null
        and "issue_liveness_reconciliations"."superseded_before_attention_at" is null
        and "issue_liveness_reconciliations"."board_attention_emitted_at" is null
        and "issue_liveness_reconciliations"."exit_action_kind" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_read_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_reference_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"target_issue_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_record_id" uuid,
	"document_key" text,
	"matched_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"related_issue_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_session_assistant_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"assistant_message_id" text NOT NULL,
	"source_total_tokens" bigint,
	"source_assistant_error_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_session_assistant_sources_nonempty_check" CHECK ("issue_session_assistant_sources"."source_total_tokens" is not null or "issue_session_assistant_sources"."source_assistant_error_kind" is not null),
	CONSTRAINT "issue_session_assistant_sources_token_check" CHECK ("issue_session_assistant_sources"."source_total_tokens" is null or "issue_session_assistant_sources"."source_total_tokens" >= 0),
	CONSTRAINT "issue_session_assistant_sources_error_kind_check" CHECK ("issue_session_assistant_sources"."source_assistant_error_kind" is null or "issue_session_assistant_sources"."source_assistant_error_kind" in ('aborted', 'other'))
);
--> statement-breakpoint
CREATE TABLE "issue_session_compaction_controls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"seq" bigint,
	"kind" text NOT NULL,
	"disposition" text DEFAULT 'active' NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidated_by_revert_event_id" text,
	"invalidated_boundary_message_id" text,
	"invalidated_boundary_seq" bigint,
	"history_scope_kind" text NOT NULL,
	"history_scope_id" text NOT NULL,
	"audience" text NOT NULL,
	"context_epoch" integer NOT NULL,
	"execution_lineage_id" uuid NOT NULL,
	"source_high_water_seq" bigint NOT NULL,
	"latest_finished_assistant_message_id" text,
	"source_run_id" uuid NOT NULL,
	"source_run_kind" text NOT NULL,
	"source_ref_id" uuid NOT NULL,
	"source_ref_ordinal" integer NOT NULL,
	"source_segment_ordinal" integer NOT NULL,
	"recovery_identity_digest" text,
	"compaction_request_message_id" text,
	"summary_assistant_message_id" text,
	"failed_assistant_message_id" text,
	"failed_assistant_error_kind" text,
	"assistant_message_id" text,
	"tool_id" text,
	"pruned_at" timestamp with time zone,
	"tail_start_message_id" text,
	"replay_message_id" text,
	"continuation_message_id" text,
	"post_checkpoint_action" text DEFAULT 'none' NOT NULL,
	"compaction_run_id" uuid,
	"compaction_run_kind" text DEFAULT 'compaction' NOT NULL,
	"prompt_transmission_phase" text,
	"protocol_settlement_state" text,
	"prompt_settlement_reference_id" uuid,
	"accounting_id" uuid,
	"cost_event_id" uuid,
	"settlement_version" integer DEFAULT 0 NOT NULL,
	"settled_at" timestamp with time zone,
	"compaction_failure_kind" text,
	"structural_positions" jsonb,
	"settings_snapshot" jsonb,
	"model_snapshot" jsonb,
	"trigger_model_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_session_compaction_controls_run_prompt_uq" UNIQUE("company_id","issue_id","id","compaction_run_id"),
	CONSTRAINT "issue_session_compaction_controls_kind_check" CHECK ("issue_session_compaction_controls"."kind" in (
        'recovery-prompt',
        'checkpoint',
        'failed-compaction',
        'tool-pruned'
      )),
	CONSTRAINT "issue_session_compaction_controls_disposition_check" CHECK ("issue_session_compaction_controls"."disposition" in ('active', 'invalidated')),
	CONSTRAINT "issue_session_compaction_controls_revert_provenance_check" CHECK ((
        "issue_session_compaction_controls"."disposition" = 'active'
        and "issue_session_compaction_controls"."invalidated_at" is null
        and "issue_session_compaction_controls"."invalidated_by_revert_event_id" is null
        and "issue_session_compaction_controls"."invalidated_boundary_message_id" is null
        and "issue_session_compaction_controls"."invalidated_boundary_seq" is null
      ) or (
        "issue_session_compaction_controls"."disposition" = 'invalidated'
        and "issue_session_compaction_controls"."invalidated_at" is not null
        and "issue_session_compaction_controls"."invalidated_by_revert_event_id" is not null
        and length("issue_session_compaction_controls"."invalidated_by_revert_event_id") > 0
        and "issue_session_compaction_controls"."invalidated_boundary_message_id" is not null
        and length("issue_session_compaction_controls"."invalidated_boundary_message_id") > 0
        and "issue_session_compaction_controls"."invalidated_boundary_seq" is not null
        and "issue_session_compaction_controls"."invalidated_boundary_seq" >= 0
      )),
	CONSTRAINT "issue_session_compaction_controls_scope_check" CHECK ((
          (
            "issue_session_compaction_controls"."history_scope_kind" = 'turns-recovery'
            and "issue_session_compaction_controls"."audience" = 'turns'
          ) or (
            "issue_session_compaction_controls"."history_scope_kind" = 'comments-recovery'
            and "issue_session_compaction_controls"."audience" = 'comments'
          )
        )
        and btrim("issue_session_compaction_controls"."history_scope_id") <> ''
        and "issue_session_compaction_controls"."context_epoch" >= 0
        and "issue_session_compaction_controls"."source_high_water_seq" >= 0
        and "issue_session_compaction_controls"."source_ref_ordinal" >= 0
        and "issue_session_compaction_controls"."source_segment_ordinal" >= 0),
	CONSTRAINT "issue_session_compaction_controls_post_checkpoint_action_check" CHECK ("issue_session_compaction_controls"."post_checkpoint_action" in (
        'none',
        'overflow-replay',
        'auto-continue'
      )),
	CONSTRAINT "issue_session_compaction_controls_settings_snapshot_check" CHECK ("issue_session_compaction_controls"."settings_snapshot" is null
        or (
          jsonb_typeof("issue_session_compaction_controls"."settings_snapshot") = 'object'
          and "issue_session_compaction_controls"."settings_snapshot"
            - 'auto'
            - 'prune'
            - 'reserved'
            - 'tail_turns'
            - 'preserve_recent_tokens'
            - 'modelRef' = '{}'::jsonb
          and (
            not ("issue_session_compaction_controls"."settings_snapshot" ? 'auto')
            or jsonb_typeof("issue_session_compaction_controls"."settings_snapshot" -> 'auto') = 'boolean'
          )
          and (
            not ("issue_session_compaction_controls"."settings_snapshot" ? 'prune')
            or jsonb_typeof("issue_session_compaction_controls"."settings_snapshot" -> 'prune') = 'boolean'
          )
          and (
            not ("issue_session_compaction_controls"."settings_snapshot" ? 'reserved')
            or (
              jsonb_typeof("issue_session_compaction_controls"."settings_snapshot" -> 'reserved') = 'number'
              and ("issue_session_compaction_controls"."settings_snapshot" ->> 'reserved') ~ '^(0|[1-9][0-9]*)$'
            )
          )
          and (
            not ("issue_session_compaction_controls"."settings_snapshot" ? 'tail_turns')
            or (
              jsonb_typeof("issue_session_compaction_controls"."settings_snapshot" -> 'tail_turns') = 'number'
              and ("issue_session_compaction_controls"."settings_snapshot" ->> 'tail_turns') ~ '^(0|[1-9][0-9]*)$'
            )
          )
          and (
            not ("issue_session_compaction_controls"."settings_snapshot" ? 'preserve_recent_tokens')
            or (
              jsonb_typeof("issue_session_compaction_controls"."settings_snapshot" -> 'preserve_recent_tokens') = 'number'
              and ("issue_session_compaction_controls"."settings_snapshot" ->> 'preserve_recent_tokens') ~ '^(0|[1-9][0-9]*)$'
            )
          )
          and (
            not ("issue_session_compaction_controls"."settings_snapshot" ? 'modelRef')
            or (
              jsonb_typeof("issue_session_compaction_controls"."settings_snapshot" -> 'modelRef') = 'string'
              and btrim("issue_session_compaction_controls"."settings_snapshot" ->> 'modelRef') <> ''
              and length(btrim("issue_session_compaction_controls"."settings_snapshot" ->> 'modelRef')) <= 500
            )
          )
        )),
	CONSTRAINT "issue_session_compaction_controls_prompt_settlement_check" CHECK ((
        "issue_session_compaction_controls"."kind" <> 'recovery-prompt'
        and "issue_session_compaction_controls"."prompt_transmission_phase" is null
        and "issue_session_compaction_controls"."protocol_settlement_state" is null
        and "issue_session_compaction_controls"."prompt_settlement_reference_id" is null
        and "issue_session_compaction_controls"."accounting_id" is null
        and "issue_session_compaction_controls"."cost_event_id" is null
        and "issue_session_compaction_controls"."settlement_version" = 0
        and "issue_session_compaction_controls"."settled_at" is null
        and "issue_session_compaction_controls"."compaction_failure_kind" is null
      ) or (
        "issue_session_compaction_controls"."kind" = 'recovery-prompt'
        and "issue_session_compaction_controls"."prompt_transmission_phase" is not null
        and (
          (
            "issue_session_compaction_controls"."protocol_settlement_state" is null
            and "issue_session_compaction_controls"."prompt_settlement_reference_id" is null
            and "issue_session_compaction_controls"."accounting_id" is null
            and "issue_session_compaction_controls"."cost_event_id" is null
            and "issue_session_compaction_controls"."settlement_version" = 0
            and "issue_session_compaction_controls"."settled_at" is null
            and "issue_session_compaction_controls"."compaction_failure_kind" is null
          ) or (
            "issue_session_compaction_controls"."prompt_transmission_phase" = 'not_transmitted'
            and "issue_session_compaction_controls"."protocol_settlement_state" = 'not_sent'
            and "issue_session_compaction_controls"."prompt_settlement_reference_id" is not null
            and "issue_session_compaction_controls"."accounting_id" is null
            and "issue_session_compaction_controls"."cost_event_id" is null
            and "issue_session_compaction_controls"."settlement_version" > 0
            and "issue_session_compaction_controls"."settled_at" is not null
            and "issue_session_compaction_controls"."compaction_failure_kind" is not null
          ) or (
            "issue_session_compaction_controls"."prompt_transmission_phase" = 'transmitted'
            and "issue_session_compaction_controls"."protocol_settlement_state" = 'incomplete'
            and "issue_session_compaction_controls"."prompt_settlement_reference_id" is not null
            and "issue_session_compaction_controls"."accounting_id" is null
            and "issue_session_compaction_controls"."cost_event_id" is null
            and "issue_session_compaction_controls"."settlement_version" > 0
            and "issue_session_compaction_controls"."settled_at" is not null
            and "issue_session_compaction_controls"."compaction_failure_kind" is not null
          ) or (
            "issue_session_compaction_controls"."prompt_transmission_phase" = 'transmitted'
            and "issue_session_compaction_controls"."protocol_settlement_state" = 'settled'
            and "issue_session_compaction_controls"."prompt_settlement_reference_id" is not null
            and "issue_session_compaction_controls"."accounting_id" is not null
            and "issue_session_compaction_controls"."cost_event_id" is not null
            and "issue_session_compaction_controls"."settlement_version" > 0
            and "issue_session_compaction_controls"."settled_at" is not null
          )
        )
      )),
	CONSTRAINT "issue_session_compaction_controls_shape_check" CHECK ((
        "issue_session_compaction_controls"."kind" = 'recovery-prompt'
        and "issue_session_compaction_controls"."compaction_request_message_id" is null
        and "issue_session_compaction_controls"."summary_assistant_message_id" is null
        and "issue_session_compaction_controls"."failed_assistant_message_id" is null
        and "issue_session_compaction_controls"."failed_assistant_error_kind" is null
        and "issue_session_compaction_controls"."assistant_message_id" is null
        and "issue_session_compaction_controls"."tool_id" is null
        and "issue_session_compaction_controls"."pruned_at" is null
        and "issue_session_compaction_controls"."tail_start_message_id" is null
        and "issue_session_compaction_controls"."replay_message_id" is null
        and "issue_session_compaction_controls"."continuation_message_id" is null
        and "issue_session_compaction_controls"."post_checkpoint_action" = 'none'
        and "issue_session_compaction_controls"."compaction_run_id" is not null
        and "issue_session_compaction_controls"."settings_snapshot" is not null
        and "issue_session_compaction_controls"."model_snapshot" is not null
        and "issue_session_compaction_controls"."trigger_model_snapshot" is not null
        and "issue_session_compaction_controls"."recovery_identity_digest" is not null
        and "issue_session_compaction_controls"."recovery_identity_digest" ~ '^[0-9a-f]{64}$'
      ) or (
        "issue_session_compaction_controls"."kind" = 'checkpoint'
        and "issue_session_compaction_controls"."compaction_request_message_id" is not null
        and "issue_session_compaction_controls"."summary_assistant_message_id" is not null
        and "issue_session_compaction_controls"."failed_assistant_message_id" is null
        and "issue_session_compaction_controls"."failed_assistant_error_kind" is null
        and "issue_session_compaction_controls"."assistant_message_id" is null
        and "issue_session_compaction_controls"."tool_id" is null
        and "issue_session_compaction_controls"."pruned_at" is null
        and "issue_session_compaction_controls"."compaction_run_id" is not null
        and "issue_session_compaction_controls"."settings_snapshot" is null
        and "issue_session_compaction_controls"."model_snapshot" is null
        and "issue_session_compaction_controls"."trigger_model_snapshot" is null
        and "issue_session_compaction_controls"."recovery_identity_digest" is null
        and (
          (
            "issue_session_compaction_controls"."post_checkpoint_action" = 'none'
            and "issue_session_compaction_controls"."replay_message_id" is null
            and "issue_session_compaction_controls"."continuation_message_id" is null
          )
          or (
            "issue_session_compaction_controls"."post_checkpoint_action" = 'overflow-replay'
            and "issue_session_compaction_controls"."replay_message_id" is not null
            and "issue_session_compaction_controls"."continuation_message_id" is null
          )
          or (
            "issue_session_compaction_controls"."post_checkpoint_action" = 'auto-continue'
            and "issue_session_compaction_controls"."replay_message_id" is null
            and "issue_session_compaction_controls"."continuation_message_id" is not null
          )
        )
      ) or (
        "issue_session_compaction_controls"."kind" = 'failed-compaction'
        and "issue_session_compaction_controls"."compaction_request_message_id" is not null
        and "issue_session_compaction_controls"."summary_assistant_message_id" is null
        and "issue_session_compaction_controls"."failed_assistant_message_id" is not null
        and "issue_session_compaction_controls"."failed_assistant_error_kind" is not null
        and "issue_session_compaction_controls"."assistant_message_id" is null
        and "issue_session_compaction_controls"."tool_id" is null
        and "issue_session_compaction_controls"."pruned_at" is null
        and "issue_session_compaction_controls"."tail_start_message_id" is null
        and "issue_session_compaction_controls"."replay_message_id" is null
        and "issue_session_compaction_controls"."continuation_message_id" is null
        and "issue_session_compaction_controls"."post_checkpoint_action" = 'none'
        and "issue_session_compaction_controls"."compaction_run_id" is not null
        and "issue_session_compaction_controls"."settings_snapshot" is null
        and "issue_session_compaction_controls"."model_snapshot" is null
        and "issue_session_compaction_controls"."trigger_model_snapshot" is null
        and "issue_session_compaction_controls"."recovery_identity_digest" is null
      ) or (
        "issue_session_compaction_controls"."kind" = 'tool-pruned'
        and "issue_session_compaction_controls"."compaction_request_message_id" is null
        and "issue_session_compaction_controls"."summary_assistant_message_id" is null
        and "issue_session_compaction_controls"."failed_assistant_message_id" is null
        and "issue_session_compaction_controls"."failed_assistant_error_kind" is null
        and "issue_session_compaction_controls"."assistant_message_id" is not null
        and "issue_session_compaction_controls"."tool_id" is not null
        and "issue_session_compaction_controls"."pruned_at" is not null
        and "issue_session_compaction_controls"."tail_start_message_id" is null
        and "issue_session_compaction_controls"."replay_message_id" is null
        and "issue_session_compaction_controls"."continuation_message_id" is null
        and "issue_session_compaction_controls"."post_checkpoint_action" = 'none'
        and "issue_session_compaction_controls"."compaction_run_id" is null
        and "issue_session_compaction_controls"."settings_snapshot" is null
        and "issue_session_compaction_controls"."model_snapshot" is null
        and "issue_session_compaction_controls"."trigger_model_snapshot" is null
        and "issue_session_compaction_controls"."recovery_identity_digest" is null
      )),
	CONSTRAINT "issue_session_compaction_controls_sequence_check" CHECK (("issue_session_compaction_controls"."kind" = 'recovery-prompt' and "issue_session_compaction_controls"."seq" is null)
        or ("issue_session_compaction_controls"."kind" <> 'recovery-prompt' and "issue_session_compaction_controls"."seq" is not null and "issue_session_compaction_controls"."seq" >= 0))
);
--> statement-breakpoint
CREATE TABLE "issue_session_completed_tool_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"assistant_message_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"source_output_text" text NOT NULL,
	"normalization_codec_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_session_context_epochs" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text PRIMARY KEY NOT NULL,
	"baseline" text,
	"snapshot" jsonb,
	"baseline_seq" bigint,
	"generation" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "issue_session_context_epochs_scope_uq" UNIQUE("company_id","issue_id","session_id"),
	CONSTRAINT "issue_session_context_epochs_state_check" CHECK ((
        "issue_session_context_epochs"."baseline" is null
        and "issue_session_context_epochs"."snapshot" is null
        and "issue_session_context_epochs"."baseline_seq" is null
      ) or (
        "issue_session_context_epochs"."baseline" is not null
        and "issue_session_context_epochs"."snapshot" is not null
        and jsonb_typeof("issue_session_context_epochs"."snapshot") = 'object'
        and "issue_session_context_epochs"."baseline_seq" >= -1
      )),
	CONSTRAINT "issue_session_context_epochs_generation_check" CHECK ("issue_session_context_epochs"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "issue_session_error_tool_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"assistant_message_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"interrupted" boolean NOT NULL,
	"interrupted_output_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_session_error_tool_sources_output_check" CHECK ("issue_session_error_tool_sources"."interrupted" = true or "issue_session_error_tool_sources"."interrupted_output_text" is null)
);
--> statement-breakpoint
CREATE TABLE "issue_session_event_sequences" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"owner_id" text,
	CONSTRAINT "issue_session_event_sequences_scope_uq" UNIQUE("company_id","issue_id","session_id"),
	CONSTRAINT "issue_session_event_sequences_seq_check" CHECK ("issue_session_event_sequences"."seq" >= -1)
);
--> statement-breakpoint
CREATE TABLE "issue_session_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"run_id" uuid,
	"ownership_epoch" integer,
	"agent_id" uuid,
	"adapter_config_revision_id" uuid,
	"source_kind" text,
	"source_id" text,
	"immutable_source_key" text,
	"source_record_id" text,
	"source_identity_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_session_events_session_event_uq" UNIQUE("session_id","id"),
	CONSTRAINT "issue_session_events_type_check" CHECK ("issue_session_events"."type" in (
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
        'session.next.compaction.started.1',
        'session.next.compaction.ended.1',
        'session.next.revert.staged.1',
        'session.next.revert.cleared.1',
        'session.next.revert.committed.1'
      )),
	CONSTRAINT "issue_session_events_data_check" CHECK (jsonb_typeof("issue_session_events"."data") = 'object'
        and not ("issue_session_events"."data" ? 'id')
        and not ("issue_session_events"."data" ? 'type')
        and not ("issue_session_events"."data" ? 'durable')
        and not ("issue_session_events"."data" ? 'metadata')),
	CONSTRAINT "issue_session_events_seq_check" CHECK ("issue_session_events"."seq" >= 0),
	CONSTRAINT "issue_session_events_source_identity_check" CHECK ((
        "issue_session_events"."source_kind" is null
        and "issue_session_events"."source_id" is null
        and "issue_session_events"."immutable_source_key" is null
        and "issue_session_events"."source_record_id" is null
        and "issue_session_events"."source_identity_digest" is null
      ) or (
        "issue_session_events"."source_kind" is not null
        and length("issue_session_events"."source_kind") > 0
        and "issue_session_events"."source_id" is not null
        and length("issue_session_events"."source_id") > 0
        and "issue_session_events"."immutable_source_key" is not null
        and length("issue_session_events"."immutable_source_key") > 0
        and "issue_session_events"."source_record_id" is not null
        and length("issue_session_events"."source_record_id") > 0
        and "issue_session_events"."source_identity_digest" is not null
        and length("issue_session_events"."source_identity_digest") = 64
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_session_input_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"input_id" text NOT NULL,
	"source_ref_id" uuid,
	"state" text DEFAULT 'active' NOT NULL,
	"invalidation_reason" text,
	"invalidated_at" timestamp with time zone,
	"invalidated_by_source_kind" text,
	"invalidated_by_source_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_session_input_dispositions_state_check" CHECK ("issue_session_input_dispositions"."state" in ('active', 'invalidated')),
	CONSTRAINT "issue_session_input_dispositions_invalidation_check" CHECK ((
        "issue_session_input_dispositions"."state" = 'active'
        and "issue_session_input_dispositions"."invalidation_reason" is null
        and "issue_session_input_dispositions"."invalidated_at" is null
        and "issue_session_input_dispositions"."invalidated_by_source_kind" is null
        and "issue_session_input_dispositions"."invalidated_by_source_id" is null
      ) or (
        "issue_session_input_dispositions"."state" = 'invalidated'
        and "issue_session_input_dispositions"."invalidation_reason" is not null
        and "issue_session_input_dispositions"."invalidated_at" is not null
        and "issue_session_input_dispositions"."invalidated_by_source_kind" is not null
        and "issue_session_input_dispositions"."invalidated_by_source_id" is not null
        and length(btrim("issue_session_input_dispositions"."invalidated_by_source_kind")) > 0
        and length(btrim("issue_session_input_dispositions"."invalidated_by_source_id")) > 0
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_session_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"prompt" jsonb NOT NULL,
	"delivery" text NOT NULL,
	"admitted_seq" bigint NOT NULL,
	"promoted_seq" bigint,
	"time_created" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_session_inputs_scope_id_uq" UNIQUE("company_id","issue_id","session_id","id"),
	CONSTRAINT "issue_session_inputs_delivery_check" CHECK ("issue_session_inputs"."delivery" in ('steer', 'queue')),
	CONSTRAINT "issue_session_inputs_promotion_check" CHECK ("issue_session_inputs"."admitted_seq" >= 0
        and ("issue_session_inputs"."promoted_seq" is null or "issue_session_inputs"."promoted_seq" >= "issue_session_inputs"."admitted_seq")),
	CONSTRAINT "issue_session_inputs_prompt_check" CHECK (jsonb_typeof("issue_session_inputs"."prompt") = 'object')
);
--> statement-breakpoint
CREATE TABLE "issue_session_message_id_allocators" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text PRIMARY KEY NOT NULL,
	"last_ordinal" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_session_message_id_allocators_scope_uq" UNIQUE("company_id","issue_id","session_id"),
	CONSTRAINT "issue_session_message_id_allocators_ordinal_check" CHECK ("issue_session_message_id_allocators"."last_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "issue_session_message_id_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"reservation_key" text NOT NULL,
	"ordinal" bigint NOT NULL,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_session_message_id_reservations_scope_key_uq" UNIQUE("company_id","issue_id","session_id","reservation_key"),
	CONSTRAINT "issue_session_message_id_reservations_scope_ordinal_uq" UNIQUE("company_id","issue_id","session_id","ordinal"),
	CONSTRAINT "issue_session_message_id_reservations_scope_message_uq" UNIQUE("company_id","issue_id","session_id","message_id"),
	CONSTRAINT "issue_session_message_id_reservations_value_check" CHECK ("issue_session_message_id_reservations"."ordinal" > 0
        and btrim("issue_session_message_id_reservations"."reservation_key") <> ''
        and length("issue_session_message_id_reservations"."reservation_key") <= 500
        and "issue_session_message_id_reservations"."message_id" = (
          'msg_' || "issue_session_message_id_reservations"."session_id" || '_' || lpad("issue_session_message_id_reservations"."ordinal"::text, 19, '0')
        ))
);
--> statement-breakpoint
CREATE TABLE "issue_session_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"model_state_seq" bigint NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"run_id" uuid,
	"ownership_epoch" integer,
	"agent_id" uuid,
	"adapter_config_revision_id" uuid,
	"time_created" timestamp with time zone DEFAULT now() NOT NULL,
	"time_updated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_session_messages_scope_id_uq" UNIQUE("company_id","issue_id","session_id","id"),
	CONSTRAINT "issue_session_messages_type_check" CHECK ("issue_session_messages"."type" in (
        'agent-switched',
        'model-switched',
        'user',
        'synthetic',
        'system',
        'shell',
        'assistant',
        'compaction'
      )),
	CONSTRAINT "issue_session_messages_data_check" CHECK (jsonb_typeof("issue_session_messages"."data") = 'object'
        and not ("issue_session_messages"."data" ? 'id')
        and not ("issue_session_messages"."data" ? 'type')),
	CONSTRAINT "issue_session_messages_time_check" CHECK ("issue_session_messages"."time_updated" >= "issue_session_messages"."time_created"),
	CONSTRAINT "issue_session_messages_seq_check" CHECK ("issue_session_messages"."seq" >= 0),
	CONSTRAINT "issue_session_messages_model_state_seq_check" CHECK ("issue_session_messages"."model_state_seq" >= "issue_session_messages"."seq")
);
--> statement-breakpoint
CREATE TABLE "issue_session_productive_turn_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"productive_run_id" uuid NOT NULL,
	"productive_run_kind" text DEFAULT 'productive' NOT NULL,
	"ref_id" uuid NOT NULL,
	"history_view_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"execution_workspace_binding_id" uuid NOT NULL,
	"context_epoch" integer NOT NULL,
	"execution_lineage_id" uuid NOT NULL,
	"history_scope_kind" text DEFAULT 'execution-lineage' NOT NULL,
	"history_scope_id" text NOT NULL,
	"composition_audience" text DEFAULT 'execution' NOT NULL,
	"source_high_water_seq" bigint NOT NULL,
	"source_user_message_id" text NOT NULL,
	"source_user_execution_id" uuid NOT NULL,
	"assistant_message_id" text,
	"settlement_kind" text NOT NULL,
	"provider_attempt" integer NOT NULL,
	"turn_ordinal" integer NOT NULL,
	"productive_agent_id" uuid NOT NULL,
	"productive_adapter_config_revision_id" uuid NOT NULL,
	"productive_model_ref" text NOT NULL,
	"productive_provider_id" text NOT NULL,
	"productive_model_id" text NOT NULL,
	"productive_model_variant" text,
	"productive_context_window" integer NOT NULL,
	"productive_input_limit" integer,
	"productive_output_limit" integer NOT NULL,
	"productive_api_id" text NOT NULL,
	"productive_api_npm" text NOT NULL,
	"compaction_settings_snapshot" jsonb NOT NULL,
	"productive_runtime_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_total_tokens" bigint,
	"source_assistant_error_kind" text,
	"settled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_session_productive_turn_settlements_scope_id_uq" UNIQUE("company_id","issue_id","session_id","id"),
	CONSTRAINT "issue_session_productive_turn_settlements_kind_check" CHECK ("issue_session_productive_turn_settlements"."settlement_kind" in ('assistant-finished', 'provider-overflow')
        and "issue_session_productive_turn_settlements"."productive_run_kind" = 'productive'
        and "issue_session_productive_turn_settlements"."history_scope_kind" = 'execution-lineage'
        and "issue_session_productive_turn_settlements"."composition_audience" = 'execution'),
	CONSTRAINT "issue_session_productive_turn_settlements_assistant_check" CHECK ((
        "issue_session_productive_turn_settlements"."settlement_kind" = 'assistant-finished'
        and "issue_session_productive_turn_settlements"."assistant_message_id" is not null
      ) or "issue_session_productive_turn_settlements"."settlement_kind" = 'provider-overflow'),
	CONSTRAINT "issue_session_productive_turn_settlements_scope_check" CHECK ("issue_session_productive_turn_settlements"."ownership_epoch" > 0
        and "issue_session_productive_turn_settlements"."context_epoch" >= 0
        and "issue_session_productive_turn_settlements"."source_high_water_seq" >= 0
        and "issue_session_productive_turn_settlements"."provider_attempt" > 0
        and "issue_session_productive_turn_settlements"."turn_ordinal" >= 0
        and "issue_session_productive_turn_settlements"."history_scope_id" = "issue_session_productive_turn_settlements"."execution_lineage_id"::text),
	CONSTRAINT "issue_session_productive_turn_settlements_model_check" CHECK (btrim("issue_session_productive_turn_settlements"."productive_model_ref") <> ''
        and length(btrim("issue_session_productive_turn_settlements"."productive_model_ref")) <= 500
        and btrim("issue_session_productive_turn_settlements"."productive_provider_id") <> ''
        and btrim("issue_session_productive_turn_settlements"."productive_model_id") <> ''
        and ("issue_session_productive_turn_settlements"."productive_model_variant" is null or btrim("issue_session_productive_turn_settlements"."productive_model_variant") <> '')
        and btrim("issue_session_productive_turn_settlements"."productive_api_id") <> ''
        and btrim("issue_session_productive_turn_settlements"."productive_api_npm") <> ''
        and "issue_session_productive_turn_settlements"."productive_context_window" >= 0
        and ("issue_session_productive_turn_settlements"."productive_input_limit" is null or "issue_session_productive_turn_settlements"."productive_input_limit" >= 0)
        and "issue_session_productive_turn_settlements"."productive_output_limit" >= 0),
	CONSTRAINT "issue_session_productive_turn_settlements_runtime_flags_check" CHECK (jsonb_typeof("issue_session_productive_turn_settlements"."productive_runtime_flags") = 'object'
        and "issue_session_productive_turn_settlements"."productive_runtime_flags" - 'outputTokenMax' = '{}'::jsonb
        and (
          not ("issue_session_productive_turn_settlements"."productive_runtime_flags" ? 'outputTokenMax')
          or (
            jsonb_typeof("issue_session_productive_turn_settlements"."productive_runtime_flags" -> 'outputTokenMax') = 'number'
            and ("issue_session_productive_turn_settlements"."productive_runtime_flags" ->> 'outputTokenMax') ~ '^(0|[1-9][0-9]*)$'
          )
        )),
	CONSTRAINT "issue_session_productive_turn_settlements_settings_snapshot_check" CHECK (jsonb_typeof("issue_session_productive_turn_settlements"."compaction_settings_snapshot") = 'object'
        and "issue_session_productive_turn_settlements"."compaction_settings_snapshot"
          - 'auto'
          - 'prune'
          - 'reserved'
          - 'tail_turns'
          - 'preserve_recent_tokens'
          - 'modelRef' = '{}'::jsonb
        and (
          not ("issue_session_productive_turn_settlements"."compaction_settings_snapshot" ? 'auto')
          or jsonb_typeof("issue_session_productive_turn_settlements"."compaction_settings_snapshot" -> 'auto') = 'boolean'
        )
        and (
          not ("issue_session_productive_turn_settlements"."compaction_settings_snapshot" ? 'prune')
          or jsonb_typeof("issue_session_productive_turn_settlements"."compaction_settings_snapshot" -> 'prune') = 'boolean'
        )
        and (
          not ("issue_session_productive_turn_settlements"."compaction_settings_snapshot" ? 'reserved')
          or (
            jsonb_typeof("issue_session_productive_turn_settlements"."compaction_settings_snapshot" -> 'reserved') = 'number'
            and ("issue_session_productive_turn_settlements"."compaction_settings_snapshot" ->> 'reserved') ~ '^(0|[1-9][0-9]*)$'
          )
        )
        and (
          not ("issue_session_productive_turn_settlements"."compaction_settings_snapshot" ? 'tail_turns')
          or (
            jsonb_typeof("issue_session_productive_turn_settlements"."compaction_settings_snapshot" -> 'tail_turns') = 'number'
            and ("issue_session_productive_turn_settlements"."compaction_settings_snapshot" ->> 'tail_turns') ~ '^(0|[1-9][0-9]*)$'
          )
        )
        and (
          not ("issue_session_productive_turn_settlements"."compaction_settings_snapshot" ? 'preserve_recent_tokens')
          or (
            jsonb_typeof("issue_session_productive_turn_settlements"."compaction_settings_snapshot" -> 'preserve_recent_tokens') = 'number'
            and ("issue_session_productive_turn_settlements"."compaction_settings_snapshot" ->> 'preserve_recent_tokens') ~ '^(0|[1-9][0-9]*)$'
          )
        )
        and (
          not ("issue_session_productive_turn_settlements"."compaction_settings_snapshot" ? 'modelRef')
          or (
            jsonb_typeof("issue_session_productive_turn_settlements"."compaction_settings_snapshot" -> 'modelRef') = 'string'
            and btrim("issue_session_productive_turn_settlements"."compaction_settings_snapshot" ->> 'modelRef') <> ''
            and length(btrim("issue_session_productive_turn_settlements"."compaction_settings_snapshot" ->> 'modelRef')) <= 500
          )
        )),
	CONSTRAINT "issue_session_productive_turn_settlements_source_facts_check" CHECK (("issue_session_productive_turn_settlements"."source_total_tokens" is null or "issue_session_productive_turn_settlements"."source_total_tokens" >= 0)
        and (
          "issue_session_productive_turn_settlements"."source_assistant_error_kind" is null
          or "issue_session_productive_turn_settlements"."source_assistant_error_kind" in ('aborted', 'other')
        ))
);
--> statement-breakpoint
CREATE TABLE "issue_session_recovery_selection_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"selection_id" uuid NOT NULL,
	"member_ordinal" integer NOT NULL,
	"member_kind" text NOT NULL,
	"selection_role" text NOT NULL,
	"source_sequence" bigint NOT NULL,
	"message_id" text,
	"comment_id" uuid,
	"comment_projected_event_seq" bigint,
	CONSTRAINT "issue_session_recovery_selection_members_selection_ordinal_uq" UNIQUE("selection_id","member_ordinal"),
	CONSTRAINT "issue_session_recovery_selection_members_ordinal_check" CHECK ("issue_session_recovery_selection_members"."member_ordinal" >= 0 and "issue_session_recovery_selection_members"."source_sequence" >= 0),
	CONSTRAINT "issue_session_recovery_selection_members_shape_check" CHECK ((
        "issue_session_recovery_selection_members"."member_kind" = 'message'
        and "issue_session_recovery_selection_members"."message_id" is not null
        and "issue_session_recovery_selection_members"."comment_id" is null
        and "issue_session_recovery_selection_members"."comment_projected_event_seq" is null
      ) or (
        "issue_session_recovery_selection_members"."member_kind" = 'comment'
        and "issue_session_recovery_selection_members"."selection_role" = 'history'
        and "issue_session_recovery_selection_members"."message_id" is null
        and "issue_session_recovery_selection_members"."comment_id" is not null
        and "issue_session_recovery_selection_members"."comment_projected_event_seq" is not null
        and "issue_session_recovery_selection_members"."source_sequence" = "issue_session_recovery_selection_members"."comment_projected_event_seq"
      )),
	CONSTRAINT "issue_session_recovery_selection_members_role_check" CHECK ("issue_session_recovery_selection_members"."selection_role" in ('history', 'retained-tail'))
);
--> statement-breakpoint
CREATE TABLE "issue_session_recovery_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"visibility" text NOT NULL,
	"history_scope_kind" text NOT NULL,
	"history_scope_id" text NOT NULL,
	"audience" text NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"lane_kind" text NOT NULL,
	"context_epoch" integer NOT NULL,
	"execution_lineage_id" uuid NOT NULL,
	"source_high_water_seq" bigint NOT NULL,
	"effective_context_digest" text NOT NULL,
	"selected_checkpoint_control_id" uuid,
	"latest_finished_assistant_message_id" text,
	"source_run_id" uuid NOT NULL,
	"source_ref_id" uuid NOT NULL,
	"source_ref_ordinal" integer NOT NULL,
	"source_segment_ordinal" integer NOT NULL,
	"selection_identity_digest" text NOT NULL,
	"expected_assembled_content_digest" text NOT NULL,
	"disposition" text DEFAULT 'active' NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_session_recovery_selections_scope_id_uq" UNIQUE("company_id","issue_id","session_id","id"),
	CONSTRAINT "issue_session_recovery_selections_scope_check" CHECK ((
        "issue_session_recovery_selections"."history_scope_kind" = 'turns-recovery'
        and "issue_session_recovery_selections"."audience" = 'turns'
      ) or (
        "issue_session_recovery_selections"."history_scope_kind" = 'comments-recovery'
        and "issue_session_recovery_selections"."audience" = 'comments'
      )),
	CONSTRAINT "issue_session_recovery_selections_identity_check" CHECK ("issue_session_recovery_selections"."visibility" in ('active', 'archived')
        and "issue_session_recovery_selections"."lane_kind" in ('owner', 'consult')
        and "issue_session_recovery_selections"."ownership_epoch" > 0
        and "issue_session_recovery_selections"."context_epoch" >= 0
        and "issue_session_recovery_selections"."source_high_water_seq" >= 0
        and "issue_session_recovery_selections"."source_ref_ordinal" >= 0
        and "issue_session_recovery_selections"."source_segment_ordinal" >= 0
        and length(btrim("issue_session_recovery_selections"."history_scope_id")) > 0
        and "issue_session_recovery_selections"."effective_context_digest" ~ '^[0-9a-f]{64}$'
        and "issue_session_recovery_selections"."selection_identity_digest" ~ '^[0-9a-f]{64}$'
        and "issue_session_recovery_selections"."expected_assembled_content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "issue_session_recovery_selections_disposition_check" CHECK ((
        "issue_session_recovery_selections"."disposition" = 'active'
        and "issue_session_recovery_selections"."consumed_at" is null
        and "issue_session_recovery_selections"."invalidated_at" is null
        and "issue_session_recovery_selections"."invalidation_reason" is null
      ) or (
        "issue_session_recovery_selections"."disposition" = 'consumed'
        and "issue_session_recovery_selections"."consumed_at" is not null
        and "issue_session_recovery_selections"."consumed_at" >= "issue_session_recovery_selections"."created_at"
        and "issue_session_recovery_selections"."invalidated_at" is null
        and "issue_session_recovery_selections"."invalidation_reason" is null
      ) or (
        "issue_session_recovery_selections"."disposition" = 'invalidated'
        and "issue_session_recovery_selections"."consumed_at" is null
        and "issue_session_recovery_selections"."invalidated_at" is not null
        and "issue_session_recovery_selections"."invalidated_at" >= "issue_session_recovery_selections"."created_at"
        and "issue_session_recovery_selections"."invalidation_reason" is not null
        and length(btrim("issue_session_recovery_selections"."invalidation_reason")) between 1 and 200
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_session_source_user_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"variant" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_session_source_user_executions_scope_id_message_uq" UNIQUE("company_id","issue_id","session_id","id","message_id")
);
--> statement-breakpoint
CREATE TABLE "issue_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"parent_session_id" text,
	"project_id" text NOT NULL,
	"agent" text,
	"model" jsonb,
	"cost" double precision,
	"tokens_input" bigint,
	"tokens_output" bigint,
	"tokens_reasoning" bigint,
	"tokens_cache_read" bigint,
	"tokens_cache_write" bigint,
	"title" text NOT NULL,
	"directory" text NOT NULL,
	"workspace_id" text,
	"subpath" text,
	"revert" jsonb,
	"time_created" timestamp with time zone DEFAULT now() NOT NULL,
	"time_updated" timestamp with time zone DEFAULT now() NOT NULL,
	"time_archived" timestamp with time zone,
	"projected_event_seq" bigint DEFAULT -1 NOT NULL,
	"integrity_state" text DEFAULT 'building' NOT NULL,
	"migrated_at" timestamp with time zone,
	"ref_admittable_at" timestamp with time zone,
	"purge_fenced_at" timestamp with time zone,
	CONSTRAINT "issue_sessions_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "issue_sessions_scope_id_uq" UNIQUE("company_id","issue_id","id"),
	CONSTRAINT "issue_sessions_integrity_state_check" CHECK ("issue_sessions"."integrity_state" in ('building', 'ready', 'archived', 'purge_fenced')),
	CONSTRAINT "issue_sessions_projected_event_seq_check" CHECK ("issue_sessions"."projected_event_seq" >= -1),
	CONSTRAINT "issue_sessions_cost_and_tokens_check" CHECK (("issue_sessions"."cost" is null or "issue_sessions"."cost" >= 0)
        and (
          (
            "issue_sessions"."tokens_input" is null
            and "issue_sessions"."tokens_output" is null
            and "issue_sessions"."tokens_reasoning" is null
            and "issue_sessions"."tokens_cache_read" is null
            and "issue_sessions"."tokens_cache_write" is null
          )
          or (
            "issue_sessions"."tokens_input" is not null
            and "issue_sessions"."tokens_output" is not null
            and "issue_sessions"."tokens_reasoning" is not null
            and "issue_sessions"."tokens_cache_read" is not null
            and "issue_sessions"."tokens_cache_write" is not null
            and "issue_sessions"."tokens_input" >= 0
            and "issue_sessions"."tokens_output" >= 0
            and "issue_sessions"."tokens_reasoning" >= 0
            and "issue_sessions"."tokens_cache_read" >= 0
            and "issue_sessions"."tokens_cache_write" >= 0
          )
        )),
	CONSTRAINT "issue_sessions_time_check" CHECK ("issue_sessions"."time_updated" >= "issue_sessions"."time_created"
        and ("issue_sessions"."time_archived" is null or "issue_sessions"."time_archived" >= "issue_sessions"."time_created")),
	CONSTRAINT "issue_sessions_info_shape_check" CHECK (length("issue_sessions"."project_id") > 0
        and length("issue_sessions"."title") > 0
        and length("issue_sessions"."directory") > 0
        and left("issue_sessions"."directory", 1) = '/'
        and ("issue_sessions"."agent" is null or length("issue_sessions"."agent") > 0)
        and ("issue_sessions"."workspace_id" is null or length("issue_sessions"."workspace_id") > 0)
        and ("issue_sessions"."model" is null or jsonb_typeof("issue_sessions"."model") = 'object')
        and ("issue_sessions"."revert" is null or jsonb_typeof("issue_sessions"."revert") = 'object'))
);
--> statement-breakpoint
CREATE TABLE "issue_tree_hold_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"parent_issue_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"issue_identifier" text,
	"issue_title" text,
	"issue_status" text NOT NULL,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"active_run_id" uuid,
	"active_run_status" text,
	"skipped" boolean DEFAULT false NOT NULL,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_tree_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"root_issue_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"release_policy" jsonb,
	"created_by_actor_type" text DEFAULT 'system' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"released_at" timestamp with time zone,
	"released_by_actor_type" text,
	"released_by_agent_id" uuid,
	"released_by_user_id" text,
	"released_by_run_id" uuid,
	"release_reason" text,
	"release_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"form" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_authority_id" uuid,
	"source_identity" jsonb NOT NULL,
	"run_id" uuid,
	"gateway_invocation_id" text NOT NULL,
	"run_sequence" integer NOT NULL,
	"message" text NOT NULL,
	"status" text,
	"disposition" jsonb,
	"comment_id" uuid NOT NULL,
	"creator_edge_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_updates_scope_id_uq" UNIQUE("company_id","issue_id","ownership_epoch","id"),
	CONSTRAINT "issue_updates_form_check" CHECK ("issue_updates"."form" in ('owner', 'creator')),
	CONSTRAINT "issue_updates_source_kind_check" CHECK ("issue_updates"."source_kind" in ('agent-execution', 'user/board', 'plugin', 'routine', 'system')),
	CONSTRAINT "issue_updates_status_check" CHECK ("issue_updates"."status" is null or "issue_updates"."status" in ('open', 'blocked', 'done', 'cancelled')),
	CONSTRAINT "issue_updates_message_check" CHECK (char_length("issue_updates"."message") > 0),
	CONSTRAINT "issue_updates_form_shape_check" CHECK ((
        "issue_updates"."form" = 'creator'
        and "issue_updates"."status" is null
        and "issue_updates"."disposition" is null
      ) or (
        "issue_updates"."form" = 'owner'
        and (
          ("issue_updates"."status" is null and "issue_updates"."disposition" is null)
          or (
            "issue_updates"."status" is not null
            and (
              ("issue_updates"."status" in ('open', 'blocked') and "issue_updates"."disposition" is null)
              or (
                "issue_updates"."status" in ('done', 'cancelled')
                and "issue_updates"."disposition" is not null
                and jsonb_typeof("issue_updates"."disposition") = 'object'
                and "issue_updates"."disposition" ? 'message'
                and jsonb_typeof("issue_updates"."disposition" -> 'message') = 'string'
                and btrim("issue_updates"."disposition" ->> 'message') <> ''
                and "issue_updates"."disposition" - 'message' - 'structuredResult' = '{}'::jsonb
              )
            )
          )
        )
      )),
	CONSTRAINT "issue_updates_run_sequence_check" CHECK ("issue_updates"."run_sequence" >= 0),
	CONSTRAINT "issue_updates_creator_edge_check" CHECK ("issue_updates"."creator_edge_id" is not null or (
        "issue_updates"."form" = 'owner'
        and "issue_updates"."source_kind" = 'plugin'
        and "issue_updates"."run_id" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "issue_watchdogs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_observed_fingerprint" text,
	"last_triggered_at" timestamp with time zone,
	"trigger_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_work_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"issue_id" uuid NOT NULL,
	"execution_workspace_id" uuid,
	"runtime_service_id" uuid,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text,
	"title" text NOT NULL,
	"url" text,
	"status" text NOT NULL,
	"review_state" text DEFAULT 'none' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"summary" text,
	"metadata" jsonb,
	"source_trust" jsonb,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"project_workspace_id" uuid,
	"goal_id" uuid,
	"parent_id" uuid,
	"parent_ownership_epoch" integer,
	"title" text,
	"request" text NOT NULL,
	"lifecycle_status" text NOT NULL,
	"board_presentation_status" text NOT NULL,
	"disposition" jsonb,
	"work_mode" text DEFAULT 'standard' NOT NULL,
	"harness_kind" text,
	"priority" text DEFAULT 'medium' NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"owner_assignment_source" text,
	"ownership_epoch" integer NOT NULL,
	"creator_kind" text NOT NULL,
	"creator_authority_id" uuid,
	"creator_adapter_config_revision_id" uuid,
	"creator_user_id" text,
	"creator_plugin_installation_id" uuid,
	"creator_plugin_key" text,
	"creator_callback_key" text,
	"creator_callback_version" text,
	"creator_routine_id" uuid,
	"creator_routine_dispatch_id" uuid,
	"creator_system_source_kind" text,
	"creator_system_source_id" text,
	"attention_mask" jsonb,
	"escalated_from_affected_issue_id" uuid,
	"escalated_from_triggering_run_id" uuid,
	"escalated_from_reason" text,
	"affected_ownership_epoch" integer,
	"responsible_user_id" text,
	"issue_number" integer,
	"identifier" text,
	"origin_kind" text DEFAULT 'manual' NOT NULL,
	"origin_id" text,
	"origin_run_id" text,
	"origin_fingerprint" text DEFAULT 'default' NOT NULL,
	"request_depth" integer DEFAULT 0 NOT NULL,
	"billing_code" text,
	"execution_policy" jsonb,
	"execution_state" jsonb,
	"monitor_next_check_at" timestamp with time zone,
	"monitor_last_triggered_at" timestamp with time zone,
	"monitor_attempt_count" integer DEFAULT 0 NOT NULL,
	"monitor_notes" text,
	"monitor_scheduled_by" text,
	"execution_workspace_preference" text,
	"execution_workspace_settings" jsonb,
	"source_trust" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issues_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "issues_parent_epoch_check" CHECK ((
        "issues"."parent_id" is null
        and "issues"."parent_ownership_epoch" is null
      ) or (
        "issues"."parent_id" is not null
        and "issues"."parent_ownership_epoch" > 0
      )),
	CONSTRAINT "issues_lifecycle_status_check" CHECK ("issues"."lifecycle_status" in ('open', 'blocked', 'done', 'cancelled')),
	CONSTRAINT "issues_board_presentation_status_check" CHECK ("issues"."board_presentation_status" in (
        'backlog',
        'todo',
        'in_progress',
        'in_review',
        'blocked',
        'done',
        'cancelled'
      )),
	CONSTRAINT "issues_lifecycle_disposition_check" CHECK ((
          "issues"."lifecycle_status" in ('open', 'blocked')
          and "issues"."disposition" is null
        )
        or (
          "issues"."lifecycle_status" in ('done', 'cancelled')
          and "issues"."disposition" is not null
          and jsonb_typeof("issues"."disposition") = 'object'
          and "issues"."disposition" ? 'message'
          and jsonb_typeof("issues"."disposition" -> 'message') = 'string'
          and btrim("issues"."disposition" ->> 'message') <> ''
          and "issues"."disposition" - 'message' - 'structuredResult' = '{}'::jsonb
        )),
	CONSTRAINT "issues_canonical_contract_check" CHECK (btrim("issues"."request") <> ''
        and "issues"."ownership_epoch" > 0),
	CONSTRAINT "issues_owner_shape_check" CHECK ((
        "issues"."owner_kind" = 'agent'
        and "issues"."owner_agent_id" is not null
        and "issues"."owner_user_id" is null
        and "issues"."owner_assignment_source" is null
        and "issues"."ownership_epoch" > 0
      ) or (
        "issues"."owner_kind" = 'user'
        and "issues"."owner_agent_id" is null
        and "issues"."owner_user_id" is not null
        and (
          (
            "issues"."owner_assignment_source" = 'user_creator_withdrawal'
            and "issues"."owner_user_id" = "issues"."creator_user_id"
          )
          or (
            "issues"."owner_assignment_source" is null
            and "issues"."creator_kind" = 'system'
            and "issues"."escalated_from_affected_issue_id" is not null
          )
        )
        and "issues"."ownership_epoch" > 0
      ) or (
        "issues"."owner_kind" = 'board'
        and "issues"."owner_agent_id" is null
        and "issues"."owner_user_id" is null
        and "issues"."owner_assignment_source" is null
        and "issues"."ownership_epoch" > 0
        and "issues"."creator_kind" = 'system'
      )),
	CONSTRAINT "issues_creator_shape_check" CHECK ((
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
        and "issues"."creator_system_source_kind" in ('watchdog', 'recovery', 'liveness')
        and "issues"."creator_system_source_id" is not null
      )),
	CONSTRAINT "issues_attention_mask_check" CHECK ("issues"."attention_mask" is null
        or (
          jsonb_typeof("issues"."attention_mask") = 'object'
          and "issues"."attention_mask" - array[
            'carry_context',
            'read_issue_comments',
            'read_issue_agent_run',
            'list_sub_issues',
            'read_sub_issue_comments',
            'read_sub_issue_agent_run',
            'list_company_issues',
            'read_company_issue_comments',
            'read_company_issue_agent_run'
          ]::text[] = '{}'::jsonb
          and not jsonb_path_exists("issues"."attention_mask", '$.* ? (@ != false)')
        )),
	CONSTRAINT "issues_escalation_shape_check" CHECK ((
        "issues"."escalated_from_affected_issue_id" is null
        and "issues"."escalated_from_triggering_run_id" is null
        and "issues"."escalated_from_reason" is null
        and "issues"."affected_ownership_epoch" is null
        and "issues"."creator_kind" <> 'system'
      ) or (
        "issues"."escalated_from_affected_issue_id" is not null
        and "issues"."escalated_from_affected_issue_id" <> "issues"."id"
        and "issues"."escalated_from_reason" is not null
        and "issues"."affected_ownership_epoch" is not null
        and "issues"."affected_ownership_epoch" > 0
        and "issues"."creator_kind" = 'system'
        and "issues"."parent_id" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invite_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"request_type" text NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"request_ip" text NOT NULL,
	"requesting_user_id" text,
	"request_email_snapshot" text,
	"agent_name" text,
	"adapter_type" text,
	"capabilities" text,
	"agent_defaults_payload" jsonb,
	"created_agent_id" uuid,
	"approved_environment_id" uuid,
	"created_agent_adapter_config_revision_id" uuid,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"rejected_by_user_id" text,
	"rejected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_automation_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"automation_id" text NOT NULL,
	"triggering_event_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"status" text NOT NULL,
	"execution_issue_id" uuid,
	"retry_of_execution_id" uuid,
	"generation" integer DEFAULT 1 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_automation_executions_status_check" CHECK ("pipeline_automation_executions"."status" in ('succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "pipeline_case_blockers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"blocked_by_case_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_case_blockers_no_self_block_check" CHECK ("pipeline_case_blockers"."case_id" <> "pipeline_case_blockers"."blocked_by_case_id")
);
--> statement-breakpoint
CREATE TABLE "pipeline_case_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" text,
	"actor_agent_id" uuid,
	"run_id" uuid,
	"from_stage_id" uuid,
	"to_stage_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_case_events_type_check" CHECK ("pipeline_case_events"."type" in (
        'ingested',
        'updated',
        'claimed',
        'lease_released',
        'lease_expired',
        'transitioned',
        'transition_forced',
        'transition_suggested',
        'suggestion_resolved',
        'review_decided',
        'conversation_opened',
        'issue_linked',
        'issue_unlinked',
        'automation_executed',
        'automation_failed',
        'automation_retry_requested',
        'automation_effects_retired',
        'automation_retry_dispatched',
        'blockers_set',
        'blockers_resolved',
        'children_terminal',
        'upstream_drift',
        'drift_acknowledged'
      )),
	CONSTRAINT "pipeline_case_events_actor_type_check" CHECK ("pipeline_case_events"."actor_type" in ('user', 'agent', 'system')),
	CONSTRAINT "pipeline_case_events_agent_run_check" CHECK ("pipeline_case_events"."actor_type" <> 'agent' or "pipeline_case_events"."run_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "pipeline_case_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_by_run_id" uuid,
	"automation_attempt_id" uuid,
	"retired_at" timestamp with time zone,
	"retired_by_attempt_id" uuid,
	"retired_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_case_issue_links_role_check" CHECK ("pipeline_case_issue_links"."role" in ('origin', 'conversation', 'work', 'automation'))
);
--> statement-breakpoint
CREATE TABLE "pipeline_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"case_key" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workspace_ref" jsonb,
	"parent_case_id" uuid,
	"parent_case_version" integer,
	"request_key" text,
	"automation_attempt_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"pending_suggestion" jsonb,
	"lease_owner_type" text,
	"lease_agent_id" uuid,
	"lease_user_id" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"terminal_kind" text,
	"terminal_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"retired_by_attempt_id" uuid,
	"retired_reason" text,
	"hidden_from_board_at" timestamp with time zone,
	"child_count" integer DEFAULT 0 NOT NULL,
	"terminal_child_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"origin_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_cases_terminal_kind_check" CHECK ("pipeline_cases"."terminal_kind" is null or "pipeline_cases"."terminal_kind" in ('done', 'cancelled')),
	CONSTRAINT "pipeline_cases_lease_owner_type_check" CHECK ("pipeline_cases"."lease_owner_type" is null or "pipeline_cases"."lease_owner_type" in ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "pipeline_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_stages_kind_check" CHECK ("pipeline_stages"."kind" in ('working', 'review', 'done', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "pipeline_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"from_stage_id" uuid NOT NULL,
	"to_stage_id" uuid NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enforce_transitions" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_company_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_creator_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"creator_delivery_id" uuid NOT NULL,
	"plugin_installation_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"callback_key" text NOT NULL,
	"callback_version" text NOT NULL,
	"committed_sequence" integer NOT NULL,
	"delivery_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"first_queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"held_since" timestamp with time zone,
	"first_attempt_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"first_leased_at" timestamp with time zone,
	"leased_at" timestamp with time zone,
	"lease_owner" text,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"last_failure" text,
	"acknowledgement" jsonb,
	"delivered_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"terminal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_creator_deliveries_state_check" CHECK ("plugin_creator_deliveries"."state" in (
        'pending',
        'leased',
        'retryable',
        'delivered',
        'exhausted',
        'permanently_unreceivable'
      )),
	CONSTRAINT "plugin_creator_deliveries_ack_check" CHECK ((
        "plugin_creator_deliveries"."state" = 'delivered'
        and "plugin_creator_deliveries"."acknowledgement" is not null
        and "plugin_creator_deliveries"."delivered_at" is not null
        and "plugin_creator_deliveries"."terminal_at" is not null
      ) or (
        "plugin_creator_deliveries"."state" in ('exhausted', 'permanently_unreceivable')
        and "plugin_creator_deliveries"."terminal_at" is not null
        and "plugin_creator_deliveries"."terminal_reason" is not null
      ) or "plugin_creator_deliveries"."state" in ('pending', 'leased', 'retryable'))
);
--> statement-breakpoint
CREATE TABLE "plugin_database_namespaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"namespace_name" text NOT NULL,
	"namespace_mode" text DEFAULT 'schema' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"company_id" uuid,
	"entity_type" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text,
	"external_id" text,
	"title" text,
	"status" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_entities_external_idx" UNIQUE NULLS NOT DISTINCT("company_id","plugin_id","entity_type","external_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"company_id" uuid,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_ms" integer,
	"error" text,
	"logs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"job_key" text NOT NULL,
	"schedule" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"company_id" uuid,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_managed_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_key" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"defaults_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lifecycle_state" text DEFAULT 'active' NOT NULL,
	"original_declaration_ref" jsonb,
	"lifecycle_reason" text,
	"triage_paused_at" timestamp with time zone,
	"adopted_at" timestamp with time zone,
	"terminated_at" timestamp with time zone,
	"lifecycle_actor_type" text,
	"lifecycle_actor_id" text,
	"lifecycle_audit" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_managed_resources_lifecycle_state_check" CHECK ("plugin_managed_resources"."lifecycle_state" in ('active', 'triage_paused', 'adopted', 'terminated')),
	CONSTRAINT "plugin_managed_resources_lifecycle_timestamp_check" CHECK ((
        "plugin_managed_resources"."lifecycle_state" = 'active'
        and "plugin_managed_resources"."triage_paused_at" is null
        and "plugin_managed_resources"."adopted_at" is null
        and "plugin_managed_resources"."terminated_at" is null
      ) or (
        "plugin_managed_resources"."lifecycle_state" = 'triage_paused'
        and "plugin_managed_resources"."triage_paused_at" is not null
        and "plugin_managed_resources"."adopted_at" is null
        and "plugin_managed_resources"."terminated_at" is null
      ) or (
        "plugin_managed_resources"."lifecycle_state" = 'adopted'
        and "plugin_managed_resources"."adopted_at" is not null
        and "plugin_managed_resources"."terminated_at" is null
      ) or (
        "plugin_managed_resources"."lifecycle_state" = 'terminated'
        and "plugin_managed_resources"."terminated_at" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "plugin_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"namespace_name" text NOT NULL,
	"migration_key" text NOT NULL,
	"checksum" text NOT NULL,
	"plugin_version" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "plugin_run_contexts" (
	"capability_connection_id" uuid NOT NULL,
	"capability_generation" integer NOT NULL,
	"run_interface_tool_call_id" uuid NOT NULL,
	"company_tool_selection_id" uuid NOT NULL,
	"plugin_installation_id" uuid NOT NULL,
	"handle_hash" text PRIMARY KEY NOT NULL,
	"first_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_run_contexts_tool_call_uq" UNIQUE("run_interface_tool_call_id"),
	CONSTRAINT "plugin_run_contexts_hash_audit_check" CHECK ("plugin_run_contexts"."capability_generation" > 0
        and "plugin_run_contexts"."handle_hash" ~ '^[0-9a-f]{64}$'
        and (
          "plugin_run_contexts"."first_used_at" is null
          or "plugin_run_contexts"."first_used_at" >= "plugin_run_contexts"."created_at"
        ))
);
--> statement-breakpoint
CREATE TABLE "plugin_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text,
	"namespace" text DEFAULT 'default' NOT NULL,
	"state_key" text NOT NULL,
	"value_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_state_unique_entry_idx" UNIQUE NULLS NOT DISTINCT("plugin_id","scope_kind","scope_id","namespace","state_key")
);
--> statement-breakpoint
CREATE TABLE "plugin_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"company_id" uuid,
	"webhook_key" text NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_ms" integer,
	"error" text,
	"payload" jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_withdrawal_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_installation_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"host_rpc_operation_id" text NOT NULL,
	"identity_digest" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"message" text NOT NULL,
	"state" text NOT NULL,
	"result" jsonb,
	"issue_update_id" uuid,
	"mutation_comment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "plugin_withdrawal_operations_command_source_uq" UNIQUE("company_id","issue_id","id","plugin_installation_id","plugin_key","issue_update_id"),
	CONSTRAINT "plugin_withdrawal_operations_state_check" CHECK ("plugin_withdrawal_operations"."state" in ('pending', 'accepted', 'rejected')),
	CONSTRAINT "plugin_withdrawal_operations_result_check" CHECK ((
        "plugin_withdrawal_operations"."state" = 'pending'
        and "plugin_withdrawal_operations"."result" is null
        and "plugin_withdrawal_operations"."issue_update_id" is null
        and "plugin_withdrawal_operations"."mutation_comment_id" is null
        and "plugin_withdrawal_operations"."completed_at" is null
      ) or (
        "plugin_withdrawal_operations"."state" = 'accepted'
        and "plugin_withdrawal_operations"."result" is not null
        and "plugin_withdrawal_operations"."issue_update_id" is not null
        and "plugin_withdrawal_operations"."mutation_comment_id" is not null
        and "plugin_withdrawal_operations"."completed_at" is not null
      ) or (
        "plugin_withdrawal_operations"."state" = 'rejected'
        and "plugin_withdrawal_operations"."result" is not null
        and "plugin_withdrawal_operations"."issue_update_id" is null
        and "plugin_withdrawal_operations"."mutation_comment_id" is null
        and "plugin_withdrawal_operations"."completed_at" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_key" text NOT NULL,
	"package_name" text NOT NULL,
	"version" text NOT NULL,
	"api_version" integer DEFAULT 1 NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"status" text DEFAULT 'installed' NOT NULL,
	"install_order" integer,
	"package_path" text,
	"last_error" text,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "principal_permission_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_user_id" text,
	"principal_agent_id" uuid,
	"permission_key" text NOT NULL,
	"scope" jsonb,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principal_permission_grants_principal_shape_check" CHECK ((
        "principal_permission_grants"."principal_type" = 'user'
        and "principal_permission_grants"."principal_user_id" is not null
        and "principal_permission_grants"."principal_agent_id" is null
      ) or (
        "principal_permission_grants"."principal_type" = 'agent'
        and "principal_permission_grants"."principal_user_id" is null
        and "principal_permission_grants"."principal_agent_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "project_goals" (
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_goals_project_id_goal_id_pk" PRIMARY KEY("project_id","goal_id")
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state" text DEFAULT 'joined' NOT NULL,
	"starred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_type" text DEFAULT 'local_path' NOT NULL,
	"cwd" text,
	"repo_url" text,
	"repo_ref" text,
	"default_ref" text,
	"visibility" text DEFAULT 'default' NOT NULL,
	"setup_command" text,
	"cleanup_command" text,
	"remote_provider" text,
	"remote_workspace_ref" text,
	"shared_workspace_key" text,
	"metadata" jsonb,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'backlog' NOT NULL,
	"lead_agent_id" uuid,
	"target_date" date,
	"color" text,
	"icon" text,
	"env" jsonb,
	"pause_reason" text,
	"paused_at" timestamp with time zone,
	"execution_workspace_policy" jsonb,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"snapshot" jsonb NOT NULL,
	"change_summary" text,
	"restored_from_revision_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"responsible_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"trigger_id" uuid,
	"source" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"routine_revision_id" uuid,
	"responsible_user_id" text,
	"idempotency_key" text,
	"trigger_payload" jsonb,
	"dispatch_fingerprint" text,
	"linked_issue_id" uuid,
	"coalesced_into_run_id" uuid,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"cron_expression" text,
	"timezone" text,
	"next_run_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"public_id" text,
	"secret_id" uuid,
	"signing_mode" text,
	"replay_window_sec" integer,
	"last_rotated_at" timestamp with time zone,
	"last_result" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"folder_id" uuid,
	"goal_id" uuid,
	"parent_issue_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"assignee_agent_id" uuid,
	"priority" text DEFAULT 'medium' NOT NULL,
	"attention_mask" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"concurrency_policy" text DEFAULT 'coalesce_if_active' NOT NULL,
	"catch_up_policy" text DEFAULT 'skip_missed' NOT NULL,
	"activity_gate_policy" text DEFAULT 'always' NOT NULL,
	"activity_gate_scope" text DEFAULT 'company' NOT NULL,
	"origin_kind" text DEFAULT 'manual' NOT NULL,
	"origin_id" text,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env" jsonb,
	"latest_revision_id" uuid,
	"latest_revision_number" integer DEFAULT 1 NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"responsible_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"last_triggered_at" timestamp with time zone,
	"last_enqueued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routines_attention_mask_check" CHECK ("routines"."attention_mask" is null
        or (
          jsonb_typeof("routines"."attention_mask") = 'object'
          and "routines"."attention_mask" - array[
            'carry_context',
            'read_issue_comments',
            'read_issue_agent_run',
            'list_sub_issues',
            'read_sub_issue_comments',
            'read_sub_issue_agent_run',
            'list_company_issues',
            'read_company_issue_comments',
            'read_company_issue_agent_run'
          ]::text[] = '{}'::jsonb
          and not jsonb_path_exists("routines"."attention_mask", '$.* ? (@ != false)')
        ))
);
--> statement-breakpoint
CREATE TABLE "run_interface_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"capability_connection_id" uuid NOT NULL,
	"capability_generation" integer NOT NULL,
	"ingress_ordinal" bigint NOT NULL,
	"call_identity_source" text NOT NULL,
	"call_identity_type" text NOT NULL,
	"call_identity_value" text NOT NULL,
	"tool_name" text NOT NULL,
	"company_tool_selection_id" uuid,
	"plugin_installation_id" uuid,
	"arguments_digest" text NOT NULL,
	"classification" text DEFAULT 'unclassified' NOT NULL,
	"mention_target_agent_id" uuid,
	"mention_admission_state" text,
	"classified_at" timestamp with time zone,
	"mention_admission_started_at" timestamp with time zone,
	"mention_admitted_at" timestamp with time zone,
	"status" text NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_interface_tool_calls_plugin_binding_uq" UNIQUE("capability_connection_id","capability_generation","id","company_tool_selection_id","plugin_installation_id"),
	CONSTRAINT "run_interface_tool_calls_identity_check" CHECK ("run_interface_tool_calls"."capability_generation" > 0
        and "run_interface_tool_calls"."ingress_ordinal" >= 0
        and "run_interface_tool_calls"."ingress_ordinal" <= 9007199254740991
        and (
          (
            "run_interface_tool_calls"."call_identity_source" in ('provider', 'jsonrpc')
            and "run_interface_tool_calls"."call_identity_type" in ('string', 'number')
          ) or (
            "run_interface_tool_calls"."call_identity_source" = 'ingress'
            and "run_interface_tool_calls"."call_identity_type" = 'ordinal'
          )
        )),
	CONSTRAINT "run_interface_tool_calls_classification_check" CHECK ((
        "run_interface_tool_calls"."classification" = 'unclassified'
        and "run_interface_tool_calls"."mention_target_agent_id" is null
        and "run_interface_tool_calls"."mention_admission_state" is null
        and "run_interface_tool_calls"."classified_at" is null
        and "run_interface_tool_calls"."mention_admission_started_at" is null
        and "run_interface_tool_calls"."mention_admitted_at" is null
      ) or (
        "run_interface_tool_calls"."classification" in ('non_mention', 'terminal_invalid')
        and "run_interface_tool_calls"."mention_target_agent_id" is null
        and "run_interface_tool_calls"."mention_admission_state" is null
        and "run_interface_tool_calls"."classified_at" is not null
        and "run_interface_tool_calls"."mention_admission_started_at" is null
        and "run_interface_tool_calls"."mention_admitted_at" is null
      ) or (
        "run_interface_tool_calls"."classification" = 'validated_mention'
        and "run_interface_tool_calls"."mention_target_agent_id" is not null
        and "run_interface_tool_calls"."classified_at" is not null
        and (
          ("run_interface_tool_calls"."mention_admission_state" = 'pending'
            and "run_interface_tool_calls"."mention_admission_started_at" is null
            and "run_interface_tool_calls"."mention_admitted_at" is null)
          or ("run_interface_tool_calls"."mention_admission_state" = 'preparing'
            and "run_interface_tool_calls"."mention_admission_started_at" is not null
            and "run_interface_tool_calls"."mention_admitted_at" is null)
          or ("run_interface_tool_calls"."mention_admission_state" = 'admitted'
            and "run_interface_tool_calls"."mention_admission_started_at" is not null
            and "run_interface_tool_calls"."mention_admitted_at" is not null
            and "run_interface_tool_calls"."mention_admitted_at" >= "run_interface_tool_calls"."mention_admission_started_at")
        )
      )),
	CONSTRAINT "run_interface_tool_calls_status_check" CHECK ((
        "run_interface_tool_calls"."status" = 'executing'
        and "run_interface_tool_calls"."classification" <> 'terminal_invalid'
        and "run_interface_tool_calls"."error" is null
        and "run_interface_tool_calls"."completed_at" is null
      ) or (
        "run_interface_tool_calls"."status" = 'completed'
        and "run_interface_tool_calls"."classification" in ('non_mention', 'validated_mention')
        and (
          "run_interface_tool_calls"."classification" <> 'validated_mention'
          or "run_interface_tool_calls"."mention_admission_state" = 'admitted'
        )
        and "run_interface_tool_calls"."error" is null
        and "run_interface_tool_calls"."completed_at" is not null
      ) or (
        "run_interface_tool_calls"."status" = 'failed'
        and "run_interface_tool_calls"."classification" <> 'unclassified'
        and "run_interface_tool_calls"."error" is not null
        and "run_interface_tool_calls"."completed_at" is not null
      )),
	CONSTRAINT "run_interface_tool_calls_plugin_binding_check" CHECK ("run_interface_tool_calls"."plugin_installation_id" is null
        or "run_interface_tool_calls"."company_tool_selection_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "runtime_agent_configuration_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"source" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"actor_plugin_installation_id" uuid,
	"run_id" uuid,
	"issue_execution_ref_id" uuid,
	"idempotency_key" text,
	"request_digest" text NOT NULL,
	"changed_keys" jsonb NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_agent_configuration_audits_operation_check" CHECK ("runtime_agent_configuration_audits"."operation" in ('create', 'update')),
	CONSTRAINT "runtime_agent_configuration_audits_source_check" CHECK ("runtime_agent_configuration_audits"."source" in (
        'board',
        'onboarding',
        'agent_hire',
        'agent_configure',
        'plugin_control'
      )),
	CONSTRAINT "runtime_agent_configuration_audits_actor_check" CHECK (length("runtime_agent_configuration_audits"."actor_id") > 0 and (
        (
          "runtime_agent_configuration_audits"."actor_kind" = 'board'
          and "runtime_agent_configuration_audits"."actor_agent_id" is null
          and "runtime_agent_configuration_audits"."actor_plugin_installation_id" is null
          and "runtime_agent_configuration_audits"."run_id" is null
          and "runtime_agent_configuration_audits"."issue_execution_ref_id" is null
        ) or (
          "runtime_agent_configuration_audits"."actor_kind" = 'agent'
          and "runtime_agent_configuration_audits"."actor_agent_id" is not null
          and "runtime_agent_configuration_audits"."actor_user_id" is null
          and "runtime_agent_configuration_audits"."actor_plugin_installation_id" is null
          and "runtime_agent_configuration_audits"."run_id" is not null
          and "runtime_agent_configuration_audits"."issue_execution_ref_id" is not null
        ) or (
          "runtime_agent_configuration_audits"."actor_kind" = 'plugin'
          and "runtime_agent_configuration_audits"."actor_agent_id" is null
          and "runtime_agent_configuration_audits"."actor_user_id" is null
          and "runtime_agent_configuration_audits"."actor_plugin_installation_id" is not null
          and "runtime_agent_configuration_audits"."run_id" is null
          and "runtime_agent_configuration_audits"."issue_execution_ref_id" is null
        )
      )),
	CONSTRAINT "runtime_agent_configuration_audits_digest_check" CHECK (length("runtime_agent_configuration_audits"."request_digest") = 64)
);
--> statement-breakpoint
CREATE TABLE "secret_access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"secret_id" uuid,
	"user_secret_definition_id" uuid,
	"secret_scope" text DEFAULT 'company' NOT NULL,
	"version" integer,
	"provider" text NOT NULL,
	"responsible_user_id" text,
	"credential_owner_user_id" text,
	"credential_subject_type" text,
	"credential_subject_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"consumer_type" text NOT NULL,
	"consumer_id" text NOT NULL,
	"config_path" text,
	"issue_id" uuid,
	"run_id" uuid,
	"plugin_id" uuid,
	"outcome" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smoke_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"path" text NOT NULL,
	"scenario_step" text NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"screenshot_artifact_ref" jsonb,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smoke_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "summary_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid,
	"slot_key" text NOT NULL,
	"routine_id" uuid,
	"document_id" uuid,
	"status" text DEFAULT 'idle' NOT NULL,
	"failure_reason" text,
	"generating_issue_id" uuid,
	"last_generated_at" timestamp with time zone,
	"last_generated_by_agent_id" uuid,
	"last_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "summary_slots_company_scope_slot_uq" UNIQUE NULLS NOT DISTINCT("company_id","scope_kind","scope_id","slot_key")
);
--> statement-breakpoint
CREATE TABLE "system_escalation_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"affected_issue_id" uuid NOT NULL,
	"affected_ownership_epoch" integer NOT NULL,
	"escalation_issue_id" uuid NOT NULL,
	"system_source" text NOT NULL,
	"triggering_run_id" uuid,
	"terminal_creator_edge_id" uuid NOT NULL,
	"immutable_source" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_escalation_identities_command_source_uq" UNIQUE("company_id","escalation_issue_id","id"),
	CONSTRAINT "system_escalation_identities_source_check" CHECK ("system_escalation_identities"."system_source" in ('watchdog', 'recovery', 'liveness')),
	CONSTRAINT "system_escalation_identities_distinct_issue_check" CHECK ("system_escalation_identities"."affected_issue_id" <> "system_escalation_identities"."escalation_issue_id")
);
--> statement-breakpoint
CREATE TABLE "tool_access_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"gateway_id" uuid,
	"gateway_token_id" uuid,
	"gateway_public_id" text,
	"client_name" text,
	"correlation_id" text,
	"connection_id" uuid,
	"catalog_entry_id" uuid,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"reason_code" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_action_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invocation_id" uuid NOT NULL,
	"issue_id" uuid,
	"approval_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"canonical_arguments" jsonb NOT NULL,
	"canonical_arguments_hash" text NOT NULL,
	"canonical_arguments_summary" jsonb NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"approval_snapshot" jsonb,
	"dispatch_idempotency_key" text,
	"preview_markdown" text,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"resolved_by_user_id" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"application_key" text,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"plugin_id" uuid,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_call_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"agent_id" uuid,
	"run_id" uuid,
	"issue_id" uuid,
	"gateway_id" uuid,
	"gateway_token_id" uuid,
	"gateway_public_id" text,
	"client_subject_type" text,
	"client_subject_id" text,
	"client_name" text,
	"mcp_session_id" text,
	"correlation_id" text,
	"application_id" uuid,
	"connection_id" uuid,
	"catalog_entry_id" uuid,
	"invocation_id" uuid,
	"action_request_id" uuid,
	"runtime_slot_id" uuid,
	"tool_name" text,
	"decision" text,
	"matched_policy_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason_code" text,
	"policy_explanation" jsonb,
	"credential_scope_summary" jsonb,
	"header_policy_summary" jsonb,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"latency_ms" integer,
	"arguments_summary" jsonb,
	"request_hash" text,
	"request_summary" jsonb,
	"result_hash" text,
	"result_summary" jsonb,
	"result_size_bytes" integer,
	"redaction_plan" jsonb,
	"rate_limit_state" jsonb,
	"metadata" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_catalog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"application_id" uuid,
	"connection_id" uuid NOT NULL,
	"entry_kind" text DEFAULT 'tool' NOT NULL,
	"name" text NOT NULL,
	"tool_name" text NOT NULL,
	"title" text,
	"description" text,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_schema" jsonb,
	"annotations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_level" text DEFAULT 'read' NOT NULL,
	"is_read_only" boolean DEFAULT true NOT NULL,
	"is_write" boolean DEFAULT false NOT NULL,
	"is_destructive" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" text,
	"version_hash" text NOT NULL,
	"schema_hash" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_agent_id" uuid,
	"reviewed_by_user_id" text,
	"quarantined_at" timestamp with time zone,
	"quarantine_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_catalog_entries_company_connection_id_uq" UNIQUE("company_id","connection_id","id")
);
--> statement-breakpoint
CREATE TABLE "tool_connection_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_agent_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_connection_installs_selection_identity_uq" UNIQUE("company_id","connection_id","id","target_agent_id"),
	CONSTRAINT "tool_connection_installs_target_shape_check" CHECK ((
        "tool_connection_installs"."target_type" = 'company'
        and "tool_connection_installs"."target_agent_id" is null
      ) or (
        "tool_connection_installs"."target_type" = 'agent'
        and "tool_connection_installs"."target_agent_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "tool_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"name" text NOT NULL,
	"uid" text NOT NULL,
	"connection_kind" text DEFAULT 'managed' NOT NULL,
	"ownership" text DEFAULT 'customer' NOT NULL,
	"transport" text NOT NULL,
	"auth_kind" text DEFAULT 'none' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transport_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credential_secret_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"health_status" text DEFAULT 'unchecked' NOT NULL,
	"health_message" text,
	"health_checked_at" timestamp with time zone,
	"last_health_at" timestamp with time zone,
	"last_catalog_refresh_at" timestamp with time zone,
	"last_error" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_connections_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "tool_connections_ownership_check" CHECK ("tool_connections"."ownership" in ('platform_shared', 'platform_provisioned', 'customer', 'dcr')),
	CONSTRAINT "tool_connections_transport_check" CHECK ("tool_connections"."transport" in ('mcp_remote', 'rest_api', 'local_stdio')),
	CONSTRAINT "tool_connections_auth_kind_check" CHECK ("tool_connections"."auth_kind" in ('oauth', 'api_key', 'none'))
);
--> statement-breakpoint
CREATE TABLE "tool_gateway_rate_limit_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"counter_key" text NOT NULL,
	"window_start_at" timestamp with time zone NOT NULL,
	"window_ms" integer NOT NULL,
	"limit" integer NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"idempotency_key" text,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"agent_id" uuid,
	"issue_id" uuid,
	"run_id" uuid,
	"gateway_id" uuid,
	"gateway_token_id" uuid,
	"gateway_public_id" text,
	"client_subject_type" text,
	"client_subject_id" text,
	"client_name" text,
	"mcp_session_id" text,
	"correlation_id" text,
	"run_interface_tool_call_id" uuid,
	"call_identity_source" text,
	"call_identity_type" text,
	"call_identity_value" text,
	"application_id" uuid,
	"connection_id" uuid,
	"connection_install_id" uuid,
	"company_tool_selection_id" uuid,
	"catalog_entry_id" uuid,
	"catalog_version_hash" text,
	"catalog_schema_hash" text,
	"provider_type" text,
	"application_key" text,
	"upstream_tool_name" text,
	"risk_level" text,
	"tool_name" text NOT NULL,
	"arguments_hash" text,
	"arguments_summary" jsonb,
	"policy_decision" text,
	"matched_policy_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_explanation" jsonb,
	"credential_scope_summary" jsonb,
	"header_policy_summary" jsonb,
	"approval_state" text DEFAULT 'not_required' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"upstream_request_id" text,
	"result_hash" text,
	"result_summary" jsonb,
	"result" jsonb,
	"result_size_bytes" integer,
	"result_artifact_id" uuid,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_invocations_call_identity_check" CHECK ((
        "tool_invocations"."call_identity_source" is null
        and "tool_invocations"."call_identity_type" is null
        and "tool_invocations"."call_identity_value" is null
      ) or (
        "tool_invocations"."call_identity_source" in ('provider', 'jsonrpc')
        and "tool_invocations"."call_identity_type" in ('string', 'number')
        and "tool_invocations"."call_identity_value" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "tool_mcp_gateway_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"gateway_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text DEFAULT '' NOT NULL,
	"subject_type" text DEFAULT 'gateway_client' NOT NULL,
	"subject_id" text,
	"client_label" text DEFAULT '' NOT NULL,
	"owner_note" text DEFAULT '' NOT NULL,
	"allowed_actions" jsonb DEFAULT '["tools/list","tools/call"]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"expiry_override_reason" text,
	"expiry_override_by_user_id" text,
	"expiry_override_by_agent_id" uuid,
	"expiry_override_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_mcp_gateway_tokens_subject_type_check" CHECK ("tool_mcp_gateway_tokens"."subject_type" in ('gateway_client', 'board_user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "tool_mcp_gateways" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"gateway_public_id" text DEFAULT 'gw_' || replace(gen_random_uuid()::text, '-', '') NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"display_slug" text DEFAULT '' NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"profile_id" uuid NOT NULL,
	"default_profile_mode" text DEFAULT 'gateway_only' NOT NULL,
	"context_scope_type" text DEFAULT 'none' NOT NULL,
	"context_scope_id" text,
	"agent_id" uuid,
	"project_id" uuid,
	"issue_id" uuid,
	"approval_issue_id" uuid,
	"auth_config" jsonb DEFAULT '{"version":1,"bearer":{"enabled":true,"tokenPrefix":"pcgw","defaultTtlSeconds":7776000,"requireFiniteExpiry":true,"longLivedTokenRequiresOverride":true},"oauth":{"enabled":false,"reservedFor":"v1_5","dynamicClientRegistration":false,"authorizationCodePkce":false}}'::jsonb NOT NULL,
	"header_policy" jsonb DEFAULT '{"version":1,"callerPassthrough":{"enabled":false,"allowedHeaders":[]},"staticHeaders":[],"generatedMetadata":{"enabled":false,"allowedHeaders":[]},"responseHeaders":{"forwardMcpRequiredHeaders":true,"forwardSafeCacheHeaders":true}}'::jsonb NOT NULL,
	"metadata_policy" jsonb DEFAULT '{"version":1,"forwardCompanyId":false,"forwardGatewayId":false,"forwardProjectId":false,"forwardIssueId":false,"forwardAgentId":false,"forwardRunId":false,"forwardCorrelationId":true}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"code_verifier" text NOT NULL,
	"created_by_actor_type" text,
	"created_by_actor_id" text,
	"created_by_session_id" text,
	"subject_user_id" text,
	"requested_scopes" jsonb,
	"return_to" text,
	"issue_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"policy_type" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"selectors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"conditions" jsonb,
	"config" jsonb,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_profile_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_profile_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"selector_type" text NOT NULL,
	"effect" text DEFAULT 'include' NOT NULL,
	"application_id" uuid,
	"connection_id" uuid,
	"catalog_entry_id" uuid,
	"tool_name" text,
	"risk_level" text,
	"conditions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"default_action" text DEFAULT 'deny' NOT NULL,
	"new_tools_reviewed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_rate_limit_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"counter_key" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"window_kind" text NOT NULL,
	"window_start_at" timestamp with time zone NOT NULL,
	"limit" integer NOT NULL,
	"remaining" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_runtime_metric_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"bucket_start_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_runtime_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"application_id" uuid,
	"connection_id" uuid,
	"project_workspace_id" uuid,
	"execution_workspace_id" uuid,
	"issue_id" uuid,
	"owner_scope_type" text DEFAULT 'connection' NOT NULL,
	"owner_scope_id" text,
	"runtime_kind" text DEFAULT 'local_stdio' NOT NULL,
	"slot_key" text NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"reuse_key" text,
	"workspace_scope" text,
	"credential_scope_hash" text,
	"provider" text,
	"provider_ref" text,
	"process_id" integer,
	"command_template_key" text,
	"health_status" text DEFAULT 'unchecked' NOT NULL,
	"health_message" text,
	"last_health_check_at" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"idle_expires_at" timestamp with time zone,
	"idle_deadline_at" timestamp with time zone,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_stdio_command_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"command" text NOT NULL,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_inbox_agent_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"mode" text DEFAULT 'open' NOT NULL,
	"allowed_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_inbox_agent_policies_mode_check" CHECK ("user_inbox_agent_policies"."mode" in ('open', 'allowlist', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "user_secret_declarations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_secret_definition_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"config_path" text NOT NULL,
	"env_key" text NOT NULL,
	"version_selector" text DEFAULT 'latest' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"allow_missing_override" boolean DEFAULT false NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_secret_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"provider" text DEFAULT 'local_encrypted' NOT NULL,
	"managed_mode" text DEFAULT 'paperclip_managed' NOT NULL,
	"provider_config_id" uuid,
	"provider_metadata" jsonb,
	"usage_guidance" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sidebar_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"company_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"execution_workspace_id" uuid,
	"run_id" uuid,
	"issue_id" uuid,
	"phase" text NOT NULL,
	"command" text,
	"cwd" text,
	"status" text DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"log_store" text,
	"log_ref" text,
	"log_bytes" bigint,
	"log_sha256" text,
	"log_compressed" boolean DEFAULT false NOT NULL,
	"stdout_excerpt" text,
	"stderr_excerpt" text,
	"metadata" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_runtime_services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"project_workspace_id" uuid,
	"execution_workspace_id" uuid,
	"issue_id" uuid,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"service_name" text NOT NULL,
	"status" text NOT NULL,
	"lifecycle" text NOT NULL,
	"reuse_key" text,
	"command" text,
	"cwd" text,
	"port" integer,
	"url" text,
	"provider" text NOT NULL,
	"provider_ref" text,
	"owner_agent_id" uuid,
	"started_by_run_id" uuid,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"stop_policy" jsonb,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_session_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_run_revision_fk" FOREIGN KEY ("company_id","issue_id","run_id","run_kind","adapter_config_revision_id") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","id","kind","adapter_config_revision_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_adapter_revision_fk" FOREIGN KEY ("company_id","agent_id","adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_productive_attempt_fk" FOREIGN KEY ("company_id","issue_id","run_id","attempt_id","run_kind","prompt_kind","run_ordinal","ref_id","segment_ordinal") REFERENCES "public"."issue_execution_attempts"("company_id","issue_id","run_id","id","run_kind","prompt_kind","ref_ordinal","ref_id","segment_ordinal") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_compaction_attempt_fk" FOREIGN KEY ("company_id","issue_id","run_id","attempt_id","run_kind","prompt_kind","compaction_control_id") REFERENCES "public"."issue_execution_attempts"("company_id","issue_id","run_id","id","run_kind","prompt_kind","compaction_control_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_run_ref_fk" FOREIGN KEY ("company_id","issue_id","session_id","run_id","run_ordinal","ref_id") REFERENCES "public"."issue_execution_run_refs"("company_id","issue_id","session_id","run_id","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_compaction_prompt_fk" FOREIGN KEY ("company_id","issue_id","compaction_control_id","run_id") REFERENCES "public"."issue_session_compaction_controls"("company_id","issue_id","id","compaction_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_responsible_user_id_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_action_grants" ADD CONSTRAINT "agent_action_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_action_grants" ADD CONSTRAINT "agent_action_grants_granted_by_agent_id_agents_id_fk" FOREIGN KEY ("granted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_action_grants" ADD CONSTRAINT "agent_action_grants_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_action_grants" ADD CONSTRAINT "agent_action_grants_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_default_environment_id_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_parent_revision_id_agent_adapter_config_revisions_id_fk" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_company_tool_selections" ADD CONSTRAINT "agent_company_tool_selections_selected_by_agent_id_agents_id_fk" FOREIGN KEY ("selected_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_company_tool_selections" ADD CONSTRAINT "agent_company_tool_selections_selected_by_user_id_user_id_fk" FOREIGN KEY ("selected_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_company_tool_selections" ADD CONSTRAINT "agent_company_tool_selections_selected_by_plugin_installation_id_plugins_id_fk" FOREIGN KEY ("selected_by_plugin_installation_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_company_tool_selections" ADD CONSTRAINT "agent_company_tool_selections_revoked_by_agent_id_agents_id_fk" FOREIGN KEY ("revoked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_company_tool_selections" ADD CONSTRAINT "agent_company_tool_selections_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_company_tool_selections" ADD CONSTRAINT "agent_company_tool_selections_revoked_by_plugin_installation_id_plugins_id_fk" FOREIGN KEY ("revoked_by_plugin_installation_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_company_tool_selections" ADD CONSTRAINT "agent_company_tool_selections_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_company_tool_selections" ADD CONSTRAINT "agent_company_tool_selections_exact_agent_install_fk" FOREIGN KEY ("company_id","connection_id","connection_install_id","agent_id") REFERENCES "public"."tool_connection_installs"("company_id","connection_id","id","target_agent_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_company_tool_selections" ADD CONSTRAINT "agent_company_tool_selections_catalog_entry_fk" FOREIGN KEY ("company_id","connection_id","catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("company_id","connection_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_revisions" ADD CONSTRAINT "agent_config_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_revisions" ADD CONSTRAINT "agent_config_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_revisions" ADD CONSTRAINT "agent_config_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_revisions" ADD CONSTRAINT "agent_config_revisions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_context_grants" ADD CONSTRAINT "agent_context_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_context_grants" ADD CONSTRAINT "agent_context_grants_granted_by_agent_id_agents_id_fk" FOREIGN KEY ("granted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_context_grants" ADD CONSTRAINT "agent_context_grants_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_context_grants" ADD CONSTRAINT "agent_context_grants_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memberships" ADD CONSTRAINT "agent_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memberships" ADD CONSTRAINT "agent_memberships_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memberships" ADD CONSTRAINT "agent_memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mention_reach_grants" ADD CONSTRAINT "agent_mention_reach_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mention_reach_grants" ADD CONSTRAINT "agent_mention_reach_grants_granted_by_agent_id_agents_id_fk" FOREIGN KEY ("granted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mention_reach_grants" ADD CONSTRAINT "agent_mention_reach_grants_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mention_reach_grants" ADD CONSTRAINT "agent_mention_reach_grants_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD CONSTRAINT "agent_runtime_state_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD CONSTRAINT "agent_runtime_state_last_run_fk" FOREIGN KEY ("company_id","last_run_id") REFERENCES "public"."issue_execution_runs"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_reports_to_agents_id_fk" FOREIGN KEY ("reports_to") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_current_adapter_config_revision_id_agent_adapter_config_revisions_id_fk" FOREIGN KEY ("current_adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_default_environment_id_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_api_keys" ADD CONSTRAINT "board_api_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_policy_id_budget_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_attachments" ADD CONSTRAINT "case_attachments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_documents" ADD CONSTRAINT "case_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_documents" ADD CONSTRAINT "case_documents_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_documents" ADD CONSTRAINT "case_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_issue_links" ADD CONSTRAINT "case_issue_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_issue_links" ADD CONSTRAINT "case_issue_links_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_issue_links" ADD CONSTRAINT "case_issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_labels" ADD CONSTRAINT "case_labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_labels" ADD CONSTRAINT "case_labels_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_labels" ADD CONSTRAINT "case_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_parent_case_id_cases_id_fk" FOREIGN KEY ("parent_case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_consents" ADD CONSTRAINT "change_consents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_consents" ADD CONSTRAINT "change_consents_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_consents" ADD CONSTRAINT "change_consents_source_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_consents" ADD CONSTRAINT "change_consents_consumed_by_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("consumed_by_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_auth_challenges" ADD CONSTRAINT "cli_auth_challenges_requested_company_id_companies_id_fk" FOREIGN KEY ("requested_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_auth_challenges" ADD CONSTRAINT "cli_auth_challenges_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_auth_challenges" ADD CONSTRAINT "cli_auth_challenges_board_api_key_id_board_api_keys_id_fk" FOREIGN KEY ("board_api_key_id") REFERENCES "public"."board_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upstream_connections" ADD CONSTRAINT "cloud_upstream_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upstream_connections" ADD CONSTRAINT "cloud_upstream_connections_authorized_global_user_id_user_id_fk" FOREIGN KEY ("authorized_global_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upstream_runs" ADD CONSTRAINT "cloud_upstream_runs_connection_id_cloud_upstream_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."cloud_upstream_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upstream_runs" ADD CONSTRAINT "cloud_upstream_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_default_responsible_user_id_user_id_fk" FOREIGN KEY ("default_responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_feedback_data_sharing_consent_by_user_id_user_id_fk" FOREIGN KEY ("feedback_data_sharing_consent_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_logos" ADD CONSTRAINT "company_logos_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_logos" ADD CONSTRAINT "company_logos_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_principal_user_id_user_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_principal_agent_company_fk" FOREIGN KEY ("company_id","principal_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_bindings" ADD CONSTRAINT "company_secret_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_bindings" ADD CONSTRAINT "company_secret_bindings_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_provider_configs" ADD CONSTRAINT "company_secret_provider_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_provider_configs" ADD CONSTRAINT "company_secret_provider_configs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_provider_configs" ADD CONSTRAINT "company_secret_provider_configs_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD CONSTRAINT "company_secret_versions_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD CONSTRAINT "company_secret_versions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_versions" ADD CONSTRAINT "company_secret_versions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_user_secret_definition_id_user_secret_definitions_id_fk" FOREIGN KEY ("user_secret_definition_id") REFERENCES "public"."user_secret_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_provider_config_id_company_secret_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."company_secret_provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_session_lifecycle_operations" ADD CONSTRAINT "company_session_lifecycle_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_session_lifecycle_operations" ADD CONSTRAINT "company_session_lifecycle_operations_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_session_lifecycle_operations" ADD CONSTRAINT "company_session_lifecycle_operations_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_comments" ADD CONSTRAINT "company_skill_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_comments" ADD CONSTRAINT "company_skill_comments_company_skill_id_company_skills_id_fk" FOREIGN KEY ("company_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_comments" ADD CONSTRAINT "company_skill_comments_parent_comment_id_company_skill_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."company_skill_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_comments" ADD CONSTRAINT "company_skill_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_comments" ADD CONSTRAINT "company_skill_comments_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_policies" ADD CONSTRAINT "company_skill_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_stars" ADD CONSTRAINT "company_skill_stars_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_stars" ADD CONSTRAINT "company_skill_stars_company_skill_id_company_skills_id_fk" FOREIGN KEY ("company_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_stars" ADD CONSTRAINT "company_skill_stars_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_stars" ADD CONSTRAINT "company_skill_stars_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_test_inputs" ADD CONSTRAINT "company_skill_test_inputs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_test_inputs" ADD CONSTRAINT "company_skill_test_inputs_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_test_run_templates" ADD CONSTRAINT "company_skill_test_run_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_test_run_templates" ADD CONSTRAINT "company_skill_test_run_templates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_test_run_templates" ADD CONSTRAINT "company_skill_test_run_templates_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_test_run_templates" ADD CONSTRAINT "company_skill_test_run_templates_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_test_run_templates" ADD CONSTRAINT "company_skill_test_run_templates_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" ADD CONSTRAINT "company_skill_test_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" ADD CONSTRAINT "company_skill_test_runs_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" ADD CONSTRAINT "company_skill_test_runs_input_id_company_skill_test_inputs_id_fk" FOREIGN KEY ("input_id") REFERENCES "public"."company_skill_test_inputs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" ADD CONSTRAINT "company_skill_test_runs_skill_version_id_company_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."company_skill_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" ADD CONSTRAINT "company_skill_test_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" ADD CONSTRAINT "company_skill_test_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD CONSTRAINT "company_skill_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD CONSTRAINT "company_skill_versions_company_skill_id_company_skills_id_fk" FOREIGN KEY ("company_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD CONSTRAINT "company_skill_versions_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD CONSTRAINT "company_skill_versions_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_forked_from_skill_id_company_skills_id_fk" FOREIGN KEY ("forked_from_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_forked_from_company_id_companies_id_fk" FOREIGN KEY ("forked_from_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_current_version_id_company_skill_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."company_skill_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_user_sidebar_preferences" ADD CONSTRAINT "company_user_sidebar_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_user_sidebar_preferences" ADD CONSTRAINT "company_user_sidebar_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_revoked_by_agent_id_agents_id_fk" FOREIGN KEY ("revoked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_company_connection_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."tool_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_accounting_id_acp_prompt_accounting_id_fk" FOREIGN KEY ("accounting_id") REFERENCES "public"."acp_prompt_accounting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_company_budget_currency_fk" FOREIGN KEY ("company_id","budget_currency") REFERENCES "public"."companies"("id","budget_currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_productive_accounting_fk" FOREIGN KEY ("company_id","issue_id","agent_id","run_id","run_kind","ref_id","run_ordinal","segment_ordinal","accounting_id") REFERENCES "public"."acp_prompt_accounting"("company_id","issue_id","agent_id","run_id","run_kind","ref_id","run_ordinal","segment_ordinal","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_compaction_accounting_fk" FOREIGN KEY ("company_id","issue_id","agent_id","run_id","run_kind","compaction_control_id","accounting_id") REFERENCES "public"."acp_prompt_accounting"("company_id","issue_id","agent_id","run_id","run_kind","compaction_control_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_deliveries" ADD CONSTRAINT "creator_deliveries_counterpart_ref_id_issue_execution_refs_id_fk" FOREIGN KEY ("counterpart_ref_id") REFERENCES "public"."issue_execution_refs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_deliveries" ADD CONSTRAINT "creator_deliveries_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_deliveries" ADD CONSTRAINT "creator_deliveries_edge_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","creator_edge_id") REFERENCES "public"."issue_creator_edge_receivability"("company_id","issue_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_deliveries" ADD CONSTRAINT "creator_deliveries_update_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","issue_update_id") REFERENCES "public"."issue_updates"("company_id","issue_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_training_examples" ADD CONSTRAINT "decision_training_examples_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_training_examples" ADD CONSTRAINT "decision_training_examples_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_training_examples" ADD CONSTRAINT "decision_training_examples_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_thread_id_document_annotation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."document_annotation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_from_revision_id_document_revisions_id_fk" FOREIGN KEY ("from_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_to_revision_id_document_revisions_id_fk" FOREIGN KEY ("to_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_thread_id_document_annotation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."document_annotation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_created_by_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_issue_comment_id_issue_comments_id_fk" FOREIGN KEY ("issue_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_original_revision_id_document_revisions_id_fk" FOREIGN KEY ("original_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_current_revision_id_document_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_created_by_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_source_issue_comment_id_issue_comments_id_fk" FOREIGN KEY ("source_issue_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_locked_by_agent_id_agents_id_fk" FOREIGN KEY ("locked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_locked_by_user_id_user_id_fk" FOREIGN KEY ("locked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions" ADD CONSTRAINT "environment_custom_image_setup_sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions" ADD CONSTRAINT "environment_custom_image_setup_sessions_template_id_environment_custom_image_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."environment_custom_image_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions" ADD CONSTRAINT "environment_custom_image_setup_sessions_promoted_template_id_environment_custom_image_templates_id_fk" FOREIGN KEY ("promoted_template_id") REFERENCES "public"."environment_custom_image_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions" ADD CONSTRAINT "environment_custom_image_setup_sessions_environment_lease_id_environment_leases_id_fk" FOREIGN KEY ("environment_lease_id") REFERENCES "public"."environment_leases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions" ADD CONSTRAINT "environment_custom_image_setup_sessions_started_by_user_id_user_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions" ADD CONSTRAINT "environment_custom_image_setup_sessions_started_by_agent_id_agents_id_fk" FOREIGN KEY ("started_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates" ADD CONSTRAINT "environment_custom_image_templates_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates" ADD CONSTRAINT "environment_custom_image_templates_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates" ADD CONSTRAINT "environment_custom_image_templates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates" ADD CONSTRAINT "environment_custom_image_templates_superseded_by_template_id_environment_custom_image_templates_id_fk" FOREIGN KEY ("superseded_by_template_id") REFERENCES "public"."environment_custom_image_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_derived_from_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("derived_from_execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_object_mentions" ADD CONSTRAINT "external_object_mentions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_object_mentions" ADD CONSTRAINT "external_object_mentions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_object_mentions" ADD CONSTRAINT "external_object_mentions_object_id_external_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."external_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_object_mentions" ADD CONSTRAINT "external_object_mentions_created_by_plugin_id_plugins_id_fk" FOREIGN KEY ("created_by_plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_objects" ADD CONSTRAINT "external_objects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_objects" ADD CONSTRAINT "external_objects_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_feedback_vote_id_feedback_votes_id_fk" FOREIGN KEY ("feedback_vote_id") REFERENCES "public"."feedback_votes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_parent_id_goals_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_dismissals" ADD CONSTRAINT "inbox_dismissals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_dismissals" ADD CONSTRAINT "inbox_dismissals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_default_environment_id_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_user_roles" ADD CONSTRAINT "instance_user_roles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_approvals" ADD CONSTRAINT "issue_approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_approvals" ADD CONSTRAINT "issue_approvals_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_approvals" ADD CONSTRAINT "issue_approvals_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_approvals" ADD CONSTRAINT "issue_approvals_linked_by_agent_id_agents_id_fk" FOREIGN KEY ("linked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_approvals" ADD CONSTRAINT "issue_approvals_linked_by_user_id_user_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_issue_comment_id_issue_comments_id_fk" FOREIGN KEY ("issue_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_lifecycle_commands" ADD CONSTRAINT "issue_board_lifecycle_commands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_lifecycle_commands" ADD CONSTRAINT "issue_board_lifecycle_commands_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_lifecycle_commands" ADD CONSTRAINT "issue_board_lifecycle_commands_creator_edge_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch") REFERENCES "public"."issue_creator_edge_receivability"("company_id","issue_id","ownership_epoch") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_reopen_commands" ADD CONSTRAINT "issue_board_reopen_commands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_reopen_commands" ADD CONSTRAINT "issue_board_reopen_commands_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_reopen_commands" ADD CONSTRAINT "issue_board_reopen_commands_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_reopen_commands" ADD CONSTRAINT "issue_board_reopen_commands_creator_edge_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","creator_edge_id") REFERENCES "public"."issue_creator_edge_receivability"("company_id","issue_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_reopen_commands" ADD CONSTRAINT "issue_board_reopen_commands_ref_fk" FOREIGN KEY ("company_id","issue_id","execution_ref_id") REFERENCES "public"."issue_execution_refs"("company_id","issue_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_reopen_commands" ADD CONSTRAINT "issue_board_reopen_commands_system_escalation_fk" FOREIGN KEY ("company_id","issue_id","system_escalation_identity_id") REFERENCES "public"."system_escalation_identities"("company_id","escalation_issue_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_user_comments" ADD CONSTRAINT "issue_board_user_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_user_comments" ADD CONSTRAINT "issue_board_user_comments_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_user_comments" ADD CONSTRAINT "issue_board_user_comments_creator_edge_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch") REFERENCES "public"."issue_creator_edge_receivability"("company_id","issue_id","ownership_epoch") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_user_comments" ADD CONSTRAINT "issue_board_user_comments_comment_fk" FOREIGN KEY ("company_id","issue_id","comment_id") REFERENCES "public"."issue_comments"("company_id","issue_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_user_comments" ADD CONSTRAINT "issue_board_user_comments_ref_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","execution_ref_id") REFERENCES "public"."issue_execution_refs"("company_id","issue_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_projection_sources" ADD CONSTRAINT "issue_comment_projection_sources_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_projection_sources" ADD CONSTRAINT "issue_comment_projection_sources_run_fk" FOREIGN KEY ("company_id","issue_id","session_id","run_id") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_projection_sources" ADD CONSTRAINT "issue_comment_projection_sources_comment_fk" FOREIGN KEY ("company_id","issue_id","comment_id","projected_event_seq") REFERENCES "public"."issue_comments"("company_id","issue_id","id","projected_event_seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_projection_sources" ADD CONSTRAINT "issue_comment_projection_sources_reply_parent_fk" FOREIGN KEY ("company_id","issue_id","reply_to_comment_id","reply_to_projected_event_seq") REFERENCES "public"."issue_comments"("company_id","issue_id","id","projected_event_seq") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_projection_sources" ADD CONSTRAINT "issue_comment_projection_sources_thread_root_fk" FOREIGN KEY ("company_id","issue_id","thread_root_comment_id","thread_root_projected_event_seq") REFERENCES "public"."issue_comments"("company_id","issue_id","id","projected_event_seq") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_projection_sources" ADD CONSTRAINT "issue_comment_projection_sources_steering_segment_fk" FOREIGN KEY ("company_id","issue_id","session_id","steering_target_run_id","ref_ordinal","ref_id","segment_ordinal") REFERENCES "public"."issue_execution_prompt_segments"("company_id","issue_id","session_id","run_id","ref_ordinal","ref_id","segment_ordinal") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_projection_sources" ADD CONSTRAINT "issue_comment_projection_sources_terminal_message_fk" FOREIGN KEY ("company_id","issue_id","session_id","terminal_session_message_id") REFERENCES "public"."issue_session_messages"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_author_agent_scope_fk" FOREIGN KEY ("company_id","author_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_author_plugin_installation_fk" FOREIGN KEY ("author_plugin_installation_id") REFERENCES "public"."plugins"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_run_scope_fk" FOREIGN KEY ("company_id","issue_id","run_id") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_session_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_reply_parent_fk" FOREIGN KEY ("company_id","issue_id","reply_to_comment_id","reply_to_projected_event_seq") REFERENCES "public"."issue_comments"("company_id","issue_id","id","projected_event_seq") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_thread_root_fk" FOREIGN KEY ("company_id","issue_id","thread_root_comment_id","thread_root_projected_event_seq") REFERENCES "public"."issue_comments"("company_id","issue_id","id","projected_event_seq") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_consult_executions" ADD CONSTRAINT "issue_consult_executions_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_consult_executions" ADD CONSTRAINT "issue_consult_executions_source_run_fk" FOREIGN KEY ("company_id","source_run_id") REFERENCES "public"."issue_execution_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_consult_executions" ADD CONSTRAINT "issue_consult_executions_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_consult_executions" ADD CONSTRAINT "issue_consult_executions_adapter_revision_fk" FOREIGN KEY ("company_id","target_agent_id","adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_create_idempotency_keys" ADD CONSTRAINT "issue_create_idempotency_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_create_idempotency_keys" ADD CONSTRAINT "issue_create_idempotency_keys_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_creator_edge_receivability" ADD CONSTRAINT "issue_creator_edge_receivability_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_creator_withdrawal_commands" ADD CONSTRAINT "issue_creator_withdrawal_commands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_creator_withdrawal_commands" ADD CONSTRAINT "issue_creator_withdrawal_commands_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_creator_withdrawal_commands" ADD CONSTRAINT "issue_creator_withdrawal_commands_resulting_edge_fk" FOREIGN KEY ("company_id","issue_id","resulting_ownership_epoch","resulting_creator_edge_id") REFERENCES "public"."issue_creator_edge_receivability"("company_id","issue_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_creator_withdrawal_commands" ADD CONSTRAINT "issue_creator_withdrawal_commands_outgoing_edge_fk" FOREIGN KEY ("company_id","issue_id","outgoing_ownership_epoch") REFERENCES "public"."issue_creator_edge_receivability"("company_id","issue_id","ownership_epoch") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_creator_withdrawal_commands" ADD CONSTRAINT "issue_creator_withdrawal_commands_update_fk" FOREIGN KEY ("company_id","issue_id","resulting_ownership_epoch","issue_update_id") REFERENCES "public"."issue_updates"("company_id","issue_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_creator_withdrawal_commands" ADD CONSTRAINT "issue_creator_withdrawal_commands_plugin_operation_fk" FOREIGN KEY ("company_id","issue_id","plugin_withdrawal_operation_id","actor_plugin_installation_id","actor_plugin_key","issue_update_id") REFERENCES "public"."plugin_withdrawal_operations"("company_id","issue_id","id","plugin_installation_id","plugin_key","issue_update_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_documents" ADD CONSTRAINT "issue_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_documents" ADD CONSTRAINT "issue_documents_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_documents" ADD CONSTRAINT "issue_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_attempt_retry_schedules" ADD CONSTRAINT "issue_execution_attempt_retry_schedules_predecessor_fk" FOREIGN KEY ("company_id","issue_id","run_id","predecessor_attempt_id") REFERENCES "public"."issue_execution_attempts"("company_id","issue_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_attempt_retry_schedules" ADD CONSTRAINT "issue_execution_attempt_retry_schedules_successor_fk" FOREIGN KEY ("company_id","issue_id","run_id","successor_attempt_id") REFERENCES "public"."issue_execution_attempts"("company_id","issue_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" ADD CONSTRAINT "issue_execution_attempts_run_fk" FOREIGN KEY ("company_id","issue_id","session_id","run_id") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" ADD CONSTRAINT "issue_execution_attempts_run_kind_fk" FOREIGN KEY ("company_id","issue_id","run_id","run_kind") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" ADD CONSTRAINT "issue_execution_attempts_base_member_fk" FOREIGN KEY ("company_id","issue_id","session_id","run_id","ref_ordinal","ref_id") REFERENCES "public"."issue_execution_run_refs"("company_id","issue_id","session_id","run_id","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" ADD CONSTRAINT "issue_execution_attempts_steering_segment_fk" FOREIGN KEY ("company_id","issue_id","session_id","run_id","ref_ordinal","ref_id","steering_segment_ordinal") REFERENCES "public"."issue_execution_prompt_segments"("company_id","issue_id","session_id","run_id","ref_ordinal","ref_id","segment_ordinal") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_attempts" ADD CONSTRAINT "issue_execution_attempts_compaction_control_fk" FOREIGN KEY ("company_id","issue_id","compaction_control_id","run_id") REFERENCES "public"."issue_session_compaction_controls"("company_id","issue_id","id","compaction_run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_authorities" ADD CONSTRAINT "issue_execution_authorities_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_authorities" ADD CONSTRAINT "issue_execution_authorities_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_authorities" ADD CONSTRAINT "issue_execution_authorities_adapter_revision_fk" FOREIGN KEY ("company_id","agent_id","audit_adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" ADD CONSTRAINT "issue_execution_cancellation_intents_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" ADD CONSTRAINT "issue_execution_cancellation_intents_attempt_fk" FOREIGN KEY ("company_id","issue_id","run_id","attempt_id") REFERENCES "public"."issue_execution_attempts"("company_id","issue_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" ADD CONSTRAINT "issue_execution_cancellation_intents_lease_fk" FOREIGN KEY ("company_id","issue_id","run_id","attempt_id","lease_id") REFERENCES "public"."issue_execution_leases"("company_id","issue_id","run_id","attempt_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" ADD CONSTRAINT "issue_execution_cancellation_intents_process_fk" FOREIGN KEY ("company_id","issue_id","run_id","attempt_id","process_fact_id") REFERENCES "public"."issue_execution_process_facts"("company_id","issue_id","run_id","attempt_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_cancellation_intents" ADD CONSTRAINT "issue_execution_cancellation_intents_actor_agent_fk" FOREIGN KEY ("company_id","actor_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_created_by_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_delivery_dependencies" ADD CONSTRAINT "issue_execution_finalization_delivery_dependencies_finalization_fk" FOREIGN KEY ("company_id","run_id","finalization_id") REFERENCES "public"."issue_execution_finalizations"("company_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_delivery_dependencies" ADD CONSTRAINT "issue_execution_finalization_delivery_dependencies_update_fk" FOREIGN KEY ("issue_update_id") REFERENCES "public"."issue_updates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_delivery_dependencies" ADD CONSTRAINT "issue_execution_finalization_delivery_dependencies_delivery_fk" FOREIGN KEY ("creator_delivery_id") REFERENCES "public"."creator_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_prompt_dependencies" ADD CONSTRAINT "issue_execution_finalization_prompt_dependencies_finalization_fk" FOREIGN KEY ("company_id","run_id","finalization_id") REFERENCES "public"."issue_execution_finalizations"("company_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_prompt_dependencies" ADD CONSTRAINT "issue_execution_finalization_prompt_dependencies_run_ref_fk" FOREIGN KEY ("company_id","issue_id","run_id","ref_ordinal","ref_id") REFERENCES "public"."issue_execution_run_refs"("company_id","issue_id","run_id","ref_ordinal","ref_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_prompt_dependencies" ADD CONSTRAINT "issue_execution_finalization_prompt_dependencies_compaction_fk" FOREIGN KEY ("company_id","issue_id","compaction_control_id","run_id") REFERENCES "public"."issue_session_compaction_controls"("company_id","issue_id","id","compaction_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_prompt_dependencies" ADD CONSTRAINT "issue_execution_finalization_prompt_dependencies_accounting_fk" FOREIGN KEY ("company_id","issue_id","run_id","accounting_id") REFERENCES "public"."acp_prompt_accounting"("company_id","issue_id","run_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_prompt_dependencies" ADD CONSTRAINT "issue_execution_finalization_prompt_dependencies_cost_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_stale_check_outbox" ADD CONSTRAINT "issue_execution_finalization_stale_check_outbox_run_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","run_id") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","ownership_epoch","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_stale_check_outbox" ADD CONSTRAINT "issue_execution_finalization_stale_check_outbox_finalization_fk" FOREIGN KEY ("company_id","run_id","finalization_id") REFERENCES "public"."issue_execution_finalizations"("company_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_update_dependencies" ADD CONSTRAINT "issue_execution_finalization_update_dependencies_finalization_fk" FOREIGN KEY ("company_id","run_id","finalization_id") REFERENCES "public"."issue_execution_finalizations"("company_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_update_dependencies" ADD CONSTRAINT "issue_execution_finalization_update_dependencies_update_fk" FOREIGN KEY ("issue_update_id") REFERENCES "public"."issue_updates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalizations" ADD CONSTRAINT "issue_execution_finalizations_terminal_session_event_id_issue_session_events_id_fk" FOREIGN KEY ("terminal_session_event_id") REFERENCES "public"."issue_session_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalizations" ADD CONSTRAINT "issue_execution_finalizations_terminal_session_message_id_issue_session_messages_id_fk" FOREIGN KEY ("terminal_session_message_id") REFERENCES "public"."issue_session_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalizations" ADD CONSTRAINT "issue_execution_finalizations_progress_comment_id_issue_comments_id_fk" FOREIGN KEY ("progress_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalizations" ADD CONSTRAINT "issue_execution_finalizations_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."issue_execution_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalizations" ADD CONSTRAINT "issue_execution_finalizations_liveness_fact_fk" FOREIGN KEY ("run_id","run_liveness_fact_id") REFERENCES "public"."issue_execution_run_liveness_facts"("run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_finalizations" ADD CONSTRAINT "issue_execution_finalizations_gateway_revocation_fk" FOREIGN KEY ("gateway_capability_connection_id","gateway_capability_generation") REFERENCES "public"."issue_execution_prompt_capabilities"("capability_connection_id","capability_generation") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_history_view_messages" ADD CONSTRAINT "issue_execution_history_view_messages_view_fk" FOREIGN KEY ("company_id","issue_id","session_id","history_view_id") REFERENCES "public"."issue_execution_history_views"("company_id","issue_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_history_view_messages" ADD CONSTRAINT "issue_execution_history_view_messages_message_fk" FOREIGN KEY ("company_id","issue_id","session_id","message_id") REFERENCES "public"."issue_session_messages"("company_id","issue_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_history_views" ADD CONSTRAINT "issue_execution_history_views_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_history_views" ADD CONSTRAINT "issue_execution_history_views_ref_fk" FOREIGN KEY ("company_id","issue_id","session_id","ref_id") REFERENCES "public"."issue_execution_refs"("company_id","issue_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_lanes" ADD CONSTRAINT "issue_execution_lanes_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_lanes" ADD CONSTRAINT "issue_execution_lanes_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_leases" ADD CONSTRAINT "issue_execution_leases_attempt_fk" FOREIGN KEY ("company_id","issue_id","run_id","attempt_id") REFERENCES "public"."issue_execution_attempts"("company_id","issue_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_process_facts" ADD CONSTRAINT "issue_execution_process_facts_attempt_fk" FOREIGN KEY ("company_id","issue_id","run_id","attempt_id") REFERENCES "public"."issue_execution_attempts"("company_id","issue_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_process_facts" ADD CONSTRAINT "issue_execution_process_facts_lease_fk" FOREIGN KEY ("company_id","issue_id","run_id","attempt_id","lease_id") REFERENCES "public"."issue_execution_leases"("company_id","issue_id","run_id","attempt_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_capabilities" ADD CONSTRAINT "issue_execution_prompt_capabilities_prompt_scope_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","run_id","target_agent_id","adapter_config_identity","workspace_identity","execution_mode") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","ownership_epoch","id","target_agent_id","adapter_config_revision_id","execution_workspace_binding_id","execution_mode") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_capabilities" ADD CONSTRAINT "issue_execution_prompt_capabilities_run_ref_fk" FOREIGN KEY ("run_id","ref_ordinal","ref_id","run_batch_digest") REFERENCES "public"."issue_execution_run_refs"("run_id","ref_ordinal","ref_id","batch_digest") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_capabilities" ADD CONSTRAINT "issue_execution_prompt_capabilities_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_capabilities" ADD CONSTRAINT "issue_execution_prompt_capabilities_authority_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","target_agent_id","issue_execution_authority_id") REFERENCES "public"."issue_execution_authorities"("company_id","issue_id","ownership_epoch","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_capabilities" ADD CONSTRAINT "issue_execution_prompt_capabilities_consult_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","target_agent_id","consult_execution_id") REFERENCES "public"."issue_consult_executions"("company_id","issue_id","ownership_epoch","target_agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_capabilities" ADD CONSTRAINT "issue_execution_prompt_capabilities_adapter_identity_fk" FOREIGN KEY ("company_id","target_agent_id","adapter_config_identity") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_capabilities" ADD CONSTRAINT "issue_execution_prompt_capabilities_workspace_identity_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","workspace_identity") REFERENCES "public"."issue_execution_workspace_bindings"("company_id","issue_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_capabilities" ADD CONSTRAINT "issue_execution_prompt_capabilities_native_correlation_fk" FOREIGN KEY ("company_id","target_session_correlation_id") REFERENCES "public"."issue_execution_sessions"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_segments" ADD CONSTRAINT "issue_execution_prompt_segments_source_comment_id_issue_comments_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_segments" ADD CONSTRAINT "issue_execution_prompt_segments_attempt_id_issue_execution_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."issue_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_segments" ADD CONSTRAINT "issue_execution_prompt_segments_cancellation_intent_id_issue_execution_cancellation_intents_id_fk" FOREIGN KEY ("cancellation_intent_id") REFERENCES "public"."issue_execution_cancellation_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_segments" ADD CONSTRAINT "issue_execution_prompt_segments_run_ref_fk" FOREIGN KEY ("run_id","ref_ordinal","ref_id") REFERENCES "public"."issue_execution_run_refs"("run_id","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_segments" ADD CONSTRAINT "issue_execution_prompt_segments_resume_source_correlation_fk" FOREIGN KEY ("company_id","resume_source_correlation_id") REFERENCES "public"."issue_execution_sessions"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_segments" ADD CONSTRAINT "issue_execution_prompt_segments_source_message_fk" FOREIGN KEY ("company_id","issue_id","session_id","source_message_id") REFERENCES "public"."issue_session_messages"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_segments" ADD CONSTRAINT "issue_execution_prompt_segments_source_input_fk" FOREIGN KEY ("company_id","issue_id","session_id","source_input_id") REFERENCES "public"."issue_session_inputs"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_segments" ADD CONSTRAINT "issue_execution_prompt_segments_terminal_message_fk" FOREIGN KEY ("company_id","issue_id","session_id","terminal_session_message_id") REFERENCES "public"."issue_session_messages"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_prompt_segments" ADD CONSTRAINT "issue_execution_prompt_segments_source_ref_fk" FOREIGN KEY ("company_id","issue_id","session_id","source_ref_id") REFERENCES "public"."issue_execution_refs"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_refs" ADD CONSTRAINT "issue_execution_refs_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_refs" ADD CONSTRAINT "issue_execution_refs_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_refs" ADD CONSTRAINT "issue_execution_refs_adapter_revision_fk" FOREIGN KEY ("company_id","target_agent_id","adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_refs" ADD CONSTRAINT "issue_execution_refs_lane_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","target_agent_id") REFERENCES "public"."issue_execution_lanes"("company_id","issue_id","ownership_epoch","target_agent_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_refs" ADD CONSTRAINT "issue_execution_refs_authority_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","target_agent_id","issue_execution_authority_id") REFERENCES "public"."issue_execution_authorities"("company_id","issue_id","ownership_epoch","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_refs" ADD CONSTRAINT "issue_execution_refs_consult_fk" FOREIGN KEY ("company_id","issue_id","session_id","consult_execution_id") REFERENCES "public"."issue_consult_executions"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_run_controls" ADD CONSTRAINT "issue_execution_run_controls_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_run_controls" ADD CONSTRAINT "issue_execution_run_controls_current_member_fk" FOREIGN KEY ("run_id","current_ordinal","current_ref_id") REFERENCES "public"."issue_execution_run_refs"("run_id","ref_ordinal","ref_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_run_liveness_facts" ADD CONSTRAINT "issue_execution_run_liveness_facts_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."issue_execution_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_run_refs" ADD CONSTRAINT "issue_execution_run_refs_attempt_id_issue_execution_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."issue_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_run_refs" ADD CONSTRAINT "issue_execution_run_refs_run_fk" FOREIGN KEY ("company_id","issue_id","session_id","run_id") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_run_refs" ADD CONSTRAINT "issue_execution_run_refs_ref_fk" FOREIGN KEY ("company_id","issue_id","session_id","ref_id") REFERENCES "public"."issue_execution_refs"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_run_refs" ADD CONSTRAINT "issue_execution_run_refs_input_fk" FOREIGN KEY ("company_id","issue_id","session_id","input_id") REFERENCES "public"."issue_session_inputs"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_adapter_config_revision_id_agent_adapter_config_revisions_id_fk" FOREIGN KEY ("adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_current_attempt_id_issue_execution_attempts_id_fk" FOREIGN KEY ("current_attempt_id") REFERENCES "public"."issue_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_current_lease_id_issue_execution_leases_id_fk" FOREIGN KEY ("current_lease_id") REFERENCES "public"."issue_execution_leases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_cancellation_intent_id_issue_execution_cancellation_intents_id_fk" FOREIGN KEY ("cancellation_intent_id") REFERENCES "public"."issue_execution_cancellation_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_terminal_finalization_id_issue_execution_finalizations_id_fk" FOREIGN KEY ("terminal_finalization_id") REFERENCES "public"."issue_execution_finalizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_session_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_lane_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","target_agent_id") REFERENCES "public"."issue_execution_lanes"("company_id","issue_id","ownership_epoch","target_agent_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_adapter_revision_fk" FOREIGN KEY ("company_id","target_agent_id","adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_authority_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","target_agent_id","issue_execution_authority_id") REFERENCES "public"."issue_execution_authorities"("company_id","issue_id","ownership_epoch","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_consult_fk" FOREIGN KEY ("company_id","issue_id","session_id","consult_execution_id") REFERENCES "public"."issue_consult_executions"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_workspace_binding_fk" FOREIGN KEY ("company_id","issue_id","session_id","ownership_epoch","execution_workspace_binding_id") REFERENCES "public"."issue_execution_workspace_bindings"("company_id","issue_id","session_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_parent_fk" FOREIGN KEY ("company_id","issue_id","parent_run_id") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_retry_fk" FOREIGN KEY ("company_id","issue_id","retry_of_run_id") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_runs" ADD CONSTRAINT "issue_execution_runs_trigger_fk" FOREIGN KEY ("company_id","issue_id","triggered_by_run_id") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_sessions" ADD CONSTRAINT "issue_execution_sessions_cost_cursor_currency_fk" FOREIGN KEY ("company_id","cost_cursor_currency") REFERENCES "public"."companies"("id","budget_currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_sessions" ADD CONSTRAINT "issue_execution_sessions_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_sessions" ADD CONSTRAINT "issue_execution_sessions_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_sessions" ADD CONSTRAINT "issue_execution_sessions_adapter_config_identity_fk" FOREIGN KEY ("company_id","target_agent_id","adapter_config_identity") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_sessions" ADD CONSTRAINT "issue_execution_sessions_workspace_identity_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","workspace_identity") REFERENCES "public"."issue_execution_workspace_bindings"("company_id","issue_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_sessions" ADD CONSTRAINT "issue_execution_sessions_steering_target_scope_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","run_id","target_agent_id","adapter_config_identity","workspace_identity") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","ownership_epoch","id","target_agent_id","adapter_config_revision_id","execution_workspace_binding_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_sessions" ADD CONSTRAINT "issue_execution_sessions_current_run_ref_fk" FOREIGN KEY ("run_id","current_ref_ordinal","current_ref_id") REFERENCES "public"."issue_execution_run_refs"("run_id","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_sessions" ADD CONSTRAINT "issue_execution_sessions_last_settled_run_ref_fk" FOREIGN KEY ("last_protocol_settled_run_id","last_protocol_settled_ref_ordinal","last_protocol_settled_ref_id") REFERENCES "public"."issue_execution_run_refs"("run_id","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_watchdog_decisions" ADD CONSTRAINT "issue_execution_watchdog_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_watchdog_decisions" ADD CONSTRAINT "issue_execution_watchdog_decisions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_watchdog_decisions" ADD CONSTRAINT "issue_execution_watchdog_decisions_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."issue_execution_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_watchdog_decisions" ADD CONSTRAINT "issue_execution_watchdog_decisions_evaluation_issue_fk" FOREIGN KEY ("company_id","evaluation_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_watchdog_decisions" ADD CONSTRAINT "issue_execution_watchdog_decisions_actor_agent_fk" FOREIGN KEY ("company_id","created_by_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_watchdog_decisions" ADD CONSTRAINT "issue_execution_watchdog_decisions_actor_run_fk" FOREIGN KEY ("company_id","created_by_run_id","created_by_agent_id") REFERENCES "public"."issue_execution_runs"("company_id","id","target_agent_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_workspace_bindings" ADD CONSTRAINT "issue_execution_workspace_bindings_bound_by_agent_id_agents_id_fk" FOREIGN KEY ("bound_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_workspace_bindings" ADD CONSTRAINT "issue_execution_workspace_bindings_bound_by_user_id_user_id_fk" FOREIGN KEY ("bound_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_workspace_bindings" ADD CONSTRAINT "issue_execution_workspace_bindings_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_workspace_bindings" ADD CONSTRAINT "issue_execution_workspace_bindings_workspace_fk" FOREIGN KEY ("company_id","execution_workspace_id") REFERENCES "public"."execution_workspaces"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_archived_by_agent_id_agents_id_fk" FOREIGN KEY ("archived_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_archived_by_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("archived_by_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" ADD CONSTRAINT "issue_liveness_reconciliations_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" ADD CONSTRAINT "issue_liveness_reconciliations_target_agent_fk" FOREIGN KEY ("company_id","stale_target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" ADD CONSTRAINT "issue_liveness_reconciliations_creator_edge_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","creator_edge_id","creator_edge_admission_version") REFERENCES "public"."issue_creator_edge_receivability"("company_id","issue_id","ownership_epoch","id","admission_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" ADD CONSTRAINT "issue_liveness_reconciliations_source_run_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","source_run_id","stale_target_agent_id","source_mode") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","ownership_epoch","id","target_agent_id","execution_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" ADD CONSTRAINT "issue_liveness_reconciliations_frontier_finalization_fk" FOREIGN KEY ("company_id","source_run_id","frontier_finalization_id") REFERENCES "public"."issue_execution_finalizations"("company_id","run_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" ADD CONSTRAINT "issue_liveness_reconciliations_source_comment_fk" FOREIGN KEY ("company_id","issue_id","source_run_id","source_comment_id") REFERENCES "public"."issue_comments"("company_id","issue_id","run_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" ADD CONSTRAINT "issue_liveness_reconciliations_followup_reply_fk" FOREIGN KEY ("company_id","issue_id","followup_system_reply_comment_id","source_comment_id") REFERENCES "public"."issue_comments"("company_id","issue_id","id","reply_to_comment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" ADD CONSTRAINT "issue_liveness_reconciliations_followup_ref_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","followup_ref_id","stale_target_agent_id","source_mode") REFERENCES "public"."issue_execution_refs"("company_id","issue_id","ownership_epoch","id","target_agent_id","mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" ADD CONSTRAINT "issue_liveness_reconciliations_followup_run_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","followup_run_id","stale_target_agent_id","source_mode") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","ownership_epoch","id","target_agent_id","execution_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" ADD CONSTRAINT "issue_liveness_reconciliations_followup_finalization_fk" FOREIGN KEY ("company_id","followup_run_id","followup_finalization_id") REFERENCES "public"."issue_execution_finalizations"("company_id","run_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_reference_mentions" ADD CONSTRAINT "issue_reference_mentions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_reference_mentions" ADD CONSTRAINT "issue_reference_mentions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_reference_mentions" ADD CONSTRAINT "issue_reference_mentions_target_issue_id_issues_id_fk" FOREIGN KEY ("target_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_related_issue_id_issues_id_fk" FOREIGN KEY ("related_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_assistant_sources" ADD CONSTRAINT "issue_session_assistant_sources_message_fk" FOREIGN KEY ("company_id","issue_id","session_id","assistant_message_id") REFERENCES "public"."issue_session_messages"("company_id","issue_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_compaction_controls" ADD CONSTRAINT "issue_session_compaction_controls_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_compaction_controls" ADD CONSTRAINT "issue_session_compaction_controls_revert_event_fk" FOREIGN KEY ("session_id","invalidated_by_revert_event_id") REFERENCES "public"."issue_session_events"("session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_compaction_controls" ADD CONSTRAINT "issue_session_compaction_controls_source_run_fk" FOREIGN KEY ("company_id","issue_id","source_run_id","source_run_kind") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_compaction_controls" ADD CONSTRAINT "issue_session_compaction_controls_source_run_ref_fk" FOREIGN KEY ("company_id","issue_id","session_id","source_run_id","source_ref_ordinal","source_ref_id") REFERENCES "public"."issue_execution_run_refs"("company_id","issue_id","session_id","run_id","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_compaction_controls" ADD CONSTRAINT "issue_session_compaction_controls_latest_assistant_fk" FOREIGN KEY ("company_id","issue_id","session_id","latest_finished_assistant_message_id") REFERENCES "public"."issue_session_messages"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_compaction_controls" ADD CONSTRAINT "issue_session_compaction_controls_compaction_run_fk" FOREIGN KEY ("company_id","issue_id","compaction_run_id","compaction_run_kind") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_compaction_controls" ADD CONSTRAINT "issue_session_compaction_controls_accounting_fk" FOREIGN KEY ("company_id","issue_id","compaction_run_id","id","prompt_settlement_reference_id","accounting_id") REFERENCES "public"."acp_prompt_accounting"("company_id","issue_id","run_id","compaction_control_id","prompt_settlement_reference_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_compaction_controls" ADD CONSTRAINT "issue_session_compaction_controls_cost_event_fk" FOREIGN KEY ("company_id","issue_id","compaction_run_id","id","accounting_id","cost_event_id") REFERENCES "public"."cost_events"("company_id","issue_id","run_id","compaction_control_id","accounting_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_completed_tool_sources" ADD CONSTRAINT "issue_session_completed_tool_sources_message_fk" FOREIGN KEY ("company_id","issue_id","session_id","assistant_message_id") REFERENCES "public"."issue_session_messages"("company_id","issue_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_context_epochs" ADD CONSTRAINT "issue_session_context_epochs_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_error_tool_sources" ADD CONSTRAINT "issue_session_error_tool_sources_message_fk" FOREIGN KEY ("company_id","issue_id","session_id","assistant_message_id") REFERENCES "public"."issue_session_messages"("company_id","issue_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_event_sequences" ADD CONSTRAINT "issue_session_event_sequences_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_events" ADD CONSTRAINT "issue_session_events_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_events" ADD CONSTRAINT "issue_session_events_sequence_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_session_event_sequences"("company_id","issue_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_events" ADD CONSTRAINT "issue_session_events_company_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."issue_execution_runs"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_events" ADD CONSTRAINT "issue_session_events_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_events" ADD CONSTRAINT "issue_session_events_adapter_revision_fk" FOREIGN KEY ("company_id","agent_id","adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_input_dispositions" ADD CONSTRAINT "issue_session_input_dispositions_input_fk" FOREIGN KEY ("company_id","issue_id","session_id","input_id") REFERENCES "public"."issue_session_inputs"("company_id","issue_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_inputs" ADD CONSTRAINT "issue_session_inputs_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_message_id_allocators" ADD CONSTRAINT "issue_session_message_id_allocators_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_message_id_reservations" ADD CONSTRAINT "issue_session_message_id_reservations_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_message_id_reservations" ADD CONSTRAINT "issue_session_message_id_reservations_allocator_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_session_message_id_allocators"("company_id","issue_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_messages" ADD CONSTRAINT "issue_session_messages_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_messages" ADD CONSTRAINT "issue_session_messages_message_id_reservation_fk" FOREIGN KEY ("company_id","issue_id","session_id","id") REFERENCES "public"."issue_session_message_id_reservations"("company_id","issue_id","session_id","message_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_messages" ADD CONSTRAINT "issue_session_messages_company_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."issue_execution_runs"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_messages" ADD CONSTRAINT "issue_session_messages_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_messages" ADD CONSTRAINT "issue_session_messages_adapter_revision_fk" FOREIGN KEY ("company_id","agent_id","adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_productive_turn_settlements" ADD CONSTRAINT "issue_session_productive_turn_settlements_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_productive_turn_settlements" ADD CONSTRAINT "issue_session_productive_turn_settlements_productive_run_fk" FOREIGN KEY ("company_id","issue_id","productive_run_id","productive_run_kind") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_productive_turn_settlements" ADD CONSTRAINT "issue_session_productive_turn_settlements_ref_epoch_fk" FOREIGN KEY ("company_id","issue_id","session_id","ref_id","ownership_epoch") REFERENCES "public"."issue_execution_refs"("company_id","issue_id","session_id","id","ownership_epoch") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_productive_turn_settlements" ADD CONSTRAINT "issue_session_productive_turn_settlements_workspace_binding_fk" FOREIGN KEY ("company_id","issue_id","session_id","ownership_epoch","execution_workspace_binding_id") REFERENCES "public"."issue_execution_workspace_bindings"("company_id","issue_id","session_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_productive_turn_settlements" ADD CONSTRAINT "issue_session_productive_turn_settlements_view_fk" FOREIGN KEY ("company_id","issue_id","session_id","ref_id","history_view_id","execution_lineage_id","context_epoch") REFERENCES "public"."issue_execution_history_views"("company_id","issue_id","session_id","ref_id","id","execution_lineage_id","context_epoch") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_productive_turn_settlements" ADD CONSTRAINT "issue_session_productive_turn_settlements_source_companion_fk" FOREIGN KEY ("company_id","issue_id","session_id","source_user_execution_id","source_user_message_id") REFERENCES "public"."issue_session_source_user_executions"("company_id","issue_id","session_id","id","message_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_productive_turn_settlements" ADD CONSTRAINT "issue_session_productive_turn_settlements_source_message_fk" FOREIGN KEY ("company_id","issue_id","session_id","source_user_message_id") REFERENCES "public"."issue_session_messages"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_productive_turn_settlements" ADD CONSTRAINT "issue_session_productive_turn_settlements_assistant_message_fk" FOREIGN KEY ("company_id","issue_id","session_id","assistant_message_id") REFERENCES "public"."issue_session_messages"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_productive_turn_settlements" ADD CONSTRAINT "issue_session_productive_turn_settlements_agent_fk" FOREIGN KEY ("company_id","productive_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_productive_turn_settlements" ADD CONSTRAINT "issue_session_productive_turn_settlements_adapter_revision_fk" FOREIGN KEY ("company_id","productive_agent_id","productive_adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_recovery_selection_members" ADD CONSTRAINT "issue_session_recovery_selection_members_selection_fk" FOREIGN KEY ("company_id","issue_id","session_id","selection_id") REFERENCES "public"."issue_session_recovery_selections"("company_id","issue_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_recovery_selection_members" ADD CONSTRAINT "issue_session_recovery_selection_members_message_fk" FOREIGN KEY ("company_id","issue_id","session_id","message_id") REFERENCES "public"."issue_session_messages"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_recovery_selection_members" ADD CONSTRAINT "issue_session_recovery_selection_members_comment_fk" FOREIGN KEY ("company_id","issue_id","comment_id","comment_projected_event_seq") REFERENCES "public"."issue_comments"("company_id","issue_id","id","projected_event_seq") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_recovery_selections" ADD CONSTRAINT "issue_session_recovery_selections_session_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_recovery_selections" ADD CONSTRAINT "issue_session_recovery_selections_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_recovery_selections" ADD CONSTRAINT "issue_session_recovery_selections_source_run_fk" FOREIGN KEY ("company_id","issue_id","source_run_id") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_recovery_selections" ADD CONSTRAINT "issue_session_recovery_selections_source_run_ref_fk" FOREIGN KEY ("company_id","issue_id","session_id","source_run_id","source_ref_ordinal","source_ref_id") REFERENCES "public"."issue_execution_run_refs"("company_id","issue_id","session_id","run_id","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_recovery_selections" ADD CONSTRAINT "issue_session_recovery_selections_latest_assistant_fk" FOREIGN KEY ("company_id","issue_id","session_id","latest_finished_assistant_message_id") REFERENCES "public"."issue_session_messages"("company_id","issue_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_recovery_selections" ADD CONSTRAINT "issue_session_recovery_selections_checkpoint_fk" FOREIGN KEY ("selected_checkpoint_control_id") REFERENCES "public"."issue_session_compaction_controls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_source_user_executions" ADD CONSTRAINT "issue_session_source_user_executions_message_fk" FOREIGN KEY ("company_id","issue_id","session_id","message_id") REFERENCES "public"."issue_session_messages"("company_id","issue_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_session_source_user_executions" ADD CONSTRAINT "issue_session_source_user_executions_agent_fk" FOREIGN KEY ("company_id","source_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_sessions" ADD CONSTRAINT "issue_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_sessions" ADD CONSTRAINT "issue_sessions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_sessions" ADD CONSTRAINT "issue_sessions_company_parent_fk" FOREIGN KEY ("company_id","parent_session_id") REFERENCES "public"."issue_sessions"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_hold_id_issue_tree_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."issue_tree_holds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_parent_issue_id_issues_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ADD CONSTRAINT "issue_tree_hold_members_active_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_root_issue_id_issues_id_fk" FOREIGN KEY ("root_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_created_by_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_released_by_agent_id_agents_id_fk" FOREIGN KEY ("released_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_released_by_user_id_user_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_released_by_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("released_by_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_updates" ADD CONSTRAINT "issue_updates_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_updates" ADD CONSTRAINT "issue_updates_creator_edge_fk" FOREIGN KEY ("company_id","issue_id","ownership_epoch","creator_edge_id") REFERENCES "public"."issue_creator_edge_receivability"("company_id","issue_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_updates" ADD CONSTRAINT "issue_updates_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."issue_execution_runs"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_updates" ADD CONSTRAINT "issue_updates_source_authority_fk" FOREIGN KEY ("company_id","source_authority_id") REFERENCES "public"."issue_execution_authorities"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_runtime_service_id_workspace_runtime_services_id_fk" FOREIGN KEY ("runtime_service_id") REFERENCES "public"."workspace_runtime_services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_created_by_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_creator_user_id_user_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_escalated_from_affected_issue_id_issues_id_fk" FOREIGN KEY ("escalated_from_affected_issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_escalated_from_triggering_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("escalated_from_triggering_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_responsible_user_id_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_fk" FOREIGN KEY ("company_id","parent_id") REFERENCES "public"."issues"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_requesting_user_id_user_id_fk" FOREIGN KEY ("requesting_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_created_agent_id_agents_id_fk" FOREIGN KEY ("created_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_approved_environment_id_environments_id_fk" FOREIGN KEY ("approved_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_created_agent_adapter_config_revision_id_agent_adapter_config_revisions_id_fk" FOREIGN KEY ("created_agent_adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_rejected_by_user_id_user_id_fk" FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_automation_executions" ADD CONSTRAINT "pipeline_automation_executions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_automation_executions" ADD CONSTRAINT "pipeline_automation_executions_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_automation_executions" ADD CONSTRAINT "pipeline_automation_executions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_automation_executions" ADD CONSTRAINT "pipeline_automation_executions_execution_issue_id_issues_id_fk" FOREIGN KEY ("execution_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_blockers" ADD CONSTRAINT "pipeline_case_blockers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_blockers" ADD CONSTRAINT "pipeline_case_blockers_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_blockers" ADD CONSTRAINT "pipeline_case_blockers_blocked_by_case_id_pipeline_cases_id_fk" FOREIGN KEY ("blocked_by_case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_documents" ADD CONSTRAINT "pipeline_case_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_documents" ADD CONSTRAINT "pipeline_case_documents_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_documents" ADD CONSTRAINT "pipeline_case_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_from_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_to_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" ADD CONSTRAINT "pipeline_case_issue_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" ADD CONSTRAINT "pipeline_case_issue_links_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" ADD CONSTRAINT "pipeline_case_issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_parent_case_id_pipeline_cases_id_fk" FOREIGN KEY ("parent_case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_lease_agent_id_agents_id_fk" FOREIGN KEY ("lease_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_lease_user_id_user_id_fk" FOREIGN KEY ("lease_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_documents" ADD CONSTRAINT "pipeline_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_documents" ADD CONSTRAINT "pipeline_documents_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_documents" ADD CONSTRAINT "pipeline_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_transitions" ADD CONSTRAINT "pipeline_transitions_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_transitions" ADD CONSTRAINT "pipeline_transitions_from_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_transitions" ADD CONSTRAINT "pipeline_transitions_to_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_company_settings" ADD CONSTRAINT "plugin_company_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_company_settings" ADD CONSTRAINT "plugin_company_settings_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_config" ADD CONSTRAINT "plugin_config_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_config" ADD CONSTRAINT "plugin_config_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_creator_deliveries" ADD CONSTRAINT "plugin_creator_deliveries_plugin_installation_id_plugins_id_fk" FOREIGN KEY ("plugin_installation_id") REFERENCES "public"."plugins"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_creator_deliveries" ADD CONSTRAINT "plugin_creator_deliveries_scope_fk" FOREIGN KEY ("company_id","issue_id","session_id") REFERENCES "public"."issue_sessions"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_creator_deliveries" ADD CONSTRAINT "plugin_creator_deliveries_delivery_fk" FOREIGN KEY ("company_id","issue_id","creator_delivery_id") REFERENCES "public"."creator_deliveries"("company_id","issue_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_database_namespaces" ADD CONSTRAINT "plugin_database_namespaces_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_entities" ADD CONSTRAINT "plugin_entities_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_entities" ADD CONSTRAINT "plugin_entities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD CONSTRAINT "plugin_job_runs_job_id_plugin_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."plugin_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD CONSTRAINT "plugin_job_runs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD CONSTRAINT "plugin_job_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_jobs" ADD CONSTRAINT "plugin_jobs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_logs" ADD CONSTRAINT "plugin_logs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_logs" ADD CONSTRAINT "plugin_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_managed_resources" ADD CONSTRAINT "plugin_managed_resources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_managed_resources" ADD CONSTRAINT "plugin_managed_resources_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_migrations" ADD CONSTRAINT "plugin_migrations_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_run_contexts" ADD CONSTRAINT "plugin_run_contexts_plugin_installation_id_plugins_id_fk" FOREIGN KEY ("plugin_installation_id") REFERENCES "public"."plugins"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_run_contexts" ADD CONSTRAINT "plugin_run_contexts_capability_generation_fk" FOREIGN KEY ("capability_connection_id","capability_generation") REFERENCES "public"."issue_execution_prompt_capabilities"("capability_connection_id","capability_generation") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_run_contexts" ADD CONSTRAINT "plugin_run_contexts_exact_tool_call_fk" FOREIGN KEY ("capability_connection_id","capability_generation","run_interface_tool_call_id","company_tool_selection_id","plugin_installation_id") REFERENCES "public"."run_interface_tool_calls"("capability_connection_id","capability_generation","id","company_tool_selection_id","plugin_installation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_run_contexts" ADD CONSTRAINT "plugin_run_contexts_tool_selection_fk" FOREIGN KEY ("company_tool_selection_id") REFERENCES "public"."agent_company_tool_selections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_state" ADD CONSTRAINT "plugin_state_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" ADD CONSTRAINT "plugin_webhook_deliveries_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" ADD CONSTRAINT "plugin_webhook_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_withdrawal_operations" ADD CONSTRAINT "plugin_withdrawal_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_withdrawal_operations" ADD CONSTRAINT "plugin_withdrawal_operations_plugin_installation_id_plugins_id_fk" FOREIGN KEY ("plugin_installation_id") REFERENCES "public"."plugins"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_withdrawal_operations" ADD CONSTRAINT "plugin_withdrawal_operations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_withdrawal_operations" ADD CONSTRAINT "plugin_withdrawal_operations_issue_update_id_issue_updates_id_fk" FOREIGN KEY ("issue_update_id") REFERENCES "public"."issue_updates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_withdrawal_operations" ADD CONSTRAINT "plugin_withdrawal_operations_mutation_comment_id_issue_comments_id_fk" FOREIGN KEY ("mutation_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_permission_grants" ADD CONSTRAINT "principal_permission_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_permission_grants" ADD CONSTRAINT "principal_permission_grants_principal_user_id_user_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_permission_grants" ADD CONSTRAINT "principal_permission_grants_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_permission_grants" ADD CONSTRAINT "principal_permission_grants_principal_agent_company_fk" FOREIGN KEY ("company_id","principal_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_goals" ADD CONSTRAINT "project_goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_goals" ADD CONSTRAINT "project_goals_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_goals" ADD CONSTRAINT "project_goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_documents" ADD CONSTRAINT "routine_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_documents" ADD CONSTRAINT "routine_documents_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_documents" ADD CONSTRAINT "routine_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_restored_from_revision_id_routine_revisions_id_fk" FOREIGN KEY ("restored_from_revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_created_by_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_responsible_user_id_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_trigger_id_routine_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."routine_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_revision_id_routine_revisions_id_fk" FOREIGN KEY ("routine_revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_responsible_user_id_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_parent_issue_id_issues_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_responsible_user_id_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" ADD CONSTRAINT "run_interface_tool_calls_company_tool_selection_id_agent_company_tool_selections_id_fk" FOREIGN KEY ("company_tool_selection_id") REFERENCES "public"."agent_company_tool_selections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" ADD CONSTRAINT "run_interface_tool_calls_plugin_installation_id_plugins_id_fk" FOREIGN KEY ("plugin_installation_id") REFERENCES "public"."plugins"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" ADD CONSTRAINT "run_interface_tool_calls_capability_generation_fk" FOREIGN KEY ("company_id","capability_connection_id","capability_generation") REFERENCES "public"."issue_execution_prompt_capabilities"("company_id","capability_connection_id","capability_generation") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" ADD CONSTRAINT "run_interface_tool_calls_company_tool_selection_fk" FOREIGN KEY ("company_id","company_tool_selection_id") REFERENCES "public"."agent_company_tool_selections"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_agent_configuration_audits" ADD CONSTRAINT "runtime_agent_configuration_audits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_agent_configuration_audits" ADD CONSTRAINT "runtime_agent_configuration_audits_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_agent_configuration_audits" ADD CONSTRAINT "runtime_agent_configuration_audits_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_user_secret_definition_id_user_secret_definitions_id_fk" FOREIGN KEY ("user_secret_definition_id") REFERENCES "public"."user_secret_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_responsible_user_id_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_credential_owner_user_id_user_id_fk" FOREIGN KEY ("credential_owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smoke_run_steps" ADD CONSTRAINT "smoke_run_steps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smoke_run_steps" ADD CONSTRAINT "smoke_run_steps_run_id_smoke_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."smoke_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smoke_runs" ADD CONSTRAINT "smoke_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_generating_issue_id_issues_id_fk" FOREIGN KEY ("generating_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_last_generated_by_agent_id_agents_id_fk" FOREIGN KEY ("last_generated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_escalation_identities" ADD CONSTRAINT "system_escalation_identities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_escalation_identities" ADD CONSTRAINT "system_escalation_identities_affected_issue_id_issues_id_fk" FOREIGN KEY ("affected_issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_escalation_identities" ADD CONSTRAINT "system_escalation_identities_escalation_issue_id_issues_id_fk" FOREIGN KEY ("escalation_issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_escalation_identities" ADD CONSTRAINT "system_escalation_identities_triggering_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("triggering_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_escalation_identities" ADD CONSTRAINT "system_escalation_identities_terminal_creator_edge_id_issue_creator_edge_receivability_id_fk" FOREIGN KEY ("terminal_creator_edge_id") REFERENCES "public"."issue_creator_edge_receivability"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_gateway_id_tool_mcp_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."tool_mcp_gateways"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_gateway_token_id_tool_mcp_gateway_tokens_id_fk" FOREIGN KEY ("gateway_token_id") REFERENCES "public"."tool_mcp_gateway_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_catalog_entry_id_tool_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_invocation_id_tool_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."tool_invocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_action_requests" ADD CONSTRAINT "tool_action_requests_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_applications" ADD CONSTRAINT "tool_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_applications" ADD CONSTRAINT "tool_applications_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_applications" ADD CONSTRAINT "tool_applications_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_applications" ADD CONSTRAINT "tool_applications_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_gateway_id_tool_mcp_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."tool_mcp_gateways"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_gateway_token_id_tool_mcp_gateway_tokens_id_fk" FOREIGN KEY ("gateway_token_id") REFERENCES "public"."tool_mcp_gateway_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_catalog_entry_id_tool_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_invocation_id_tool_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."tool_invocations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_action_request_id_tool_action_requests_id_fk" FOREIGN KEY ("action_request_id") REFERENCES "public"."tool_action_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_runtime_slot_id_tool_runtime_slots_id_fk" FOREIGN KEY ("runtime_slot_id") REFERENCES "public"."tool_runtime_slots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_reviewed_by_agent_id_agents_id_fk" FOREIGN KEY ("reviewed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_connection_installs" ADD CONSTRAINT "tool_connection_installs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_connection_installs" ADD CONSTRAINT "tool_connection_installs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_connection_installs" ADD CONSTRAINT "tool_connection_installs_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_connection_installs" ADD CONSTRAINT "tool_connection_installs_company_connection_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."tool_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_connection_installs" ADD CONSTRAINT "tool_connection_installs_company_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_gateway_rate_limit_counters" ADD CONSTRAINT "tool_gateway_rate_limit_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_gateway_id_tool_mcp_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."tool_mcp_gateways"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_gateway_token_id_tool_mcp_gateway_tokens_id_fk" FOREIGN KEY ("gateway_token_id") REFERENCES "public"."tool_mcp_gateway_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_connection_install_id_tool_connection_installs_id_fk" FOREIGN KEY ("connection_install_id") REFERENCES "public"."tool_connection_installs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_company_tool_selection_id_agent_company_tool_selections_id_fk" FOREIGN KEY ("company_tool_selection_id") REFERENCES "public"."agent_company_tool_selections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_catalog_entry_id_tool_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD CONSTRAINT "tool_mcp_gateway_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD CONSTRAINT "tool_mcp_gateway_tokens_gateway_id_tool_mcp_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."tool_mcp_gateways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD CONSTRAINT "tool_mcp_gateway_tokens_expiry_override_by_user_id_user_id_fk" FOREIGN KEY ("expiry_override_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD CONSTRAINT "tool_mcp_gateway_tokens_expiry_override_by_agent_id_agents_id_fk" FOREIGN KEY ("expiry_override_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD CONSTRAINT "tool_mcp_gateway_tokens_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD CONSTRAINT "tool_mcp_gateway_tokens_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_profile_id_tool_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."tool_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_approval_issue_id_issues_id_fk" FOREIGN KEY ("approval_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_oauth_states" ADD CONSTRAINT "tool_oauth_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_oauth_states" ADD CONSTRAINT "tool_oauth_states_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_oauth_states" ADD CONSTRAINT "tool_oauth_states_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_policies" ADD CONSTRAINT "tool_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_policies" ADD CONSTRAINT "tool_policies_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_policies" ADD CONSTRAINT "tool_policies_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_profile_bindings" ADD CONSTRAINT "tool_profile_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_profile_bindings" ADD CONSTRAINT "tool_profile_bindings_profile_id_tool_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."tool_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_profile_bindings" ADD CONSTRAINT "tool_profile_bindings_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_profile_bindings" ADD CONSTRAINT "tool_profile_bindings_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_profile_id_tool_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."tool_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_profile_entries" ADD CONSTRAINT "tool_profile_entries_catalog_entry_id_tool_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_profiles" ADD CONSTRAINT "tool_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_rate_limit_counters" ADD CONSTRAINT "tool_rate_limit_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_rate_limit_counters" ADD CONSTRAINT "tool_rate_limit_counters_policy_id_tool_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."tool_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_runtime_metric_counters" ADD CONSTRAINT "tool_runtime_metric_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_stdio_command_templates" ADD CONSTRAINT "tool_stdio_command_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_stdio_command_templates" ADD CONSTRAINT "tool_stdio_command_templates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_stdio_command_templates" ADD CONSTRAINT "tool_stdio_command_templates_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_inbox_agent_policies" ADD CONSTRAINT "user_inbox_agent_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_inbox_agent_policies" ADD CONSTRAINT "user_inbox_agent_policies_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_secret_declarations" ADD CONSTRAINT "user_secret_declarations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_secret_declarations" ADD CONSTRAINT "user_secret_declarations_user_secret_definition_id_user_secret_definitions_id_fk" FOREIGN KEY ("user_secret_definition_id") REFERENCES "public"."user_secret_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_provider_config_id_company_secret_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."company_secret_provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_secret_definitions" ADD CONSTRAINT "user_secret_definitions_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sidebar_preferences" ADD CONSTRAINT "user_sidebar_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_started_by_run_id_issue_execution_runs_id_fk" FOREIGN KEY ("started_by_run_id") REFERENCES "public"."issue_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acp_prompt_accounting_productive_prompt_uq" ON "acp_prompt_accounting" USING btree ("run_id","ref_id","run_ordinal","segment_ordinal") WHERE "acp_prompt_accounting"."prompt_kind" in ('base', 'steering');--> statement-breakpoint
CREATE UNIQUE INDEX "acp_prompt_accounting_compaction_prompt_uq" ON "acp_prompt_accounting" USING btree ("run_id","compaction_control_id") WHERE "acp_prompt_accounting"."prompt_kind" = 'compaction';--> statement-breakpoint
CREATE INDEX "acp_prompt_accounting_agent_settled_idx" ON "acp_prompt_accounting" USING btree ("company_id","agent_id","settled_at");--> statement-breakpoint
CREATE INDEX "acp_prompt_accounting_run_idx" ON "acp_prompt_accounting" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "activity_log_company_created_idx" ON "activity_log" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_log_company_agent_created_idx" ON "activity_log" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_log_company_responsible_user_created_idx" ON "activity_log" USING btree ("company_id","responsible_user_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_log_run_id_idx" ON "activity_log" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "activity_log_entity_type_id_idx" ON "activity_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_action_grants_company_agent_key_uq" ON "agent_action_grants" USING btree ("company_id","agent_id","key");--> statement-breakpoint
CREATE INDEX "agent_action_grants_company_agent_idx" ON "agent_action_grants" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_adapter_config_revisions_agent_number_uq" ON "agent_adapter_config_revisions" USING btree ("company_id","agent_id","revision_number");--> statement-breakpoint
CREATE INDEX "agent_adapter_config_revisions_agent_digest_idx" ON "agent_adapter_config_revisions" USING btree ("company_id","agent_id","digest");--> statement-breakpoint
CREATE INDEX "agent_adapter_config_revisions_agent_created_idx" ON "agent_adapter_config_revisions" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_adapter_config_revisions_environment_idx" ON "agent_adapter_config_revisions" USING btree ("default_environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_company_tool_selections_active_uq" ON "agent_company_tool_selections" USING btree ("company_id","agent_id","catalog_entry_id") WHERE "agent_company_tool_selections"."status" = 'selected';--> statement-breakpoint
CREATE INDEX "agent_company_tool_selections_agent_status_idx" ON "agent_company_tool_selections" USING btree ("company_id","agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_company_tool_selections_install_idx" ON "agent_company_tool_selections" USING btree ("company_id","connection_install_id");--> statement-breakpoint
CREATE INDEX "agent_config_revisions_company_agent_created_idx" ON "agent_config_revisions" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_config_revisions_agent_created_idx" ON "agent_config_revisions" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_context_grants_company_agent_key_uq" ON "agent_context_grants" USING btree ("company_id","agent_id","key");--> statement-breakpoint
CREATE INDEX "agent_context_grants_company_agent_idx" ON "agent_context_grants" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_memberships_company_user_idx" ON "agent_memberships" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "agent_memberships_company_user_starred_idx" ON "agent_memberships" USING btree ("company_id","user_id","starred_at");--> statement-breakpoint
CREATE INDEX "agent_memberships_agent_idx" ON "agent_memberships" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memberships_company_user_agent_uq" ON "agent_memberships" USING btree ("company_id","user_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_mention_reach_grants_company_agent_key_uq" ON "agent_mention_reach_grants" USING btree ("company_id","agent_id","key");--> statement-breakpoint
CREATE INDEX "agent_mention_reach_grants_company_agent_idx" ON "agent_mention_reach_grants" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_runtime_state_company_agent_idx" ON "agent_runtime_state" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_runtime_state_company_updated_idx" ON "agent_runtime_state" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX "agent_runtime_state_company_last_run_idx" ON "agent_runtime_state" USING btree ("company_id","last_run_id");--> statement-breakpoint
CREATE INDEX "agents_company_status_idx" ON "agents" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "agents_company_reports_to_idx" ON "agents" USING btree ("company_id","reports_to");--> statement-breakpoint
CREATE INDEX "agents_company_default_environment_idx" ON "agents" USING btree ("company_id","default_environment_id");--> statement-breakpoint
CREATE INDEX "agents_current_adapter_config_revision_idx" ON "agents" USING btree ("company_id","current_adapter_config_revision_id");--> statement-breakpoint
CREATE INDEX "approval_comments_company_idx" ON "approval_comments" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "approval_comments_approval_idx" ON "approval_comments" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "approval_comments_approval_created_idx" ON "approval_comments" USING btree ("approval_id","created_at");--> statement-breakpoint
CREATE INDEX "approvals_company_status_type_idx" ON "approvals" USING btree ("company_id","status","type");--> statement-breakpoint
CREATE INDEX "assets_company_created_idx" ON "assets" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "assets_company_provider_idx" ON "assets" USING btree ("company_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_company_object_key_uq" ON "assets" USING btree ("company_id","object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "board_api_keys_key_hash_idx" ON "board_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "board_api_keys_user_idx" ON "board_api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "budget_incidents_company_status_idx" ON "budget_incidents" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "budget_incidents_company_scope_idx" ON "budget_incidents" USING btree ("company_id","scope_type","scope_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_incidents_policy_window_threshold_idx" ON "budget_incidents" USING btree ("policy_id","window_start","threshold_type") WHERE "budget_incidents"."status" <> 'dismissed';--> statement-breakpoint
CREATE INDEX "budget_policies_company_scope_active_idx" ON "budget_policies" USING btree ("company_id","scope_type","scope_id","is_active");--> statement-breakpoint
CREATE INDEX "budget_policies_company_window_idx" ON "budget_policies" USING btree ("company_id","window_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_policies_company_scope_window_uq" ON "budget_policies" USING btree ("company_id","scope_type","scope_id","window_kind");--> statement-breakpoint
CREATE INDEX "case_attachments_company_case_idx" ON "case_attachments" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_attachments_asset_uq" ON "case_attachments" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_documents_company_case_key_uq" ON "case_documents" USING btree ("company_id","case_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "case_documents_document_uq" ON "case_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "case_documents_company_case_updated_idx" ON "case_documents" USING btree ("company_id","case_id","updated_at");--> statement-breakpoint
CREATE INDEX "case_events_case_created_idx" ON "case_events" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "case_events_company_case_idx" ON "case_events" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_issue_links_case_issue_uq" ON "case_issue_links" USING btree ("case_id","issue_id");--> statement-breakpoint
CREATE INDEX "case_issue_links_company_case_idx" ON "case_issue_links" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE INDEX "case_issue_links_issue_idx" ON "case_issue_links" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_labels_case_label_uq" ON "case_labels" USING btree ("case_id","label_id");--> statement-breakpoint
CREATE INDEX "case_labels_company_case_idx" ON "case_labels" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE INDEX "case_labels_label_idx" ON "case_labels" USING btree ("label_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_company_case_number_uq" ON "cases" USING btree ("company_id","case_number");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_identifier_uq" ON "cases" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_company_type_key_uq" ON "cases" USING btree ("company_id","case_type","key");--> statement-breakpoint
CREATE INDEX "cases_company_status_idx" ON "cases" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "cases_company_type_idx" ON "cases" USING btree ("company_id","case_type");--> statement-breakpoint
CREATE INDEX "cases_company_project_idx" ON "cases" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "cases_parent_idx" ON "cases" USING btree ("parent_case_id");--> statement-breakpoint
CREATE INDEX "cases_title_search_idx" ON "cases" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cases_identifier_search_idx" ON "cases" USING gin ("identifier" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cases_summary_search_idx" ON "cases" USING gin ("summary" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "change_consents_company_status_expiry_idx" ON "change_consents" USING btree ("company_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "change_consents_gate_lookup_idx" ON "change_consents" USING btree ("company_id","requested_by_agent_id","target_key","status","created_at");--> statement-breakpoint
CREATE INDEX "cli_auth_challenges_secret_hash_idx" ON "cli_auth_challenges" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "cli_auth_challenges_approved_by_idx" ON "cli_auth_challenges" USING btree ("approved_by_user_id");--> statement-breakpoint
CREATE INDEX "cli_auth_challenges_requested_company_idx" ON "cli_auth_challenges" USING btree ("requested_company_id");--> statement-breakpoint
CREATE INDEX "cloud_upstream_connections_company_idx" ON "cloud_upstream_connections" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "cloud_upstream_runs_company_created_idx" ON "cloud_upstream_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "cloud_upstream_runs_connection_idx" ON "cloud_upstream_runs" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_issue_prefix_idx" ON "companies" USING btree ("issue_prefix");--> statement-breakpoint
CREATE INDEX "companies_session_integrity_idx" ON "companies" USING btree ("session_integrity_state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "company_logos_company_uq" ON "company_logos" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_logos_asset_uq" ON "company_logos" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_memberships_company_user_unique_idx" ON "company_memberships" USING btree ("company_id","principal_user_id") WHERE "company_memberships"."principal_type" = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX "company_memberships_company_agent_unique_idx" ON "company_memberships" USING btree ("company_id","principal_agent_id") WHERE "company_memberships"."principal_type" = 'agent';--> statement-breakpoint
CREATE INDEX "company_memberships_principal_user_status_idx" ON "company_memberships" USING btree ("principal_user_id","status");--> statement-breakpoint
CREATE INDEX "company_memberships_principal_agent_status_idx" ON "company_memberships" USING btree ("principal_agent_id","status");--> statement-breakpoint
CREATE INDEX "company_memberships_company_status_idx" ON "company_memberships" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "company_secret_bindings_company_idx" ON "company_secret_bindings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_secret_bindings_secret_idx" ON "company_secret_bindings" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX "company_secret_bindings_target_idx" ON "company_secret_bindings" USING btree ("company_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_secret_bindings_target_path_uq" ON "company_secret_bindings" USING btree ("company_id","target_type","target_id","config_path");--> statement-breakpoint
CREATE INDEX "company_secret_provider_configs_company_idx" ON "company_secret_provider_configs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_secret_provider_configs_company_provider_idx" ON "company_secret_provider_configs" USING btree ("company_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "company_secret_provider_configs_default_uq" ON "company_secret_provider_configs" USING btree ("company_id","provider") WHERE "company_secret_provider_configs"."is_default" = true;--> statement-breakpoint
CREATE INDEX "company_secret_versions_secret_idx" ON "company_secret_versions" USING btree ("secret_id","created_at");--> statement-breakpoint
CREATE INDEX "company_secret_versions_value_sha256_idx" ON "company_secret_versions" USING btree ("value_sha256");--> statement-breakpoint
CREATE INDEX "company_secret_versions_fingerprint_idx" ON "company_secret_versions" USING btree ("fingerprint_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "company_secret_versions_secret_version_uq" ON "company_secret_versions" USING btree ("secret_id","version");--> statement-breakpoint
CREATE INDEX "company_secrets_company_idx" ON "company_secrets" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_secrets_company_scope_idx" ON "company_secrets" USING btree ("company_id","scope");--> statement-breakpoint
CREATE INDEX "company_secrets_company_owner_idx" ON "company_secrets" USING btree ("company_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "company_secrets_user_definition_owner_idx" ON "company_secrets" USING btree ("company_id","user_secret_definition_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "company_secrets_company_provider_idx" ON "company_secrets" USING btree ("company_id","provider");--> statement-breakpoint
CREATE INDEX "company_secrets_provider_config_idx" ON "company_secrets" USING btree ("provider_config_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_secrets_company_name_uq" ON "company_secrets" USING btree ("company_id","name") WHERE "company_secrets"."scope" = 'company' and "company_secrets"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "company_secrets_company_key_uq" ON "company_secrets" USING btree ("company_id","key") WHERE "company_secrets"."scope" = 'company' and "company_secrets"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "company_secrets_user_definition_owner_uq" ON "company_secrets" USING btree ("company_id","user_secret_definition_id","owner_user_id") WHERE "company_secrets"."scope" = 'user' and "company_secrets"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "company_session_lifecycle_operations_generation_uq" ON "company_session_lifecycle_operations" USING btree ("company_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "company_session_lifecycle_operations_fence_token_uq" ON "company_session_lifecycle_operations" USING btree ("fence_token");--> statement-breakpoint
CREATE UNIQUE INDEX "company_session_lifecycle_operations_active_uq" ON "company_session_lifecycle_operations" USING btree ("company_id") WHERE "company_session_lifecycle_operations"."status" in ('fenced', 'cancelling', 'purge_ready');--> statement-breakpoint
CREATE INDEX "company_session_lifecycle_operations_status_idx" ON "company_session_lifecycle_operations" USING btree ("company_id","status","generation");--> statement-breakpoint
CREATE INDEX "company_skill_comments_company_skill_created_idx" ON "company_skill_comments" USING btree ("company_id","company_skill_id","created_at");--> statement-breakpoint
CREATE INDEX "company_skill_comments_parent_idx" ON "company_skill_comments" USING btree ("parent_comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_skill_stars_skill_agent_idx" ON "company_skill_stars" USING btree ("company_skill_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_skill_stars_skill_user_idx" ON "company_skill_stars" USING btree ("company_skill_id","user_id");--> statement-breakpoint
CREATE INDEX "company_skill_stars_company_skill_created_idx" ON "company_skill_stars" USING btree ("company_id","company_skill_id","created_at");--> statement-breakpoint
CREATE INDEX "company_skill_test_inputs_company_skill_name_idx" ON "company_skill_test_inputs" USING btree ("company_id","skill_id","name");--> statement-breakpoint
CREATE INDEX "company_skill_test_inputs_company_skill_active_idx" ON "company_skill_test_inputs" USING btree ("company_id","skill_id","deleted_at");--> statement-breakpoint
CREATE INDEX "company_skill_test_run_templates_company_active_idx" ON "company_skill_test_run_templates" USING btree ("company_id","deleted_at","name");--> statement-breakpoint
CREATE INDEX "company_skill_test_runs_company_skill_created_idx" ON "company_skill_test_runs" USING btree ("company_id","skill_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "company_skill_test_runs_company_issue_idx" ON "company_skill_test_runs" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "company_skill_test_runs_company_input_created_idx" ON "company_skill_test_runs" USING btree ("company_id","input_id","created_at");--> statement-breakpoint
CREATE INDEX "company_skill_test_runs_company_status_idx" ON "company_skill_test_runs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "company_skill_test_runs_company_harness_expires_idx" ON "company_skill_test_runs" USING btree ("company_id","harness_issue_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "company_skill_versions_skill_revision_idx" ON "company_skill_versions" USING btree ("company_skill_id","revision_number");--> statement-breakpoint
CREATE INDEX "company_skill_versions_company_skill_created_idx" ON "company_skill_versions" USING btree ("company_id","company_skill_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "company_skills_company_key_idx" ON "company_skills" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "company_skills_company_name_idx" ON "company_skills" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "company_skills_company_folder_idx" ON "company_skills" USING btree ("company_id","folder_id");--> statement-breakpoint
CREATE INDEX "company_skills_company_categories_idx" ON "company_skills" USING gin ("categories");--> statement-breakpoint
CREATE INDEX "company_skills_company_sharing_scope_idx" ON "company_skills" USING btree ("company_id","sharing_scope");--> statement-breakpoint
CREATE INDEX "company_skills_company_current_version_idx" ON "company_skills" USING btree ("company_id","current_version_id");--> statement-breakpoint
CREATE INDEX "company_skills_company_forked_from_idx" ON "company_skills" USING btree ("company_id","forked_from_skill_id");--> statement-breakpoint
CREATE INDEX "company_user_sidebar_preferences_company_idx" ON "company_user_sidebar_preferences" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_user_sidebar_preferences_user_idx" ON "company_user_sidebar_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_user_sidebar_preferences_company_user_uq" ON "company_user_sidebar_preferences" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "connection_grants_company_connection_idx" ON "connection_grants" USING btree ("company_id","connection_id");--> statement-breakpoint
CREATE INDEX "connection_grants_subject_user_idx" ON "connection_grants" USING btree ("company_id","subject_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_grants_user_uq" ON "connection_grants" USING btree ("connection_id","subject_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_grants_default_uq" ON "connection_grants" USING btree ("connection_id") WHERE "connection_grants"."is_default" = true and "connection_grants"."kind" = 'workspace';--> statement-breakpoint
CREATE INDEX "cost_events_company_occurred_idx" ON "cost_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "cost_events_company_agent_occurred_idx" ON "cost_events" USING btree ("company_id","agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "cost_events_run_idx" ON "cost_events" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "cost_events_known_company_idx" ON "cost_events" USING btree ("company_id","occurred_at") WHERE "cost_events"."kind" = 'known';--> statement-breakpoint
CREATE UNIQUE INDEX "creator_deliveries_delivery_id_uq" ON "creator_deliveries" USING btree ("delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_deliveries_idempotency_uq" ON "creator_deliveries" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_deliveries_update_uq" ON "creator_deliveries" USING btree ("issue_update_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_deliveries_counterpart_sequence_uq" ON "creator_deliveries" USING btree ("company_id","counterpart_execution_key","committed_sequence");--> statement-breakpoint
CREATE INDEX "creator_deliveries_claim_idx" ON "creator_deliveries" USING btree ("company_id","state","retry_at","lease_expires_at","first_queued_at");--> statement-breakpoint
CREATE INDEX "creator_deliveries_counterpart_claim_idx" ON "creator_deliveries" USING btree ("company_id","counterpart_execution_key","committed_sequence","state");--> statement-breakpoint
CREATE INDEX "creator_deliveries_edge_state_idx" ON "creator_deliveries" USING btree ("creator_edge_id","state");--> statement-breakpoint
CREATE INDEX "creator_deliveries_hold_idx" ON "creator_deliveries" USING btree ("company_id","hold_reason","held_since");--> statement-breakpoint
CREATE INDEX "decision_training_examples_company_created_at_idx" ON "decision_training_examples" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "decision_training_examples_issue_idx" ON "decision_training_examples" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_training_examples_source_author_uq" ON "decision_training_examples" USING btree ("source_kind","source_id","created_by_user_id");--> statement-breakpoint
CREATE INDEX "document_annotation_anchor_snapshots_company_thread_created_at_idx" ON "document_annotation_anchor_snapshots" USING btree ("company_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_anchor_snapshots_company_document_revision_idx" ON "document_annotation_anchor_snapshots" USING btree ("company_id","document_id","to_revision_number");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_company_thread_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_company_issue_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_company_routine_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","routine_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_company_case_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","case_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_company_document_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","document_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_issue_comment_idx" ON "document_annotation_comments" USING btree ("issue_comment_id");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_body_search_idx" ON "document_annotation_comments" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_document_status_idx" ON "document_annotation_threads" USING btree ("company_id","document_id","status");--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_issue_status_idx" ON "document_annotation_threads" USING btree ("company_id","issue_id","status");--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_routine_status_idx" ON "document_annotation_threads" USING btree ("company_id","routine_id","status");--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_case_status_idx" ON "document_annotation_threads" USING btree ("company_id","case_id","status");--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_current_revision_open_idx" ON "document_annotation_threads" USING btree ("company_id","document_id","current_revision_id","status");--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_anchor_state_idx" ON "document_annotation_threads" USING btree ("company_id","anchor_state");--> statement-breakpoint
CREATE UNIQUE INDEX "document_revisions_document_revision_uq" ON "document_revisions" USING btree ("document_id","revision_number");--> statement-breakpoint
CREATE INDEX "document_revisions_company_document_created_idx" ON "document_revisions" USING btree ("company_id","document_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_revisions_source_issue_comment_uq" ON "document_revisions" USING btree ("source_issue_comment_id");--> statement-breakpoint
CREATE INDEX "documents_company_updated_idx" ON "documents" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX "documents_company_created_idx" ON "documents" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_title_search_idx" ON "documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "documents_latest_body_search_idx" ON "documents" USING gin ("latest_body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_environment_status_idx" ON "environment_custom_image_setup_sessions" USING btree ("environment_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_custom_image_setup_sessions_environment_active_uq" ON "environment_custom_image_setup_sessions" USING btree ("environment_id") WHERE "environment_custom_image_setup_sessions"."status" IN ('starting', 'waiting_for_user', 'capturing');--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_template_idx" ON "environment_custom_image_setup_sessions" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_promoted_template_idx" ON "environment_custom_image_setup_sessions" USING btree ("promoted_template_id");--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_expires_idx" ON "environment_custom_image_setup_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_provider_lease_idx" ON "environment_custom_image_setup_sessions" USING btree ("provider","provider_lease_id");--> statement-breakpoint
CREATE INDEX "environment_custom_image_templates_environment_status_idx" ON "environment_custom_image_templates" USING btree ("environment_id","status");--> statement-breakpoint
CREATE INDEX "environment_custom_image_templates_environment_provider_status_idx" ON "environment_custom_image_templates" USING btree ("environment_id","provider","status");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_custom_image_templates_environment_active_uq" ON "environment_custom_image_templates" USING btree ("environment_id") WHERE "environment_custom_image_templates"."status" = 'active';--> statement-breakpoint
CREATE INDEX "environment_custom_image_templates_superseded_by_idx" ON "environment_custom_image_templates" USING btree ("superseded_by_template_id");--> statement-breakpoint
CREATE INDEX "environment_custom_image_templates_last_used_idx" ON "environment_custom_image_templates" USING btree ("last_used_at");--> statement-breakpoint
CREATE INDEX "environment_leases_company_environment_status_idx" ON "environment_leases" USING btree ("company_id","environment_id","status");--> statement-breakpoint
CREATE INDEX "environment_leases_company_execution_workspace_idx" ON "environment_leases" USING btree ("company_id","execution_workspace_id");--> statement-breakpoint
CREATE INDEX "environment_leases_company_issue_idx" ON "environment_leases" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "environment_leases_run_idx" ON "environment_leases" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "environment_leases_company_last_used_idx" ON "environment_leases" USING btree ("company_id","last_used_at");--> statement-breakpoint
CREATE INDEX "environment_leases_provider_lease_idx" ON "environment_leases" USING btree ("provider_lease_id");--> statement-breakpoint
CREATE INDEX "environments_status_idx" ON "environments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_local_driver_idx" ON "environments" USING btree ("driver") WHERE "environments"."driver" = 'local';--> statement-breakpoint
CREATE UNIQUE INDEX "environments_managed_sandbox_idx" ON "environments" USING btree ("driver") WHERE "environments"."driver" = 'sandbox' AND ("environments"."metadata" ->> 'managedByPaperclip')::boolean = true;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_name_idx" ON "environments" USING btree ("name");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_project_status_idx" ON "execution_workspaces" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_project_workspace_status_idx" ON "execution_workspaces" USING btree ("company_id","project_workspace_id","status");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_source_issue_idx" ON "execution_workspaces" USING btree ("company_id","source_issue_id");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_last_used_idx" ON "execution_workspaces" USING btree ("company_id","last_used_at");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_branch_idx" ON "execution_workspaces" USING btree ("company_id","branch_name");--> statement-breakpoint
CREATE INDEX "external_object_mentions_company_source_issue_idx" ON "external_object_mentions" USING btree ("company_id","source_issue_id");--> statement-breakpoint
CREATE INDEX "external_object_mentions_company_object_idx" ON "external_object_mentions" USING btree ("company_id","object_id");--> statement-breakpoint
CREATE INDEX "external_object_mentions_company_provider_idx" ON "external_object_mentions" USING btree ("company_id","provider_key","object_type");--> statement-breakpoint
CREATE UNIQUE INDEX "external_object_mentions_company_source_record_uq" ON "external_object_mentions" USING btree ("company_id","source_issue_id","source_kind","source_record_id","document_key","property_key","canonical_identity_hash") WHERE "external_object_mentions"."source_record_id" is not null and "external_object_mentions"."canonical_identity_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "external_object_mentions_company_source_null_record_uq" ON "external_object_mentions" USING btree ("company_id","source_issue_id","source_kind","document_key","property_key","canonical_identity_hash") WHERE "external_object_mentions"."source_record_id" is null and "external_object_mentions"."canonical_identity_hash" is not null;--> statement-breakpoint
CREATE INDEX "external_objects_company_provider_object_idx" ON "external_objects" USING btree ("company_id","provider_key","object_type");--> statement-breakpoint
CREATE INDEX "external_objects_company_provider_status_idx" ON "external_objects" USING btree ("company_id","provider_key","status_category");--> statement-breakpoint
CREATE INDEX "external_objects_company_refresh_idx" ON "external_objects" USING btree ("company_id","next_refresh_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_objects_company_external_id_uq" ON "external_objects" USING btree ("company_id","provider_key","object_type","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_objects_company_identity_uq" ON "external_objects" USING btree ("company_id","provider_key","object_type","canonical_identity_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_exports_feedback_vote_idx" ON "feedback_exports" USING btree ("feedback_vote_id");--> statement-breakpoint
CREATE INDEX "feedback_exports_company_created_idx" ON "feedback_exports" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_exports_company_status_idx" ON "feedback_exports" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_exports_company_issue_idx" ON "feedback_exports" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_exports_company_project_idx" ON "feedback_exports" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_exports_company_author_idx" ON "feedback_exports" USING btree ("company_id","author_user_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_votes_company_issue_idx" ON "feedback_votes" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "feedback_votes_issue_target_idx" ON "feedback_votes" USING btree ("issue_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "feedback_votes_author_idx" ON "feedback_votes" USING btree ("author_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_votes_company_target_author_idx" ON "feedback_votes" USING btree ("company_id","target_type","target_id","author_user_id");--> statement-breakpoint
CREATE INDEX "finance_events_company_occurred_idx" ON "finance_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "finance_events_company_biller_occurred_idx" ON "finance_events" USING btree ("company_id","biller","occurred_at");--> statement-breakpoint
CREATE INDEX "finance_events_company_kind_occurred_idx" ON "finance_events" USING btree ("company_id","event_kind","occurred_at");--> statement-breakpoint
CREATE INDEX "finance_events_company_direction_occurred_idx" ON "finance_events" USING btree ("company_id","direction","occurred_at");--> statement-breakpoint
CREATE INDEX "folders_company_kind_position_idx" ON "folders" USING btree ("company_id","kind","position","name");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_company_kind_root_slug_uq" ON "folders" USING btree ("company_id","kind","slug") WHERE "folders"."parent_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_company_kind_parent_slug_uq" ON "folders" USING btree ("company_id","kind","parent_id","slug") WHERE "folders"."parent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_company_kind_system_key_uq" ON "folders" USING btree ("company_id","kind","system_key") WHERE "folders"."system_key" is not null;--> statement-breakpoint
CREATE INDEX "folders_company_kind_parent_position_idx" ON "folders" USING btree ("company_id","kind","parent_id","position","name");--> statement-breakpoint
CREATE INDEX "goals_company_idx" ON "goals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "inbox_dismissals_company_user_idx" ON "inbox_dismissals" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "inbox_dismissals_company_item_idx" ON "inbox_dismissals" USING btree ("company_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_dismissals_company_user_item_idx" ON "inbox_dismissals" USING btree ("company_id","user_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "instance_settings_singleton_key_idx" ON "instance_settings" USING btree ("singleton_key");--> statement-breakpoint
CREATE UNIQUE INDEX "instance_user_roles_user_role_unique_idx" ON "instance_user_roles" USING btree ("user_id","role");--> statement-breakpoint
CREATE INDEX "instance_user_roles_role_idx" ON "instance_user_roles" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_hash_unique_idx" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invites_company_invite_state_idx" ON "invites" USING btree ("company_id","invite_type","revoked_at","expires_at");--> statement-breakpoint
CREATE INDEX "issue_approvals_issue_idx" ON "issue_approvals" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_approvals_approval_idx" ON "issue_approvals" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "issue_approvals_company_idx" ON "issue_approvals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "issue_attachments_company_issue_idx" ON "issue_attachments" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_attachments_issue_comment_idx" ON "issue_attachments" USING btree ("issue_comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_attachments_asset_uq" ON "issue_attachments" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "issue_board_lifecycle_commands_issue_committed_idx" ON "issue_board_lifecycle_commands" USING btree ("company_id","issue_id","committed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_board_reopen_commands_idempotency_uq" ON "issue_board_reopen_commands" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "issue_board_reopen_commands_issue_created_idx" ON "issue_board_reopen_commands" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_board_user_comments_idempotency_uq" ON "issue_board_user_comments" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_board_user_comments_comment_uq" ON "issue_board_user_comments" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "issue_board_user_comments_issue_created_idx" ON "issue_board_user_comments" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comment_projection_sources_source_uq" ON "issue_comment_projection_sources" USING btree ("session_id","source_kind","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comment_projection_sources_message_uq" ON "issue_comment_projection_sources" USING btree ("session_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comment_projection_sources_run_progress_uq" ON "issue_comment_projection_sources" USING btree ("company_id","issue_id","run_id","source_kind") WHERE "issue_comment_projection_sources"."source_kind" = 'run_progress';--> statement-breakpoint
CREATE INDEX "issue_comment_projection_sources_event_idx" ON "issue_comment_projection_sources" USING btree ("session_id","projected_event_seq");--> statement-breakpoint
CREATE INDEX "issue_comment_projection_sources_run_idx" ON "issue_comment_projection_sources" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "issue_comments_issue_idx" ON "issue_comments" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_comments_company_idx" ON "issue_comments" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "issue_comments_company_issue_created_at_idx" ON "issue_comments" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_comments_company_author_issue_created_at_idx" ON "issue_comments" USING btree ("company_id","author_user_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_comments_body_search_idx" ON "issue_comments" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issue_consult_executions_active_idx" ON "issue_consult_executions" USING btree ("company_id","issue_id","ownership_epoch","state");--> statement-breakpoint
CREATE INDEX "issue_consult_executions_source_run_idx" ON "issue_consult_executions" USING btree ("source_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_create_idempotency_keys_company_key_uq" ON "issue_create_idempotency_keys" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "issue_create_idempotency_keys_issue_idx" ON "issue_create_idempotency_keys" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_create_idempotency_keys_company_created_at_idx" ON "issue_create_idempotency_keys" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_creator_edge_receivability_current_idx" ON "issue_creator_edge_receivability" USING btree ("company_id","issue_id","state");--> statement-breakpoint
CREATE INDEX "issue_creator_edge_receivability_endpoint_idx" ON "issue_creator_edge_receivability" USING btree ("company_id","endpoint_kind","endpoint_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_creator_withdrawal_commands_plugin_operation_uq" ON "issue_creator_withdrawal_commands" USING btree ("plugin_withdrawal_operation_id") WHERE "issue_creator_withdrawal_commands"."plugin_withdrawal_operation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_creator_withdrawal_commands_update_uq" ON "issue_creator_withdrawal_commands" USING btree ("issue_update_id") WHERE "issue_creator_withdrawal_commands"."issue_update_id" is not null;--> statement-breakpoint
CREATE INDEX "issue_creator_withdrawal_commands_issue_accepted_idx" ON "issue_creator_withdrawal_commands" USING btree ("company_id","issue_id","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_documents_company_issue_key_uq" ON "issue_documents" USING btree ("company_id","issue_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_documents_document_uq" ON "issue_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "issue_documents_company_issue_updated_idx" ON "issue_documents" USING btree ("company_id","issue_id","updated_at");--> statement-breakpoint
CREATE INDEX "issue_execution_attempt_retry_schedules_due_idx" ON "issue_execution_attempt_retry_schedules" USING btree ("company_id","state","retry_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_attempts_base_prompt_uq" ON "issue_execution_attempts" USING btree ("run_id","ref_ordinal","ref_id","attempt_generation") WHERE "issue_execution_attempts"."prompt_kind" = 'base';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_attempts_steering_prompt_uq" ON "issue_execution_attempts" USING btree ("run_id","ref_ordinal","ref_id","segment_ordinal","attempt_generation") WHERE "issue_execution_attempts"."prompt_kind" = 'steering';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_attempts_compaction_prompt_uq" ON "issue_execution_attempts" USING btree ("run_id","compaction_control_id","attempt_generation") WHERE "issue_execution_attempts"."prompt_kind" = 'compaction';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_attempts_live_run_uq" ON "issue_execution_attempts" USING btree ("run_id") WHERE "issue_execution_attempts"."state" in ('pending', 'leased', 'running');--> statement-breakpoint
CREATE INDEX "issue_execution_attempts_state_idx" ON "issue_execution_attempts" USING btree ("company_id","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_authorities_identity_uq" ON "issue_execution_authorities" USING btree ("company_id","issue_id","ownership_epoch","agent_id");--> statement-breakpoint
CREATE INDEX "issue_execution_authorities_current_idx" ON "issue_execution_authorities" USING btree ("company_id","issue_id","state");--> statement-breakpoint
CREATE INDEX "issue_execution_authorities_agent_state_idx" ON "issue_execution_authorities" USING btree ("company_id","agent_id","state");--> statement-breakpoint
CREATE INDEX "issue_execution_cancellation_intents_state_idx" ON "issue_execution_cancellation_intents" USING btree ("company_id","state","requested_at");--> statement-breakpoint
CREATE INDEX "issue_execution_decisions_company_issue_idx" ON "issue_execution_decisions" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_execution_decisions_stage_idx" ON "issue_execution_decisions" USING btree ("issue_id","stage_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_execution_finalization_delivery_dependencies_run_idx" ON "issue_execution_finalization_delivery_dependencies" USING btree ("company_id","run_id","dependency_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_finalization_prompt_dependencies_base_uq" ON "issue_execution_finalization_prompt_dependencies" USING btree ("finalization_id","ref_id") WHERE "issue_execution_finalization_prompt_dependencies"."prompt_kind" = 'base';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_finalization_prompt_dependencies_steering_uq" ON "issue_execution_finalization_prompt_dependencies" USING btree ("finalization_id","ref_id","segment_ordinal") WHERE "issue_execution_finalization_prompt_dependencies"."prompt_kind" = 'steering';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_finalization_prompt_dependencies_compaction_uq" ON "issue_execution_finalization_prompt_dependencies" USING btree ("finalization_id","compaction_control_id") WHERE "issue_execution_finalization_prompt_dependencies"."prompt_kind" = 'compaction';--> statement-breakpoint
CREATE INDEX "issue_execution_finalization_prompt_dependencies_run_idx" ON "issue_execution_finalization_prompt_dependencies" USING btree ("company_id","run_id","dependency_ordinal");--> statement-breakpoint
CREATE INDEX "issue_execution_finalization_stale_check_outbox_pending_idx" ON "issue_execution_finalization_stale_check_outbox" USING btree ("created_at","finalization_id") WHERE "issue_execution_finalization_stale_check_outbox"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "issue_execution_finalization_update_dependencies_run_idx" ON "issue_execution_finalization_update_dependencies" USING btree ("company_id","run_id","dependency_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_history_view_messages_order_uq" ON "issue_execution_history_view_messages" USING btree ("history_view_id","lower_order");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_history_view_messages_message_uq" ON "issue_execution_history_view_messages" USING btree ("history_view_id","message_id");--> statement-breakpoint
CREATE INDEX "issue_execution_history_view_messages_scope_idx" ON "issue_execution_history_view_messages" USING btree ("session_id","history_view_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_history_views_ref_uq" ON "issue_execution_history_views" USING btree ("ref_id");--> statement-breakpoint
CREATE INDEX "issue_execution_history_views_lineage_idx" ON "issue_execution_history_views" USING btree ("session_id","execution_lineage_id","source_high_water_seq");--> statement-breakpoint
CREATE INDEX "issue_execution_history_views_preparation_idx" ON "issue_execution_history_views" USING btree ("composition_preparation_id");--> statement-breakpoint
CREATE INDEX "issue_execution_history_views_state_idx" ON "issue_execution_history_views" USING btree ("company_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "issue_execution_lanes_active_idx" ON "issue_execution_lanes" USING btree ("company_id","active_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_lanes_active_lease_uq" ON "issue_execution_lanes" USING btree ("active_lease_id") WHERE "issue_execution_lanes"."active_lease_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_leases_active_run_uq" ON "issue_execution_leases" USING btree ("run_id") WHERE "issue_execution_leases"."state" = 'active';--> statement-breakpoint
CREATE INDEX "issue_execution_leases_expiry_idx" ON "issue_execution_leases" USING btree ("company_id","state","expires_at");--> statement-breakpoint
CREATE INDEX "issue_execution_process_facts_state_idx" ON "issue_execution_process_facts" USING btree ("company_id","state","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_prompt_capabilities_bearer_hash_uq" ON "issue_execution_prompt_capabilities" USING btree ("bearer_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_prompt_capabilities_live_run_uq" ON "issue_execution_prompt_capabilities" USING btree ("run_id") WHERE "issue_execution_prompt_capabilities"."state" in ('pending_setup', 'active');--> statement-breakpoint
CREATE INDEX "issue_execution_prompt_capabilities_issue_state_idx" ON "issue_execution_prompt_capabilities" USING btree ("company_id","issue_id","state");--> statement-breakpoint
CREATE INDEX "issue_execution_prompt_capabilities_expiry_idx" ON "issue_execution_prompt_capabilities" USING btree ("company_id","expires_at");--> statement-breakpoint
CREATE INDEX "issue_execution_prompt_segments_source_comment_idx" ON "issue_execution_prompt_segments" USING btree ("company_id","source_comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_refs_delivery_idempotency_uq" ON "issue_execution_refs" USING btree ("company_id","delivery_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_refs_history_view_uq" ON "issue_execution_refs" USING btree ("history_view_id");--> statement-breakpoint
CREATE INDEX "issue_execution_refs_lane_order_idx" ON "issue_execution_refs" USING btree ("company_id","issue_id","ownership_epoch","target_agent_id","lane_ordinal");--> statement-breakpoint
CREATE INDEX "issue_execution_refs_source_idx" ON "issue_execution_refs" USING btree ("company_id","source_kind","source_record_id");--> statement-breakpoint
CREATE INDEX "issue_execution_refs_counterpart_idx" ON "issue_execution_refs" USING btree ("company_id","counterpart_issue_id","counterpart_ownership_epoch");--> statement-breakpoint
CREATE INDEX "issue_execution_refs_lineage_idx" ON "issue_execution_refs" USING btree ("session_id","execution_lineage_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_run_refs_active_ref_uq" ON "issue_execution_run_refs" USING btree ("company_id","ref_id") WHERE "issue_execution_run_refs"."protocol_settlement_state" is null;--> statement-breakpoint
CREATE INDEX "issue_execution_run_refs_run_order_idx" ON "issue_execution_run_refs" USING btree ("run_id","ref_ordinal");--> statement-breakpoint
CREATE INDEX "issue_execution_runs_execution_scope_idx" ON "issue_execution_runs" USING btree ("company_id","execution_scope_id");--> statement-breakpoint
CREATE INDEX "issue_execution_runs_issue_status_idx" ON "issue_execution_runs" USING btree ("company_id","issue_id","status","created_at");--> statement-breakpoint
CREATE INDEX "issue_execution_runs_agent_status_idx" ON "issue_execution_runs" USING btree ("company_id","target_agent_id","status","created_at");--> statement-breakpoint
CREATE INDEX "issue_execution_runs_parent_idx" ON "issue_execution_runs" USING btree ("company_id","parent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_sessions_current_carry_uq" ON "issue_execution_sessions" USING btree ("company_id","issue_id","ownership_epoch","target_agent_id","adapter_config_identity","workspace_identity","lane_kind") WHERE "issue_execution_sessions"."purpose" = 'carry' and "issue_execution_sessions"."state" = 'eligible';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_sessions_current_steering_uq" ON "issue_execution_sessions" USING btree ("company_id","issue_id","ownership_epoch","run_id","target_agent_id","adapter_config_identity","workspace_identity") WHERE "issue_execution_sessions"."purpose" = 'active_run_steering' and "issue_execution_sessions"."state" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_sessions_carry_generation_uq" ON "issue_execution_sessions" USING btree ("company_id","issue_id","ownership_epoch","target_agent_id","adapter_config_identity","workspace_identity","lane_kind","correlation_generation") WHERE "issue_execution_sessions"."purpose" = 'carry';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_sessions_steering_generation_uq" ON "issue_execution_sessions" USING btree ("company_id","issue_id","ownership_epoch","run_id","target_agent_id","adapter_config_identity","workspace_identity","correlation_generation") WHERE "issue_execution_sessions"."purpose" = 'active_run_steering';--> statement-breakpoint
CREATE INDEX "issue_execution_sessions_digest_idx" ON "issue_execution_sessions" USING btree ("company_id","protected_target_session_digest");--> statement-breakpoint
CREATE INDEX "issue_execution_sessions_issue_state_idx" ON "issue_execution_sessions" USING btree ("company_id","issue_id","state");--> statement-breakpoint
CREATE INDEX "issue_execution_watchdog_decisions_company_run_created_idx" ON "issue_execution_watchdog_decisions" USING btree ("company_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_execution_watchdog_decisions_company_run_snooze_idx" ON "issue_execution_watchdog_decisions" USING btree ("company_id","run_id","snoozed_until");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_workspace_bindings_epoch_uq" ON "issue_execution_workspace_bindings" USING btree ("company_id","issue_id","ownership_epoch");--> statement-breakpoint
CREATE INDEX "issue_execution_workspace_bindings_workspace_idx" ON "issue_execution_workspace_bindings" USING btree ("company_id","execution_workspace_id");--> statement-breakpoint
CREATE INDEX "issue_inbox_archives_company_issue_idx" ON "issue_inbox_archives" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_inbox_archives_company_user_idx" ON "issue_inbox_archives" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_inbox_archives_company_issue_user_idx" ON "issue_inbox_archives" USING btree ("company_id","issue_id","user_id");--> statement-breakpoint
CREATE INDEX "issue_labels_issue_idx" ON "issue_labels" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_labels_label_idx" ON "issue_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "issue_labels_company_idx" ON "issue_labels" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_liveness_reconciliations_followup_comment_uq" ON "issue_liveness_reconciliations" USING btree ("followup_system_reply_comment_id") WHERE "issue_liveness_reconciliations"."followup_system_reply_comment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_liveness_reconciliations_followup_ref_uq" ON "issue_liveness_reconciliations" USING btree ("followup_ref_id") WHERE "issue_liveness_reconciliations"."followup_ref_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_liveness_reconciliations_followup_run_uq" ON "issue_liveness_reconciliations" USING btree ("followup_run_id") WHERE "issue_liveness_reconciliations"."followup_run_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_liveness_reconciliations_followup_finalization_uq" ON "issue_liveness_reconciliations" USING btree ("followup_finalization_id") WHERE "issue_liveness_reconciliations"."followup_finalization_id" is not null;--> statement-breakpoint
CREATE INDEX "issue_liveness_reconciliations_attention_idx" ON "issue_liveness_reconciliations" USING btree ("company_id","board_attention_emitted_at","exit_action_committed_at");--> statement-breakpoint
CREATE INDEX "issue_read_states_company_issue_idx" ON "issue_read_states" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_read_states_company_user_idx" ON "issue_read_states" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_read_states_company_issue_user_idx" ON "issue_read_states" USING btree ("company_id","issue_id","user_id");--> statement-breakpoint
CREATE INDEX "issue_reference_mentions_company_source_issue_idx" ON "issue_reference_mentions" USING btree ("company_id","source_issue_id");--> statement-breakpoint
CREATE INDEX "issue_reference_mentions_company_target_issue_idx" ON "issue_reference_mentions" USING btree ("company_id","target_issue_id");--> statement-breakpoint
CREATE INDEX "issue_reference_mentions_company_issue_pair_idx" ON "issue_reference_mentions" USING btree ("company_id","source_issue_id","target_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_reference_mentions_company_source_mention_record_uq" ON "issue_reference_mentions" USING btree ("company_id","source_issue_id","target_issue_id","source_kind","source_record_id") WHERE "issue_reference_mentions"."source_record_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_reference_mentions_company_source_mention_null_record_uq" ON "issue_reference_mentions" USING btree ("company_id","source_issue_id","target_issue_id","source_kind") WHERE "issue_reference_mentions"."source_record_id" is null;--> statement-breakpoint
CREATE INDEX "issue_relations_company_issue_idx" ON "issue_relations" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_relations_company_related_issue_idx" ON "issue_relations" USING btree ("company_id","related_issue_id");--> statement-breakpoint
CREATE INDEX "issue_relations_company_type_idx" ON "issue_relations" USING btree ("company_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_relations_company_edge_uq" ON "issue_relations" USING btree ("company_id","issue_id","related_issue_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_assistant_sources_message_uq" ON "issue_session_assistant_sources" USING btree ("assistant_message_id");--> statement-breakpoint
CREATE INDEX "issue_session_compaction_controls_session_seq_idx" ON "issue_session_compaction_controls" USING btree ("session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_compaction_controls_recovery_identity_uq" ON "issue_session_compaction_controls" USING btree ("company_id","recovery_identity_digest") WHERE "issue_session_compaction_controls"."kind" = 'recovery-prompt';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_compaction_controls_recovery_run_uq" ON "issue_session_compaction_controls" USING btree ("company_id","issue_id","compaction_run_id") WHERE "issue_session_compaction_controls"."kind" = 'recovery-prompt';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_compaction_controls_checkpoint_run_uq" ON "issue_session_compaction_controls" USING btree ("company_id","issue_id","compaction_run_id") WHERE "issue_session_compaction_controls"."kind" = 'checkpoint';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_compaction_controls_failed_run_uq" ON "issue_session_compaction_controls" USING btree ("company_id","issue_id","compaction_run_id") WHERE "issue_session_compaction_controls"."kind" = 'failed-compaction';--> statement-breakpoint
CREATE INDEX "issue_session_compaction_controls_checkpoint_idx" ON "issue_session_compaction_controls" USING btree ("session_id","history_scope_kind","history_scope_id","audience","source_high_water_seq");--> statement-breakpoint
CREATE INDEX "issue_session_compaction_controls_active_scope_idx" ON "issue_session_compaction_controls" USING btree ("session_id","disposition","kind","history_scope_kind","history_scope_id","audience","source_high_water_seq");--> statement-breakpoint
CREATE INDEX "issue_session_compaction_controls_run_idx" ON "issue_session_compaction_controls" USING btree ("company_id","compaction_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_completed_tool_sources_tool_uq" ON "issue_session_completed_tool_sources" USING btree ("session_id","assistant_message_id","tool_id");--> statement-breakpoint
CREATE INDEX "issue_session_context_epochs_session_baseline_idx" ON "issue_session_context_epochs" USING btree ("session_id","baseline_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_error_tool_sources_tool_uq" ON "issue_session_error_tool_sources" USING btree ("session_id","assistant_message_id","tool_id");--> statement-breakpoint
CREATE INDEX "issue_session_event_sequences_owner_idx" ON "issue_session_event_sequences" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_events_session_seq_uq" ON "issue_session_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_events_source_identity_uq" ON "issue_session_events" USING btree ("session_id","source_kind","immutable_source_key") WHERE "issue_session_events"."source_kind" is not null;--> statement-breakpoint
CREATE INDEX "issue_session_events_session_type_seq_idx" ON "issue_session_events" USING btree ("session_id","type","seq");--> statement-breakpoint
CREATE INDEX "issue_session_events_scope_run_idx" ON "issue_session_events" USING btree ("company_id","issue_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_input_dispositions_input_uq" ON "issue_session_input_dispositions" USING btree ("input_id");--> statement-breakpoint
CREATE INDEX "issue_session_input_dispositions_source_ref_idx" ON "issue_session_input_dispositions" USING btree ("source_ref_id");--> statement-breakpoint
CREATE INDEX "issue_session_input_dispositions_pending_idx" ON "issue_session_input_dispositions" USING btree ("session_id","state","input_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_inputs_session_admitted_seq_uq" ON "issue_session_inputs" USING btree ("session_id","admitted_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_inputs_session_promoted_seq_uq" ON "issue_session_inputs" USING btree ("session_id","promoted_seq") WHERE "issue_session_inputs"."promoted_seq" is not null;--> statement-breakpoint
CREATE INDEX "issue_session_inputs_pending_delivery_idx" ON "issue_session_inputs" USING btree ("session_id","delivery","promoted_seq","admitted_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_message_id_reservations_message_uq" ON "issue_session_message_id_reservations" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "issue_session_message_id_reservations_scope_ordinal_idx" ON "issue_session_message_id_reservations" USING btree ("session_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_messages_session_seq_uq" ON "issue_session_messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "issue_session_messages_session_type_seq_idx" ON "issue_session_messages" USING btree ("session_id","type","seq");--> statement-breakpoint
CREATE INDEX "issue_session_messages_session_model_state_seq_idx" ON "issue_session_messages" USING btree ("session_id","model_state_seq","seq");--> statement-breakpoint
CREATE INDEX "issue_session_messages_time_created_idx" ON "issue_session_messages" USING btree ("time_created");--> statement-breakpoint
CREATE INDEX "issue_session_messages_scope_run_idx" ON "issue_session_messages" USING btree ("company_id","issue_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_productive_turn_settlements_turn_uq" ON "issue_session_productive_turn_settlements" USING btree ("productive_run_id","provider_attempt","turn_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_productive_turn_settlements_assistant_uq" ON "issue_session_productive_turn_settlements" USING btree ("assistant_message_id") WHERE "issue_session_productive_turn_settlements"."assistant_message_id" is not null;--> statement-breakpoint
CREATE INDEX "issue_session_productive_turn_settlements_scope_settled_idx" ON "issue_session_productive_turn_settlements" USING btree ("company_id","issue_id","session_id","context_epoch","settled_at");--> statement-breakpoint
CREATE INDEX "issue_session_productive_turn_settlements_run_idx" ON "issue_session_productive_turn_settlements" USING btree ("company_id","productive_run_id","settled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_recovery_selection_members_message_uq" ON "issue_session_recovery_selection_members" USING btree ("selection_id","message_id") WHERE "issue_session_recovery_selection_members"."member_kind" = 'message';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_recovery_selection_members_comment_uq" ON "issue_session_recovery_selection_members" USING btree ("selection_id","comment_id") WHERE "issue_session_recovery_selection_members"."member_kind" = 'comment';--> statement-breakpoint
CREATE INDEX "issue_session_recovery_selection_members_order_idx" ON "issue_session_recovery_selection_members" USING btree ("selection_id","member_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_recovery_selections_identity_uq" ON "issue_session_recovery_selections" USING btree ("company_id","selection_identity_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_recovery_selections_active_source_uq" ON "issue_session_recovery_selections" USING btree ("company_id","issue_id","source_run_id","source_ref_ordinal","source_segment_ordinal") WHERE "issue_session_recovery_selections"."disposition" = 'active';--> statement-breakpoint
CREATE INDEX "issue_session_recovery_selections_active_scope_idx" ON "issue_session_recovery_selections" USING btree ("company_id","issue_id","ownership_epoch","target_agent_id","disposition","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_session_source_user_executions_message_uq" ON "issue_session_source_user_executions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "issue_session_source_user_executions_model_idx" ON "issue_session_source_user_executions" USING btree ("company_id","provider_id","model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_sessions_company_issue_uq" ON "issue_sessions" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_sessions_company_parent_idx" ON "issue_sessions" USING btree ("company_id","parent_session_id");--> statement-breakpoint
CREATE INDEX "issue_sessions_company_integrity_idx" ON "issue_sessions" USING btree ("company_id","integrity_state");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_tree_hold_members_hold_issue_uq" ON "issue_tree_hold_members" USING btree ("hold_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_tree_hold_members_company_issue_idx" ON "issue_tree_hold_members" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_tree_hold_members_hold_depth_idx" ON "issue_tree_hold_members" USING btree ("hold_id","depth");--> statement-breakpoint
CREATE INDEX "issue_tree_holds_company_root_status_idx" ON "issue_tree_holds" USING btree ("company_id","root_issue_id","status");--> statement-breakpoint
CREATE INDEX "issue_tree_holds_company_status_mode_idx" ON "issue_tree_holds" USING btree ("company_id","status","mode");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_updates_gateway_invocation_uq" ON "issue_updates" USING btree ("company_id","gateway_invocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_updates_run_sequence_uq" ON "issue_updates" USING btree ("company_id","run_id","run_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_updates_comment_uq" ON "issue_updates" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "issue_updates_issue_sequence_idx" ON "issue_updates" USING btree ("company_id","issue_id","ownership_epoch","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_watchdogs_company_issue_uq" ON "issue_watchdogs" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_watchdogs_company_status_idx" ON "issue_watchdogs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "issue_work_products_company_issue_type_idx" ON "issue_work_products" USING btree ("company_id","issue_id","type");--> statement-breakpoint
CREATE INDEX "issue_work_products_company_execution_workspace_type_idx" ON "issue_work_products" USING btree ("company_id","execution_workspace_id","type");--> statement-breakpoint
CREATE INDEX "issue_work_products_company_provider_external_id_idx" ON "issue_work_products" USING btree ("company_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "issue_work_products_company_updated_idx" ON "issue_work_products" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX "issues_company_status_idx" ON "issues" USING btree ("company_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX "issues_company_harness_kind_idx" ON "issues" USING btree ("company_id","harness_kind");--> statement-breakpoint
CREATE INDEX "issues_company_owner_status_idx" ON "issues" USING btree ("company_id","owner_agent_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX "issues_company_owner_user_status_idx" ON "issues" USING btree ("company_id","owner_user_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX "issues_company_responsible_user_idx" ON "issues" USING btree ("company_id","responsible_user_id");--> statement-breakpoint
CREATE INDEX "issues_company_parent_idx" ON "issues" USING btree ("company_id","parent_id");--> statement-breakpoint
CREATE INDEX "issues_company_project_idx" ON "issues" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "issues_company_origin_idx" ON "issues" USING btree ("company_id","origin_kind","origin_id");--> statement-breakpoint
CREATE INDEX "issues_company_project_workspace_idx" ON "issues" USING btree ("company_id","project_workspace_id");--> statement-breakpoint
CREATE INDEX "issues_company_monitor_due_idx" ON "issues" USING btree ("company_id","monitor_next_check_at");--> statement-breakpoint
CREATE INDEX "issues_company_updated_idx" ON "issues" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX "issues_company_created_idx" ON "issues" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "issues_open_normalized_title_created_idx" ON "issues" USING btree ("company_id","parent_id",lower(regexp_replace(btrim("title"), '\s+', ' ', 'g')),"created_at") WHERE "issues"."hidden_at" is null
          and "issues"."lifecycle_status" in ('open', 'blocked');--> statement-breakpoint
CREATE INDEX "issues_company_priority_idx" ON "issues" USING btree ("company_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_identifier_idx" ON "issues" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "issues_title_search_idx" ON "issues" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issues_identifier_search_idx" ON "issues" USING gin ("identifier" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issues_request_search_idx" ON "issues" USING gin ("request" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_invite_unique_idx" ON "join_requests" USING btree ("invite_id");--> statement-breakpoint
CREATE INDEX "join_requests_company_status_type_created_idx" ON "join_requests" USING btree ("company_id","status","request_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_pending_human_user_uq" ON "join_requests" USING btree ("company_id","requesting_user_id") WHERE "join_requests"."request_type" = 'human' AND "join_requests"."status" = 'pending_approval' AND "join_requests"."requesting_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_pending_human_email_uq" ON "join_requests" USING btree ("company_id",lower("request_email_snapshot")) WHERE "join_requests"."request_type" = 'human' AND "join_requests"."status" = 'pending_approval' AND "join_requests"."request_email_snapshot" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "labels_company_idx" ON "labels" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_company_name_idx" ON "labels" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_automation_executions_idempotency_uq" ON "pipeline_automation_executions" USING btree ("case_id","automation_id","triggering_event_id");--> statement-breakpoint
CREATE INDEX "pipeline_automation_executions_company_case_idx" ON "pipeline_automation_executions" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE INDEX "pipeline_automation_executions_routine_idx" ON "pipeline_automation_executions" USING btree ("routine_id");--> statement-breakpoint
CREATE INDEX "pipeline_automation_executions_execution_issue_idx" ON "pipeline_automation_executions" USING btree ("execution_issue_id");--> statement-breakpoint
CREATE INDEX "pipeline_automation_executions_retry_of_execution_idx" ON "pipeline_automation_executions" USING btree ("retry_of_execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_blockers_case_blocked_by_uq" ON "pipeline_case_blockers" USING btree ("case_id","blocked_by_case_id");--> statement-breakpoint
CREATE INDEX "pipeline_case_blockers_blocked_by_idx" ON "pipeline_case_blockers" USING btree ("blocked_by_case_id");--> statement-breakpoint
CREATE INDEX "pipeline_case_blockers_company_case_idx" ON "pipeline_case_blockers" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_documents_company_case_key_uq" ON "pipeline_case_documents" USING btree ("company_id","case_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_documents_document_uq" ON "pipeline_case_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "pipeline_case_documents_company_case_updated_idx" ON "pipeline_case_documents" USING btree ("company_id","case_id","updated_at");--> statement-breakpoint
CREATE INDEX "pipeline_case_events_case_created_idx" ON "pipeline_case_events" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "pipeline_case_events_company_case_idx" ON "pipeline_case_events" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_issue_links_case_issue_uq" ON "pipeline_case_issue_links" USING btree ("case_id","issue_id");--> statement-breakpoint
CREATE INDEX "pipeline_case_issue_links_issue_idx" ON "pipeline_case_issue_links" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "pipeline_case_issue_links_company_case_idx" ON "pipeline_case_issue_links" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE INDEX "pipeline_case_issue_links_automation_attempt_idx" ON "pipeline_case_issue_links" USING btree ("automation_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_cases_pipeline_case_key_uq" ON "pipeline_cases" USING btree ("pipeline_id","case_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_cases_parent_request_key_uq" ON "pipeline_cases" USING btree ("parent_case_id","request_key") WHERE "pipeline_cases"."request_key" is not null and "pipeline_cases"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "pipeline_cases_company_idx" ON "pipeline_cases" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "pipeline_cases_pipeline_stage_idx" ON "pipeline_cases" USING btree ("pipeline_id","stage_id");--> statement-breakpoint
CREATE INDEX "pipeline_cases_parent_idx" ON "pipeline_cases" USING btree ("parent_case_id");--> statement-breakpoint
CREATE INDEX "pipeline_cases_automation_attempt_idx" ON "pipeline_cases" USING btree ("automation_attempt_id");--> statement-breakpoint
CREATE INDEX "pipeline_cases_retired_idx" ON "pipeline_cases" USING btree ("company_id","retired_at");--> statement-breakpoint
CREATE INDEX "pipeline_cases_lease_expires_idx" ON "pipeline_cases" USING btree ("lease_expires_at") WHERE "pipeline_cases"."lease_expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_documents_company_pipeline_key_uq" ON "pipeline_documents" USING btree ("company_id","pipeline_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_documents_document_uq" ON "pipeline_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "pipeline_documents_company_pipeline_updated_idx" ON "pipeline_documents" USING btree ("company_id","pipeline_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_pipeline_key_uq" ON "pipeline_stages" USING btree ("pipeline_id","key");--> statement-breakpoint
CREATE INDEX "pipeline_stages_pipeline_position_idx" ON "pipeline_stages" USING btree ("pipeline_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_transitions_pipeline_edge_uq" ON "pipeline_transitions" USING btree ("pipeline_id","from_stage_id","to_stage_id");--> statement-breakpoint
CREATE INDEX "pipeline_transitions_pipeline_from_idx" ON "pipeline_transitions" USING btree ("pipeline_id","from_stage_id");--> statement-breakpoint
CREATE INDEX "pipeline_transitions_pipeline_to_idx" ON "pipeline_transitions" USING btree ("pipeline_id","to_stage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_company_key_uq" ON "pipelines" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "pipelines_company_idx" ON "pipelines" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "pipelines_company_project_idx" ON "pipelines" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "plugin_company_settings_company_idx" ON "plugin_company_settings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "plugin_company_settings_plugin_idx" ON "plugin_company_settings" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_company_settings_company_plugin_uq" ON "plugin_company_settings" USING btree ("company_id","plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_config_plugin_company_idx" ON "plugin_config" USING btree ("plugin_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_creator_deliveries_creator_delivery_uq" ON "plugin_creator_deliveries" USING btree ("creator_delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_creator_deliveries_delivery_id_uq" ON "plugin_creator_deliveries" USING btree ("delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_creator_deliveries_callback_sequence_uq" ON "plugin_creator_deliveries" USING btree ("plugin_installation_id","plugin_key","callback_key","callback_version","committed_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_creator_deliveries_idempotency_uq" ON "plugin_creator_deliveries" USING btree ("plugin_installation_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "plugin_creator_deliveries_claim_idx" ON "plugin_creator_deliveries" USING btree ("company_id","state","retry_at","lease_expires_at","first_queued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_database_namespaces_plugin_idx" ON "plugin_database_namespaces" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_database_namespaces_namespace_idx" ON "plugin_database_namespaces" USING btree ("namespace_name");--> statement-breakpoint
CREATE INDEX "plugin_database_namespaces_status_idx" ON "plugin_database_namespaces" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plugin_entities_plugin_idx" ON "plugin_entities" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_entities_company_idx" ON "plugin_entities" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "plugin_entities_type_idx" ON "plugin_entities" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "plugin_entities_scope_idx" ON "plugin_entities" USING btree ("scope_kind","scope_id");--> statement-breakpoint
CREATE INDEX "plugin_job_runs_job_idx" ON "plugin_job_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "plugin_job_runs_plugin_idx" ON "plugin_job_runs" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_job_runs_company_idx" ON "plugin_job_runs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "plugin_job_runs_status_idx" ON "plugin_job_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plugin_jobs_plugin_idx" ON "plugin_jobs" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_jobs_next_run_idx" ON "plugin_jobs" USING btree ("next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_jobs_unique_idx" ON "plugin_jobs" USING btree ("plugin_id","job_key");--> statement-breakpoint
CREATE INDEX "plugin_logs_plugin_time_idx" ON "plugin_logs" USING btree ("plugin_id","created_at");--> statement-breakpoint
CREATE INDEX "plugin_logs_company_idx" ON "plugin_logs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "plugin_logs_level_idx" ON "plugin_logs" USING btree ("level");--> statement-breakpoint
CREATE INDEX "plugin_managed_resources_company_idx" ON "plugin_managed_resources" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "plugin_managed_resources_plugin_idx" ON "plugin_managed_resources" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_managed_resources_resource_idx" ON "plugin_managed_resources" USING btree ("resource_kind","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_managed_resources_active_agent_binding_uq" ON "plugin_managed_resources" USING btree ("company_id","resource_id") WHERE "plugin_managed_resources"."resource_kind" = 'agent' and "plugin_managed_resources"."lifecycle_state" in ('active', 'triage_paused');--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_managed_resources_company_plugin_resource_uq" ON "plugin_managed_resources" USING btree ("company_id","plugin_id","resource_kind","resource_key");--> statement-breakpoint
CREATE INDEX "plugin_managed_resources_lifecycle_idx" ON "plugin_managed_resources" USING btree ("company_id","plugin_id","lifecycle_state");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_migrations_plugin_key_idx" ON "plugin_migrations" USING btree ("plugin_id","migration_key");--> statement-breakpoint
CREATE INDEX "plugin_migrations_plugin_idx" ON "plugin_migrations" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_migrations_status_idx" ON "plugin_migrations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plugin_run_contexts_capability_idx" ON "plugin_run_contexts" USING btree ("capability_connection_id","capability_generation");--> statement-breakpoint
CREATE INDEX "plugin_run_contexts_selection_installation_idx" ON "plugin_run_contexts" USING btree ("company_tool_selection_id","plugin_installation_id");--> statement-breakpoint
CREATE INDEX "plugin_state_plugin_scope_idx" ON "plugin_state" USING btree ("plugin_id","scope_kind");--> statement-breakpoint
CREATE INDEX "plugin_webhook_deliveries_plugin_idx" ON "plugin_webhook_deliveries" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_webhook_deliveries_company_idx" ON "plugin_webhook_deliveries" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "plugin_webhook_deliveries_status_idx" ON "plugin_webhook_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plugin_webhook_deliveries_key_idx" ON "plugin_webhook_deliveries" USING btree ("webhook_key");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_withdrawal_operations_rpc_uq" ON "plugin_withdrawal_operations" USING btree ("plugin_installation_id","host_rpc_operation_id");--> statement-breakpoint
CREATE INDEX "plugin_withdrawal_operations_issue_idx" ON "plugin_withdrawal_operations" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_plugin_key_idx" ON "plugins" USING btree ("plugin_key") WHERE "plugins"."status" <> 'uninstalled';--> statement-breakpoint
CREATE INDEX "plugins_status_idx" ON "plugins" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "principal_permission_grants_user_unique_idx" ON "principal_permission_grants" USING btree ("company_id","principal_user_id","permission_key") WHERE "principal_permission_grants"."principal_type" = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX "principal_permission_grants_agent_unique_idx" ON "principal_permission_grants" USING btree ("company_id","principal_agent_id","permission_key") WHERE "principal_permission_grants"."principal_type" = 'agent';--> statement-breakpoint
CREATE INDEX "principal_permission_grants_user_permission_idx" ON "principal_permission_grants" USING btree ("principal_user_id","permission_key");--> statement-breakpoint
CREATE INDEX "principal_permission_grants_agent_permission_idx" ON "principal_permission_grants" USING btree ("principal_agent_id","permission_key");--> statement-breakpoint
CREATE INDEX "principal_permission_grants_company_permission_idx" ON "principal_permission_grants" USING btree ("company_id","permission_key");--> statement-breakpoint
CREATE INDEX "project_goals_project_idx" ON "project_goals" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_goals_goal_idx" ON "project_goals" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "project_goals_company_idx" ON "project_goals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "project_memberships_company_user_idx" ON "project_memberships" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "project_memberships_company_user_starred_idx" ON "project_memberships" USING btree ("company_id","user_id","starred_at");--> statement-breakpoint
CREATE INDEX "project_memberships_project_idx" ON "project_memberships" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_memberships_company_user_project_uq" ON "project_memberships" USING btree ("company_id","user_id","project_id");--> statement-breakpoint
CREATE INDEX "project_workspaces_company_project_idx" ON "project_workspaces" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "project_workspaces_project_primary_idx" ON "project_workspaces" USING btree ("project_id","is_primary");--> statement-breakpoint
CREATE INDEX "project_workspaces_project_source_type_idx" ON "project_workspaces" USING btree ("project_id","source_type");--> statement-breakpoint
CREATE INDEX "project_workspaces_company_shared_key_idx" ON "project_workspaces" USING btree ("company_id","shared_workspace_key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_workspaces_project_remote_ref_idx" ON "project_workspaces" USING btree ("project_id","remote_provider","remote_workspace_ref");--> statement-breakpoint
CREATE INDEX "projects_company_idx" ON "projects" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_documents_company_routine_key_uq" ON "routine_documents" USING btree ("company_id","routine_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_documents_document_uq" ON "routine_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "routine_documents_company_routine_updated_idx" ON "routine_documents" USING btree ("company_id","routine_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_revisions_routine_revision_uq" ON "routine_revisions" USING btree ("routine_id","revision_number");--> statement-breakpoint
CREATE INDEX "routine_revisions_company_routine_created_idx" ON "routine_revisions" USING btree ("company_id","routine_id","created_at");--> statement-breakpoint
CREATE INDEX "routine_revisions_company_responsible_user_idx" ON "routine_revisions" USING btree ("company_id","responsible_user_id","created_at");--> statement-breakpoint
CREATE INDEX "routine_runs_company_routine_idx" ON "routine_runs" USING btree ("company_id","routine_id","created_at");--> statement-breakpoint
CREATE INDEX "routine_runs_revision_idx" ON "routine_runs" USING btree ("routine_revision_id");--> statement-breakpoint
CREATE INDEX "routine_runs_company_responsible_user_idx" ON "routine_runs" USING btree ("company_id","responsible_user_id","created_at");--> statement-breakpoint
CREATE INDEX "routine_runs_trigger_idx" ON "routine_runs" USING btree ("trigger_id","created_at");--> statement-breakpoint
CREATE INDEX "routine_runs_dispatch_fingerprint_idx" ON "routine_runs" USING btree ("routine_id","dispatch_fingerprint");--> statement-breakpoint
CREATE INDEX "routine_runs_linked_issue_idx" ON "routine_runs" USING btree ("linked_issue_id");--> statement-breakpoint
CREATE INDEX "routine_runs_trigger_idempotency_idx" ON "routine_runs" USING btree ("trigger_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "routine_triggers_company_routine_idx" ON "routine_triggers" USING btree ("company_id","routine_id");--> statement-breakpoint
CREATE INDEX "routine_triggers_company_kind_idx" ON "routine_triggers" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX "routine_triggers_next_run_idx" ON "routine_triggers" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "routine_triggers_public_id_idx" ON "routine_triggers" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_triggers_public_id_uq" ON "routine_triggers" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "routines_company_status_idx" ON "routines" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "routines_company_assignee_idx" ON "routines" USING btree ("company_id","assignee_agent_id");--> statement-breakpoint
CREATE INDEX "routines_company_project_idx" ON "routines" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "routines_company_folder_idx" ON "routines" USING btree ("company_id","folder_id");--> statement-breakpoint
CREATE INDEX "routines_company_responsible_user_idx" ON "routines" USING btree ("company_id","responsible_user_id");--> statement-breakpoint
CREATE INDEX "routines_company_origin_idx" ON "routines" USING btree ("company_id","origin_kind","origin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_interface_tool_calls_identity_uq" ON "run_interface_tool_calls" USING btree ("company_id","capability_connection_id","capability_generation","call_identity_source","call_identity_type","call_identity_value");--> statement-breakpoint
CREATE UNIQUE INDEX "run_interface_tool_calls_ingress_ordinal_uq" ON "run_interface_tool_calls" USING btree ("company_id","capability_connection_id","capability_generation","ingress_ordinal");--> statement-breakpoint
CREATE INDEX "run_interface_tool_calls_capability_status_idx" ON "run_interface_tool_calls" USING btree ("company_id","capability_connection_id","capability_generation","status");--> statement-breakpoint
CREATE INDEX "run_interface_tool_calls_mention_admission_idx" ON "run_interface_tool_calls" USING btree ("company_id","capability_connection_id","capability_generation","mention_target_agent_id","ingress_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_agent_configuration_audits_idempotency_uq" ON "runtime_agent_configuration_audits" USING btree ("company_id","idempotency_key") WHERE "runtime_agent_configuration_audits"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "runtime_agent_configuration_audits_agent_time_idx" ON "runtime_agent_configuration_audits" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_company_created_idx" ON "secret_access_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_secret_created_idx" ON "secret_access_events" USING btree ("secret_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_user_definition_created_idx" ON "secret_access_events" USING btree ("user_secret_definition_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_company_credential_owner_idx" ON "secret_access_events" USING btree ("company_id","credential_owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_consumer_idx" ON "secret_access_events" USING btree ("company_id","consumer_type","consumer_id");--> statement-breakpoint
CREATE INDEX "secret_access_events_run_idx" ON "secret_access_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "smoke_run_steps_company_run_idx" ON "smoke_run_steps" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "smoke_run_steps_company_path_idx" ON "smoke_run_steps" USING btree ("company_id","path");--> statement-breakpoint
CREATE INDEX "smoke_runs_company_started_idx" ON "smoke_runs" USING btree ("company_id","started_at");--> statement-breakpoint
CREATE INDEX "smoke_runs_company_status_idx" ON "smoke_runs" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "summary_slots_document_uq" ON "summary_slots" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "summary_slots_routine_uq" ON "summary_slots" USING btree ("routine_id");--> statement-breakpoint
CREATE INDEX "summary_slots_company_scope_idx" ON "summary_slots" USING btree ("company_id","scope_kind","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "summary_slots_generating_issue_uq" ON "summary_slots" USING btree ("generating_issue_id");--> statement-breakpoint
CREATE INDEX "summary_slots_company_updated_idx" ON "summary_slots" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "system_escalation_identities_affected_epoch_uq" ON "system_escalation_identities" USING btree ("company_id","affected_issue_id","affected_ownership_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "system_escalation_identities_escalation_issue_uq" ON "system_escalation_identities" USING btree ("company_id","escalation_issue_id");--> statement-breakpoint
CREATE INDEX "system_escalation_identities_source_idx" ON "system_escalation_identities" USING btree ("company_id","system_source","created_at");--> statement-breakpoint
CREATE INDEX "tool_access_audit_company_created_idx" ON "tool_access_audit_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_access_audit_connection_idx" ON "tool_access_audit_events" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "tool_access_audit_gateway_idx" ON "tool_access_audit_events" USING btree ("company_id","gateway_id");--> statement-breakpoint
CREATE INDEX "tool_action_requests_company_status_idx" ON "tool_action_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "tool_action_requests_invocation_idx" ON "tool_action_requests" USING btree ("invocation_id");--> statement-breakpoint
CREATE INDEX "tool_action_requests_issue_idx" ON "tool_action_requests" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_action_requests_company_dispatch_uq" ON "tool_action_requests" USING btree ("company_id","dispatch_idempotency_key");--> statement-breakpoint
CREATE INDEX "tool_applications_company_idx" ON "tool_applications" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tool_applications_company_status_idx" ON "tool_applications" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_applications_company_name_uq" ON "tool_applications" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_applications_company_key_uq" ON "tool_applications" USING btree ("company_id","application_key");--> statement-breakpoint
CREATE INDEX "tool_call_events_company_created_idx" ON "tool_call_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_call_events_run_idx" ON "tool_call_events" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "tool_call_events_issue_idx" ON "tool_call_events" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "tool_call_events_invocation_idx" ON "tool_call_events" USING btree ("invocation_id");--> statement-breakpoint
CREATE INDEX "tool_call_events_gateway_idx" ON "tool_call_events" USING btree ("company_id","gateway_id");--> statement-breakpoint
CREATE INDEX "tool_catalog_entries_company_idx" ON "tool_catalog_entries" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tool_catalog_entries_application_idx" ON "tool_catalog_entries" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "tool_catalog_entries_connection_idx" ON "tool_catalog_entries" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "tool_catalog_entries_company_status_idx" ON "tool_catalog_entries" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_catalog_entries_connection_name_uq" ON "tool_catalog_entries" USING btree ("connection_id","name");--> statement-breakpoint
CREATE INDEX "tool_connection_installs_company_target_idx" ON "tool_connection_installs" USING btree ("company_id","target_type","target_agent_id");--> statement-breakpoint
CREATE INDEX "tool_connection_installs_connection_idx" ON "tool_connection_installs" USING btree ("company_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_connection_installs_company_target_uq" ON "tool_connection_installs" USING btree ("company_id","connection_id") WHERE "tool_connection_installs"."target_type" = 'company';--> statement-breakpoint
CREATE UNIQUE INDEX "tool_connection_installs_agent_target_uq" ON "tool_connection_installs" USING btree ("company_id","connection_id","target_agent_id") WHERE "tool_connection_installs"."target_type" = 'agent';--> statement-breakpoint
CREATE INDEX "tool_connections_company_idx" ON "tool_connections" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tool_connections_application_idx" ON "tool_connections" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "tool_connections_company_enabled_idx" ON "tool_connections" USING btree ("company_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_connections_company_name_uq" ON "tool_connections" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_connections_company_uid_uq" ON "tool_connections" USING btree ("company_id","uid");--> statement-breakpoint
CREATE INDEX "tool_gateway_rate_limit_counters_company_idx" ON "tool_gateway_rate_limit_counters" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_gateway_rate_limit_counters_window_uq" ON "tool_gateway_rate_limit_counters" USING btree ("company_id","counter_key","window_start_at");--> statement-breakpoint
CREATE INDEX "tool_invocations_company_created_idx" ON "tool_invocations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_invocations_run_idx" ON "tool_invocations" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "tool_invocations_issue_idx" ON "tool_invocations" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "tool_invocations_gateway_idx" ON "tool_invocations" USING btree ("company_id","gateway_id");--> statement-breakpoint
CREATE INDEX "tool_invocations_run_interface_call_idx" ON "tool_invocations" USING btree ("company_id","run_interface_tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_invocations_company_idempotency_uq" ON "tool_invocations" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_mcp_gateway_tokens_token_hash_uq" ON "tool_mcp_gateway_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "tool_mcp_gateway_tokens_gateway_idx" ON "tool_mcp_gateway_tokens" USING btree ("company_id","gateway_id");--> statement-breakpoint
CREATE INDEX "tool_mcp_gateway_tokens_subject_idx" ON "tool_mcp_gateway_tokens" USING btree ("company_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "tool_mcp_gateway_tokens_company_expires_idx" ON "tool_mcp_gateway_tokens" USING btree ("company_id","expires_at");--> statement-breakpoint
CREATE INDEX "tool_mcp_gateways_company_idx" ON "tool_mcp_gateways" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tool_mcp_gateways_company_status_idx" ON "tool_mcp_gateways" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "tool_mcp_gateways_profile_idx" ON "tool_mcp_gateways" USING btree ("company_id","profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_mcp_gateways_public_id_uq" ON "tool_mcp_gateways" USING btree ("gateway_public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_mcp_gateways_company_slug_uq" ON "tool_mcp_gateways" USING btree ("company_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_mcp_gateways_company_name_uq" ON "tool_mcp_gateways" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "tool_oauth_states_company_idx" ON "tool_oauth_states" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tool_oauth_states_connection_idx" ON "tool_oauth_states" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "tool_oauth_states_actor_idx" ON "tool_oauth_states" USING btree ("created_by_actor_type","created_by_actor_id");--> statement-breakpoint
CREATE INDEX "tool_oauth_states_expires_at_idx" ON "tool_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tool_policies_company_enabled_idx" ON "tool_policies" USING btree ("company_id","enabled");--> statement-breakpoint
CREATE INDEX "tool_policies_company_type_idx" ON "tool_policies" USING btree ("company_id","policy_type");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_policies_company_name_uq" ON "tool_policies" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "tool_profile_bindings_company_target_idx" ON "tool_profile_bindings" USING btree ("company_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_profile_bindings_target_profile_uq" ON "tool_profile_bindings" USING btree ("company_id","target_type","target_id","profile_id");--> statement-breakpoint
CREATE INDEX "tool_profile_entries_company_profile_idx" ON "tool_profile_entries" USING btree ("company_id","profile_id");--> statement-breakpoint
CREATE INDEX "tool_profile_entries_application_idx" ON "tool_profile_entries" USING btree ("company_id","application_id");--> statement-breakpoint
CREATE INDEX "tool_profile_entries_connection_idx" ON "tool_profile_entries" USING btree ("company_id","connection_id");--> statement-breakpoint
CREATE INDEX "tool_profile_entries_catalog_entry_idx" ON "tool_profile_entries" USING btree ("company_id","catalog_entry_id");--> statement-breakpoint
CREATE INDEX "tool_profiles_company_status_idx" ON "tool_profiles" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_profiles_company_key_uq" ON "tool_profiles" USING btree ("company_id","profile_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_profiles_company_name_uq" ON "tool_profiles" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "tool_rate_limit_counters_company_idx" ON "tool_rate_limit_counters" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_rate_limit_counters_window_uq" ON "tool_rate_limit_counters" USING btree ("company_id","policy_id","counter_key","window_kind","window_start_at");--> statement-breakpoint
CREATE INDEX "tool_runtime_metric_counters_company_metric_idx" ON "tool_runtime_metric_counters" USING btree ("company_id","metric","bucket_start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_runtime_metric_counters_bucket_uq" ON "tool_runtime_metric_counters" USING btree ("company_id","metric","bucket_start_at");--> statement-breakpoint
CREATE INDEX "tool_runtime_slots_company_idx" ON "tool_runtime_slots" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tool_runtime_slots_connection_idx" ON "tool_runtime_slots" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "tool_runtime_slots_execution_workspace_idx" ON "tool_runtime_slots" USING btree ("company_id","execution_workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_runtime_slots_slot_key_uq" ON "tool_runtime_slots" USING btree ("company_id","slot_key");--> statement-breakpoint
CREATE INDEX "tool_stdio_command_templates_company_idx" ON "tool_stdio_command_templates" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tool_stdio_command_templates_company_status_idx" ON "tool_stdio_command_templates" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_stdio_command_templates_company_key_uq" ON "tool_stdio_command_templates" USING btree ("company_id","template_key");--> statement-breakpoint
CREATE UNIQUE INDEX "user_inbox_agent_policies_company_user_uq" ON "user_inbox_agent_policies" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "user_inbox_agent_policies_allowed_agent_ids_idx" ON "user_inbox_agent_policies" USING gin ("allowed_agent_ids");--> statement-breakpoint
CREATE INDEX "user_secret_declarations_company_idx" ON "user_secret_declarations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "user_secret_declarations_definition_idx" ON "user_secret_declarations" USING btree ("user_secret_definition_id");--> statement-breakpoint
CREATE INDEX "user_secret_declarations_target_idx" ON "user_secret_declarations" USING btree ("company_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "user_secret_declarations_company_required_idx" ON "user_secret_declarations" USING btree ("company_id","required");--> statement-breakpoint
CREATE UNIQUE INDEX "user_secret_declarations_target_path_uq" ON "user_secret_declarations" USING btree ("company_id","target_type","target_id","config_path");--> statement-breakpoint
CREATE INDEX "user_secret_declarations_required_override_idx" ON "user_secret_declarations" USING btree ("company_id","allow_missing_override") WHERE "user_secret_declarations"."allow_missing_override" = true;--> statement-breakpoint
CREATE INDEX "user_secret_definitions_company_status_idx" ON "user_secret_definitions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "user_secret_definitions_company_provider_idx" ON "user_secret_definitions" USING btree ("company_id","provider");--> statement-breakpoint
CREATE INDEX "user_secret_definitions_provider_config_idx" ON "user_secret_definitions" USING btree ("provider_config_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_secret_definitions_company_key_uq" ON "user_secret_definitions" USING btree ("company_id","key") WHERE "user_secret_definitions"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_sidebar_preferences_user_uq" ON "user_sidebar_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workspace_operations_company_run_started_idx" ON "workspace_operations" USING btree ("company_id","run_id","started_at");--> statement-breakpoint
CREATE INDEX "workspace_operations_company_workspace_started_idx" ON "workspace_operations" USING btree ("company_id","execution_workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "workspace_operations_company_workspace_issue_started_idx" ON "workspace_operations" USING btree ("company_id","execution_workspace_id","issue_id","started_at");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_company_workspace_status_idx" ON "workspace_runtime_services" USING btree ("company_id","project_workspace_id","status");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_company_execution_workspace_status_idx" ON "workspace_runtime_services" USING btree ("company_id","execution_workspace_id","status");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_company_project_status_idx" ON "workspace_runtime_services" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_run_idx" ON "workspace_runtime_services" USING btree ("started_by_run_id");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_company_updated_idx" ON "workspace_runtime_services" USING btree ("company_id","updated_at");