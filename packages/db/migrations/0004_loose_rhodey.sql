CREATE TABLE "issue_board_mentions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"ownership_epoch" integer NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"reason" text,
	"comment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_board_mentions_epoch_check" CHECK ("issue_board_mentions"."ownership_epoch" > 0),
	CONSTRAINT "issue_board_mentions_reason_check" CHECK ("issue_board_mentions"."reason" is null or length(btrim("issue_board_mentions"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "issues" RENAME COLUMN "attention_mask" TO "context_access_mask";--> statement-breakpoint
ALTER TABLE "routines" RENAME COLUMN "attention_mask" TO "context_access_mask";--> statement-breakpoint
UPDATE "routine_revisions"
SET "snapshot" = CASE
  WHEN "snapshot" #> '{routine,contextAccessMask}' IS NULL THEN
    jsonb_set(
      "snapshot" #- '{routine,attentionMask}',
      '{routine,contextAccessMask}',
      "snapshot" #> '{routine,attentionMask}',
      true
    )
  ELSE "snapshot" #- '{routine,attentionMask}'
END
WHERE "snapshot" #> '{routine,attentionMask}' IS NOT NULL;--> statement-breakpoint
UPDATE "plugins" AS "plugin"
SET "manifest_json" = jsonb_set(
  "plugin"."manifest_json",
  '{routines}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN "entry"."routine" #> '{issueTemplate,attentionMask}' IS NULL THEN
          "entry"."routine"
        WHEN "entry"."routine" #> '{issueTemplate,contextAccessMask}' IS NULL THEN
          jsonb_set(
            "entry"."routine" #- '{issueTemplate,attentionMask}',
            '{issueTemplate,contextAccessMask}',
            "entry"."routine" #> '{issueTemplate,attentionMask}',
            true
          )
        ELSE "entry"."routine" #- '{issueTemplate,attentionMask}'
      END
      ORDER BY "entry"."ordinality"
    )
    FROM jsonb_array_elements("plugin"."manifest_json" -> 'routines')
      WITH ORDINALITY AS "entry"("routine", "ordinality")
  ),
  false
)
WHERE jsonb_typeof("plugin"."manifest_json" -> 'routines') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements("plugin"."manifest_json" -> 'routines') AS "entry"("routine")
    WHERE "entry"."routine" #> '{issueTemplate,attentionMask}' IS NOT NULL
  );--> statement-breakpoint
UPDATE "plugin_managed_resources"
SET "defaults_json" = CASE
  WHEN "defaults_json" #> '{issueTemplate,contextAccessMask}' IS NULL THEN
    jsonb_set(
      "defaults_json" #- '{issueTemplate,attentionMask}',
      '{issueTemplate,contextAccessMask}',
      "defaults_json" #> '{issueTemplate,attentionMask}',
      true
    )
  ELSE "defaults_json" #- '{issueTemplate,attentionMask}'
END
WHERE "defaults_json" #> '{issueTemplate,attentionMask}' IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_action_grants" DROP CONSTRAINT "agent_action_grants_key_check";--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" DROP CONSTRAINT "issue_liveness_reconciliations_accepted_action_kind_check";--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" DROP CONSTRAINT "issue_liveness_reconciliations_exit_action_kind_check";--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_attention_mask_check";--> statement-breakpoint
ALTER TABLE "routines" DROP CONSTRAINT "routines_attention_mask_check";--> statement-breakpoint
ALTER TABLE "issue_board_mentions" ADD CONSTRAINT "issue_board_mentions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_mentions" ADD CONSTRAINT "issue_board_mentions_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_mentions" ADD CONSTRAINT "issue_board_mentions_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_mentions" ADD CONSTRAINT "issue_board_mentions_run_fk" FOREIGN KEY ("company_id","issue_id","run_id") REFERENCES "public"."issue_execution_runs"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_board_mentions" ADD CONSTRAINT "issue_board_mentions_comment_fk" FOREIGN KEY ("company_id","issue_id","comment_id") REFERENCES "public"."issue_comments"("company_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_board_mentions_idempotency_uq" ON "issue_board_mentions" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_board_mentions_comment_uq" ON "issue_board_mentions" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "issue_board_mentions_company_created_idx" ON "issue_board_mentions" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_board_mentions_issue_created_idx" ON "issue_board_mentions" USING btree ("company_id","issue_id","ownership_epoch","created_at");--> statement-breakpoint
ALTER TABLE "agent_action_grants" ADD CONSTRAINT "agent_action_grants_key_check" CHECK ("agent_action_grants"."key" in (
        'issue_create',
        'issue_assign',
        'issue_update',
        'mention_agent',
        'mention_board',
        'agent_hire',
        'agent_configure'
      ));--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" ADD CONSTRAINT "issue_liveness_reconciliations_accepted_action_kind_check" CHECK ("issue_liveness_reconciliations"."accepted_action_kind" is null or "issue_liveness_reconciliations"."accepted_action_kind" in (
        'authenticated_human_comment',
        'issue_create_child',
        'mention_agent',
        'mention_board',
        'issue_assign',
        'issue_update',
        'creator_withdrawal',
        'board_lifecycle_command',
        'board_reopen'
      ));--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" ADD CONSTRAINT "issue_liveness_reconciliations_exit_action_kind_check" CHECK ("issue_liveness_reconciliations"."exit_action_kind" is null or "issue_liveness_reconciliations"."exit_action_kind" in (
        'authenticated_human_comment',
        'issue_create_child',
        'mention_agent',
        'mention_board',
        'issue_assign',
        'issue_update',
        'creator_withdrawal',
        'board_lifecycle_command',
        'board_reopen'
      ));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_context_access_mask_check" CHECK ("issues"."context_access_mask" is null
        or (
          jsonb_typeof("issues"."context_access_mask") = 'object'
          and "issues"."context_access_mask" - array[
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
          and not jsonb_path_exists("issues"."context_access_mask", '$.* ? (@ != false)')
        ));--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_context_access_mask_check" CHECK ("routines"."context_access_mask" is null
        or (
          jsonb_typeof("routines"."context_access_mask") = 'object'
          and "routines"."context_access_mask" - array[
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
          and not jsonb_path_exists("routines"."context_access_mask", '$.* ? (@ != false)')
        ));
