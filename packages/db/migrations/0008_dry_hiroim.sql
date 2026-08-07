ALTER TABLE "creator_deliveries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_execution_finalization_delivery_dependencies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plugin_creator_deliveries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "creator_deliveries" CASCADE;--> statement-breakpoint
DROP TABLE "issue_execution_finalization_delivery_dependencies" CASCADE;--> statement-breakpoint
DROP TABLE "plugin_creator_deliveries" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_action_grants" DROP CONSTRAINT "agent_action_grants_key_check";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP CONSTRAINT "instance_settings_creator_delivery_check";--> statement-breakpoint
ALTER TABLE "issue_execution_refs" DROP CONSTRAINT "issue_execution_refs_source_kind_check";--> statement-breakpoint
ALTER TABLE "issue_updates" DROP CONSTRAINT "issue_updates_form_shape_check";--> statement-breakpoint
ALTER TABLE "issue_creator_edge_receivability" DROP CONSTRAINT "issue_creator_edge_receivability_terminal_reason_check";--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" DROP CONSTRAINT "run_interface_tool_calls_classification_check";--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" DROP CONSTRAINT "run_interface_tool_calls_status_check";--> statement-breakpoint
ALTER TABLE "issue_board_mentions" DROP CONSTRAINT "issue_board_mentions_run_fk";
--> statement-breakpoint
DROP INDEX "run_interface_tool_calls_mention_admission_idx";--> statement-breakpoint
ALTER TABLE "issue_board_mentions" ADD CONSTRAINT "issue_board_mentions_run_fk" FOREIGN KEY ("company_id","run_id") REFERENCES "public"."issue_execution_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_interface_tool_calls_mention_target_idx" ON "run_interface_tool_calls" USING btree ("company_id","capability_connection_id","capability_generation","mention_target_agent_id","ingress_ordinal");--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "creator_delivery";--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" DROP COLUMN "mention_admission_state";--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" DROP COLUMN "mention_admission_started_at";--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" DROP COLUMN "mention_admitted_at";--> statement-breakpoint
UPDATE "issue_execution_refs" SET "source_kind" = 'issue_update' WHERE "source_kind" = 'creator_update';--> statement-breakpoint
DELETE FROM "agent_action_grants" WHERE "key" IN ('issue_assign', 'issue_update');--> statement-breakpoint
ALTER TABLE "agent_action_grants" ADD CONSTRAINT "agent_action_grants_key_check" CHECK ("agent_action_grants"."key" in (
        'issue_create',
        'mention_agent',
        'mention_board',
        'agent_hire',
        'agent_configure'
      ));--> statement-breakpoint
ALTER TABLE "issue_execution_refs" ADD CONSTRAINT "issue_execution_refs_source_kind_check" CHECK ("issue_execution_refs"."source_kind" in (
        'issue_request',
        'issue_reassignment',
        'issue_reopen',
        'board_chat',
        'human_comment_mention',
        'routine_dispatch',
        'issue_update',
        'consult_mention',
        'system_nudge',
        'termination_recovery',
        'agent_liveness_followup'
      ));--> statement-breakpoint
ALTER TABLE "issue_updates" ADD CONSTRAINT "issue_updates_form_shape_check" CHECK ((
        ("issue_updates"."status" is null and "issue_updates"."disposition" is null)
        or (
          "issue_updates"."status" in ('open', 'blocked')
          and "issue_updates"."disposition" is null
          and (
            "issue_updates"."form" <> 'creator'
            or "issue_updates"."source_kind" = 'agent-execution'
          )
        ) or (
          "issue_updates"."form" = 'owner'
          and "issue_updates"."status" in ('done', 'cancelled')
          and "issue_updates"."disposition" is not null
          and jsonb_typeof("issue_updates"."disposition") = 'object'
          and "issue_updates"."disposition" ? 'message'
          and jsonb_typeof("issue_updates"."disposition" ->> 'message') = 'string'
          and btrim("issue_updates"."disposition" ->> 'message') <> ''
          and "issue_updates"."disposition" - 'message' - 'structuredResult' = '{}'::jsonb
        )
      ));--> statement-breakpoint
ALTER TABLE "issue_creator_edge_receivability" ADD CONSTRAINT "issue_creator_edge_receivability_terminal_reason_check" CHECK ("issue_creator_edge_receivability"."terminal_reason" is null or "issue_creator_edge_receivability"."terminal_reason" in (
        'creator_execution_superseded',
        'agent_terminated',
        'agent_deleted',
        'plugin_disabled',
        'plugin_uninstalled',
        'routine_deleted'
      ));--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" ADD CONSTRAINT "run_interface_tool_calls_classification_check" CHECK ((
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
      ));--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" ADD CONSTRAINT "run_interface_tool_calls_status_check" CHECK ((
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
      ));
