ALTER TABLE "acp_prompt_accounting" DROP CONSTRAINT "acp_prompt_accounting_references_check";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check";--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ALTER COLUMN "selected_model_id" DROP NOT NULL;--> statement-breakpoint
UPDATE "agent_adapter_config_revisions"
SET "acp_configuration" = jsonb_set(
  "acp_configuration",
  '{launchProfile}',
  jsonb_build_object(
    'registryName',
    "acp_configuration" #> '{launchProfile,registryName}'
  ),
  true
)
WHERE jsonb_typeof("acp_configuration" -> 'launchProfile') = 'object'
  AND "acp_configuration" -> 'launchProfile' ? 'registryName';--> statement-breakpoint
ALTER TABLE "acp_prompt_accounting" ADD CONSTRAINT "acp_prompt_accounting_references_check" CHECK ((
          "acp_prompt_accounting"."selected_model_id" is null
          or length(btrim("acp_prompt_accounting"."selected_model_id")) between 1 and 500
        )
        and length(btrim("acp_prompt_accounting"."terminal_usage_reference")) between 1 and 500
        and length(btrim("acp_prompt_accounting"."terminal_stop_reference")) between 1 and 500);--> statement-breakpoint
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
      );
