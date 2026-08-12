ALTER TABLE "agent_config_revisions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_skill_comments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_skill_policies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_skill_stars" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_skill_test_inputs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_skill_test_run_templates" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_skill_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_skills" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_config_revisions" CASCADE;--> statement-breakpoint
DROP TABLE "company_skill_comments" CASCADE;--> statement-breakpoint
DROP TABLE "company_skill_policies" CASCADE;--> statement-breakpoint
DROP TABLE "company_skill_stars" CASCADE;--> statement-breakpoint
DROP TABLE "company_skill_test_inputs" CASCADE;--> statement-breakpoint
DROP TABLE "company_skill_test_run_templates" CASCADE;--> statement-breakpoint
DROP TABLE "company_skill_test_runs" CASCADE;--> statement-breakpoint
DROP TABLE "company_skill_versions" CASCADE;--> statement-breakpoint
DROP TABLE "company_skills" CASCADE;--> statement-breakpoint
DELETE FROM "tasks"
WHERE "harness_kind" = 'skill_test'
   OR "work_mode" = 'skill_test';--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check";--> statement-breakpoint
UPDATE "agent_adapter_config_revisions"
SET "acp_configuration" = jsonb_set(
  "acp_configuration" - 'companySkillPins' - 'workspaceSelector',
  '{model}',
  CASE
    WHEN jsonb_typeof("acp_configuration" -> 'model') = 'object'
      THEN ("acp_configuration" -> 'model') - 'id' - 'limits'
    ELSE 'null'::jsonb
  END
);--> statement-breakpoint
ALTER TABLE "agent_runtime_state" DROP CONSTRAINT "agent_runtime_state_adapter_type_check";--> statement-breakpoint
ALTER TABLE "invites" DROP CONSTRAINT "invites_bootstrap_shape_check";--> statement-breakpoint
ALTER TABLE "join_requests" DROP CONSTRAINT "join_requests_created_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "join_requests" DROP CONSTRAINT "join_requests_created_agent_adapter_config_revision_id_agent_adapter_config_revisions_id_fk";
--> statement-breakpoint
WITH "deleted_agent_join_requests" AS (
  DELETE FROM "join_requests"
  WHERE "request_type" = 'agent'
  RETURNING "invite_id"
)
DELETE FROM "invites"
WHERE "id" IN (
  SELECT "invite_id"
  FROM "deleted_agent_join_requests"
);--> statement-breakpoint
DELETE FROM "join_requests"
WHERE "invite_id" IN (
  SELECT "id"
  FROM "invites"
  WHERE "invite_type" = 'company_join'
    AND (
      "allowed_join_types" = 'agent'
      OR "allowed_join_types" NOT IN ('human', 'both')
      OR jsonb_typeof("defaults_payload" -> 'human') IS DISTINCT FROM 'object'
      OR "defaults_payload" #>> '{human,role}' IS NULL
      OR "defaults_payload" #>> '{human,role}' NOT IN ('owner', 'admin', 'operator', 'viewer')
      OR jsonb_typeof("defaults_payload" #> '{human,grants}') IS DISTINCT FROM 'array'
    )
);--> statement-breakpoint
DELETE FROM "invites"
WHERE "invite_type" = 'company_join'
  AND (
    "allowed_join_types" = 'agent'
    OR "allowed_join_types" NOT IN ('human', 'both')
    OR jsonb_typeof("defaults_payload" -> 'human') IS DISTINCT FROM 'object'
    OR "defaults_payload" #>> '{human,role}' IS NULL
    OR "defaults_payload" #>> '{human,role}' NOT IN ('owner', 'admin', 'operator', 'viewer')
    OR jsonb_typeof("defaults_payload" #> '{human,grants}') IS DISTINCT FROM 'array'
  );--> statement-breakpoint
UPDATE "invites"
SET "defaults_payload" = jsonb_build_object(
      'user',
      jsonb_build_object(
        'role', "defaults_payload" #> '{human,role}',
        'grants', "defaults_payload" #> '{human,grants}'
      )
    ),
    "updated_at" = now()
WHERE "invite_type" = 'company_join';--> statement-breakpoint
DROP INDEX "join_requests_company_status_type_created_idx";--> statement-breakpoint
DROP INDEX "join_requests_pending_human_user_uq";--> statement-breakpoint
DROP INDEX "join_requests_pending_human_email_uq";--> statement-breakpoint
DROP INDEX "tasks_company_harness_kind_idx";--> statement-breakpoint
UPDATE "agents"
SET "status" = 'idle',
    "updated_at" = now()
WHERE "status" IN ('active', 'running');--> statement-breakpoint
UPDATE "company_memberships"
SET "membership_role" = 'operator',
    "updated_at" = now()
WHERE "principal_type" = 'user'
  AND (
    "membership_role" IS NULL
    OR "membership_role" NOT IN ('owner', 'admin', 'operator', 'viewer')
  );--> statement-breakpoint
UPDATE "company_memberships"
SET "membership_role" = 'member',
    "updated_at" = now()
WHERE "principal_type" = 'agent'
  AND "membership_role" IS DISTINCT FROM 'member';--> statement-breakpoint
ALTER TABLE "company_memberships" ALTER COLUMN "membership_role" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_tree_hold_members" ALTER COLUMN "task_identifier" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "task_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "identifier" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "join_requests_company_status_created_idx" ON "join_requests" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_pending_user_id_uq" ON "join_requests" USING btree ("company_id","requesting_user_id") WHERE "join_requests"."status" = 'pending_approval' AND "join_requests"."requesting_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_pending_user_email_uq" ON "join_requests" USING btree ("company_id",lower("request_email_snapshot")) WHERE "join_requests"."status" = 'pending_approval' AND "join_requests"."request_email_snapshot" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_company_task_number_uq" ON "tasks" USING btree ("company_id","task_number");--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "adapter_type";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "implementation_identity";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "adapter_config_schema_version";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "normalized_config";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" DROP COLUMN "runtime_config";--> statement-breakpoint
ALTER TABLE "agent_runtime_state" DROP COLUMN "adapter_type";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "adapter_type";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "adapter_config";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "runtime_config";--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "allowed_join_types";--> statement-breakpoint
ALTER TABLE "join_requests" DROP COLUMN "request_type";--> statement-breakpoint
ALTER TABLE "join_requests" DROP COLUMN "agent_name";--> statement-breakpoint
ALTER TABLE "join_requests" DROP COLUMN "adapter_type";--> statement-breakpoint
ALTER TABLE "join_requests" DROP COLUMN "capabilities";--> statement-breakpoint
ALTER TABLE "join_requests" DROP COLUMN "agent_defaults_payload";--> statement-breakpoint
ALTER TABLE "join_requests" DROP COLUMN "created_agent_id";--> statement-breakpoint
ALTER TABLE "join_requests" DROP COLUMN "created_agent_adapter_config_revision_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "harness_kind";--> statement-breakpoint
ALTER TABLE "agent_adapter_config_revisions" ADD CONSTRAINT "agent_adapter_config_revisions_acp_configuration_shape_check" CHECK (
        jsonb_typeof("agent_adapter_config_revisions"."acp_configuration") = 'object'
        and "agent_adapter_config_revisions"."acp_configuration" ?& array[
          'contractVersion',
          'launchProfile',
          'sessionConfigSelections',
          'model'
        ]::text[]
        and "agent_adapter_config_revisions"."acp_configuration" - array[
          'contractVersion',
          'launchProfile',
          'sessionConfigSelections',
          'model'
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
              'value', 'label'
            ]::text[]
            and ("agent_adapter_config_revisions"."acp_configuration" -> 'model') - array[
              'value', 'label'
            ]::text[] = '{}'::jsonb
            and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,label}') = 'string'
            and jsonb_typeof("agent_adapter_config_revisions"."acp_configuration" #> '{model,value}') = 'string'
            and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,label}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{model,label}')
            and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,label}' <> ''
            and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,value}' = btrim("agent_adapter_config_revisions"."acp_configuration" #>> '{model,value}')
            and "agent_adapter_config_revisions"."acp_configuration" #>> '{model,value}' <> ''
          )
        )
      );--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_task_prefix_check" CHECK ("companies"."task_prefix" ~ '^[A-Z][A-Z0-9]*$');--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_task_counter_check" CHECK ("companies"."task_counter" >= 0);--> statement-breakpoint
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_principal_role_check" CHECK ((
        "company_memberships"."principal_type" = 'user'
        and "company_memberships"."membership_role" in ('owner', 'admin', 'operator', 'viewer')
      ) or (
        "company_memberships"."principal_type" = 'agent'
        and "company_memberships"."membership_role" = 'member'
      ));--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_routine_kind_check" CHECK ("folders"."kind" = 'routine');--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_bootstrap_shape_check" CHECK ((
        (
          "invites"."source" = 'bootstrap_admin_cli'
          AND "invites"."invite_type" = 'bootstrap_admin'
          AND "invites"."company_id" IS NULL
        )
        OR
        (
          "invites"."source" <> 'bootstrap_admin_cli'
          AND "invites"."invite_type" = 'company_join'
          AND "invites"."company_id" IS NOT NULL
        )
      ));--> statement-breakpoint
UPDATE "projects"
SET "color" = NULL,
    "updated_at" = now()
WHERE "color" IS NOT NULL
  AND "color" !~ '^#[0-9a-f]{6}$';--> statement-breakpoint
DELETE FROM "routine_runs"
WHERE "source" NOT IN ('schedule', 'manual', 'api', 'webhook')
   OR "status" NOT IN ('received', 'coalesced', 'skipped', 'task_created', 'completed', 'failed');--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_color_check" CHECK ("projects"."color" is null or "projects"."color" ~ '^#[0-9a-f]{6}$');--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_source_check" CHECK ("routine_runs"."source" in ('schedule', 'manual', 'api', 'webhook'));--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_status_check" CHECK ("routine_runs"."status" in ('received', 'coalesced', 'skipped', 'task_created', 'completed', 'failed'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_canonical_identity_check" CHECK ("tasks"."task_number" > 0
        and "tasks"."identifier" ~ '^[A-Z][A-Z0-9]*-[1-9][0-9]*$'
        and "tasks"."identifier" = split_part("tasks"."identifier", '-', 1) || '-' || "tasks"."task_number"::text);
