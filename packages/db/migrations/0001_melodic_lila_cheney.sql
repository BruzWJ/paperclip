CREATE TABLE "acp_prompt_accounting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"run_kind" text NOT NULL,
	"prompt_kind" text NOT NULL,
	"ref_id" uuid,
	"run_ordinal" integer,
	"segment_ordinal" integer,
	"attempt_id" uuid NOT NULL,
	"adapter_config_revision_id" uuid NOT NULL,
	"selected_model_id" text,
	"context_token_limit" bigint NOT NULL,
	"context_used_tokens" bigint NOT NULL,
	"context_window_tokens" bigint NOT NULL,
	"prompt_settlement_reference_id" uuid NOT NULL,
	"terminal_usage_reference" text NOT NULL,
	"terminal_stop_reference" text NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acp_prompt_accounting_scope_id_uq" UNIQUE("company_id","task_id","run_id","id"),
	CONSTRAINT "acp_prompt_accounting_common_attribution_uq" UNIQUE("company_id","task_id","agent_id","run_id","run_kind","id"),
	CONSTRAINT "acp_prompt_accounting_productive_cost_attribution_uq" UNIQUE("company_id","task_id","agent_id","run_id","run_kind","ref_id","run_ordinal","segment_ordinal","id"),
	CONSTRAINT "acp_prompt_accounting_prompt_identity_check" CHECK ((
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
      )),
	CONSTRAINT "acp_prompt_accounting_context_occupancy_check" CHECK ("acp_prompt_accounting"."context_used_tokens" >= 0
        and "acp_prompt_accounting"."context_window_tokens" > 0
        and "acp_prompt_accounting"."context_token_limit" > 0
        and "acp_prompt_accounting"."context_used_tokens" <= "acp_prompt_accounting"."context_window_tokens"
        and "acp_prompt_accounting"."context_window_tokens" = "acp_prompt_accounting"."context_token_limit"),
	CONSTRAINT "acp_prompt_accounting_references_check" CHECK ((
          "acp_prompt_accounting"."selected_model_id" is null
          or length(btrim("acp_prompt_accounting"."selected_model_id")) between 1 and 500
        )
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
        'task_create',
        'mention_board',
        'agent_hire',
        'agent_configure',
        'list_all_agents',
        'list_parent_agents'
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
	"normalized_config" jsonb NOT NULL,
	"runtime_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acp_configuration" jsonb NOT NULL,
	"digest" text NOT NULL,
	"parent_revision_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_adapter_config_revisions_scope_id_uq" UNIQUE("company_id","agent_id","id"),
	CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check" CHECK (
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
        and "agent_adapter_config_revisions"."acp_configuration" #>> '{workspaceSelector,kind}' = 'task_execution_workspace'
        and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" -> 'companySkillPins') = 'array'
      )
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
        'read_task_comments',
        'read_task_agent_run',
        'list_sub_tasks',
        'read_sub_task_comments',
        'read_sub_task_agent_run',
        'list_company_tasks',
        'read_company_task_comments',
        'read_company_task_agent_run'
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
	"budget_monthly_amount" numeric NOT NULL,
	"pause_reason" text,
	"paused_at" timestamp with time zone,
	"error_reason" text,
	"instruction" text,
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
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"pause_reason" text,
	"paused_at" timestamp with time zone,
	"task_prefix" text DEFAULT 'PAP' NOT NULL,
	"task_counter" integer DEFAULT 0 NOT NULL,
	"budget_currency" text NOT NULL,
	"budget_monthly_amount" numeric NOT NULL,
	"attachment_max_bytes" integer DEFAULT 10485760 NOT NULL,
	"default_responsible_user_id" text,
	"require_board_approval_for_new_agents" boolean DEFAULT false NOT NULL,
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
	"task_id" uuid NOT NULL,
	"template_id" text,
	"template_name" text,
	"template_body" text,
	"rendered_template_body" text,
	"harness_task_request" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"output_document_key" text DEFAULT 'output' NOT NULL,
	"output_snapshot" text DEFAULT '' NOT NULL,
	"error" text,
	"deleted_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"harness_task_expires_at" timestamp with time zone,
	"harness_task_deleted_at" timestamp with time zone,
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
CREATE TABLE "cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accounting_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"run_kind" text NOT NULL,
	"prompt_kind" text NOT NULL,
	"ref_id" uuid,
	"run_ordinal" integer,
	"segment_ordinal" integer,
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
	CONSTRAINT "cost_events_prompt_identity_check" CHECK ((
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
      ))
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
	"task_id" uuid,
	"routine_id" uuid,
	"document_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_type" text NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"created_by_run_id" uuid,
	"task_comment_id" uuid,
	"source_trust" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_annotation_comments_exactly_one_owner_chk" CHECK (num_nonnulls("document_annotation_comments"."task_id", "document_annotation_comments"."routine_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "document_annotation_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid,
	"routine_id" uuid,
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
	CONSTRAINT "document_annotation_threads_exactly_one_owner_chk" CHECK (num_nonnulls("document_annotation_threads"."task_id", "document_annotation_threads"."routine_id") = 1)
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
	"source_task_comment_id" uuid,
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
CREATE TABLE "execution_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"project_workspace_id" uuid,
	"cwd" text NOT NULL,
	"repo_url" text,
	"branch_name" text,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_workspaces_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "finance_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"task_id" uuid,
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
	"level" text DEFAULT 'task' NOT NULL,
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
	"general" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "local_execution_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"execution_workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
CREATE TABLE "plugin_company_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_database_namespaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"namespace_name" text NOT NULL,
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
	CONSTRAINT "plugin_entities_external_idx" UNIQUE NULLS NOT DISTINCT("company_id","plugin_id","entity_type","scope_kind","scope_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"duration_ms" integer,
	"error" text,
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
	"webhook_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_ms" integer,
	"error" text,
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
	"task_id" uuid NOT NULL,
	"message" text NOT NULL,
	"state" text NOT NULL,
	"result" jsonb,
	"task_update_id" uuid,
	"mutation_comment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "plugin_withdrawal_operations_command_source_uq" UNIQUE("company_id","task_id","id","plugin_installation_id","plugin_key","task_update_id"),
	CONSTRAINT "plugin_withdrawal_operations_state_check" CHECK ("plugin_withdrawal_operations"."state" in ('pending', 'accepted', 'rejected')),
	CONSTRAINT "plugin_withdrawal_operations_result_check" CHECK ((
        "plugin_withdrawal_operations"."state" = 'pending'
        and "plugin_withdrawal_operations"."result" is null
        and "plugin_withdrawal_operations"."task_update_id" is null
        and "plugin_withdrawal_operations"."mutation_comment_id" is null
        and "plugin_withdrawal_operations"."completed_at" is null
      ) or (
        "plugin_withdrawal_operations"."state" = 'accepted'
        and "plugin_withdrawal_operations"."result" is not null
        and "plugin_withdrawal_operations"."task_update_id" is not null
        and "plugin_withdrawal_operations"."mutation_comment_id" is not null
        and "plugin_withdrawal_operations"."completed_at" is not null
      ) or (
        "plugin_withdrawal_operations"."state" = 'rejected'
        and "plugin_withdrawal_operations"."result" is not null
        and "plugin_withdrawal_operations"."task_update_id" is null
        and "plugin_withdrawal_operations"."mutation_comment_id" is null
        and "plugin_withdrawal_operations"."completed_at" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_key" text NOT NULL,
	"package_name" text NOT NULL,
	"source" text NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"install_order" integer NOT NULL,
	"package_path" text NOT NULL,
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
	"cwd" text,
	"repo_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
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
	"linked_task_id" uuid,
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
	"parent_task_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"assignee_agent_id" uuid,
	"priority" text DEFAULT 'medium' NOT NULL,
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"plugin_installation_id" uuid,
	"arguments_digest" text NOT NULL,
	"classification" text DEFAULT 'unclassified' NOT NULL,
	"mention_target_agent_id" uuid,
	"classified_at" timestamp with time zone,
	"status" text NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_interface_tool_calls_plugin_binding_uq" UNIQUE("capability_connection_id","capability_generation","id","plugin_installation_id"),
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
        and "run_interface_tool_calls"."classified_at" is null
      ) or (
        "run_interface_tool_calls"."classification" in ('non_mention', 'terminal_invalid')
        and "run_interface_tool_calls"."mention_target_agent_id" is null
        and "run_interface_tool_calls"."classified_at" is not null
      ) or (
        "run_interface_tool_calls"."classification" = 'validated_mention'
        and "run_interface_tool_calls"."mention_target_agent_id" is not null
        and "run_interface_tool_calls"."classified_at" is not null
      )),
	CONSTRAINT "run_interface_tool_calls_status_check" CHECK ((
        "run_interface_tool_calls"."status" = 'executing'
        and "run_interface_tool_calls"."classification" <> 'terminal_invalid'
        and "run_interface_tool_calls"."error" is null
        and "run_interface_tool_calls"."completed_at" is null
      ) or (
        "run_interface_tool_calls"."status" = 'completed'
        and "run_interface_tool_calls"."classification" in ('non_mention', 'validated_mention')
        and "run_interface_tool_calls"."error" is null
        and "run_interface_tool_calls"."completed_at" is not null
      ) or (
        "run_interface_tool_calls"."status" = 'failed'
        and "run_interface_tool_calls"."classification" <> 'unclassified'
        and "run_interface_tool_calls"."error" is not null
        and "run_interface_tool_calls"."completed_at" is not null
      ))
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
	"task_execution_ref_id" uuid,
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
          and "runtime_agent_configuration_audits"."task_execution_ref_id" is null
        ) or (
          "runtime_agent_configuration_audits"."actor_kind" = 'agent'
          and "runtime_agent_configuration_audits"."actor_agent_id" is not null
          and "runtime_agent_configuration_audits"."actor_user_id" is null
          and "runtime_agent_configuration_audits"."actor_plugin_installation_id" is null
          and "runtime_agent_configuration_audits"."run_id" is not null
          and "runtime_agent_configuration_audits"."task_execution_ref_id" is not null
        ) or (
          "runtime_agent_configuration_audits"."actor_kind" = 'plugin'
          and "runtime_agent_configuration_audits"."actor_agent_id" is null
          and "runtime_agent_configuration_audits"."actor_user_id" is null
          and "runtime_agent_configuration_audits"."actor_plugin_installation_id" is not null
          and "runtime_agent_configuration_audits"."run_id" is null
          and "runtime_agent_configuration_audits"."task_execution_ref_id" is null
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
	"task_id" uuid,
	"run_id" uuid,
	"plugin_id" uuid,
	"outcome" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_escalation_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"affected_task_id" uuid NOT NULL,
	"affected_ownership_epoch" integer NOT NULL,
	"escalation_task_id" uuid NOT NULL,
	"system_source" text NOT NULL,
	"triggering_run_id" uuid,
	"terminal_creator_edge_id" uuid NOT NULL,
	"immutable_source" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_escalation_identities_command_source_uq" UNIQUE("company_id","escalation_task_id","id"),
	CONSTRAINT "system_escalation_identities_source_check" CHECK ("system_escalation_identities"."system_source" in ('recovery', 'liveness')),
	CONSTRAINT "system_escalation_identities_distinct_task_check" CHECK ("system_escalation_identities"."affected_task_id" <> "system_escalation_identities"."escalation_task_id")
);
--> statement-breakpoint
CREATE TABLE "task_approvals" (
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"linked_by_agent_id" uuid,
	"linked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_approvals_pk" PRIMARY KEY("task_id","approval_id")
);
--> statement-breakpoint
CREATE TABLE "task_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"task_comment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_board_lifecycle_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"actor_user_id" text NOT NULL,
	"subtype" text NOT NULL,
	"source_command_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_board_lifecycle_commands_source_task_uq" UNIQUE("company_id","task_id","source_command_id"),
	CONSTRAINT "task_board_lifecycle_commands_idempotency_task_uq" UNIQUE("company_id","task_id","idempotency_key"),
	CONSTRAINT "task_board_lifecycle_commands_epoch_check" CHECK ("task_board_lifecycle_commands"."ownership_epoch" > 0),
	CONSTRAINT "task_board_lifecycle_commands_actor_check" CHECK (length(btrim("task_board_lifecycle_commands"."actor_user_id")) > 0),
	CONSTRAINT "task_board_lifecycle_commands_subtype_check" CHECK ("task_board_lifecycle_commands"."subtype" in (
        'execution_policy_configure',
        'execution_policy_decision',
        'tree_control_pause',
        'tree_control_resume',
        'tree_control_cancel',
        'tree_control_restore',
        'tree_control_release'
      )),
	CONSTRAINT "task_board_lifecycle_commands_idempotency_check" CHECK (length(btrim("task_board_lifecycle_commands"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "task_board_mentions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"comment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_board_mentions_epoch_check" CHECK ("task_board_mentions"."ownership_epoch" > 0)
);
--> statement-breakpoint
CREATE TABLE "task_board_reopen_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	CONSTRAINT "task_board_reopen_commands_actor_check" CHECK (length(btrim("task_board_reopen_commands"."actor_user_id")) > 0),
	CONSTRAINT "task_board_reopen_commands_reason_check" CHECK (length(btrim("task_board_reopen_commands"."reason")) > 0),
	CONSTRAINT "task_board_reopen_commands_prior_status_check" CHECK ("task_board_reopen_commands"."prior_status" in ('done', 'cancelled')),
	CONSTRAINT "task_board_reopen_commands_epoch_check" CHECK ("task_board_reopen_commands"."ownership_epoch" > 0
        and "task_board_reopen_commands"."continuity_fence_generation" > 0),
	CONSTRAINT "task_board_reopen_commands_branch_check" CHECK ((
        "task_board_reopen_commands"."branch" = 'agent_execution'
        and "task_board_reopen_commands"."preserved_owner_kind" = 'agent'
        and "task_board_reopen_commands"."execution_ref_id" is not null
        and "task_board_reopen_commands"."system_escalation_identity_id" is null
      ) or (
        "task_board_reopen_commands"."branch" = 'board_only'
        and "task_board_reopen_commands"."preserved_owner_kind" in ('user', 'board')
        and "task_board_reopen_commands"."execution_ref_id" is null
        and "task_board_reopen_commands"."system_escalation_identity_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "task_board_user_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"actor_user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"identity_digest" text NOT NULL,
	"mention_target_agent_id" uuid,
	"comment_id" uuid NOT NULL,
	"execution_ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_board_user_comments_actor_check" CHECK (length(btrim("task_board_user_comments"."actor_user_id")) > 0),
	CONSTRAINT "task_board_user_comments_epoch_check" CHECK ("task_board_user_comments"."ownership_epoch" > 0),
	CONSTRAINT "task_board_user_comments_mention_shape_check" CHECK ((
        "task_board_user_comments"."mention_target_agent_id" is null
        and "task_board_user_comments"."execution_ref_id" is null
      ) or (
        "task_board_user_comments"."mention_target_agent_id" is not null
        and "task_board_user_comments"."execution_ref_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "task_comment_projection_sources" (
	"comment_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	CONSTRAINT "task_comment_projection_sources_kind_check" CHECK ("task_comment_projection_sources"."source_kind" in (
        'task_request',
        'human_comment',
        'harness_delivery',
        'system_control',
        'run_output',
        'run_progress',
        'task_update',
        'plugin_withdrawal'
      )),
	CONSTRAINT "task_comment_projection_sources_run_check" CHECK ((
        "task_comment_projection_sources"."source_kind" in ('run_output', 'run_progress')
        and "task_comment_projection_sources"."run_id" is not null
      ) or (
        "task_comment_projection_sources"."source_kind" not in ('run_output', 'run_progress')
      )),
	CONSTRAINT "task_comment_projection_sources_reply_shape_check" CHECK ((
        "task_comment_projection_sources"."reply_to_comment_id" is null
        and "task_comment_projection_sources"."reply_to_projected_event_seq" is null
        and "task_comment_projection_sources"."thread_root_comment_id" is null
        and "task_comment_projection_sources"."thread_root_projected_event_seq" is null
      ) or (
        "task_comment_projection_sources"."reply_to_comment_id" is not null
        and "task_comment_projection_sources"."reply_to_projected_event_seq" is not null
        and "task_comment_projection_sources"."thread_root_comment_id" is not null
        and "task_comment_projection_sources"."thread_root_projected_event_seq" is not null
      )),
	CONSTRAINT "task_comment_projection_sources_reply_order_check" CHECK ("task_comment_projection_sources"."reply_to_projected_event_seq" is null
        or "task_comment_projection_sources"."reply_to_projected_event_seq" < "task_comment_projection_sources"."projected_event_seq"),
	CONSTRAINT "task_comment_projection_sources_steering_segment_shape_check" CHECK ((
        "task_comment_projection_sources"."steering_target_run_id" is null
        and "task_comment_projection_sources"."ref_id" is null
        and "task_comment_projection_sources"."ref_ordinal" is null
        and "task_comment_projection_sources"."segment_ordinal" is null
      ) or (
        "task_comment_projection_sources"."steering_target_run_id" is not null
        and "task_comment_projection_sources"."ref_id" is not null
        and "task_comment_projection_sources"."ref_ordinal" is not null
        and "task_comment_projection_sources"."ref_ordinal" >= 0
        and "task_comment_projection_sources"."segment_ordinal" is not null
        and "task_comment_projection_sources"."segment_ordinal" > 0
      )),
	CONSTRAINT "task_comment_projection_sources_terminal_dependency_check" CHECK ("task_comment_projection_sources"."terminal_session_message_id" is null
        or "task_comment_projection_sources"."source_kind" = 'run_progress'),
	CONSTRAINT "task_comment_projection_sources_sequence_check" CHECK (("task_comment_projection_sources"."admitted_event_seq" is null
          or "task_comment_projection_sources"."projected_event_seq" = "task_comment_projection_sources"."admitted_event_seq")
        and (
          "task_comment_projection_sources"."promoted_event_seq" is null
          or "task_comment_projection_sources"."admitted_event_seq" is null
          or "task_comment_projection_sources"."promoted_event_seq" >= "task_comment_projection_sources"."admitted_event_seq"
        ))
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	CONSTRAINT "task_comments_projected_identity_uq" UNIQUE("company_id","task_id","id","projected_event_seq"),
	CONSTRAINT "task_comments_scope_identity_uq" UNIQUE("company_id","task_id","id"),
	CONSTRAINT "task_comments_run_identity_uq" UNIQUE("company_id","task_id","run_id","id"),
	CONSTRAINT "task_comments_reply_identity_uq" UNIQUE("company_id","task_id","id","reply_to_comment_id"),
	CONSTRAINT "task_comments_canonical_source_kind_check" CHECK ("task_comments"."canonical_source_kind" in (
        'task_request',
        'human_comment',
        'harness_delivery',
        'system_control',
        'run_output',
        'run_progress',
        'task_update',
        'plugin_withdrawal'
      )),
	CONSTRAINT "task_comments_author_shape_check" CHECK ((
        "task_comments"."author_type" = 'agent'
        and "task_comments"."author_agent_id" is not null
        and "task_comments"."author_user_id" is null
        and "task_comments"."author_plugin_installation_id" is null
        and "task_comments"."author_plugin_key" is null
      ) or (
        "task_comments"."author_type" = 'user'
        and "task_comments"."author_agent_id" is null
        and "task_comments"."author_user_id" is not null
        and "task_comments"."author_plugin_installation_id" is null
        and "task_comments"."author_plugin_key" is null
      ) or (
        "task_comments"."author_type" = 'plugin'
        and "task_comments"."author_agent_id" is null
        and "task_comments"."author_user_id" is null
        and "task_comments"."author_plugin_installation_id" is not null
        and "task_comments"."author_plugin_key" is not null
      ) or (
        "task_comments"."author_type" = 'system'
        and "task_comments"."author_agent_id" is null
        and "task_comments"."author_user_id" is null
        and "task_comments"."author_plugin_installation_id" is null
        and "task_comments"."author_plugin_key" is null
      )),
	CONSTRAINT "task_comments_run_shape_check" CHECK ((
        "task_comments"."author_type" = 'agent'
        and "task_comments"."run_id" is not null
      ) or (
        "task_comments"."author_type" in ('user', 'plugin', 'system')
        and "task_comments"."run_id" is null
      )),
	CONSTRAINT "task_comments_reply_shape_check" CHECK ((
        "task_comments"."reply_to_comment_id" is null
        and "task_comments"."reply_to_projected_event_seq" is null
        and "task_comments"."thread_root_comment_id" is null
        and "task_comments"."thread_root_projected_event_seq" is null
      ) or (
        "task_comments"."reply_to_comment_id" is not null
        and "task_comments"."reply_to_projected_event_seq" is not null
        and "task_comments"."thread_root_comment_id" is not null
        and "task_comments"."thread_root_projected_event_seq" is not null
      )),
	CONSTRAINT "task_comments_reply_order_check" CHECK ("task_comments"."reply_to_projected_event_seq" is null
        or "task_comments"."reply_to_projected_event_seq" < "task_comments"."projected_event_seq"),
	CONSTRAINT "task_comments_canonical_projection_sequence_check" CHECK ("task_comments"."projected_event_seq" = "task_comments"."admitted_event_seq"
        and (
          "task_comments"."promoted_event_seq" is null
          or "task_comments"."promoted_event_seq" >= "task_comments"."admitted_event_seq"
        ))
);
--> statement-breakpoint
CREATE TABLE "task_consult_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	CONSTRAINT "task_consult_executions_scope_id_uq" UNIQUE("company_id","task_id","session_id","id"),
	CONSTRAINT "task_consult_executions_lane_identity_uq" UNIQUE("company_id","task_id","ownership_epoch","target_agent_id","id"),
	CONSTRAINT "task_consult_executions_state_check" CHECK ("task_consult_executions"."state" in ('active', 'completed', 'cancelled', 'revoked')),
	CONSTRAINT "task_consult_executions_close_check" CHECK ((
        "task_consult_executions"."state" = 'active'
        and "task_consult_executions"."closed_at" is null
        and "task_consult_executions"."close_reason" is null
      ) or (
        "task_consult_executions"."state" <> 'active'
        and "task_consult_executions"."closed_at" is not null
        and "task_consult_executions"."close_reason" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "task_create_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_creator_edge_receivability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	CONSTRAINT "task_creator_edge_receivability_scope_id_uq" UNIQUE("company_id","task_id","ownership_epoch","id"),
	CONSTRAINT "task_creator_edge_receivability_admission_identity_uq" UNIQUE("company_id","task_id","ownership_epoch","id","admission_version"),
	CONSTRAINT "task_creator_edge_receivability_epoch_uq" UNIQUE("company_id","task_id","ownership_epoch"),
	CONSTRAINT "task_creator_edge_receivability_creator_kind_check" CHECK ("task_creator_edge_receivability"."creator_kind" in ('agent-execution', 'user/board', 'plugin', 'routine', 'system')),
	CONSTRAINT "task_creator_edge_receivability_endpoint_kind_check" CHECK ("task_creator_edge_receivability"."endpoint_kind" in ('agent-execution', 'user/board', 'plugin', 'routine', 'system')
        and "task_creator_edge_receivability"."endpoint_kind" = "task_creator_edge_receivability"."creator_kind"),
	CONSTRAINT "task_creator_edge_receivability_state_check" CHECK ("task_creator_edge_receivability"."state" in ('receivable', 'terminal')),
	CONSTRAINT "task_creator_edge_receivability_admission_version_check" CHECK ("task_creator_edge_receivability"."admission_version" > 0),
	CONSTRAINT "task_creator_edge_receivability_terminal_check" CHECK ((
        "task_creator_edge_receivability"."state" = 'receivable'
        and "task_creator_edge_receivability"."terminal_reason" is null
        and "task_creator_edge_receivability"."terminalized_at" is null
      ) or (
        "task_creator_edge_receivability"."state" = 'terminal'
        and "task_creator_edge_receivability"."terminal_reason" is not null
        and "task_creator_edge_receivability"."terminal_source_kind" is not null
        and "task_creator_edge_receivability"."terminal_source_id" is not null
        and "task_creator_edge_receivability"."terminalized_at" is not null
      )),
	CONSTRAINT "task_creator_edge_receivability_terminal_reason_check" CHECK ("task_creator_edge_receivability"."terminal_reason" is null or "task_creator_edge_receivability"."terminal_reason" in (
        'creator_execution_superseded',
        'agent_terminated',
        'agent_deleted',
        'plugin_disabled',
        'plugin_uninstalled',
        'routine_deleted'
      ))
);
--> statement-breakpoint
CREATE TABLE "task_creator_withdrawal_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"outgoing_ownership_epoch" integer NOT NULL,
	"resulting_ownership_epoch" integer NOT NULL,
	"resulting_creator_edge_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"actor_plugin_installation_id" uuid,
	"actor_plugin_key" text,
	"plugin_withdrawal_operation_id" uuid,
	"task_update_id" uuid,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_creator_withdrawal_commands_epoch_uq" UNIQUE("company_id","task_id","outgoing_ownership_epoch"),
	CONSTRAINT "task_creator_withdrawal_commands_epoch_check" CHECK ("task_creator_withdrawal_commands"."outgoing_ownership_epoch" > 0
        and "task_creator_withdrawal_commands"."resulting_ownership_epoch" =
          "task_creator_withdrawal_commands"."outgoing_ownership_epoch" + 1),
	CONSTRAINT "task_creator_withdrawal_commands_actor_check" CHECK ((
        "task_creator_withdrawal_commands"."actor_kind" = 'user'
        and "task_creator_withdrawal_commands"."actor_user_id" is not null
        and "task_creator_withdrawal_commands"."resulting_creator_edge_id" is not null
        and "task_creator_withdrawal_commands"."actor_plugin_installation_id" is null
        and "task_creator_withdrawal_commands"."actor_plugin_key" is null
        and "task_creator_withdrawal_commands"."plugin_withdrawal_operation_id" is null
        and "task_creator_withdrawal_commands"."task_update_id" is null
      ) or (
        "task_creator_withdrawal_commands"."actor_kind" = 'plugin'
        and "task_creator_withdrawal_commands"."actor_user_id" is null
        and "task_creator_withdrawal_commands"."resulting_creator_edge_id" is null
        and "task_creator_withdrawal_commands"."actor_plugin_installation_id" is not null
        and "task_creator_withdrawal_commands"."actor_plugin_key" is not null
        and length(btrim("task_creator_withdrawal_commands"."actor_plugin_key")) > 0
        and "task_creator_withdrawal_commands"."plugin_withdrawal_operation_id" is not null
        and "task_creator_withdrawal_commands"."task_update_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "task_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_execution_attempt_retry_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"predecessor_attempt_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"retry_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"successor_attempt_id" uuid,
	"claimed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_execution_attempt_retry_schedules_predecessor_uq" UNIQUE("predecessor_attempt_id"),
	CONSTRAINT "task_execution_attempt_retry_schedules_successor_uq" UNIQUE("successor_attempt_id"),
	CONSTRAINT "task_execution_attempt_retry_schedules_scope_id_uq" UNIQUE("company_id","task_id","run_id","id"),
	CONSTRAINT "task_execution_attempt_retry_schedules_reason_check" CHECK (length(btrim("task_execution_attempt_retry_schedules"."reason_code")) between 1 and 200),
	CONSTRAINT "task_execution_attempt_retry_schedules_state_check" CHECK ("task_execution_attempt_retry_schedules"."state" in ('scheduled', 'claimed', 'cancelled')),
	CONSTRAINT "task_execution_attempt_retry_schedules_state_time_check" CHECK ((
        "task_execution_attempt_retry_schedules"."state" = 'scheduled'
        and "task_execution_attempt_retry_schedules"."successor_attempt_id" is null
        and "task_execution_attempt_retry_schedules"."claimed_at" is null
        and "task_execution_attempt_retry_schedules"."cancelled_at" is null
      ) or (
        "task_execution_attempt_retry_schedules"."state" = 'claimed'
        and "task_execution_attempt_retry_schedules"."successor_attempt_id" is not null
        and "task_execution_attempt_retry_schedules"."claimed_at" is not null
        and "task_execution_attempt_retry_schedules"."cancelled_at" is null
      ) or (
        "task_execution_attempt_retry_schedules"."state" = 'cancelled'
        and "task_execution_attempt_retry_schedules"."successor_attempt_id" is null
        and "task_execution_attempt_retry_schedules"."claimed_at" is null
        and "task_execution_attempt_retry_schedules"."cancelled_at" is not null
      )),
	CONSTRAINT "task_execution_attempt_retry_schedules_time_check" CHECK ("task_execution_attempt_retry_schedules"."retry_at" >= "task_execution_attempt_retry_schedules"."created_at"
        and (
          "task_execution_attempt_retry_schedules"."claimed_at" is null
          or "task_execution_attempt_retry_schedules"."claimed_at" >= "task_execution_attempt_retry_schedules"."created_at"
        )
        and (
          "task_execution_attempt_retry_schedules"."cancelled_at" is null
          or "task_execution_attempt_retry_schedules"."cancelled_at" >= "task_execution_attempt_retry_schedules"."created_at"
        ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"run_kind" text NOT NULL,
	"prompt_kind" text NOT NULL,
	"session_operation" text NOT NULL,
	"ref_id" uuid,
	"ref_ordinal" integer,
	"segment_ordinal" integer,
	"steering_segment_ordinal" integer,
	"attempt_generation" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_execution_attempts_scope_id_uq" UNIQUE("company_id","task_id","run_id","id"),
	CONSTRAINT "task_execution_attempts_accounting_productive_uq" UNIQUE("company_id","task_id","run_id","id","run_kind","prompt_kind","ref_ordinal","ref_id","segment_ordinal"),
	CONSTRAINT "task_execution_attempts_prompt_kind_check" CHECK ("task_execution_attempts"."prompt_kind" in ('base', 'steering')),
	CONSTRAINT "task_execution_attempts_session_operation_check" CHECK ("task_execution_attempts"."session_operation" in (
        'new',
        'resume',
        'steer_resume'
      )
      and (
        "task_execution_attempts"."prompt_kind" <> 'base'
        or "task_execution_attempts"."session_operation" <> 'steer_resume'
      )),
	CONSTRAINT "task_execution_attempts_state_check" CHECK ("task_execution_attempts"."state" in (
        'pending',
        'leased',
        'running',
        'settled',
        'failed',
        'cancelled'
      )),
	CONSTRAINT "task_execution_attempts_generation_check" CHECK ("task_execution_attempts"."attempt_generation" > 0),
	CONSTRAINT "task_execution_attempts_prompt_identity_check" CHECK ((
        "task_execution_attempts"."prompt_kind" = 'base'
        and "task_execution_attempts"."run_kind" in ('productive', 'consult')
        and "task_execution_attempts"."ref_id" is not null
        and "task_execution_attempts"."ref_ordinal" is not null
        and "task_execution_attempts"."ref_ordinal" >= 0
        and "task_execution_attempts"."segment_ordinal" is not null
        and "task_execution_attempts"."segment_ordinal" = 0
        and "task_execution_attempts"."steering_segment_ordinal" is null
      ) or (
        "task_execution_attempts"."prompt_kind" = 'steering'
        and "task_execution_attempts"."run_kind" in ('productive', 'consult')
        and "task_execution_attempts"."ref_id" is not null
        and "task_execution_attempts"."ref_ordinal" is not null
        and "task_execution_attempts"."ref_ordinal" >= 0
        and "task_execution_attempts"."segment_ordinal" is not null
        and "task_execution_attempts"."segment_ordinal" > 0
        and "task_execution_attempts"."steering_segment_ordinal" = "task_execution_attempts"."segment_ordinal"
      )),
	CONSTRAINT "task_execution_attempts_time_check" CHECK ((
        (
          "task_execution_attempts"."state" in ('pending', 'leased')
          and "task_execution_attempts"."started_at" is null
          and "task_execution_attempts"."finished_at" is null
        ) or (
          "task_execution_attempts"."state" = 'running'
          and "task_execution_attempts"."started_at" is not null
          and "task_execution_attempts"."finished_at" is null
        ) or (
          "task_execution_attempts"."state" in ('settled', 'failed', 'cancelled')
          and "task_execution_attempts"."finished_at" is not null
        )
      )
      and (
        "task_execution_attempts"."started_at" is null
        or "task_execution_attempts"."started_at" >= "task_execution_attempts"."created_at"
      )
      and (
        "task_execution_attempts"."finished_at" is null
        or "task_execution_attempts"."finished_at" >= coalesce("task_execution_attempts"."started_at", "task_execution_attempts"."created_at")
      ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_authorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"agent_id" uuid NOT NULL,
	"audit_adapter_config_revision_id" uuid NOT NULL,
	"state" text DEFAULT 'current' NOT NULL,
	"revocation_reason" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_execution_authorities_scope_id_uq" UNIQUE("company_id","task_id","ownership_epoch","agent_id","id"),
	CONSTRAINT "task_execution_authorities_company_task_id_uq" UNIQUE("company_id","task_id","id"),
	CONSTRAINT "task_execution_authorities_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "task_execution_authorities_state_check" CHECK ("task_execution_authorities"."state" in ('current', 'revoked')),
	CONSTRAINT "task_execution_authorities_revocation_check" CHECK ((
        "task_execution_authorities"."state" = 'current'
        and "task_execution_authorities"."revocation_reason" is null
        and "task_execution_authorities"."revoked_at" is null
      ) or (
        "task_execution_authorities"."state" = 'revoked'
        and "task_execution_authorities"."revocation_reason" is not null
        and "task_execution_authorities"."revoked_at" is not null
      )),
	CONSTRAINT "task_execution_authorities_epoch_check" CHECK ("task_execution_authorities"."ownership_epoch" > 0)
);
--> statement-breakpoint
CREATE TABLE "task_execution_cancellation_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"lease_id" uuid,
	"reason_kind" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"actor_agent_id" uuid,
	"state" text DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"native_cancellation_settled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_execution_cancellation_intents_attempt_uq" UNIQUE("attempt_id"),
	CONSTRAINT "task_execution_cancellation_intents_scope_id_uq" UNIQUE("company_id","task_id","run_id","attempt_id","id"),
	CONSTRAINT "task_execution_cancellation_intents_reason_check" CHECK ("task_execution_cancellation_intents"."reason_kind" in (
        'lifecycle',
        'authority',
        'timeout',
        'lease_expired',
        'steering'
      )),
	CONSTRAINT "task_execution_cancellation_intents_actor_check" CHECK ((
        "task_execution_cancellation_intents"."actor_kind" = 'system'
        and "task_execution_cancellation_intents"."actor_user_id" is null
        and "task_execution_cancellation_intents"."actor_agent_id" is null
      ) or (
        "task_execution_cancellation_intents"."actor_kind" = 'user'
        and "task_execution_cancellation_intents"."actor_user_id" is not null
        and "task_execution_cancellation_intents"."actor_agent_id" is null
      ) or (
        "task_execution_cancellation_intents"."actor_kind" = 'agent'
        and "task_execution_cancellation_intents"."actor_user_id" is null
        and "task_execution_cancellation_intents"."actor_agent_id" is not null
      )),
	CONSTRAINT "task_execution_cancellation_intents_state_check" CHECK ("task_execution_cancellation_intents"."state" in ('requested', 'acknowledged', 'completed', 'failed')),
	CONSTRAINT "task_execution_cancellation_intents_state_time_check" CHECK ((
        "task_execution_cancellation_intents"."state" = 'requested'
        and "task_execution_cancellation_intents"."acknowledged_at" is null
        and "task_execution_cancellation_intents"."completed_at" is null
        and "task_execution_cancellation_intents"."failed_at" is null
        and "task_execution_cancellation_intents"."failure_code" is null
      ) or (
        "task_execution_cancellation_intents"."state" = 'acknowledged'
        and "task_execution_cancellation_intents"."acknowledged_at" is not null
        and "task_execution_cancellation_intents"."completed_at" is null
        and "task_execution_cancellation_intents"."failed_at" is null
        and "task_execution_cancellation_intents"."failure_code" is null
      ) or (
        "task_execution_cancellation_intents"."state" = 'completed'
        and "task_execution_cancellation_intents"."acknowledged_at" is not null
        and "task_execution_cancellation_intents"."completed_at" is not null
        and "task_execution_cancellation_intents"."failed_at" is null
        and "task_execution_cancellation_intents"."failure_code" is null
      ) or (
        "task_execution_cancellation_intents"."state" = 'failed'
        and "task_execution_cancellation_intents"."completed_at" is null
        and "task_execution_cancellation_intents"."failed_at" is not null
        and "task_execution_cancellation_intents"."failure_code" is not null
        and length(btrim("task_execution_cancellation_intents"."failure_code")) between 1 and 200
      )),
	CONSTRAINT "task_execution_cancellation_intents_time_check" CHECK ("task_execution_cancellation_intents"."requested_at" >= "task_execution_cancellation_intents"."created_at"
        and (
          "task_execution_cancellation_intents"."acknowledged_at" is null
          or "task_execution_cancellation_intents"."acknowledged_at" >= "task_execution_cancellation_intents"."requested_at"
        )
        and (
          "task_execution_cancellation_intents"."native_cancellation_settled_at" is null
          or "task_execution_cancellation_intents"."native_cancellation_settled_at" >= "task_execution_cancellation_intents"."requested_at"
        )
        and (
          "task_execution_cancellation_intents"."completed_at" is null
          or "task_execution_cancellation_intents"."completed_at" >= "task_execution_cancellation_intents"."requested_at"
        )
        and (
          "task_execution_cancellation_intents"."failed_at" is null
          or "task_execution_cancellation_intents"."failed_at" >= "task_execution_cancellation_intents"."requested_at"
        ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
CREATE TABLE "task_execution_finalization_prompt_dependencies" (
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"finalization_id" uuid NOT NULL,
	"dependency_ordinal" integer NOT NULL,
	"prompt_kind" text NOT NULL,
	"ref_id" uuid,
	"ref_ordinal" integer,
	"segment_ordinal" integer,
	"protocol_settlement_state" text NOT NULL,
	"settlement_version" integer NOT NULL,
	"accounting_id" uuid,
	"cost_event_id" uuid,
	CONSTRAINT "task_execution_finalization_prompt_dependencies_pk" PRIMARY KEY("finalization_id","dependency_ordinal"),
	CONSTRAINT "task_execution_finalization_prompt_dependencies_ordinal_check" CHECK ("task_execution_finalization_prompt_dependencies"."dependency_ordinal" >= 0
        and "task_execution_finalization_prompt_dependencies"."settlement_version" > 0),
	CONSTRAINT "task_execution_finalization_prompt_dependencies_identity_check" CHECK ((
        "task_execution_finalization_prompt_dependencies"."prompt_kind" = 'base'
        and "task_execution_finalization_prompt_dependencies"."ref_id" is not null
        and "task_execution_finalization_prompt_dependencies"."ref_ordinal" is not null
        and "task_execution_finalization_prompt_dependencies"."ref_ordinal" >= 0
        and "task_execution_finalization_prompt_dependencies"."segment_ordinal" = 0
      ) or (
        "task_execution_finalization_prompt_dependencies"."prompt_kind" = 'steering'
        and "task_execution_finalization_prompt_dependencies"."ref_id" is not null
        and "task_execution_finalization_prompt_dependencies"."ref_ordinal" is not null
        and "task_execution_finalization_prompt_dependencies"."ref_ordinal" >= 0
        and "task_execution_finalization_prompt_dependencies"."segment_ordinal" is not null
        and "task_execution_finalization_prompt_dependencies"."segment_ordinal" > 0
      )),
	CONSTRAINT "task_execution_finalization_prompt_dependencies_settlement_check" CHECK ((
        "task_execution_finalization_prompt_dependencies"."protocol_settlement_state" = 'settled'
        and "task_execution_finalization_prompt_dependencies"."accounting_id" is not null
        and "task_execution_finalization_prompt_dependencies"."cost_event_id" is not null
      ) or (
        "task_execution_finalization_prompt_dependencies"."protocol_settlement_state" in ('not_sent', 'incomplete')
        and "task_execution_finalization_prompt_dependencies"."accounting_id" is null
        and "task_execution_finalization_prompt_dependencies"."cost_event_id" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_finalization_update_dependencies" (
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"finalization_id" uuid NOT NULL,
	"dependency_ordinal" integer NOT NULL,
	"task_update_id" uuid NOT NULL,
	CONSTRAINT "task_execution_finalization_update_dependencies_pk" PRIMARY KEY("finalization_id","dependency_ordinal"),
	CONSTRAINT "task_execution_finalization_update_dependencies_update_uq" UNIQUE("finalization_id","task_update_id"),
	CONSTRAINT "task_execution_finalization_update_dependencies_ordinal_check" CHECK ("task_execution_finalization_update_dependencies"."dependency_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "task_execution_finalizations" (
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
	CONSTRAINT "task_execution_finalizations_run_uq" UNIQUE("run_id"),
	CONSTRAINT "task_execution_finalizations_company_run_id_uq" UNIQUE("company_id","run_id","id"),
	CONSTRAINT "task_execution_finalizations_action_check" CHECK ("task_execution_finalizations"."action" in (
        'comment_only',
        'updates_committed',
        'no_conversational_output'
      )),
	CONSTRAINT "task_execution_finalizations_identity_digest_check" CHECK (length("task_execution_finalizations"."finalization_identity_digest") = 64
        and "task_execution_finalizations"."finalization_identity_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "task_execution_finalizations_gateway_revocation_check" CHECK ((
        "task_execution_finalizations"."gateway_capability_connection_id" is null
        and "task_execution_finalizations"."gateway_capability_generation" is null
      ) or (
        "task_execution_finalizations"."gateway_capability_connection_id" is not null
        and "task_execution_finalizations"."gateway_capability_generation" is not null
        and "task_execution_finalizations"."gateway_capability_generation" > 0
      )),
	CONSTRAINT "task_execution_finalizations_reference_shape_check" CHECK ((
        "task_execution_finalizations"."action" = 'comment_only'
        and "task_execution_finalizations"."terminal_session_event_id" is not null
        and "task_execution_finalizations"."terminal_session_message_id" is not null
        and "task_execution_finalizations"."progress_comment_id" is not null
      ) or (
        "task_execution_finalizations"."action" = 'updates_committed'
        and "task_execution_finalizations"."terminal_session_event_id" is not null
        and "task_execution_finalizations"."terminal_session_message_id" is null
        and "task_execution_finalizations"."progress_comment_id" is not null
      ) or (
        "task_execution_finalizations"."action" = 'no_conversational_output'
        and "task_execution_finalizations"."terminal_session_message_id" is null
      )),
	CONSTRAINT "task_execution_finalizations_time_check" CHECK ("task_execution_finalizations"."finalized_at" >= "task_execution_finalizations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "task_execution_history_view_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"history_view_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"lower_order" integer NOT NULL,
	"membership_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_execution_history_view_messages_kind_check" CHECK ("task_execution_history_view_messages"."membership_kind" in (
        'composition',
        'source',
        'execution'
      )),
	CONSTRAINT "task_execution_history_view_messages_order_check" CHECK ("task_execution_history_view_messages"."lower_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "task_execution_history_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	"selected_record_ids" jsonb,
	"lower_order_snapshot" jsonb,
	"composition_preparation_id" uuid,
	"composition_bytes" text,
	"composition_hash" text,
	"source_message_id" text NOT NULL,
	"source_input_id" text,
	"source_admitted_seq" bigint,
	"source_promoted_seq" bigint,
	"invalidation_reason" text,
	"invalidated_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_execution_history_views_scope_id_uq" UNIQUE("company_id","task_id","session_id","id"),
	CONSTRAINT "task_execution_history_views_scope_ref_id_lineage_context_uq" UNIQUE("company_id","task_id","session_id","ref_id","id","execution_lineage_id","context_epoch"),
	CONSTRAINT "task_execution_history_views_state_check" CHECK ("task_execution_history_views"."state" in ('empty', 'preparing', 'current', 'invalidated', 'terminal')),
	CONSTRAINT "task_execution_history_views_depth_check" CHECK ("task_execution_history_views"."composition_depth" in ('none', 'comments', 'turns')),
	CONSTRAINT "task_execution_history_views_scope_check" CHECK ((
        "task_execution_history_views"."state" in ('empty', 'invalidated', 'terminal')
      ) or (
        "task_execution_history_views"."history_scope_kind" in (
          'execution-lineage',
          'turns-composition',
          'comments-composition'
        )
        and "task_execution_history_views"."history_scope_id" is not null
        and (
          ("task_execution_history_views"."composition_depth" = 'none' and "task_execution_history_views"."composition_audience" is null)
          or ("task_execution_history_views"."composition_depth" = 'comments' and "task_execution_history_views"."composition_audience" = 'comments')
          or ("task_execution_history_views"."composition_depth" = 'turns' and "task_execution_history_views"."composition_audience" = 'turns')
        )
      )),
	CONSTRAINT "task_execution_history_views_snapshot_check" CHECK ((
        "task_execution_history_views"."state" <> 'current'
      ) or (
        "task_execution_history_views"."effective_dial_snapshot" is not null
        and "task_execution_history_views"."effective_dial_digest" is not null
        and "task_execution_history_views"."selected_record_ids" is not null
        and "task_execution_history_views"."lower_order_snapshot" is not null
      )),
	CONSTRAINT "task_execution_history_views_composition_check" CHECK ((
        "task_execution_history_views"."composition_depth" = 'none'
        and "task_execution_history_views"."composition_bytes" is null
        and "task_execution_history_views"."composition_hash" is null
        and "task_execution_history_views"."composition_preparation_id" is null
      ) or (
        "task_execution_history_views"."composition_depth" in ('comments', 'turns')
        and (
          "task_execution_history_views"."state" in ('empty', 'preparing')
          or (
            "task_execution_history_views"."composition_bytes" is not null
            and "task_execution_history_views"."composition_hash" is not null
            and "task_execution_history_views"."composition_preparation_id" is not null
          )
        )
      ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_lanes" (
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"next_ordinal" bigint DEFAULT 0 NOT NULL,
	"active_ordinal" bigint,
	"active_lease_generation" integer,
	"active_lease_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_execution_lanes_pk" PRIMARY KEY("company_id","task_id","ownership_epoch","target_agent_id"),
	CONSTRAINT "task_execution_lanes_epoch_check" CHECK ("task_execution_lanes"."ownership_epoch" > 0),
	CONSTRAINT "task_execution_lanes_ordinal_check" CHECK ("task_execution_lanes"."next_ordinal" between 0 and 9007199254740991
        and (
          "task_execution_lanes"."active_ordinal" is null
          or (
            "task_execution_lanes"."active_ordinal" between 0 and 9007199254740991
            and "task_execution_lanes"."active_ordinal" < "task_execution_lanes"."next_ordinal"
          )
        )),
	CONSTRAINT "task_execution_lanes_active_lease_check" CHECK ((
        "task_execution_lanes"."active_ordinal" is null
        and "task_execution_lanes"."active_lease_generation" is null
        and "task_execution_lanes"."active_lease_id" is null
      ) or (
        "task_execution_lanes"."active_ordinal" is not null
        and "task_execution_lanes"."active_lease_generation" is not null
        and "task_execution_lanes"."active_lease_generation" > 0
        and "task_execution_lanes"."active_lease_id" is not null
      )),
	CONSTRAINT "task_execution_lanes_time_check" CHECK ("task_execution_lanes"."updated_at" >= "task_execution_lanes"."created_at")
);
--> statement-breakpoint
CREATE TABLE "task_execution_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	CONSTRAINT "task_execution_leases_attempt_uq" UNIQUE("attempt_id"),
	CONSTRAINT "task_execution_leases_scope_id_uq" UNIQUE("company_id","task_id","run_id","attempt_id","id"),
	CONSTRAINT "task_execution_leases_generation_check" CHECK ("task_execution_leases"."lease_generation" > 0),
	CONSTRAINT "task_execution_leases_worker_check" CHECK (length(btrim("task_execution_leases"."worker_id")) between 1 and 200),
	CONSTRAINT "task_execution_leases_state_check" CHECK ("task_execution_leases"."state" in ('active', 'released', 'expired', 'revoked')),
	CONSTRAINT "task_execution_leases_state_time_check" CHECK ((
        (
          "task_execution_leases"."state" = 'active'
          and "task_execution_leases"."released_at" is null
        ) or (
          "task_execution_leases"."state" in ('released', 'expired', 'revoked')
          and "task_execution_leases"."released_at" is not null
        )
      )
      and "task_execution_leases"."expires_at" > "task_execution_leases"."acquired_at"
      and (
        "task_execution_leases"."renewed_at" is null
        or "task_execution_leases"."renewed_at" >= "task_execution_leases"."acquired_at"
      )
      and (
        "task_execution_leases"."released_at" is null
        or "task_execution_leases"."released_at" >= "task_execution_leases"."acquired_at"
      ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_prompt_capabilities" (
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
	"task_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"lane_kind" text NOT NULL,
	"execution_mode" text NOT NULL,
	"task_execution_authority_id" uuid,
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
	CONSTRAINT "task_execution_prompt_capabilities_pk" PRIMARY KEY("capability_connection_id","capability_generation"),
	CONSTRAINT "task_execution_prompt_capabilities_company_pair_uq" UNIQUE("company_id","capability_connection_id","capability_generation"),
	CONSTRAINT "task_execution_prompt_capabilities_connection_uq" UNIQUE("capability_connection_id"),
	CONSTRAINT "task_execution_prompt_capabilities_run_generation_uq" UNIQUE("run_id","capability_generation"),
	CONSTRAINT "task_execution_prompt_capabilities_identity_check" CHECK ("task_execution_prompt_capabilities"."capability_generation" > 0
        and "task_execution_prompt_capabilities"."ownership_epoch" > 0
        and "task_execution_prompt_capabilities"."ref_ordinal" >= 0
        and "task_execution_prompt_capabilities"."segment_ordinal" >= 0
        and "task_execution_prompt_capabilities"."lease_generation" > 0
        and "task_execution_prompt_capabilities"."run_batch_digest" ~ '^[0-9a-f]{64}$'
        and "task_execution_prompt_capabilities"."effective_context_exposure_digest" ~ '^[0-9a-f]{64}$'
        and "task_execution_prompt_capabilities"."effective_tools_digest" ~ '^[0-9a-f]{64}$'
        and "task_execution_prompt_capabilities"."bearer_hash" ~ '^[0-9a-f]{64}$'
        and "task_execution_prompt_capabilities"."ingress_high_water" >= -1
        and "task_execution_prompt_capabilities"."ingress_high_water" <= 9007199254740991
        and "task_execution_prompt_capabilities"."classification_high_water" >= -1
        and "task_execution_prompt_capabilities"."classification_high_water" <= 9007199254740991
        and "task_execution_prompt_capabilities"."classification_high_water" <= "task_execution_prompt_capabilities"."ingress_high_water"),
	CONSTRAINT "task_execution_prompt_capabilities_mode_check" CHECK ((
        "task_execution_prompt_capabilities"."lane_kind" = 'owner'
        and "task_execution_prompt_capabilities"."execution_mode" = 'owner'
        and "task_execution_prompt_capabilities"."task_execution_authority_id" is not null
        and "task_execution_prompt_capabilities"."consult_execution_id" is null
      ) or (
        "task_execution_prompt_capabilities"."lane_kind" = 'consult'
        and "task_execution_prompt_capabilities"."execution_mode" = 'consult'
        and "task_execution_prompt_capabilities"."task_execution_authority_id" is null
        and "task_execution_prompt_capabilities"."consult_execution_id" is not null
      )),
	CONSTRAINT "task_execution_prompt_capabilities_state_check" CHECK ((
        "task_execution_prompt_capabilities"."state" = 'pending_setup'
        and "task_execution_prompt_capabilities"."activated_at" is null
        and "task_execution_prompt_capabilities"."revocation_reason" is null
        and "task_execution_prompt_capabilities"."revoked_at" is null
      ) or (
        "task_execution_prompt_capabilities"."state" = 'active'
        and "task_execution_prompt_capabilities"."target_session_correlation_id" is not null
        and "task_execution_prompt_capabilities"."activated_at" is not null
        and "task_execution_prompt_capabilities"."revocation_reason" is null
        and "task_execution_prompt_capabilities"."revoked_at" is null
      ) or (
        "task_execution_prompt_capabilities"."state" = 'revoked'
        and "task_execution_prompt_capabilities"."revocation_reason" is not null
        and length(btrim("task_execution_prompt_capabilities"."revocation_reason")) between 1 and 200
        and "task_execution_prompt_capabilities"."revoked_at" is not null
        and (
          "task_execution_prompt_capabilities"."activated_at" is null
          or "task_execution_prompt_capabilities"."revoked_at" >= "task_execution_prompt_capabilities"."activated_at"
        )
      )),
	CONSTRAINT "task_execution_prompt_capabilities_time_check" CHECK ("task_execution_prompt_capabilities"."expires_at" > "task_execution_prompt_capabilities"."created_at"
        and (
          "task_execution_prompt_capabilities"."activated_at" is null
          or "task_execution_prompt_capabilities"."activated_at" >= "task_execution_prompt_capabilities"."created_at"
        )
        and (
          "task_execution_prompt_capabilities"."revoked_at" is null
          or "task_execution_prompt_capabilities"."revoked_at" >= "task_execution_prompt_capabilities"."created_at"
        ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_prompt_segments" (
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	CONSTRAINT "task_execution_prompt_segments_run_ordinal_ref_segment_uq" UNIQUE("run_id","ref_ordinal","ref_id","segment_ordinal"),
	CONSTRAINT "task_execution_prompt_segments_run_ref_segment_uq" UNIQUE("run_id","ref_id","segment_ordinal"),
	CONSTRAINT "task_execution_prompt_segments_scope_prompt_uq" UNIQUE("company_id","task_id","session_id","run_id","ref_ordinal","ref_id","segment_ordinal"),
	CONSTRAINT "task_execution_prompt_segments_positive_ordinal_check" CHECK ("task_execution_prompt_segments"."ref_ordinal" >= 0 and "task_execution_prompt_segments"."segment_ordinal" > 0),
	CONSTRAINT "task_execution_prompt_segments_generation_check" CHECK (("task_execution_prompt_segments"."target_session_generation" is null
          or "task_execution_prompt_segments"."target_session_generation" > 0)
        and ("task_execution_prompt_segments"."capability_generation" is null
          or "task_execution_prompt_segments"."capability_generation" > 0)),
	CONSTRAINT "task_execution_prompt_segments_source_input_check" CHECK ("task_execution_prompt_segments"."source_input_id" is null
        or "task_execution_prompt_segments"."source_input_id" = "task_execution_prompt_segments"."source_message_id"),
	CONSTRAINT "task_execution_prompt_segments_attempt_capability_check" CHECK ((
        "task_execution_prompt_segments"."attempt_id" is null
        and "task_execution_prompt_segments"."capability_connection_id" is null
        and "task_execution_prompt_segments"."capability_generation" is null
      ) or (
        "task_execution_prompt_segments"."attempt_id" is not null
        and "task_execution_prompt_segments"."capability_connection_id" is not null
        and "task_execution_prompt_segments"."capability_generation" is not null
      )),
	CONSTRAINT "task_execution_prompt_segments_steering_state_check" CHECK ("task_execution_prompt_segments"."steering_state" in (
        'requested',
        'sent',
        'protocol_settled',
        'rebound',
        'resumed'
      )),
	CONSTRAINT "task_execution_prompt_segments_resumed_at_check" CHECK ("task_execution_prompt_segments"."resumed_at" is null or (
        "task_execution_prompt_segments"."resumed_at" > "task_execution_prompt_segments"."created_at"
        and (
          "task_execution_prompt_segments"."steering_state" = 'resumed'
          or (
            "task_execution_prompt_segments"."steering_state" = 'protocol_settled'
            and "task_execution_prompt_segments"."protocol_settlement_state" is not null
          )
        )
      )),
	CONSTRAINT "task_execution_prompt_segments_transmission_check" CHECK ("task_execution_prompt_segments"."prompt_transmission_phase" in ('not_transmitted', 'transmitted')),
	CONSTRAINT "task_execution_prompt_segments_outcome_check" CHECK ("task_execution_prompt_segments"."outcome" is null
        or "task_execution_prompt_segments"."outcome" in (
          'released_unsent',
          'succeeded',
          'refused',
          'failed',
          'ambiguous',
          'cancelled'
        )),
	CONSTRAINT "task_execution_prompt_segments_protocol_settlement_state_check" CHECK ("task_execution_prompt_segments"."protocol_settlement_state" is null
        or "task_execution_prompt_segments"."protocol_settlement_state" in ('not_sent', 'settled', 'incomplete')),
	CONSTRAINT "task_execution_prompt_segments_terminal_message_check" CHECK ((
        "task_execution_prompt_segments"."protocol_settlement_state" = 'settled'
        and "task_execution_prompt_segments"."terminal_session_message_id" is not null
      ) or (
        "task_execution_prompt_segments"."protocol_settlement_state" is distinct from 'settled'
        and "task_execution_prompt_segments"."terminal_session_message_id" is null
      )),
	CONSTRAINT "task_execution_prompt_segments_settlement_matrix_check" CHECK ((
        "task_execution_prompt_segments"."protocol_settlement_state" is null
        and "task_execution_prompt_segments"."outcome" is null
        and "task_execution_prompt_segments"."outcome_reference_id" is null
        and "task_execution_prompt_segments"."accounting_id" is null
        and "task_execution_prompt_segments"."cost_event_id" is null
        and "task_execution_prompt_segments"."settlement_version" = 0
        and "task_execution_prompt_segments"."settled_at" is null
      ) or (
        "task_execution_prompt_segments"."protocol_settlement_state" = 'not_sent'
        and "task_execution_prompt_segments"."prompt_transmission_phase" = 'not_transmitted'
        and "task_execution_prompt_segments"."outcome" = 'released_unsent'
        and "task_execution_prompt_segments"."outcome_reference_id" is not null
        and "task_execution_prompt_segments"."accounting_id" is null
        and "task_execution_prompt_segments"."cost_event_id" is null
        and "task_execution_prompt_segments"."settlement_version" > 0
        and "task_execution_prompt_segments"."settled_at" is not null
      ) or (
        "task_execution_prompt_segments"."protocol_settlement_state" = 'incomplete'
        and "task_execution_prompt_segments"."prompt_transmission_phase" = 'transmitted'
        and "task_execution_prompt_segments"."outcome" in ('failed', 'ambiguous', 'cancelled')
        and "task_execution_prompt_segments"."outcome_reference_id" is not null
        and "task_execution_prompt_segments"."accounting_id" is null
        and "task_execution_prompt_segments"."cost_event_id" is null
        and "task_execution_prompt_segments"."settlement_version" > 0
        and "task_execution_prompt_segments"."settled_at" is not null
      ) or (
        "task_execution_prompt_segments"."protocol_settlement_state" = 'settled'
        and "task_execution_prompt_segments"."prompt_transmission_phase" = 'transmitted'
        and "task_execution_prompt_segments"."outcome" in ('succeeded', 'refused', 'failed', 'cancelled')
        and "task_execution_prompt_segments"."outcome_reference_id" is not null
        and "task_execution_prompt_segments"."accounting_id" is not null
        and "task_execution_prompt_segments"."cost_event_id" is not null
        and "task_execution_prompt_segments"."settlement_version" > 0
        and "task_execution_prompt_segments"."settled_at" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	"task_execution_authority_id" uuid,
	"consult_execution_id" uuid,
	"adapter_config_revision_id" uuid NOT NULL,
	"context_epoch" integer NOT NULL,
	"history_view_id" uuid NOT NULL,
	"admission_high_water_seq" bigint NOT NULL,
	"input_id" text,
	"admitted_seq" bigint,
	"promoted_seq" bigint,
	"counterpart_task_id" uuid,
	"counterpart_authority_id" uuid,
	"counterpart_ownership_epoch" integer,
	"consult_caller_ref_id" uuid,
	"consult_chain_token" text,
	"disposition" text DEFAULT 'active' NOT NULL,
	"invalidation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_execution_refs_scope_id_uq" UNIQUE("company_id","task_id","session_id","id"),
	CONSTRAINT "task_execution_refs_company_task_id_uq" UNIQUE("company_id","task_id","id"),
	CONSTRAINT "task_execution_refs_company_task_epoch_id_uq" UNIQUE("company_id","task_id","ownership_epoch","id"),
	CONSTRAINT "task_execution_refs_lane_ordinal_uq" UNIQUE("company_id","task_id","ownership_epoch","target_agent_id","lane_ordinal"),
	CONSTRAINT "task_execution_refs_scope_epoch_id_uq" UNIQUE("company_id","task_id","session_id","id","ownership_epoch"),
	CONSTRAINT "task_execution_refs_liveness_identity_uq" UNIQUE("company_id","task_id","ownership_epoch","id","target_agent_id","mode"),
	CONSTRAINT "task_execution_refs_mode_check" CHECK ("task_execution_refs"."mode" in ('owner', 'consult')),
	CONSTRAINT "task_execution_refs_source_kind_check" CHECK ("task_execution_refs"."source_kind" in (
        'task_request',
        'task_reassignment',
        'task_reopen',
        'human_comment_mention',
        'routine_dispatch',
        'task_update',
        'consult_mention',
        'system_nudge'
      )),
	CONSTRAINT "task_execution_refs_previous_epoch_check" CHECK ((
        "task_execution_refs"."source_kind" = 'task_reassignment'
        and "task_execution_refs"."previous_ownership_epoch" > 0
        and "task_execution_refs"."previous_ownership_epoch" = "task_execution_refs"."ownership_epoch" - 1
      ) or (
        "task_execution_refs"."source_kind" <> 'task_reassignment'
        and "task_execution_refs"."previous_ownership_epoch" is null
      )),
	CONSTRAINT "task_execution_refs_message_kind_check" CHECK ("task_execution_refs"."message_kind" in ('user', 'synthetic')),
	CONSTRAINT "task_execution_refs_message_input_shape_check" CHECK ((
        "task_execution_refs"."message_kind" = 'user'
        and "task_execution_refs"."input_id" is not null
        and "task_execution_refs"."admitted_seq" is not null
        and "task_execution_refs"."admitted_seq" between 0 and 9007199254740991
        and (
          "task_execution_refs"."promoted_seq" is null
          or "task_execution_refs"."promoted_seq" between "task_execution_refs"."admitted_seq" and 9007199254740991
        )
      ) or (
        "task_execution_refs"."message_kind" = 'synthetic'
        and "task_execution_refs"."input_id" is null
        and "task_execution_refs"."admitted_seq" is null
        and "task_execution_refs"."promoted_seq" is null
      )),
	CONSTRAINT "task_execution_refs_disposition_check" CHECK ("task_execution_refs"."disposition" in ('active', 'invalidated', 'terminal')),
	CONSTRAINT "task_execution_refs_lane_ordinal_check" CHECK ("task_execution_refs"."lane_ordinal" between 0 and 9007199254740991),
	CONSTRAINT "task_execution_refs_mode_binding_check" CHECK ((
        "task_execution_refs"."mode" = 'owner'
        and "task_execution_refs"."task_execution_authority_id" is not null
        and "task_execution_refs"."consult_execution_id" is null
      ) or (
        "task_execution_refs"."mode" = 'consult'
        and "task_execution_refs"."task_execution_authority_id" is null
        and "task_execution_refs"."consult_execution_id" is not null
      )),
	CONSTRAINT "task_execution_refs_counterpart_check" CHECK ((
        "task_execution_refs"."counterpart_task_id" is null
        and "task_execution_refs"."counterpart_authority_id" is null
        and "task_execution_refs"."counterpart_ownership_epoch" is null
      ) or (
        "task_execution_refs"."counterpart_task_id" is not null
        and "task_execution_refs"."counterpart_authority_id" is not null
        and "task_execution_refs"."counterpart_ownership_epoch" is not null
      )),
	CONSTRAINT "task_execution_refs_consult_chain_check" CHECK ((
        "task_execution_refs"."mode" = 'owner'
        and "task_execution_refs"."consult_caller_ref_id" is null
        and "task_execution_refs"."consult_chain_token" is null
      ) or (
        "task_execution_refs"."mode" = 'consult'
        and "task_execution_refs"."consult_caller_ref_id" is not null
        and "task_execution_refs"."consult_chain_token" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_run_controls" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"current_ref_id" uuid,
	"current_ordinal" integer,
	"current_segment_ordinal" integer,
	CONSTRAINT "task_execution_run_controls_current_prompt_shape_check" CHECK ((
        "task_execution_run_controls"."current_ref_id" is null
        and "task_execution_run_controls"."current_ordinal" is null
        and "task_execution_run_controls"."current_segment_ordinal" is null
      ) or (
        "task_execution_run_controls"."current_ref_id" is not null
        and "task_execution_run_controls"."current_ordinal" is not null
        and "task_execution_run_controls"."current_ordinal" >= 0
        and "task_execution_run_controls"."current_segment_ordinal" is not null
        and "task_execution_run_controls"."current_segment_ordinal" >= 0
      ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_run_liveness_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"liveness_state" text NOT NULL,
	"liveness_reason" text NOT NULL,
	"continuation_attempt" integer NOT NULL,
	"last_useful_action_at" timestamp with time zone,
	"next_action" text,
	CONSTRAINT "task_execution_run_liveness_facts_run_uq" UNIQUE("run_id"),
	CONSTRAINT "task_execution_run_liveness_facts_run_id_uq" UNIQUE("run_id","id"),
	CONSTRAINT "task_execution_run_liveness_facts_state_check" CHECK ("task_execution_run_liveness_facts"."liveness_state" in (
        'completed',
        'advanced',
        'plan_only',
        'empty_response',
        'blocked',
        'failed',
        'needs_followup'
      )),
	CONSTRAINT "task_execution_run_liveness_facts_payload_check" CHECK (length(btrim("task_execution_run_liveness_facts"."liveness_reason")) between 1 and 500
        and "task_execution_run_liveness_facts"."continuation_attempt" >= 0
        and (
          "task_execution_run_liveness_facts"."next_action" is null
          or length(btrim("task_execution_run_liveness_facts"."next_action")) between 1 and 500
        ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_run_refs" (
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	CONSTRAINT "task_execution_run_refs_run_ordinal_uq" UNIQUE("run_id","ref_ordinal"),
	CONSTRAINT "task_execution_run_refs_run_ref_uq" UNIQUE("run_id","ref_id"),
	CONSTRAINT "task_execution_run_refs_run_ordinal_ref_uq" UNIQUE("run_id","ref_ordinal","ref_id"),
	CONSTRAINT "task_execution_run_refs_prompt_identity_uq" UNIQUE("run_id","ref_ordinal","ref_id","batch_digest"),
	CONSTRAINT "task_execution_run_refs_scope_member_uq" UNIQUE("company_id","task_id","session_id","run_id","ref_ordinal","ref_id"),
	CONSTRAINT "task_execution_run_refs_company_task_run_ordinal_ref_uq" UNIQUE("company_id","task_id","run_id","ref_ordinal","ref_id"),
	CONSTRAINT "task_execution_run_refs_ordinal_check" CHECK ("task_execution_run_refs"."ref_ordinal" >= 0 and "task_execution_run_refs"."admission_order" >= 0),
	CONSTRAINT "task_execution_run_refs_batch_digest_check" CHECK (length("task_execution_run_refs"."batch_digest") = 64
        and "task_execution_run_refs"."batch_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "task_execution_run_refs_transmission_check" CHECK ("task_execution_run_refs"."prompt_transmission_phase" in ('not_transmitted', 'transmitted')),
	CONSTRAINT "task_execution_run_refs_outcome_check" CHECK ("task_execution_run_refs"."outcome" is null
        or "task_execution_run_refs"."outcome" in (
          'released_unsent',
          'succeeded',
          'refused',
          'failed',
          'ambiguous',
          'cancelled'
        )),
	CONSTRAINT "task_execution_run_refs_protocol_settlement_state_check" CHECK ("task_execution_run_refs"."protocol_settlement_state" is null
        or "task_execution_run_refs"."protocol_settlement_state" in ('not_sent', 'settled', 'incomplete')),
	CONSTRAINT "task_execution_run_refs_settlement_matrix_check" CHECK ((
        "task_execution_run_refs"."protocol_settlement_state" is null
        and "task_execution_run_refs"."outcome" is null
        and "task_execution_run_refs"."outcome_reference_id" is null
        and "task_execution_run_refs"."accounting_id" is null
        and "task_execution_run_refs"."cost_event_id" is null
        and "task_execution_run_refs"."settlement_version" = 0
        and "task_execution_run_refs"."settled_at" is null
      ) or (
        "task_execution_run_refs"."protocol_settlement_state" = 'not_sent'
        and "task_execution_run_refs"."prompt_transmission_phase" = 'not_transmitted'
        and "task_execution_run_refs"."outcome" = 'released_unsent'
        and "task_execution_run_refs"."outcome_reference_id" is not null
        and "task_execution_run_refs"."accounting_id" is null
        and "task_execution_run_refs"."cost_event_id" is null
        and "task_execution_run_refs"."settlement_version" > 0
        and "task_execution_run_refs"."settled_at" is not null
      ) or (
        "task_execution_run_refs"."protocol_settlement_state" = 'incomplete'
        and "task_execution_run_refs"."prompt_transmission_phase" = 'transmitted'
        and "task_execution_run_refs"."outcome" in ('failed', 'ambiguous', 'cancelled')
        and "task_execution_run_refs"."outcome_reference_id" is not null
        and "task_execution_run_refs"."accounting_id" is null
        and "task_execution_run_refs"."cost_event_id" is null
        and "task_execution_run_refs"."settlement_version" > 0
        and "task_execution_run_refs"."settled_at" is not null
      ) or (
        "task_execution_run_refs"."protocol_settlement_state" = 'settled'
        and "task_execution_run_refs"."prompt_transmission_phase" = 'transmitted'
        and "task_execution_run_refs"."outcome" in ('succeeded', 'refused', 'failed', 'cancelled')
        and "task_execution_run_refs"."outcome_reference_id" is not null
        and "task_execution_run_refs"."accounting_id" is not null
        and "task_execution_run_refs"."cost_event_id" is not null
        and "task_execution_run_refs"."settlement_version" > 0
        and "task_execution_run_refs"."settled_at" is not null
      )),
	CONSTRAINT "task_execution_run_refs_capability_generation_check" CHECK ((
        "task_execution_run_refs"."attempt_id" is null
        and "task_execution_run_refs"."capability_connection_id" is null
        and "task_execution_run_refs"."capability_generation" is null
      ) or (
        "task_execution_run_refs"."attempt_id" is not null
        and "task_execution_run_refs"."capability_connection_id" is not null
        and "task_execution_run_refs"."capability_generation" is not null
        and "task_execution_run_refs"."capability_generation" > 0
      ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"execution_scope_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"adapter_config_revision_id" uuid NOT NULL,
	"execution_workspace_binding_id" uuid NOT NULL,
	"execution_mode" text NOT NULL,
	"task_execution_authority_id" uuid,
	"consult_execution_id" uuid,
	"parent_run_id" uuid,
	"retry_of_run_id" uuid,
	"current_attempt_id" uuid,
	"current_lease_id" uuid,
	"cancellation_intent_id" uuid,
	"terminal_finalization_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"terminal_classification" text,
	"terminal_reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_execution_runs_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "task_execution_runs_company_task_id_uq" UNIQUE("company_id","task_id","id"),
	CONSTRAINT "task_execution_runs_scope_id_uq" UNIQUE("company_id","task_id","session_id","id"),
	CONSTRAINT "task_execution_runs_company_task_id_kind_uq" UNIQUE("company_id","task_id","id","kind"),
	CONSTRAINT "task_execution_runs_epoch_id_uq" UNIQUE("company_id","task_id","ownership_epoch","id"),
	CONSTRAINT "task_execution_runs_liveness_identity_uq" UNIQUE("company_id","task_id","ownership_epoch","id","target_agent_id","execution_mode"),
	CONSTRAINT "task_execution_runs_company_id_target_agent_uq" UNIQUE("company_id","id","target_agent_id"),
	CONSTRAINT "task_execution_runs_accounting_revision_uq" UNIQUE("company_id","task_id","id","kind","adapter_config_revision_id"),
	CONSTRAINT "task_execution_runs_native_target_scope_uq" UNIQUE("company_id","task_id","ownership_epoch","id","target_agent_id","adapter_config_revision_id","execution_workspace_binding_id"),
	CONSTRAINT "task_execution_runs_prompt_scope_uq" UNIQUE("company_id","task_id","ownership_epoch","id","target_agent_id","adapter_config_revision_id","execution_workspace_binding_id","execution_mode"),
	CONSTRAINT "task_execution_runs_kind_check" CHECK ("task_execution_runs"."kind" in ('productive', 'consult')),
	CONSTRAINT "task_execution_runs_status_check" CHECK ("task_execution_runs"."status" in (
        'queued',
        'scheduled_retry',
        'running',
        'succeeded',
        'interrupted',
        'failed',
        'cancelled',
        'timed_out'
      )),
	CONSTRAINT "task_execution_runs_epoch_check" CHECK ("task_execution_runs"."ownership_epoch" > 0),
	CONSTRAINT "task_execution_runs_mode_check" CHECK ("task_execution_runs"."execution_mode" in ('owner', 'consult')),
	CONSTRAINT "task_execution_runs_kind_shape_check" CHECK ((
        "task_execution_runs"."kind" = 'productive'
        and "task_execution_runs"."target_agent_id" is not null
        and "task_execution_runs"."execution_mode" = 'owner'
        and "task_execution_runs"."task_execution_authority_id" is not null
        and "task_execution_runs"."consult_execution_id" is null
        and "task_execution_runs"."parent_run_id" is null
      ) or (
        "task_execution_runs"."kind" = 'consult'
        and "task_execution_runs"."target_agent_id" is not null
        and "task_execution_runs"."execution_mode" = 'consult'
        and "task_execution_runs"."task_execution_authority_id" is null
        and "task_execution_runs"."consult_execution_id" is not null
        and "task_execution_runs"."parent_run_id" is not null
      )),
	CONSTRAINT "task_execution_runs_current_attempt_lease_check" CHECK ((
        "task_execution_runs"."current_attempt_id" is null
        and "task_execution_runs"."current_lease_id" is null
      ) or (
        "task_execution_runs"."current_attempt_id" is not null
        and "task_execution_runs"."current_lease_id" is not null
      )),
	CONSTRAINT "task_execution_runs_terminal_shape_check" CHECK ((
        "task_execution_runs"."status" in ('queued', 'scheduled_retry', 'running')
        and "task_execution_runs"."finished_at" is null
        and "task_execution_runs"."terminal_classification" is null
        and "task_execution_runs"."terminal_reason_code" is null
        and "task_execution_runs"."terminal_finalization_id" is null
      ) or (
        "task_execution_runs"."status" in (
          'succeeded',
          'interrupted',
          'failed',
          'cancelled',
          'timed_out'
        )
        and "task_execution_runs"."finished_at" is not null
        and "task_execution_runs"."terminal_classification" = "task_execution_runs"."status"
        and "task_execution_runs"."terminal_reason_code" is not null
        and length(btrim("task_execution_runs"."terminal_reason_code")) between 1 and 200
        and "task_execution_runs"."terminal_finalization_id" is not null
        and "task_execution_runs"."current_attempt_id" is null
        and "task_execution_runs"."current_lease_id" is null
      )),
	CONSTRAINT "task_execution_runs_time_check" CHECK ("task_execution_runs"."updated_at" >= "task_execution_runs"."created_at"
        and (
          "task_execution_runs"."started_at" is null
          or "task_execution_runs"."started_at" >= "task_execution_runs"."created_at"
        )
        and (
          "task_execution_runs"."finished_at" is null
          or "task_execution_runs"."started_at" is null
          or "task_execution_runs"."finished_at" >= "task_execution_runs"."started_at"
        ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	"envelope_version" text DEFAULT 'task-execution-native/v1' NOT NULL,
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
	CONSTRAINT "task_execution_sessions_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "task_execution_sessions_epoch_generation_check" CHECK ("task_execution_sessions"."ownership_epoch" > 0
        and "task_execution_sessions"."correlation_generation" > 0),
	CONSTRAINT "task_execution_sessions_purpose_shape_check" CHECK ((
        "task_execution_sessions"."purpose" = 'carry'
        and "task_execution_sessions"."state" in ('eligible', 'superseded')
        and "task_execution_sessions"."lane_kind" is not null
        and "task_execution_sessions"."lane_kind" in ('owner', 'consult')
        and "task_execution_sessions"."run_id" is null
        and "task_execution_sessions"."current_ref_id" is null
        and "task_execution_sessions"."current_ref_ordinal" is null
        and "task_execution_sessions"."current_segment_ordinal" is null
        and "task_execution_sessions"."authorized_context_exposure_digest" is not null
      ) or (
        "task_execution_sessions"."purpose" = 'active_run_steering'
        and "task_execution_sessions"."state" in ('current', 'superseded')
        and "task_execution_sessions"."lane_kind" is null
        and "task_execution_sessions"."run_id" is not null
        and "task_execution_sessions"."current_ref_id" is not null
        and "task_execution_sessions"."current_ref_ordinal" is not null
        and "task_execution_sessions"."current_ref_ordinal" >= 0
        and "task_execution_sessions"."current_segment_ordinal" is not null
        and "task_execution_sessions"."current_segment_ordinal" >= 0
        and "task_execution_sessions"."authorized_context_exposure_digest" is null
      )),
	CONSTRAINT "task_execution_sessions_supersession_check" CHECK ((
        "task_execution_sessions"."state" in ('eligible', 'current')
        and "task_execution_sessions"."supersession_reason" is null
        and "task_execution_sessions"."superseded_at" is null
      ) or (
        "task_execution_sessions"."state" = 'superseded'
        and "task_execution_sessions"."supersession_reason" is not null
        and length(btrim("task_execution_sessions"."supersession_reason")) between 1 and 200
        and "task_execution_sessions"."superseded_at" is not null
        and "task_execution_sessions"."superseded_at" >= "task_execution_sessions"."created_at"
      )),
	CONSTRAINT "task_execution_sessions_envelope_check" CHECK ("task_execution_sessions"."envelope_version" = 'task-execution-native/v1'
        and "task_execution_sessions"."codec_kind" = 'acp-session/v1'
        and "task_execution_sessions"."acp_wire_protocol_version" = 1
        and length(btrim("task_execution_sessions"."protected_target_session")) > 0
        and "task_execution_sessions"."protected_target_session" like 'pcnc.v1.%'),
	CONSTRAINT "task_execution_sessions_digest_check" CHECK ("task_execution_sessions"."protected_target_session_digest" ~ '^[0-9a-f]{64}$'
        and "task_execution_sessions"."target_fingerprint" ~ '^[0-9a-f]{64}$'
        and (
          "task_execution_sessions"."authorized_context_exposure_digest" is null
          or "task_execution_sessions"."authorized_context_exposure_digest" ~ '^[0-9a-f]{64}$'
        )),
	CONSTRAINT "task_execution_sessions_last_settled_prompt_check" CHECK ((
        "task_execution_sessions"."last_protocol_settled_run_id" is null
        and "task_execution_sessions"."last_protocol_settled_ref_id" is null
        and "task_execution_sessions"."last_protocol_settled_ref_ordinal" is null
        and "task_execution_sessions"."last_protocol_settled_segment_ordinal" is null
      ) or (
        "task_execution_sessions"."last_protocol_settled_run_id" is not null
        and "task_execution_sessions"."last_protocol_settled_ref_id" is not null
        and "task_execution_sessions"."last_protocol_settled_ref_ordinal" is not null
        and "task_execution_sessions"."last_protocol_settled_ref_ordinal" >= 0
        and "task_execution_sessions"."last_protocol_settled_segment_ordinal" is not null
        and "task_execution_sessions"."last_protocol_settled_segment_ordinal" >= 0
      )),
	CONSTRAINT "task_execution_sessions_cost_cursor_check" CHECK ((
        "task_execution_sessions"."cost_cursor_state" = 'unanchored'
        and "task_execution_sessions"."cost_cursor_amount" is null
        and "task_execution_sessions"."cost_cursor_currency" is null
        and "task_execution_sessions"."last_protocol_settled_run_id" is null
      ) or (
        "task_execution_sessions"."cost_cursor_state" = 'known'
        and "task_execution_sessions"."cost_cursor_amount" is not null
        and "task_execution_sessions"."cost_cursor_amount" >= 0
    and "task_execution_sessions"."cost_cursor_amount" not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and "task_execution_sessions"."cost_cursor_amount"::text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'
        and "task_execution_sessions"."cost_cursor_currency" is not null
        and "task_execution_sessions"."last_protocol_settled_run_id" is not null
      ) or (
        "task_execution_sessions"."cost_cursor_state" = 'unavailable'
        and "task_execution_sessions"."cost_cursor_amount" is null
        and "task_execution_sessions"."cost_cursor_currency" is null
        and "task_execution_sessions"."last_protocol_settled_run_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "task_execution_workspace_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"execution_workspace_id" uuid NOT NULL,
	"absolute_cwd" text NOT NULL,
	"bound_by_agent_id" uuid,
	"bound_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_execution_workspace_bindings_scope_epoch_id_uq" UNIQUE("company_id","task_id","session_id","ownership_epoch","id"),
	CONSTRAINT "task_execution_workspace_bindings_identity_uq" UNIQUE("company_id","task_id","ownership_epoch","id"),
	CONSTRAINT "task_execution_workspace_bindings_epoch_check" CHECK ("task_execution_workspace_bindings"."ownership_epoch" > 0),
	CONSTRAINT "task_execution_workspace_bindings_absolute_cwd_check" CHECK (left("task_execution_workspace_bindings"."absolute_cwd", 1) = '/')
);
--> statement-breakpoint
CREATE TABLE "task_inbox_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"archived_by_actor_type" text DEFAULT 'user' NOT NULL,
	"archived_by_agent_id" uuid,
	"archived_by_run_id" uuid,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_inbox_archives_archived_by_actor_type_check" CHECK ("task_inbox_archives"."archived_by_actor_type" in ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "task_labels" (
	"task_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_labels_pk" PRIMARY KEY("task_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "task_read_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_reference_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_task_id" uuid NOT NULL,
	"target_task_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_record_id" uuid,
	"document_key" text,
	"matched_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"related_task_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_session_context_epochs" (
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text PRIMARY KEY NOT NULL,
	"baseline" text,
	"snapshot" jsonb,
	"baseline_seq" bigint,
	"generation" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "task_session_context_epochs_scope_uq" UNIQUE("company_id","task_id","session_id"),
	CONSTRAINT "task_session_context_epochs_state_check" CHECK ((
        "task_session_context_epochs"."baseline" is null
        and "task_session_context_epochs"."snapshot" is null
        and "task_session_context_epochs"."baseline_seq" is null
      ) or (
        "task_session_context_epochs"."baseline" is not null
        and "task_session_context_epochs"."snapshot" is not null
        and jsonb_typeof("task_session_context_epochs"."snapshot") = 'object'
        and "task_session_context_epochs"."baseline_seq" >= -1
      )),
	CONSTRAINT "task_session_context_epochs_generation_check" CHECK ("task_session_context_epochs"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "task_session_event_sequences" (
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"owner_id" text,
	CONSTRAINT "task_session_event_sequences_scope_uq" UNIQUE("company_id","task_id","session_id"),
	CONSTRAINT "task_session_event_sequences_seq_check" CHECK ("task_session_event_sequences"."seq" >= -1)
);
--> statement-breakpoint
CREATE TABLE "task_session_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	CONSTRAINT "task_session_events_session_event_uq" UNIQUE("session_id","id"),
	CONSTRAINT "task_session_events_type_check" CHECK ("task_session_events"."type" in (
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
      )),
	CONSTRAINT "task_session_events_data_check" CHECK (jsonb_typeof("task_session_events"."data") = 'object'
        and not ("task_session_events"."data" ? 'id')
        and not ("task_session_events"."data" ? 'type')
        and not ("task_session_events"."data" ? 'durable')
        and not ("task_session_events"."data" ? 'metadata')),
	CONSTRAINT "task_session_events_seq_check" CHECK ("task_session_events"."seq" >= 0),
	CONSTRAINT "task_session_events_source_identity_check" CHECK ((
        "task_session_events"."source_kind" is null
        and "task_session_events"."source_id" is null
        and "task_session_events"."immutable_source_key" is null
        and "task_session_events"."source_record_id" is null
        and "task_session_events"."source_identity_digest" is null
      ) or (
        "task_session_events"."source_kind" is not null
        and length("task_session_events"."source_kind") > 0
        and "task_session_events"."source_id" is not null
        and length("task_session_events"."source_id") > 0
        and "task_session_events"."immutable_source_key" is not null
        and length("task_session_events"."immutable_source_key") > 0
        and "task_session_events"."source_record_id" is not null
        and length("task_session_events"."source_record_id") > 0
        and "task_session_events"."source_identity_digest" is not null
        and length("task_session_events"."source_identity_digest") = 64
      ))
);
--> statement-breakpoint
CREATE TABLE "task_session_input_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"input_id" text NOT NULL,
	"source_ref_id" uuid,
	"state" text DEFAULT 'active' NOT NULL,
	"invalidation_reason" text,
	"invalidated_at" timestamp with time zone,
	"invalidated_by_source_kind" text,
	"invalidated_by_source_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_session_input_dispositions_state_check" CHECK ("task_session_input_dispositions"."state" in ('active', 'invalidated')),
	CONSTRAINT "task_session_input_dispositions_invalidation_check" CHECK ((
        "task_session_input_dispositions"."state" = 'active'
        and "task_session_input_dispositions"."invalidation_reason" is null
        and "task_session_input_dispositions"."invalidated_at" is null
        and "task_session_input_dispositions"."invalidated_by_source_kind" is null
        and "task_session_input_dispositions"."invalidated_by_source_id" is null
      ) or (
        "task_session_input_dispositions"."state" = 'invalidated'
        and "task_session_input_dispositions"."invalidation_reason" is not null
        and "task_session_input_dispositions"."invalidated_at" is not null
        and "task_session_input_dispositions"."invalidated_by_source_kind" is not null
        and "task_session_input_dispositions"."invalidated_by_source_id" is not null
        and length(btrim("task_session_input_dispositions"."invalidated_by_source_kind")) > 0
        and length(btrim("task_session_input_dispositions"."invalidated_by_source_id")) > 0
      ))
);
--> statement-breakpoint
CREATE TABLE "task_session_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"prompt" jsonb NOT NULL,
	"delivery" text NOT NULL,
	"admitted_seq" bigint NOT NULL,
	"promoted_seq" bigint,
	"time_created" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_session_inputs_scope_id_uq" UNIQUE("company_id","task_id","session_id","id"),
	CONSTRAINT "task_session_inputs_delivery_check" CHECK ("task_session_inputs"."delivery" in ('steer', 'queue')),
	CONSTRAINT "task_session_inputs_promotion_check" CHECK ("task_session_inputs"."admitted_seq" >= 0
        and ("task_session_inputs"."promoted_seq" is null or "task_session_inputs"."promoted_seq" >= "task_session_inputs"."admitted_seq")),
	CONSTRAINT "task_session_inputs_prompt_check" CHECK (jsonb_typeof("task_session_inputs"."prompt") = 'object')
);
--> statement-breakpoint
CREATE TABLE "task_session_message_id_allocators" (
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text PRIMARY KEY NOT NULL,
	"last_ordinal" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_session_message_id_allocators_scope_uq" UNIQUE("company_id","task_id","session_id"),
	CONSTRAINT "task_session_message_id_allocators_ordinal_check" CHECK ("task_session_message_id_allocators"."last_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "task_session_message_id_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"reservation_key" text NOT NULL,
	"ordinal" bigint NOT NULL,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_session_message_id_reservations_scope_key_uq" UNIQUE("company_id","task_id","session_id","reservation_key"),
	CONSTRAINT "task_session_message_id_reservations_scope_ordinal_uq" UNIQUE("company_id","task_id","session_id","ordinal"),
	CONSTRAINT "task_session_message_id_reservations_scope_message_uq" UNIQUE("company_id","task_id","session_id","message_id"),
	CONSTRAINT "task_session_message_id_reservations_value_check" CHECK ("task_session_message_id_reservations"."ordinal" > 0
        and btrim("task_session_message_id_reservations"."reservation_key") <> ''
        and length("task_session_message_id_reservations"."reservation_key") <= 500
        and "task_session_message_id_reservations"."message_id" = (
          'msg_' || "task_session_message_id_reservations"."session_id" || '_' || lpad("task_session_message_id_reservations"."ordinal"::text, 19, '0')
        ))
);
--> statement-breakpoint
CREATE TABLE "task_session_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	CONSTRAINT "task_session_messages_scope_id_uq" UNIQUE("company_id","task_id","session_id","id"),
	CONSTRAINT "task_session_messages_type_check" CHECK ("task_session_messages"."type" in (
        'agent-switched',
        'model-switched',
        'user',
        'synthetic',
        'system',
        'shell',
        'assistant'
      )),
	CONSTRAINT "task_session_messages_data_check" CHECK (jsonb_typeof("task_session_messages"."data") = 'object'
        and not ("task_session_messages"."data" ? 'id')
        and not ("task_session_messages"."data" ? 'type')),
	CONSTRAINT "task_session_messages_time_check" CHECK ("task_session_messages"."time_updated" >= "task_session_messages"."time_created"),
	CONSTRAINT "task_session_messages_seq_check" CHECK ("task_session_messages"."seq" >= 0),
	CONSTRAINT "task_session_messages_model_state_seq_check" CHECK ("task_session_messages"."model_state_seq" >= "task_session_messages"."seq")
);
--> statement-breakpoint
CREATE TABLE "task_session_source_user_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"variant" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_session_source_user_executions_scope_id_message_uq" UNIQUE("company_id","task_id","session_id","id","message_id")
);
--> statement-breakpoint
CREATE TABLE "task_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	CONSTRAINT "task_sessions_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "task_sessions_scope_id_uq" UNIQUE("company_id","task_id","id"),
	CONSTRAINT "task_sessions_integrity_state_check" CHECK ("task_sessions"."integrity_state" in ('building', 'ready', 'archived', 'purge_fenced')),
	CONSTRAINT "task_sessions_projected_event_seq_check" CHECK ("task_sessions"."projected_event_seq" >= -1),
	CONSTRAINT "task_sessions_cost_and_tokens_check" CHECK (("task_sessions"."cost" is null or "task_sessions"."cost" >= 0)
        and (
          (
            "task_sessions"."tokens_input" is null
            and "task_sessions"."tokens_output" is null
            and "task_sessions"."tokens_reasoning" is null
            and "task_sessions"."tokens_cache_read" is null
            and "task_sessions"."tokens_cache_write" is null
          )
          or (
            "task_sessions"."tokens_input" is not null
            and "task_sessions"."tokens_output" is not null
            and "task_sessions"."tokens_reasoning" is not null
            and "task_sessions"."tokens_cache_read" is not null
            and "task_sessions"."tokens_cache_write" is not null
            and "task_sessions"."tokens_input" >= 0
            and "task_sessions"."tokens_output" >= 0
            and "task_sessions"."tokens_reasoning" >= 0
            and "task_sessions"."tokens_cache_read" >= 0
            and "task_sessions"."tokens_cache_write" >= 0
          )
        )),
	CONSTRAINT "task_sessions_time_check" CHECK ("task_sessions"."time_updated" >= "task_sessions"."time_created"
        and ("task_sessions"."time_archived" is null or "task_sessions"."time_archived" >= "task_sessions"."time_created")),
	CONSTRAINT "task_sessions_info_shape_check" CHECK (length("task_sessions"."project_id") > 0
        and length("task_sessions"."title") > 0
        and length("task_sessions"."directory") > 0
        and left("task_sessions"."directory", 1) = '/'
        and ("task_sessions"."agent" is null or length("task_sessions"."agent") > 0)
        and ("task_sessions"."workspace_id" is null or length("task_sessions"."workspace_id") > 0)
        and ("task_sessions"."model" is null or jsonb_typeof("task_sessions"."model") = 'object')
        and ("task_sessions"."revert" is null or jsonb_typeof("task_sessions"."revert") = 'object'))
);
--> statement-breakpoint
CREATE TABLE "task_tree_hold_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"task_identifier" text,
	"task_title" text,
	"task_status" text NOT NULL,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"active_run_id" uuid,
	"active_run_status" text,
	"skipped" boolean DEFAULT false NOT NULL,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_tree_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"root_task_id" uuid NOT NULL,
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
CREATE TABLE "task_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
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
	CONSTRAINT "task_updates_scope_id_uq" UNIQUE("company_id","task_id","ownership_epoch","id"),
	CONSTRAINT "task_updates_form_check" CHECK ("task_updates"."form" in ('owner', 'creator')),
	CONSTRAINT "task_updates_source_kind_check" CHECK ("task_updates"."source_kind" in ('agent-execution', 'user/board', 'plugin', 'routine', 'system')),
	CONSTRAINT "task_updates_status_check" CHECK ("task_updates"."status" is null or "task_updates"."status" in ('open', 'blocked', 'done', 'cancelled')),
	CONSTRAINT "task_updates_message_check" CHECK (char_length("task_updates"."message") > 0),
	CONSTRAINT "task_updates_form_shape_check" CHECK ((
        ("task_updates"."status" is null and "task_updates"."disposition" is null)
        or (
          "task_updates"."status" in ('open', 'blocked')
          and "task_updates"."disposition" is null
          and (
            "task_updates"."form" <> 'creator'
            or "task_updates"."source_kind" = 'agent-execution'
          )
        ) or (
          "task_updates"."form" = 'owner'
          and "task_updates"."status" in ('done', 'cancelled')
          and "task_updates"."disposition" is not null
          and jsonb_typeof("task_updates"."disposition") = 'object'
          and "task_updates"."disposition" ? 'message'
          and jsonb_typeof("task_updates"."disposition" -> 'message') = 'string'
          and btrim("task_updates"."disposition" ->> 'message') <> ''
          and "task_updates"."disposition" - 'message' - 'structuredResult' = '{}'::jsonb
        )
      )),
	CONSTRAINT "task_updates_run_sequence_check" CHECK ("task_updates"."run_sequence" >= 0),
	CONSTRAINT "task_updates_creator_edge_check" CHECK ("task_updates"."creator_edge_id" is not null or (
        "task_updates"."form" = 'owner'
        and "task_updates"."source_kind" = 'plugin'
        and "task_updates"."run_id" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "task_work_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"task_id" uuid NOT NULL,
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
CREATE TABLE "tasks" (
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
	"escalated_from_affected_task_id" uuid,
	"escalated_from_triggering_run_id" uuid,
	"escalated_from_reason" text,
	"affected_ownership_epoch" integer,
	"responsible_user_id" text,
	"task_number" integer,
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
	"source_trust" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "tasks_parent_epoch_check" CHECK ((
        "tasks"."parent_id" is null
        and "tasks"."parent_ownership_epoch" is null
      ) or (
        "tasks"."parent_id" is not null
        and "tasks"."parent_ownership_epoch" > 0
      )),
	CONSTRAINT "tasks_lifecycle_status_check" CHECK ("tasks"."lifecycle_status" in ('open', 'blocked', 'done', 'cancelled')),
	CONSTRAINT "tasks_board_presentation_status_check" CHECK ("tasks"."board_presentation_status" in (
        'backlog',
        'todo',
        'in_progress',
        'in_review',
        'blocked',
        'done',
        'cancelled'
      )),
	CONSTRAINT "tasks_lifecycle_disposition_check" CHECK ((
          "tasks"."lifecycle_status" in ('open', 'blocked')
          and "tasks"."disposition" is null
        )
        or (
          "tasks"."lifecycle_status" in ('done', 'cancelled')
          and "tasks"."disposition" is not null
          and jsonb_typeof("tasks"."disposition") = 'object'
          and "tasks"."disposition" ? 'message'
          and jsonb_typeof("tasks"."disposition" -> 'message') = 'string'
          and btrim("tasks"."disposition" ->> 'message') <> ''
          and "tasks"."disposition" - 'message' - 'structuredResult' = '{}'::jsonb
        )),
	CONSTRAINT "tasks_canonical_contract_check" CHECK (btrim("tasks"."request") <> ''
        and "tasks"."ownership_epoch" > 0),
	CONSTRAINT "tasks_owner_shape_check" CHECK ((
        "tasks"."owner_kind" = 'agent'
        and "tasks"."owner_agent_id" is not null
        and "tasks"."owner_user_id" is null
        and "tasks"."owner_assignment_source" is null
        and "tasks"."ownership_epoch" > 0
      ) or (
        "tasks"."owner_kind" = 'user'
        and "tasks"."owner_agent_id" is null
        and "tasks"."owner_user_id" is not null
        and (
          (
            "tasks"."owner_assignment_source" = 'user_creator_withdrawal'
            and "tasks"."owner_user_id" = "tasks"."creator_user_id"
          )
          or (
            "tasks"."owner_assignment_source" is null
            and "tasks"."creator_kind" = 'system'
            and "tasks"."escalated_from_affected_task_id" is not null
          )
        )
        and "tasks"."ownership_epoch" > 0
      ) or (
        "tasks"."owner_kind" = 'board'
        and "tasks"."owner_agent_id" is null
        and "tasks"."owner_user_id" is null
        and "tasks"."owner_assignment_source" is null
        and "tasks"."ownership_epoch" > 0
        and "tasks"."creator_kind" = 'system'
      )),
	CONSTRAINT "tasks_creator_shape_check" CHECK ((
        "tasks"."creator_kind" = 'agent-execution'
        and "tasks"."creator_authority_id" is not null
        and "tasks"."creator_adapter_config_revision_id" is not null
        and "tasks"."creator_user_id" is null
        and "tasks"."creator_plugin_installation_id" is null
        and "tasks"."creator_plugin_key" is null
        and "tasks"."creator_callback_key" is null
        and "tasks"."creator_callback_version" is null
        and "tasks"."creator_routine_id" is null
        and "tasks"."creator_routine_dispatch_id" is null
        and "tasks"."creator_system_source_kind" is null
        and "tasks"."creator_system_source_id" is null
      ) or (
        "tasks"."creator_kind" = 'user/board'
        and "tasks"."creator_authority_id" is null
        and "tasks"."creator_adapter_config_revision_id" is null
        and "tasks"."creator_plugin_installation_id" is null
        and "tasks"."creator_plugin_key" is null
        and "tasks"."creator_callback_key" is null
        and "tasks"."creator_callback_version" is null
        and "tasks"."creator_routine_id" is null
        and "tasks"."creator_routine_dispatch_id" is null
        and "tasks"."creator_system_source_kind" is null
        and "tasks"."creator_system_source_id" is null
      ) or (
        "tasks"."creator_kind" = 'plugin'
        and "tasks"."creator_authority_id" is null
        and "tasks"."creator_adapter_config_revision_id" is null
        and "tasks"."creator_user_id" is null
        and "tasks"."creator_plugin_installation_id" is not null
        and "tasks"."creator_plugin_key" is not null
        and "tasks"."creator_callback_key" is not null
        and "tasks"."creator_callback_version" is not null
        and "tasks"."creator_routine_id" is null
        and "tasks"."creator_routine_dispatch_id" is null
        and "tasks"."creator_system_source_kind" is null
        and "tasks"."creator_system_source_id" is null
      ) or (
        "tasks"."creator_kind" = 'routine'
        and "tasks"."creator_authority_id" is null
        and "tasks"."creator_adapter_config_revision_id" is null
        and "tasks"."creator_user_id" is null
        and "tasks"."creator_plugin_installation_id" is null
        and "tasks"."creator_plugin_key" is null
        and "tasks"."creator_callback_key" is null
        and "tasks"."creator_callback_version" is null
        and "tasks"."creator_routine_id" is not null
        and "tasks"."creator_routine_dispatch_id" is not null
        and "tasks"."creator_system_source_kind" is null
        and "tasks"."creator_system_source_id" is null
      ) or (
        "tasks"."creator_kind" = 'system'
        and "tasks"."creator_authority_id" is null
        and "tasks"."creator_adapter_config_revision_id" is null
        and "tasks"."creator_user_id" is null
        and "tasks"."creator_plugin_installation_id" is null
        and "tasks"."creator_plugin_key" is null
        and "tasks"."creator_callback_key" is null
        and "tasks"."creator_callback_version" is null
        and "tasks"."creator_routine_id" is null
        and "tasks"."creator_routine_dispatch_id" is null
        and "tasks"."creator_system_source_kind" is not null
        and "tasks"."creator_system_source_kind" in ('recovery', 'liveness')
        and "tasks"."creator_system_source_id" is not null
      )),
	CONSTRAINT "tasks_escalation_shape_check" CHECK ((
        "tasks"."escalated_from_affected_task_id" is null
        and "tasks"."escalated_from_triggering_run_id" is null
        and "tasks"."escalated_from_reason" is null
        and "tasks"."affected_ownership_epoch" is null
        and "tasks"."creator_kind" <> 'system'
      ) or (
        "tasks"."escalated_from_affected_task_id" is not null
        and "tasks"."escalated_from_affected_task_id" <> "tasks"."id"
        and "tasks"."escalated_from_reason" is not null
        and "tasks"."affected_ownership_epoch" is not null
        and "tasks"."affected_ownership_epoch" > 0
        and "tasks"."creator_kind" = 'system'
        and "tasks"."parent_id" is null
      ))
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
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_session_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_run_revision_fk" FOREIGN KEY ("company_id","task_id","run_id","run_kind","adapter_config_revision_id") REFERENCES "public"."task_execution_runs"("company_id","task_id","id","kind","adapter_config_revision_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_adapter_revision_fk" FOREIGN KEY ("company_id","agent_id","adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_productive_attempt_fk" FOREIGN KEY ("company_id","task_id","run_id","attempt_id","run_kind","prompt_kind","run_ordinal","ref_id","segment_ordinal") REFERENCES "public"."task_execution_attempts"("company_id","task_id","run_id","id","run_kind","prompt_kind","ref_ordinal","ref_id","segment_ordinal") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_run_ref_fk" FOREIGN KEY ("company_id","task_id","session_id","run_id","run_ordinal","ref_id") REFERENCES "public"."task_execution_run_refs"("company_id","task_id","session_id","run_id","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_run_id_task_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_responsible_user_id_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_action_grants" ADD CONSTRAINT "agent_action_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_action_grants" ADD CONSTRAINT "agent_action_grants_granted_by_agent_id_agents_id_fk" FOREIGN KEY ("granted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_action_grants" ADD CONSTRAINT "agent_action_grants_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_action_grants" ADD CONSTRAINT "agent_action_grants_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_parent_revision_id_agent_adapter_config_revisions_id_fk" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "agent_runtime_state" ADD CONSTRAINT "agent_runtime_state_last_run_fk" FOREIGN KEY ("company_id","last_run_id") REFERENCES "public"."task_execution_runs"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_reports_to_agents_id_fk" FOREIGN KEY ("reports_to") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_current_adapter_config_revision_id_agent_adapter_config_revisions_id_fk" FOREIGN KEY ("current_adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "change_consents" ADD CONSTRAINT "change_consents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_consents" ADD CONSTRAINT "change_consents_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_consents" ADD CONSTRAINT "change_consents_source_run_id_task_execution_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_consents" ADD CONSTRAINT "change_consents_consumed_by_run_id_task_execution_runs_id_fk" FOREIGN KEY ("consumed_by_run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_auth_challenges" ADD CONSTRAINT "cli_auth_challenges_requested_company_id_companies_id_fk" FOREIGN KEY ("requested_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_auth_challenges" ADD CONSTRAINT "cli_auth_challenges_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_auth_challenges" ADD CONSTRAINT "cli_auth_challenges_board_api_key_id_board_api_keys_id_fk" FOREIGN KEY ("board_api_key_id") REFERENCES "public"."board_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_default_responsible_user_id_user_id_fk" FOREIGN KEY ("default_responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "company_skill_test_runs" ADD CONSTRAINT "company_skill_test_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_accounting_id_acp_prompt_accounting_id_fk" FOREIGN KEY ("accounting_id") REFERENCES "public"."acp_prompt_accounting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_company_budget_currency_fk" FOREIGN KEY ("company_id","budget_currency") REFERENCES "public"."companies"("id","budget_currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_productive_accounting_fk" FOREIGN KEY ("company_id","task_id","agent_id","run_id","run_kind","ref_id","run_ordinal","segment_ordinal","accounting_id") REFERENCES "public"."acp_prompt_accounting"("company_id","task_id","agent_id","run_id","run_kind","ref_id","run_ordinal","segment_ordinal","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_thread_id_document_annotation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."document_annotation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_from_revision_id_document_revisions_id_fk" FOREIGN KEY ("from_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_anchor_snapshots" ADD CONSTRAINT "document_annotation_anchor_snapshots_to_revision_id_document_revisions_id_fk" FOREIGN KEY ("to_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_thread_id_document_annotation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."document_annotation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_created_by_run_id_task_execution_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_task_comment_id_task_comments_id_fk" FOREIGN KEY ("task_comment_id") REFERENCES "public"."task_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_created_by_run_id_task_execution_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_source_task_comment_id_task_comments_id_fk" FOREIGN KEY ("source_task_comment_id") REFERENCES "public"."task_comments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_locked_by_agent_id_agents_id_fk" FOREIGN KEY ("locked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_locked_by_user_id_user_id_fk" FOREIGN KEY ("locked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_parent_id_goals_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_dismissals" ADD CONSTRAINT "inbox_dismissals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_dismissals" ADD CONSTRAINT "inbox_dismissals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_user_roles" ADD CONSTRAINT "instance_user_roles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_requesting_user_id_user_id_fk" FOREIGN KEY ("requesting_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_created_agent_id_agents_id_fk" FOREIGN KEY ("created_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_created_agent_adapter_config_revision_id_agent_adapter_config_revisions_id_fk" FOREIGN KEY ("created_agent_adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_rejected_by_user_id_user_id_fk" FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_execution_leases" ADD CONSTRAINT "local_execution_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_execution_leases" ADD CONSTRAINT "local_execution_leases_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_execution_leases" ADD CONSTRAINT "local_execution_leases_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_execution_leases" ADD CONSTRAINT "local_execution_leases_run_id_task_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_company_settings" ADD CONSTRAINT "plugin_company_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_company_settings" ADD CONSTRAINT "plugin_company_settings_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_config" ADD CONSTRAINT "plugin_config_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_database_namespaces" ADD CONSTRAINT "plugin_database_namespaces_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_entities" ADD CONSTRAINT "plugin_entities_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_entities" ADD CONSTRAINT "plugin_entities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD CONSTRAINT "plugin_job_runs_job_id_plugin_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."plugin_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD CONSTRAINT "plugin_job_runs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_jobs" ADD CONSTRAINT "plugin_jobs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_logs" ADD CONSTRAINT "plugin_logs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_logs" ADD CONSTRAINT "plugin_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_managed_resources" ADD CONSTRAINT "plugin_managed_resources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_managed_resources" ADD CONSTRAINT "plugin_managed_resources_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_migrations" ADD CONSTRAINT "plugin_migrations_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_run_contexts" ADD CONSTRAINT "plugin_run_contexts_plugin_installation_id_plugins_id_fk" FOREIGN KEY ("plugin_installation_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_run_contexts" ADD CONSTRAINT "plugin_run_contexts_capability_generation_fk" FOREIGN KEY ("capability_connection_id","capability_generation") REFERENCES "public"."task_execution_prompt_capabilities"("capability_connection_id","capability_generation") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_run_contexts" ADD CONSTRAINT "plugin_run_contexts_exact_tool_call_fk" FOREIGN KEY ("capability_connection_id","capability_generation","run_interface_tool_call_id","plugin_installation_id") REFERENCES "public"."run_interface_tool_calls"("capability_connection_id","capability_generation","id","plugin_installation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_state" ADD CONSTRAINT "plugin_state_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" ADD CONSTRAINT "plugin_webhook_deliveries_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_withdrawal_operations" ADD CONSTRAINT "plugin_withdrawal_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_withdrawal_operations" ADD CONSTRAINT "plugin_withdrawal_operations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_withdrawal_operations" ADD CONSTRAINT "plugin_withdrawal_operations_task_update_id_task_updates_id_fk" FOREIGN KEY ("task_update_id") REFERENCES "public"."task_updates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_withdrawal_operations" ADD CONSTRAINT "plugin_withdrawal_operations_mutation_comment_id_task_comments_id_fk" FOREIGN KEY ("mutation_comment_id") REFERENCES "public"."task_comments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_documents" ADD CONSTRAINT "routine_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_documents" ADD CONSTRAINT "routine_documents_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_documents" ADD CONSTRAINT "routine_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_restored_from_revision_id_routine_revisions_id_fk" FOREIGN KEY ("restored_from_revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_created_by_run_id_task_execution_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_responsible_user_id_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_trigger_id_routine_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."routine_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_revision_id_routine_revisions_id_fk" FOREIGN KEY ("routine_revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_responsible_user_id_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_linked_task_id_tasks_id_fk" FOREIGN KEY ("linked_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "routines" ADD CONSTRAINT "routines_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_responsible_user_id_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" ADD CONSTRAINT "run_interface_tool_calls_capability_generation_fk" FOREIGN KEY ("company_id","capability_connection_id","capability_generation") REFERENCES "public"."task_execution_prompt_capabilities"("company_id","capability_connection_id","capability_generation") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_agent_configuration_audits" ADD CONSTRAINT "runtime_agent_configuration_audits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_agent_configuration_audits" ADD CONSTRAINT "runtime_agent_configuration_audits_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_agent_configuration_audits" ADD CONSTRAINT "runtime_agent_configuration_audits_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_user_secret_definition_id_user_secret_definitions_id_fk" FOREIGN KEY ("user_secret_definition_id") REFERENCES "public"."user_secret_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_responsible_user_id_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_credential_owner_user_id_user_id_fk" FOREIGN KEY ("credential_owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_run_id_task_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD CONSTRAINT "secret_access_events_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_escalation_identities" ADD CONSTRAINT "system_escalation_identities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_escalation_identities" ADD CONSTRAINT "system_escalation_identities_affected_task_id_tasks_id_fk" FOREIGN KEY ("affected_task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_escalation_identities" ADD CONSTRAINT "system_escalation_identities_escalation_task_id_tasks_id_fk" FOREIGN KEY ("escalation_task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_escalation_identities" ADD CONSTRAINT "system_escalation_identities_triggering_run_id_task_execution_runs_id_fk" FOREIGN KEY ("triggering_run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_escalation_identities" ADD CONSTRAINT "system_escalation_identities_terminal_creator_edge_id_task_creator_edge_receivability_id_fk" FOREIGN KEY ("terminal_creator_edge_id") REFERENCES "public"."task_creator_edge_receivability"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_approvals" ADD CONSTRAINT "task_approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_approvals" ADD CONSTRAINT "task_approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_approvals" ADD CONSTRAINT "task_approvals_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_approvals" ADD CONSTRAINT "task_approvals_linked_by_agent_id_agents_id_fk" FOREIGN KEY ("linked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_approvals" ADD CONSTRAINT "task_approvals_linked_by_user_id_user_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_task_comment_id_task_comments_id_fk" FOREIGN KEY ("task_comment_id") REFERENCES "public"."task_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_lifecycle_commands" ADD CONSTRAINT "task_board_lifecycle_commands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_lifecycle_commands" ADD CONSTRAINT "task_board_lifecycle_commands_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_lifecycle_commands" ADD CONSTRAINT "task_board_lifecycle_commands_creator_edge_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch") REFERENCES "public"."task_creator_edge_receivability"("company_id","task_id","ownership_epoch") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_mentions" ADD CONSTRAINT "task_board_mentions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_mentions" ADD CONSTRAINT "task_board_mentions_task_fk" FOREIGN KEY ("company_id","task_id") REFERENCES "public"."tasks"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_mentions" ADD CONSTRAINT "task_board_mentions_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_mentions" ADD CONSTRAINT "task_board_mentions_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."task_execution_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_mentions" ADD CONSTRAINT "task_board_mentions_comment_fk" FOREIGN KEY ("company_id","task_id","comment_id") REFERENCES "public"."task_comments"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_reopen_commands" ADD CONSTRAINT "task_board_reopen_commands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_reopen_commands" ADD CONSTRAINT "task_board_reopen_commands_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_reopen_commands" ADD CONSTRAINT "task_board_reopen_commands_task_fk" FOREIGN KEY ("company_id","task_id") REFERENCES "public"."tasks"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_reopen_commands" ADD CONSTRAINT "task_board_reopen_commands_creator_edge_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch","creator_edge_id") REFERENCES "public"."task_creator_edge_receivability"("company_id","task_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_reopen_commands" ADD CONSTRAINT "task_board_reopen_commands_ref_fk" FOREIGN KEY ("company_id","task_id","execution_ref_id") REFERENCES "public"."task_execution_refs"("company_id","task_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_reopen_commands" ADD CONSTRAINT "task_board_reopen_commands_system_escalation_fk" FOREIGN KEY ("company_id","task_id","system_escalation_identity_id") REFERENCES "public"."system_escalation_identities"("company_id","escalation_task_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_user_comments" ADD CONSTRAINT "task_board_user_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_user_comments" ADD CONSTRAINT "task_board_user_comments_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_user_comments" ADD CONSTRAINT "task_board_user_comments_creator_edge_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch") REFERENCES "public"."task_creator_edge_receivability"("company_id","task_id","ownership_epoch") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_user_comments" ADD CONSTRAINT "task_board_user_comments_comment_fk" FOREIGN KEY ("company_id","task_id","comment_id") REFERENCES "public"."task_comments"("company_id","task_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_user_comments" ADD CONSTRAINT "task_board_user_comments_ref_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch","execution_ref_id") REFERENCES "public"."task_execution_refs"("company_id","task_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comment_projection_sources" ADD CONSTRAINT "task_comment_projection_sources_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comment_projection_sources" ADD CONSTRAINT "task_comment_projection_sources_run_fk" FOREIGN KEY ("company_id","task_id","session_id","run_id") REFERENCES "public"."task_execution_runs"("company_id","task_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comment_projection_sources" ADD CONSTRAINT "task_comment_projection_sources_comment_fk" FOREIGN KEY ("company_id","task_id","comment_id","projected_event_seq") REFERENCES "public"."task_comments"("company_id","task_id","id","projected_event_seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comment_projection_sources" ADD CONSTRAINT "task_comment_projection_sources_reply_parent_fk" FOREIGN KEY ("company_id","task_id","reply_to_comment_id","reply_to_projected_event_seq") REFERENCES "public"."task_comments"("company_id","task_id","id","projected_event_seq") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comment_projection_sources" ADD CONSTRAINT "task_comment_projection_sources_thread_root_fk" FOREIGN KEY ("company_id","task_id","thread_root_comment_id","thread_root_projected_event_seq") REFERENCES "public"."task_comments"("company_id","task_id","id","projected_event_seq") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comment_projection_sources" ADD CONSTRAINT "task_comment_projection_sources_steering_segment_fk" FOREIGN KEY ("company_id","task_id","session_id","steering_target_run_id","ref_ordinal","ref_id","segment_ordinal") REFERENCES "public"."task_execution_prompt_segments"("company_id","task_id","session_id","run_id","ref_ordinal","ref_id","segment_ordinal") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comment_projection_sources" ADD CONSTRAINT "task_comment_projection_sources_terminal_message_fk" FOREIGN KEY ("company_id","task_id","session_id","terminal_session_message_id") REFERENCES "public"."task_session_messages"("company_id","task_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_agent_scope_fk" FOREIGN KEY ("company_id","author_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_run_scope_fk" FOREIGN KEY ("company_id","task_id","run_id") REFERENCES "public"."task_execution_runs"("company_id","task_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_session_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_reply_parent_fk" FOREIGN KEY ("company_id","task_id","reply_to_comment_id","reply_to_projected_event_seq") REFERENCES "public"."task_comments"("company_id","task_id","id","projected_event_seq") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_thread_root_fk" FOREIGN KEY ("company_id","task_id","thread_root_comment_id","thread_root_projected_event_seq") REFERENCES "public"."task_comments"("company_id","task_id","id","projected_event_seq") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_consult_executions" ADD CONSTRAINT "task_consult_executions_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_consult_executions" ADD CONSTRAINT "task_consult_executions_source_run_fk" FOREIGN KEY ("company_id","source_run_id") REFERENCES "public"."task_execution_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_consult_executions" ADD CONSTRAINT "task_consult_executions_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_consult_executions" ADD CONSTRAINT "task_consult_executions_adapter_revision_fk" FOREIGN KEY ("company_id","target_agent_id","adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_create_idempotency_keys" ADD CONSTRAINT "task_create_idempotency_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_create_idempotency_keys" ADD CONSTRAINT "task_create_idempotency_keys_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_creator_edge_receivability" ADD CONSTRAINT "task_creator_edge_receivability_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_creator_withdrawal_commands" ADD CONSTRAINT "task_creator_withdrawal_commands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_creator_withdrawal_commands" ADD CONSTRAINT "task_creator_withdrawal_commands_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_creator_withdrawal_commands" ADD CONSTRAINT "task_creator_withdrawal_commands_resulting_edge_fk" FOREIGN KEY ("company_id","task_id","resulting_ownership_epoch","resulting_creator_edge_id") REFERENCES "public"."task_creator_edge_receivability"("company_id","task_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_creator_withdrawal_commands" ADD CONSTRAINT "task_creator_withdrawal_commands_outgoing_edge_fk" FOREIGN KEY ("company_id","task_id","outgoing_ownership_epoch") REFERENCES "public"."task_creator_edge_receivability"("company_id","task_id","ownership_epoch") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_creator_withdrawal_commands" ADD CONSTRAINT "task_creator_withdrawal_commands_update_fk" FOREIGN KEY ("company_id","task_id","resulting_ownership_epoch","task_update_id") REFERENCES "public"."task_updates"("company_id","task_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_creator_withdrawal_commands" ADD CONSTRAINT "task_creator_withdrawal_commands_plugin_operation_fk" FOREIGN KEY ("company_id","task_id","plugin_withdrawal_operation_id","actor_plugin_installation_id","actor_plugin_key","task_update_id") REFERENCES "public"."plugin_withdrawal_operations"("company_id","task_id","id","plugin_installation_id","plugin_key","task_update_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_attempt_retry_schedules" ADD CONSTRAINT "task_execution_attempt_retry_schedules_predecessor_fk" FOREIGN KEY ("company_id","task_id","run_id","predecessor_attempt_id") REFERENCES "public"."task_execution_attempts"("company_id","task_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_attempt_retry_schedules" ADD CONSTRAINT "task_execution_attempt_retry_schedules_successor_fk" FOREIGN KEY ("company_id","task_id","run_id","successor_attempt_id") REFERENCES "public"."task_execution_attempts"("company_id","task_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_attempts" ADD CONSTRAINT "task_execution_attempts_run_fk" FOREIGN KEY ("company_id","task_id","session_id","run_id") REFERENCES "public"."task_execution_runs"("company_id","task_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_attempts" ADD CONSTRAINT "task_execution_attempts_run_kind_fk" FOREIGN KEY ("company_id","task_id","run_id","run_kind") REFERENCES "public"."task_execution_runs"("company_id","task_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_attempts" ADD CONSTRAINT "task_execution_attempts_base_member_fk" FOREIGN KEY ("company_id","task_id","session_id","run_id","ref_ordinal","ref_id") REFERENCES "public"."task_execution_run_refs"("company_id","task_id","session_id","run_id","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_attempts" ADD CONSTRAINT "task_execution_attempts_steering_segment_fk" FOREIGN KEY ("company_id","task_id","session_id","run_id","ref_ordinal","ref_id","steering_segment_ordinal") REFERENCES "public"."task_execution_prompt_segments"("company_id","task_id","session_id","run_id","ref_ordinal","ref_id","segment_ordinal") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_authorities" ADD CONSTRAINT "task_execution_authorities_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_authorities" ADD CONSTRAINT "task_execution_authorities_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_authorities" ADD CONSTRAINT "task_execution_authorities_adapter_revision_fk" FOREIGN KEY ("company_id","agent_id","audit_adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_cancellation_intents" ADD CONSTRAINT "task_execution_cancellation_intents_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_cancellation_intents" ADD CONSTRAINT "task_execution_cancellation_intents_attempt_fk" FOREIGN KEY ("company_id","task_id","run_id","attempt_id") REFERENCES "public"."task_execution_attempts"("company_id","task_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_cancellation_intents" ADD CONSTRAINT "task_execution_cancellation_intents_lease_fk" FOREIGN KEY ("company_id","task_id","run_id","attempt_id","lease_id") REFERENCES "public"."task_execution_leases"("company_id","task_id","run_id","attempt_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_cancellation_intents" ADD CONSTRAINT "task_execution_cancellation_intents_actor_agent_fk" FOREIGN KEY ("company_id","actor_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_decisions" ADD CONSTRAINT "task_execution_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_decisions" ADD CONSTRAINT "task_execution_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_decisions" ADD CONSTRAINT "task_execution_decisions_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_decisions" ADD CONSTRAINT "task_execution_decisions_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_decisions" ADD CONSTRAINT "task_execution_decisions_created_by_run_id_task_execution_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_finalization_prompt_dependencies" ADD CONSTRAINT "task_execution_finalization_prompt_dependencies_finalization_fk" FOREIGN KEY ("company_id","run_id","finalization_id") REFERENCES "public"."task_execution_finalizations"("company_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_finalization_prompt_dependencies" ADD CONSTRAINT "task_execution_finalization_prompt_dependencies_run_ref_fk" FOREIGN KEY ("company_id","task_id","run_id","ref_ordinal","ref_id") REFERENCES "public"."task_execution_run_refs"("company_id","task_id","run_id","ref_ordinal","ref_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_finalization_prompt_dependencies" ADD CONSTRAINT "task_execution_finalization_prompt_dependencies_accounting_fk" FOREIGN KEY ("company_id","task_id","run_id","accounting_id") REFERENCES "public"."acp_prompt_accounting"("company_id","task_id","run_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_finalization_prompt_dependencies" ADD CONSTRAINT "task_execution_finalization_prompt_dependencies_cost_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_finalization_update_dependencies" ADD CONSTRAINT "task_execution_finalization_update_dependencies_finalization_fk" FOREIGN KEY ("company_id","run_id","finalization_id") REFERENCES "public"."task_execution_finalizations"("company_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_finalization_update_dependencies" ADD CONSTRAINT "task_execution_finalization_update_dependencies_update_fk" FOREIGN KEY ("task_update_id") REFERENCES "public"."task_updates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_finalizations" ADD CONSTRAINT "task_execution_finalizations_terminal_session_event_id_task_session_events_id_fk" FOREIGN KEY ("terminal_session_event_id") REFERENCES "public"."task_session_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_finalizations" ADD CONSTRAINT "task_execution_finalizations_terminal_session_message_id_task_session_messages_id_fk" FOREIGN KEY ("terminal_session_message_id") REFERENCES "public"."task_session_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_finalizations" ADD CONSTRAINT "task_execution_finalizations_progress_comment_id_task_comments_id_fk" FOREIGN KEY ("progress_comment_id") REFERENCES "public"."task_comments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_finalizations" ADD CONSTRAINT "task_execution_finalizations_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."task_execution_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_finalizations" ADD CONSTRAINT "task_execution_finalizations_liveness_fact_fk" FOREIGN KEY ("run_id","run_liveness_fact_id") REFERENCES "public"."task_execution_run_liveness_facts"("run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_finalizations" ADD CONSTRAINT "task_execution_finalizations_gateway_revocation_fk" FOREIGN KEY ("gateway_capability_connection_id","gateway_capability_generation") REFERENCES "public"."task_execution_prompt_capabilities"("capability_connection_id","capability_generation") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_history_view_messages" ADD CONSTRAINT "task_execution_history_view_messages_view_fk" FOREIGN KEY ("company_id","task_id","session_id","history_view_id") REFERENCES "public"."task_execution_history_views"("company_id","task_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_history_view_messages" ADD CONSTRAINT "task_execution_history_view_messages_message_fk" FOREIGN KEY ("company_id","task_id","session_id","message_id") REFERENCES "public"."task_session_messages"("company_id","task_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_history_views" ADD CONSTRAINT "task_execution_history_views_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_history_views" ADD CONSTRAINT "task_execution_history_views_ref_fk" FOREIGN KEY ("company_id","task_id","session_id","ref_id") REFERENCES "public"."task_execution_refs"("company_id","task_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_lanes" ADD CONSTRAINT "task_execution_lanes_task_fk" FOREIGN KEY ("company_id","task_id") REFERENCES "public"."tasks"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_lanes" ADD CONSTRAINT "task_execution_lanes_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_leases" ADD CONSTRAINT "task_execution_leases_attempt_fk" FOREIGN KEY ("company_id","task_id","run_id","attempt_id") REFERENCES "public"."task_execution_attempts"("company_id","task_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_capabilities" ADD CONSTRAINT "task_execution_prompt_capabilities_prompt_scope_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch","run_id","target_agent_id","adapter_config_identity","workspace_identity","execution_mode") REFERENCES "public"."task_execution_runs"("company_id","task_id","ownership_epoch","id","target_agent_id","adapter_config_revision_id","execution_workspace_binding_id","execution_mode") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_capabilities" ADD CONSTRAINT "task_execution_prompt_capabilities_run_ref_fk" FOREIGN KEY ("run_id","ref_ordinal","ref_id","run_batch_digest") REFERENCES "public"."task_execution_run_refs"("run_id","ref_ordinal","ref_id","batch_digest") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_capabilities" ADD CONSTRAINT "task_execution_prompt_capabilities_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_capabilities" ADD CONSTRAINT "task_execution_prompt_capabilities_authority_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch","target_agent_id","task_execution_authority_id") REFERENCES "public"."task_execution_authorities"("company_id","task_id","ownership_epoch","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_capabilities" ADD CONSTRAINT "task_execution_prompt_capabilities_consult_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch","target_agent_id","consult_execution_id") REFERENCES "public"."task_consult_executions"("company_id","task_id","ownership_epoch","target_agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_capabilities" ADD CONSTRAINT "task_execution_prompt_capabilities_adapter_identity_fk" FOREIGN KEY ("company_id","target_agent_id","adapter_config_identity") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_capabilities" ADD CONSTRAINT "task_execution_prompt_capabilities_workspace_identity_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch","workspace_identity") REFERENCES "public"."task_execution_workspace_bindings"("company_id","task_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_capabilities" ADD CONSTRAINT "task_execution_prompt_capabilities_native_correlation_fk" FOREIGN KEY ("company_id","target_session_correlation_id") REFERENCES "public"."task_execution_sessions"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_segments" ADD CONSTRAINT "task_execution_prompt_segments_source_comment_id_task_comments_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."task_comments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_segments" ADD CONSTRAINT "task_execution_prompt_segments_attempt_id_task_execution_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."task_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_segments" ADD CONSTRAINT "task_execution_prompt_segments_cancellation_intent_id_task_execution_cancellation_intents_id_fk" FOREIGN KEY ("cancellation_intent_id") REFERENCES "public"."task_execution_cancellation_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_segments" ADD CONSTRAINT "task_execution_prompt_segments_run_ref_fk" FOREIGN KEY ("run_id","ref_ordinal","ref_id") REFERENCES "public"."task_execution_run_refs"("run_id","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_segments" ADD CONSTRAINT "task_execution_prompt_segments_resume_source_correlation_fk" FOREIGN KEY ("company_id","resume_source_correlation_id") REFERENCES "public"."task_execution_sessions"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_segments" ADD CONSTRAINT "task_execution_prompt_segments_source_message_fk" FOREIGN KEY ("company_id","task_id","session_id","source_message_id") REFERENCES "public"."task_session_messages"("company_id","task_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_segments" ADD CONSTRAINT "task_execution_prompt_segments_source_input_fk" FOREIGN KEY ("company_id","task_id","session_id","source_input_id") REFERENCES "public"."task_session_inputs"("company_id","task_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_segments" ADD CONSTRAINT "task_execution_prompt_segments_terminal_message_fk" FOREIGN KEY ("company_id","task_id","session_id","terminal_session_message_id") REFERENCES "public"."task_session_messages"("company_id","task_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_prompt_segments" ADD CONSTRAINT "task_execution_prompt_segments_source_ref_fk" FOREIGN KEY ("company_id","task_id","session_id","source_ref_id") REFERENCES "public"."task_execution_refs"("company_id","task_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_refs" ADD CONSTRAINT "task_execution_refs_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_refs" ADD CONSTRAINT "task_execution_refs_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_refs" ADD CONSTRAINT "task_execution_refs_adapter_revision_fk" FOREIGN KEY ("company_id","target_agent_id","adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_refs" ADD CONSTRAINT "task_execution_refs_lane_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch","target_agent_id") REFERENCES "public"."task_execution_lanes"("company_id","task_id","ownership_epoch","target_agent_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_refs" ADD CONSTRAINT "task_execution_refs_authority_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch","target_agent_id","task_execution_authority_id") REFERENCES "public"."task_execution_authorities"("company_id","task_id","ownership_epoch","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_refs" ADD CONSTRAINT "task_execution_refs_consult_fk" FOREIGN KEY ("company_id","task_id","session_id","consult_execution_id") REFERENCES "public"."task_consult_executions"("company_id","task_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_run_controls" ADD CONSTRAINT "task_execution_run_controls_run_id_task_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_run_controls" ADD CONSTRAINT "task_execution_run_controls_current_member_fk" FOREIGN KEY ("run_id","current_ordinal","current_ref_id") REFERENCES "public"."task_execution_run_refs"("run_id","ref_ordinal","ref_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_run_liveness_facts" ADD CONSTRAINT "task_execution_run_liveness_facts_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."task_execution_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_run_refs" ADD CONSTRAINT "task_execution_run_refs_attempt_id_task_execution_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."task_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_run_refs" ADD CONSTRAINT "task_execution_run_refs_run_fk" FOREIGN KEY ("company_id","task_id","session_id","run_id") REFERENCES "public"."task_execution_runs"("company_id","task_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_run_refs" ADD CONSTRAINT "task_execution_run_refs_ref_fk" FOREIGN KEY ("company_id","task_id","session_id","ref_id") REFERENCES "public"."task_execution_refs"("company_id","task_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_run_refs" ADD CONSTRAINT "task_execution_run_refs_input_fk" FOREIGN KEY ("company_id","task_id","session_id","input_id") REFERENCES "public"."task_session_inputs"("company_id","task_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_adapter_config_revision_id_agent_adapter_config_revisions_id_fk" FOREIGN KEY ("adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_current_attempt_id_task_execution_attempts_id_fk" FOREIGN KEY ("current_attempt_id") REFERENCES "public"."task_execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_current_lease_id_task_execution_leases_id_fk" FOREIGN KEY ("current_lease_id") REFERENCES "public"."task_execution_leases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_cancellation_intent_id_task_execution_cancellation_intents_id_fk" FOREIGN KEY ("cancellation_intent_id") REFERENCES "public"."task_execution_cancellation_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_terminal_finalization_id_task_execution_finalizations_id_fk" FOREIGN KEY ("terminal_finalization_id") REFERENCES "public"."task_execution_finalizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_session_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_lane_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch","target_agent_id") REFERENCES "public"."task_execution_lanes"("company_id","task_id","ownership_epoch","target_agent_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_adapter_revision_fk" FOREIGN KEY ("company_id","target_agent_id","adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_authority_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch","target_agent_id","task_execution_authority_id") REFERENCES "public"."task_execution_authorities"("company_id","task_id","ownership_epoch","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_consult_fk" FOREIGN KEY ("company_id","task_id","session_id","consult_execution_id") REFERENCES "public"."task_consult_executions"("company_id","task_id","session_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_workspace_binding_fk" FOREIGN KEY ("company_id","task_id","session_id","ownership_epoch","execution_workspace_binding_id") REFERENCES "public"."task_execution_workspace_bindings"("company_id","task_id","session_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_parent_fk" FOREIGN KEY ("company_id","task_id","parent_run_id") REFERENCES "public"."task_execution_runs"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_runs" ADD CONSTRAINT "task_execution_runs_retry_fk" FOREIGN KEY ("company_id","task_id","retry_of_run_id") REFERENCES "public"."task_execution_runs"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ADD CONSTRAINT "task_execution_sessions_cost_cursor_currency_fk" FOREIGN KEY ("company_id","cost_cursor_currency") REFERENCES "public"."companies"("id","budget_currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ADD CONSTRAINT "task_execution_sessions_task_fk" FOREIGN KEY ("company_id","task_id") REFERENCES "public"."tasks"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ADD CONSTRAINT "task_execution_sessions_target_agent_fk" FOREIGN KEY ("company_id","target_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ADD CONSTRAINT "task_execution_sessions_adapter_config_identity_fk" FOREIGN KEY ("company_id","target_agent_id","adapter_config_identity") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ADD CONSTRAINT "task_execution_sessions_workspace_identity_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch","workspace_identity") REFERENCES "public"."task_execution_workspace_bindings"("company_id","task_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ADD CONSTRAINT "task_execution_sessions_steering_target_scope_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch","run_id","target_agent_id","adapter_config_identity","workspace_identity") REFERENCES "public"."task_execution_runs"("company_id","task_id","ownership_epoch","id","target_agent_id","adapter_config_revision_id","execution_workspace_binding_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ADD CONSTRAINT "task_execution_sessions_current_run_ref_fk" FOREIGN KEY ("run_id","current_ref_ordinal","current_ref_id") REFERENCES "public"."task_execution_run_refs"("run_id","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_sessions" ADD CONSTRAINT "task_execution_sessions_last_settled_run_ref_fk" FOREIGN KEY ("last_protocol_settled_run_id","last_protocol_settled_ref_ordinal","last_protocol_settled_ref_id") REFERENCES "public"."task_execution_run_refs"("run_id","ref_ordinal","ref_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_workspace_bindings" ADD CONSTRAINT "task_execution_workspace_bindings_bound_by_agent_id_agents_id_fk" FOREIGN KEY ("bound_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_workspace_bindings" ADD CONSTRAINT "task_execution_workspace_bindings_bound_by_user_id_user_id_fk" FOREIGN KEY ("bound_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_workspace_bindings" ADD CONSTRAINT "task_execution_workspace_bindings_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_workspace_bindings" ADD CONSTRAINT "task_execution_workspace_bindings_workspace_fk" FOREIGN KEY ("company_id","execution_workspace_id") REFERENCES "public"."execution_workspaces"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_inbox_archives" ADD CONSTRAINT "task_inbox_archives_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_inbox_archives" ADD CONSTRAINT "task_inbox_archives_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_inbox_archives" ADD CONSTRAINT "task_inbox_archives_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_inbox_archives" ADD CONSTRAINT "task_inbox_archives_archived_by_agent_id_agents_id_fk" FOREIGN KEY ("archived_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_inbox_archives" ADD CONSTRAINT "task_inbox_archives_archived_by_run_id_task_execution_runs_id_fk" FOREIGN KEY ("archived_by_run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_read_states" ADD CONSTRAINT "task_read_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_read_states" ADD CONSTRAINT "task_read_states_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_read_states" ADD CONSTRAINT "task_read_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reference_mentions" ADD CONSTRAINT "task_reference_mentions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reference_mentions" ADD CONSTRAINT "task_reference_mentions_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reference_mentions" ADD CONSTRAINT "task_reference_mentions_target_task_id_tasks_id_fk" FOREIGN KEY ("target_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_related_task_id_tasks_id_fk" FOREIGN KEY ("related_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_context_epochs" ADD CONSTRAINT "task_session_context_epochs_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_event_sequences" ADD CONSTRAINT "task_session_event_sequences_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_events" ADD CONSTRAINT "task_session_events_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_events" ADD CONSTRAINT "task_session_events_sequence_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_session_event_sequences"("company_id","task_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_events" ADD CONSTRAINT "task_session_events_company_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."task_execution_runs"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_events" ADD CONSTRAINT "task_session_events_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_events" ADD CONSTRAINT "task_session_events_adapter_revision_fk" FOREIGN KEY ("company_id","agent_id","adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_input_dispositions" ADD CONSTRAINT "task_session_input_dispositions_input_fk" FOREIGN KEY ("company_id","task_id","session_id","input_id") REFERENCES "public"."task_session_inputs"("company_id","task_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_inputs" ADD CONSTRAINT "task_session_inputs_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_message_id_allocators" ADD CONSTRAINT "task_session_message_id_allocators_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_message_id_reservations" ADD CONSTRAINT "task_session_message_id_reservations_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_message_id_reservations" ADD CONSTRAINT "task_session_message_id_reservations_allocator_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_session_message_id_allocators"("company_id","task_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_messages" ADD CONSTRAINT "task_session_messages_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_messages" ADD CONSTRAINT "task_session_messages_message_id_reservation_fk" FOREIGN KEY ("company_id","task_id","session_id","id") REFERENCES "public"."task_session_message_id_reservations"("company_id","task_id","session_id","message_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_messages" ADD CONSTRAINT "task_session_messages_company_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."task_execution_runs"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_messages" ADD CONSTRAINT "task_session_messages_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_messages" ADD CONSTRAINT "task_session_messages_adapter_revision_fk" FOREIGN KEY ("company_id","agent_id","adapter_config_revision_id") REFERENCES "public"."agent_adapter_config_revisions"("company_id","agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_source_user_executions" ADD CONSTRAINT "task_session_source_user_executions_message_fk" FOREIGN KEY ("company_id","task_id","session_id","message_id") REFERENCES "public"."task_session_messages"("company_id","task_id","session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_source_user_executions" ADD CONSTRAINT "task_session_source_user_executions_agent_fk" FOREIGN KEY ("company_id","source_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_sessions" ADD CONSTRAINT "task_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_sessions" ADD CONSTRAINT "task_sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_sessions" ADD CONSTRAINT "task_sessions_company_parent_fk" FOREIGN KEY ("company_id","parent_session_id") REFERENCES "public"."task_sessions"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_hold_members" ADD CONSTRAINT "task_tree_hold_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_hold_members" ADD CONSTRAINT "task_tree_hold_members_hold_id_task_tree_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."task_tree_holds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_hold_members" ADD CONSTRAINT "task_tree_hold_members_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_hold_members" ADD CONSTRAINT "task_tree_hold_members_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_hold_members" ADD CONSTRAINT "task_tree_hold_members_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_hold_members" ADD CONSTRAINT "task_tree_hold_members_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_hold_members" ADD CONSTRAINT "task_tree_hold_members_active_run_id_task_execution_runs_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_root_task_id_tasks_id_fk" FOREIGN KEY ("root_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_created_by_run_id_task_execution_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_released_by_agent_id_agents_id_fk" FOREIGN KEY ("released_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_released_by_user_id_user_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tree_holds" ADD CONSTRAINT "task_tree_holds_released_by_run_id_task_execution_runs_id_fk" FOREIGN KEY ("released_by_run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_updates" ADD CONSTRAINT "task_updates_scope_fk" FOREIGN KEY ("company_id","task_id","session_id") REFERENCES "public"."task_sessions"("company_id","task_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_updates" ADD CONSTRAINT "task_updates_creator_edge_fk" FOREIGN KEY ("company_id","task_id","ownership_epoch","creator_edge_id") REFERENCES "public"."task_creator_edge_receivability"("company_id","task_id","ownership_epoch","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_updates" ADD CONSTRAINT "task_updates_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."task_execution_runs"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_updates" ADD CONSTRAINT "task_updates_source_authority_fk" FOREIGN KEY ("company_id","source_authority_id") REFERENCES "public"."task_execution_authorities"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_work_products" ADD CONSTRAINT "task_work_products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_work_products" ADD CONSTRAINT "task_work_products_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_work_products" ADD CONSTRAINT "task_work_products_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_work_products" ADD CONSTRAINT "task_work_products_created_by_run_id_task_execution_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_creator_user_id_user_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_escalated_from_affected_task_id_tasks_id_fk" FOREIGN KEY ("escalated_from_affected_task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_escalated_from_triggering_run_id_task_execution_runs_id_fk" FOREIGN KEY ("escalated_from_triggering_run_id") REFERENCES "public"."task_execution_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_responsible_user_id_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_fk" FOREIGN KEY ("company_id","parent_id") REFERENCES "public"."tasks"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
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
CREATE UNIQUE INDEX "acp_prompt_accounting_productive_prompt_uq" ON "acp_prompt_accounting" USING btree ("run_id","ref_id","run_ordinal","segment_ordinal") WHERE "acp_prompt_accounting"."prompt_kind" in ('base', 'steering');--> statement-breakpoint
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
CREATE INDEX "change_consents_company_status_expiry_idx" ON "change_consents" USING btree ("company_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "change_consents_gate_lookup_idx" ON "change_consents" USING btree ("company_id","requested_by_agent_id","target_key","status","created_at");--> statement-breakpoint
CREATE INDEX "cli_auth_challenges_secret_hash_idx" ON "cli_auth_challenges" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "cli_auth_challenges_approved_by_idx" ON "cli_auth_challenges" USING btree ("approved_by_user_id");--> statement-breakpoint
CREATE INDEX "cli_auth_challenges_requested_company_idx" ON "cli_auth_challenges" USING btree ("requested_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_task_prefix_idx" ON "companies" USING btree ("task_prefix");--> statement-breakpoint
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
CREATE UNIQUE INDEX "company_skill_test_runs_company_task_idx" ON "company_skill_test_runs" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "company_skill_test_runs_company_input_created_idx" ON "company_skill_test_runs" USING btree ("company_id","input_id","created_at");--> statement-breakpoint
CREATE INDEX "company_skill_test_runs_company_status_idx" ON "company_skill_test_runs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "company_skill_test_runs_company_harness_expires_idx" ON "company_skill_test_runs" USING btree ("company_id","harness_task_expires_at");--> statement-breakpoint
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
CREATE INDEX "cost_events_company_occurred_idx" ON "cost_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "cost_events_company_agent_occurred_idx" ON "cost_events" USING btree ("company_id","agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "cost_events_run_idx" ON "cost_events" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "cost_events_known_company_idx" ON "cost_events" USING btree ("company_id","occurred_at") WHERE "cost_events"."kind" = 'known';--> statement-breakpoint
CREATE INDEX "document_annotation_anchor_snapshots_company_thread_created_at_idx" ON "document_annotation_anchor_snapshots" USING btree ("company_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_anchor_snapshots_company_document_revision_idx" ON "document_annotation_anchor_snapshots" USING btree ("company_id","document_id","to_revision_number");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_company_thread_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_company_task_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_company_routine_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","routine_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_company_document_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","document_id","created_at");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_task_comment_idx" ON "document_annotation_comments" USING btree ("task_comment_id");--> statement-breakpoint
CREATE INDEX "document_annotation_comments_body_search_idx" ON "document_annotation_comments" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_document_status_idx" ON "document_annotation_threads" USING btree ("company_id","document_id","status");--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_task_status_idx" ON "document_annotation_threads" USING btree ("company_id","task_id","status");--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_routine_status_idx" ON "document_annotation_threads" USING btree ("company_id","routine_id","status");--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_current_revision_open_idx" ON "document_annotation_threads" USING btree ("company_id","document_id","current_revision_id","status");--> statement-breakpoint
CREATE INDEX "document_annotation_threads_company_anchor_state_idx" ON "document_annotation_threads" USING btree ("company_id","anchor_state");--> statement-breakpoint
CREATE UNIQUE INDEX "document_revisions_document_revision_uq" ON "document_revisions" USING btree ("document_id","revision_number");--> statement-breakpoint
CREATE INDEX "document_revisions_company_document_created_idx" ON "document_revisions" USING btree ("company_id","document_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_revisions_source_task_comment_uq" ON "document_revisions" USING btree ("source_task_comment_id");--> statement-breakpoint
CREATE INDEX "documents_company_updated_idx" ON "documents" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX "documents_company_created_idx" ON "documents" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_title_search_idx" ON "documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "documents_latest_body_search_idx" ON "documents" USING gin ("latest_body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_project_idx" ON "execution_workspaces" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_project_workspace_idx" ON "execution_workspaces" USING btree ("company_id","project_workspace_id");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_last_used_idx" ON "execution_workspaces" USING btree ("company_id","last_used_at");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_branch_idx" ON "execution_workspaces" USING btree ("company_id","branch_name");--> statement-breakpoint
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
CREATE UNIQUE INDEX "join_requests_invite_unique_idx" ON "join_requests" USING btree ("invite_id");--> statement-breakpoint
CREATE INDEX "join_requests_company_status_type_created_idx" ON "join_requests" USING btree ("company_id","status","request_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_pending_human_user_uq" ON "join_requests" USING btree ("company_id","requesting_user_id") WHERE "join_requests"."request_type" = 'human' AND "join_requests"."status" = 'pending_approval' AND "join_requests"."requesting_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_pending_human_email_uq" ON "join_requests" USING btree ("company_id",lower("request_email_snapshot")) WHERE "join_requests"."request_type" = 'human' AND "join_requests"."status" = 'pending_approval' AND "join_requests"."request_email_snapshot" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "labels_company_idx" ON "labels" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_company_name_idx" ON "labels" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "local_execution_leases_company_status_idx" ON "local_execution_leases" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "local_execution_leases_company_execution_workspace_idx" ON "local_execution_leases" USING btree ("company_id","execution_workspace_id");--> statement-breakpoint
CREATE INDEX "local_execution_leases_company_task_idx" ON "local_execution_leases" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "local_execution_leases_company_last_used_idx" ON "local_execution_leases" USING btree ("company_id","last_used_at");--> statement-breakpoint
CREATE INDEX "plugin_company_settings_company_idx" ON "plugin_company_settings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "plugin_company_settings_plugin_idx" ON "plugin_company_settings" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_company_settings_company_plugin_uq" ON "plugin_company_settings" USING btree ("company_id","plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_config_plugin_id_idx" ON "plugin_config" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_database_namespaces_plugin_idx" ON "plugin_database_namespaces" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_database_namespaces_namespace_idx" ON "plugin_database_namespaces" USING btree ("namespace_name");--> statement-breakpoint
CREATE INDEX "plugin_database_namespaces_status_idx" ON "plugin_database_namespaces" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plugin_entities_plugin_idx" ON "plugin_entities" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_entities_company_idx" ON "plugin_entities" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "plugin_entities_type_idx" ON "plugin_entities" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "plugin_entities_scope_idx" ON "plugin_entities" USING btree ("scope_kind","scope_id");--> statement-breakpoint
CREATE INDEX "plugin_job_runs_job_idx" ON "plugin_job_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "plugin_job_runs_plugin_idx" ON "plugin_job_runs" USING btree ("plugin_id");--> statement-breakpoint
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
CREATE INDEX "plugin_run_contexts_installation_idx" ON "plugin_run_contexts" USING btree ("plugin_installation_id");--> statement-breakpoint
CREATE INDEX "plugin_state_plugin_scope_idx" ON "plugin_state" USING btree ("plugin_id","scope_kind");--> statement-breakpoint
CREATE INDEX "plugin_webhook_deliveries_plugin_idx" ON "plugin_webhook_deliveries" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_webhook_deliveries_status_idx" ON "plugin_webhook_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plugin_webhook_deliveries_key_idx" ON "plugin_webhook_deliveries" USING btree ("webhook_key");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_withdrawal_operations_rpc_uq" ON "plugin_withdrawal_operations" USING btree ("plugin_installation_id","host_rpc_operation_id");--> statement-breakpoint
CREATE INDEX "plugin_withdrawal_operations_task_idx" ON "plugin_withdrawal_operations" USING btree ("company_id","task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_plugin_key_idx" ON "plugins" USING btree ("plugin_key");--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_install_order_idx" ON "plugins" USING btree ("install_order");--> statement-breakpoint
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
CREATE UNIQUE INDEX "project_workspaces_project_codebase_uq" ON "project_workspaces" USING btree ("project_id");--> statement-breakpoint
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
CREATE INDEX "routine_runs_linked_task_idx" ON "routine_runs" USING btree ("linked_task_id");--> statement-breakpoint
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
CREATE INDEX "run_interface_tool_calls_mention_target_idx" ON "run_interface_tool_calls" USING btree ("company_id","capability_connection_id","capability_generation","mention_target_agent_id","ingress_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_agent_configuration_audits_idempotency_uq" ON "runtime_agent_configuration_audits" USING btree ("company_id","idempotency_key") WHERE "runtime_agent_configuration_audits"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "runtime_agent_configuration_audits_agent_time_idx" ON "runtime_agent_configuration_audits" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_company_created_idx" ON "secret_access_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_secret_created_idx" ON "secret_access_events" USING btree ("secret_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_user_definition_created_idx" ON "secret_access_events" USING btree ("user_secret_definition_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_company_credential_owner_idx" ON "secret_access_events" USING btree ("company_id","credential_owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "secret_access_events_consumer_idx" ON "secret_access_events" USING btree ("company_id","consumer_type","consumer_id");--> statement-breakpoint
CREATE INDEX "secret_access_events_run_idx" ON "secret_access_events" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "system_escalation_identities_affected_epoch_uq" ON "system_escalation_identities" USING btree ("company_id","affected_task_id","affected_ownership_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "system_escalation_identities_escalation_task_uq" ON "system_escalation_identities" USING btree ("company_id","escalation_task_id");--> statement-breakpoint
CREATE INDEX "system_escalation_identities_source_idx" ON "system_escalation_identities" USING btree ("company_id","system_source","created_at");--> statement-breakpoint
CREATE INDEX "task_approvals_task_idx" ON "task_approvals" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_approvals_approval_idx" ON "task_approvals" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "task_approvals_company_idx" ON "task_approvals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "task_attachments_company_task_idx" ON "task_attachments" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "task_attachments_task_comment_idx" ON "task_attachments" USING btree ("task_comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_attachments_asset_uq" ON "task_attachments" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "task_board_lifecycle_commands_task_committed_idx" ON "task_board_lifecycle_commands" USING btree ("company_id","task_id","committed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_board_mentions_idempotency_uq" ON "task_board_mentions" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "task_board_mentions_comment_uq" ON "task_board_mentions" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "task_board_mentions_company_created_idx" ON "task_board_mentions" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "task_board_mentions_task_created_idx" ON "task_board_mentions" USING btree ("company_id","task_id","ownership_epoch","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_board_reopen_commands_idempotency_uq" ON "task_board_reopen_commands" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "task_board_reopen_commands_task_created_idx" ON "task_board_reopen_commands" USING btree ("company_id","task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_board_user_comments_idempotency_uq" ON "task_board_user_comments" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "task_board_user_comments_comment_uq" ON "task_board_user_comments" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "task_board_user_comments_task_created_idx" ON "task_board_user_comments" USING btree ("company_id","task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_comment_projection_sources_source_uq" ON "task_comment_projection_sources" USING btree ("session_id","source_kind","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_comment_projection_sources_message_uq" ON "task_comment_projection_sources" USING btree ("session_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_comment_projection_sources_run_progress_uq" ON "task_comment_projection_sources" USING btree ("company_id","task_id","run_id","source_kind") WHERE "task_comment_projection_sources"."source_kind" = 'run_progress';--> statement-breakpoint
CREATE INDEX "task_comment_projection_sources_event_idx" ON "task_comment_projection_sources" USING btree ("session_id","projected_event_seq");--> statement-breakpoint
CREATE INDEX "task_comment_projection_sources_run_idx" ON "task_comment_projection_sources" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "task_comments_task_idx" ON "task_comments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_comments_company_idx" ON "task_comments" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "task_comments_company_task_created_at_idx" ON "task_comments" USING btree ("company_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_comments_company_author_task_created_at_idx" ON "task_comments" USING btree ("company_id","author_user_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_comments_body_search_idx" ON "task_comments" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "task_consult_executions_active_idx" ON "task_consult_executions" USING btree ("company_id","task_id","ownership_epoch","state");--> statement-breakpoint
CREATE INDEX "task_consult_executions_source_run_idx" ON "task_consult_executions" USING btree ("source_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_create_idempotency_keys_company_key_uq" ON "task_create_idempotency_keys" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "task_create_idempotency_keys_task_idx" ON "task_create_idempotency_keys" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_create_idempotency_keys_company_created_at_idx" ON "task_create_idempotency_keys" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "task_creator_edge_receivability_current_idx" ON "task_creator_edge_receivability" USING btree ("company_id","task_id","state");--> statement-breakpoint
CREATE INDEX "task_creator_edge_receivability_endpoint_idx" ON "task_creator_edge_receivability" USING btree ("company_id","endpoint_kind","endpoint_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "task_creator_withdrawal_commands_plugin_operation_uq" ON "task_creator_withdrawal_commands" USING btree ("plugin_withdrawal_operation_id") WHERE "task_creator_withdrawal_commands"."plugin_withdrawal_operation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "task_creator_withdrawal_commands_update_uq" ON "task_creator_withdrawal_commands" USING btree ("task_update_id") WHERE "task_creator_withdrawal_commands"."task_update_id" is not null;--> statement-breakpoint
CREATE INDEX "task_creator_withdrawal_commands_task_accepted_idx" ON "task_creator_withdrawal_commands" USING btree ("company_id","task_id","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_documents_company_task_key_uq" ON "task_documents" USING btree ("company_id","task_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "task_documents_document_uq" ON "task_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "task_documents_company_task_updated_idx" ON "task_documents" USING btree ("company_id","task_id","updated_at");--> statement-breakpoint
CREATE INDEX "task_execution_attempt_retry_schedules_due_idx" ON "task_execution_attempt_retry_schedules" USING btree ("company_id","state","retry_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_attempts_base_prompt_uq" ON "task_execution_attempts" USING btree ("run_id","ref_ordinal","ref_id","attempt_generation") WHERE "task_execution_attempts"."prompt_kind" = 'base';--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_attempts_steering_prompt_uq" ON "task_execution_attempts" USING btree ("run_id","ref_ordinal","ref_id","segment_ordinal","attempt_generation") WHERE "task_execution_attempts"."prompt_kind" = 'steering';--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_attempts_live_run_uq" ON "task_execution_attempts" USING btree ("run_id") WHERE "task_execution_attempts"."state" in ('pending', 'leased', 'running');--> statement-breakpoint
CREATE INDEX "task_execution_attempts_state_idx" ON "task_execution_attempts" USING btree ("company_id","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_authorities_identity_uq" ON "task_execution_authorities" USING btree ("company_id","task_id","ownership_epoch","agent_id");--> statement-breakpoint
CREATE INDEX "task_execution_authorities_current_idx" ON "task_execution_authorities" USING btree ("company_id","task_id","state");--> statement-breakpoint
CREATE INDEX "task_execution_authorities_agent_state_idx" ON "task_execution_authorities" USING btree ("company_id","agent_id","state");--> statement-breakpoint
CREATE INDEX "task_execution_cancellation_intents_state_idx" ON "task_execution_cancellation_intents" USING btree ("company_id","state","requested_at");--> statement-breakpoint
CREATE INDEX "task_execution_decisions_company_task_idx" ON "task_execution_decisions" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "task_execution_decisions_stage_idx" ON "task_execution_decisions" USING btree ("task_id","stage_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_finalization_prompt_dependencies_base_uq" ON "task_execution_finalization_prompt_dependencies" USING btree ("finalization_id","ref_id") WHERE "task_execution_finalization_prompt_dependencies"."prompt_kind" = 'base';--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_finalization_prompt_dependencies_steering_uq" ON "task_execution_finalization_prompt_dependencies" USING btree ("finalization_id","ref_id","segment_ordinal") WHERE "task_execution_finalization_prompt_dependencies"."prompt_kind" = 'steering';--> statement-breakpoint
CREATE INDEX "task_execution_finalization_prompt_dependencies_run_idx" ON "task_execution_finalization_prompt_dependencies" USING btree ("company_id","run_id","dependency_ordinal");--> statement-breakpoint
CREATE INDEX "task_execution_finalization_update_dependencies_run_idx" ON "task_execution_finalization_update_dependencies" USING btree ("company_id","run_id","dependency_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_history_view_messages_order_uq" ON "task_execution_history_view_messages" USING btree ("history_view_id","lower_order");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_history_view_messages_message_uq" ON "task_execution_history_view_messages" USING btree ("history_view_id","message_id");--> statement-breakpoint
CREATE INDEX "task_execution_history_view_messages_scope_idx" ON "task_execution_history_view_messages" USING btree ("session_id","history_view_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_history_views_ref_uq" ON "task_execution_history_views" USING btree ("ref_id");--> statement-breakpoint
CREATE INDEX "task_execution_history_views_lineage_idx" ON "task_execution_history_views" USING btree ("session_id","execution_lineage_id","source_high_water_seq");--> statement-breakpoint
CREATE INDEX "task_execution_history_views_preparation_idx" ON "task_execution_history_views" USING btree ("composition_preparation_id");--> statement-breakpoint
CREATE INDEX "task_execution_history_views_state_idx" ON "task_execution_history_views" USING btree ("company_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "task_execution_lanes_active_idx" ON "task_execution_lanes" USING btree ("company_id","active_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_lanes_active_lease_uq" ON "task_execution_lanes" USING btree ("active_lease_id") WHERE "task_execution_lanes"."active_lease_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_leases_active_run_uq" ON "task_execution_leases" USING btree ("run_id") WHERE "task_execution_leases"."state" = 'active';--> statement-breakpoint
CREATE INDEX "task_execution_leases_expiry_idx" ON "task_execution_leases" USING btree ("company_id","state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_prompt_capabilities_bearer_hash_uq" ON "task_execution_prompt_capabilities" USING btree ("bearer_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_prompt_capabilities_live_run_uq" ON "task_execution_prompt_capabilities" USING btree ("run_id") WHERE "task_execution_prompt_capabilities"."state" in ('pending_setup', 'active');--> statement-breakpoint
CREATE INDEX "task_execution_prompt_capabilities_task_state_idx" ON "task_execution_prompt_capabilities" USING btree ("company_id","task_id","state");--> statement-breakpoint
CREATE INDEX "task_execution_prompt_capabilities_expiry_idx" ON "task_execution_prompt_capabilities" USING btree ("company_id","expires_at");--> statement-breakpoint
CREATE INDEX "task_execution_prompt_segments_source_comment_idx" ON "task_execution_prompt_segments" USING btree ("company_id","source_comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_refs_delivery_idempotency_uq" ON "task_execution_refs" USING btree ("company_id","delivery_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_refs_history_view_uq" ON "task_execution_refs" USING btree ("history_view_id");--> statement-breakpoint
CREATE INDEX "task_execution_refs_lane_order_idx" ON "task_execution_refs" USING btree ("company_id","task_id","ownership_epoch","target_agent_id","lane_ordinal");--> statement-breakpoint
CREATE INDEX "task_execution_refs_source_idx" ON "task_execution_refs" USING btree ("company_id","source_kind","source_record_id");--> statement-breakpoint
CREATE INDEX "task_execution_refs_counterpart_idx" ON "task_execution_refs" USING btree ("company_id","counterpart_task_id","counterpart_ownership_epoch");--> statement-breakpoint
CREATE INDEX "task_execution_refs_lineage_idx" ON "task_execution_refs" USING btree ("session_id","execution_lineage_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_run_refs_active_ref_uq" ON "task_execution_run_refs" USING btree ("company_id","ref_id") WHERE "task_execution_run_refs"."protocol_settlement_state" is null;--> statement-breakpoint
CREATE INDEX "task_execution_run_refs_run_order_idx" ON "task_execution_run_refs" USING btree ("run_id","ref_ordinal");--> statement-breakpoint
CREATE INDEX "task_execution_runs_execution_scope_idx" ON "task_execution_runs" USING btree ("company_id","execution_scope_id");--> statement-breakpoint
CREATE INDEX "task_execution_runs_task_status_idx" ON "task_execution_runs" USING btree ("company_id","task_id","status","created_at");--> statement-breakpoint
CREATE INDEX "task_execution_runs_agent_status_idx" ON "task_execution_runs" USING btree ("company_id","target_agent_id","status","created_at");--> statement-breakpoint
CREATE INDEX "task_execution_runs_parent_idx" ON "task_execution_runs" USING btree ("company_id","parent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_sessions_current_carry_uq" ON "task_execution_sessions" USING btree ("company_id","task_id","ownership_epoch","target_agent_id","adapter_config_identity","workspace_identity","lane_kind") WHERE "task_execution_sessions"."purpose" = 'carry' and "task_execution_sessions"."state" = 'eligible';--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_sessions_current_steering_uq" ON "task_execution_sessions" USING btree ("company_id","task_id","ownership_epoch","run_id","target_agent_id","adapter_config_identity","workspace_identity") WHERE "task_execution_sessions"."purpose" = 'active_run_steering' and "task_execution_sessions"."state" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_sessions_carry_generation_uq" ON "task_execution_sessions" USING btree ("company_id","task_id","ownership_epoch","target_agent_id","adapter_config_identity","workspace_identity","lane_kind","correlation_generation") WHERE "task_execution_sessions"."purpose" = 'carry';--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_sessions_steering_generation_uq" ON "task_execution_sessions" USING btree ("company_id","task_id","ownership_epoch","run_id","target_agent_id","adapter_config_identity","workspace_identity","correlation_generation") WHERE "task_execution_sessions"."purpose" = 'active_run_steering';--> statement-breakpoint
CREATE INDEX "task_execution_sessions_digest_idx" ON "task_execution_sessions" USING btree ("company_id","protected_target_session_digest");--> statement-breakpoint
CREATE INDEX "task_execution_sessions_task_state_idx" ON "task_execution_sessions" USING btree ("company_id","task_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "task_execution_workspace_bindings_epoch_uq" ON "task_execution_workspace_bindings" USING btree ("company_id","task_id","ownership_epoch");--> statement-breakpoint
CREATE INDEX "task_execution_workspace_bindings_workspace_idx" ON "task_execution_workspace_bindings" USING btree ("company_id","execution_workspace_id");--> statement-breakpoint
CREATE INDEX "task_inbox_archives_company_task_idx" ON "task_inbox_archives" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "task_inbox_archives_company_user_idx" ON "task_inbox_archives" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_inbox_archives_company_task_user_idx" ON "task_inbox_archives" USING btree ("company_id","task_id","user_id");--> statement-breakpoint
CREATE INDEX "task_labels_task_idx" ON "task_labels" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_labels_label_idx" ON "task_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "task_labels_company_idx" ON "task_labels" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "task_read_states_company_task_idx" ON "task_read_states" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "task_read_states_company_user_idx" ON "task_read_states" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_read_states_company_task_user_idx" ON "task_read_states" USING btree ("company_id","task_id","user_id");--> statement-breakpoint
CREATE INDEX "task_reference_mentions_company_source_task_idx" ON "task_reference_mentions" USING btree ("company_id","source_task_id");--> statement-breakpoint
CREATE INDEX "task_reference_mentions_company_target_task_idx" ON "task_reference_mentions" USING btree ("company_id","target_task_id");--> statement-breakpoint
CREATE INDEX "task_reference_mentions_company_task_pair_idx" ON "task_reference_mentions" USING btree ("company_id","source_task_id","target_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_reference_mentions_company_source_mention_record_uq" ON "task_reference_mentions" USING btree ("company_id","source_task_id","target_task_id","source_kind","source_record_id") WHERE "task_reference_mentions"."source_record_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "task_reference_mentions_company_source_mention_null_record_uq" ON "task_reference_mentions" USING btree ("company_id","source_task_id","target_task_id","source_kind") WHERE "task_reference_mentions"."source_record_id" is null;--> statement-breakpoint
CREATE INDEX "task_relations_company_task_idx" ON "task_relations" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "task_relations_company_related_task_idx" ON "task_relations" USING btree ("company_id","related_task_id");--> statement-breakpoint
CREATE INDEX "task_relations_company_type_idx" ON "task_relations" USING btree ("company_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "task_relations_company_edge_uq" ON "task_relations" USING btree ("company_id","task_id","related_task_id","type");--> statement-breakpoint
CREATE INDEX "task_session_context_epochs_session_baseline_idx" ON "task_session_context_epochs" USING btree ("session_id","baseline_seq");--> statement-breakpoint
CREATE INDEX "task_session_event_sequences_owner_idx" ON "task_session_event_sequences" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_session_events_session_seq_uq" ON "task_session_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "task_session_events_source_identity_uq" ON "task_session_events" USING btree ("session_id","source_kind","immutable_source_key") WHERE "task_session_events"."source_kind" is not null;--> statement-breakpoint
CREATE INDEX "task_session_events_session_type_seq_idx" ON "task_session_events" USING btree ("session_id","type","seq");--> statement-breakpoint
CREATE INDEX "task_session_events_scope_run_idx" ON "task_session_events" USING btree ("company_id","task_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_session_input_dispositions_input_uq" ON "task_session_input_dispositions" USING btree ("input_id");--> statement-breakpoint
CREATE INDEX "task_session_input_dispositions_source_ref_idx" ON "task_session_input_dispositions" USING btree ("source_ref_id");--> statement-breakpoint
CREATE INDEX "task_session_input_dispositions_pending_idx" ON "task_session_input_dispositions" USING btree ("session_id","state","input_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_session_inputs_session_admitted_seq_uq" ON "task_session_inputs" USING btree ("session_id","admitted_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "task_session_inputs_session_promoted_seq_uq" ON "task_session_inputs" USING btree ("session_id","promoted_seq") WHERE "task_session_inputs"."promoted_seq" is not null;--> statement-breakpoint
CREATE INDEX "task_session_inputs_pending_delivery_idx" ON "task_session_inputs" USING btree ("session_id","delivery","promoted_seq","admitted_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "task_session_message_id_reservations_message_uq" ON "task_session_message_id_reservations" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "task_session_message_id_reservations_scope_ordinal_idx" ON "task_session_message_id_reservations" USING btree ("session_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "task_session_messages_session_seq_uq" ON "task_session_messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "task_session_messages_session_type_seq_idx" ON "task_session_messages" USING btree ("session_id","type","seq");--> statement-breakpoint
CREATE INDEX "task_session_messages_session_model_state_seq_idx" ON "task_session_messages" USING btree ("session_id","model_state_seq","seq");--> statement-breakpoint
CREATE INDEX "task_session_messages_time_created_idx" ON "task_session_messages" USING btree ("time_created");--> statement-breakpoint
CREATE INDEX "task_session_messages_scope_run_idx" ON "task_session_messages" USING btree ("company_id","task_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_session_source_user_executions_message_uq" ON "task_session_source_user_executions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "task_session_source_user_executions_model_idx" ON "task_session_source_user_executions" USING btree ("company_id","provider_id","model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_sessions_company_task_uq" ON "task_sessions" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "task_sessions_company_parent_idx" ON "task_sessions" USING btree ("company_id","parent_session_id");--> statement-breakpoint
CREATE INDEX "task_sessions_company_integrity_idx" ON "task_sessions" USING btree ("company_id","integrity_state");--> statement-breakpoint
CREATE UNIQUE INDEX "task_tree_hold_members_hold_task_uq" ON "task_tree_hold_members" USING btree ("hold_id","task_id");--> statement-breakpoint
CREATE INDEX "task_tree_hold_members_company_task_idx" ON "task_tree_hold_members" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "task_tree_hold_members_hold_depth_idx" ON "task_tree_hold_members" USING btree ("hold_id","depth");--> statement-breakpoint
CREATE INDEX "task_tree_holds_company_root_status_idx" ON "task_tree_holds" USING btree ("company_id","root_task_id","status");--> statement-breakpoint
CREATE INDEX "task_tree_holds_company_status_mode_idx" ON "task_tree_holds" USING btree ("company_id","status","mode");--> statement-breakpoint
CREATE UNIQUE INDEX "task_updates_gateway_invocation_uq" ON "task_updates" USING btree ("company_id","gateway_invocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_updates_run_sequence_uq" ON "task_updates" USING btree ("company_id","run_id","run_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "task_updates_comment_uq" ON "task_updates" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "task_updates_task_sequence_idx" ON "task_updates" USING btree ("company_id","task_id","ownership_epoch","created_at");--> statement-breakpoint
CREATE INDEX "task_work_products_company_task_type_idx" ON "task_work_products" USING btree ("company_id","task_id","type");--> statement-breakpoint
CREATE INDEX "task_work_products_company_provider_external_id_idx" ON "task_work_products" USING btree ("company_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "task_work_products_company_updated_idx" ON "task_work_products" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX "tasks_company_status_idx" ON "tasks" USING btree ("company_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX "tasks_company_harness_kind_idx" ON "tasks" USING btree ("company_id","harness_kind");--> statement-breakpoint
CREATE INDEX "tasks_company_owner_status_idx" ON "tasks" USING btree ("company_id","owner_agent_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX "tasks_company_owner_user_status_idx" ON "tasks" USING btree ("company_id","owner_user_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX "tasks_company_responsible_user_idx" ON "tasks" USING btree ("company_id","responsible_user_id");--> statement-breakpoint
CREATE INDEX "tasks_company_parent_idx" ON "tasks" USING btree ("company_id","parent_id");--> statement-breakpoint
CREATE INDEX "tasks_company_project_idx" ON "tasks" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "tasks_company_project_workspace_idx" ON "tasks" USING btree ("company_id","project_workspace_id");--> statement-breakpoint
CREATE INDEX "tasks_company_origin_idx" ON "tasks" USING btree ("company_id","origin_kind","origin_id");--> statement-breakpoint
CREATE INDEX "tasks_company_monitor_due_idx" ON "tasks" USING btree ("company_id","monitor_next_check_at");--> statement-breakpoint
CREATE INDEX "tasks_company_updated_idx" ON "tasks" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX "tasks_company_created_idx" ON "tasks" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_open_normalized_title_created_idx" ON "tasks" USING btree ("company_id","parent_id",lower(regexp_replace(btrim("title"), '\s+', ' ', 'g')),"created_at") WHERE "tasks"."hidden_at" is null
          and "tasks"."lifecycle_status" in ('open', 'blocked');--> statement-breakpoint
CREATE INDEX "tasks_company_priority_idx" ON "tasks" USING btree ("company_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_identifier_idx" ON "tasks" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "tasks_title_search_idx" ON "tasks" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tasks_identifier_search_idx" ON "tasks" USING gin ("identifier" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tasks_request_search_idx" ON "tasks" USING gin ("request" gin_trgm_ops);--> statement-breakpoint
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
CREATE UNIQUE INDEX "user_sidebar_preferences_user_uq" ON "user_sidebar_preferences" USING btree ("user_id");