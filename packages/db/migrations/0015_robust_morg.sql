ALTER TABLE "issue_execution_finalization_stale_check_outbox" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_liveness_reconciliations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "issue_execution_finalization_stale_check_outbox" CASCADE;--> statement-breakpoint
DROP TABLE "issue_liveness_reconciliations" CASCADE;--> statement-breakpoint
ALTER TABLE "issue_execution_refs" DROP CONSTRAINT "issue_execution_refs_source_kind_check";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_goal_id_goals_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "goal_id";--> statement-breakpoint
ALTER TABLE "issue_execution_refs" ADD CONSTRAINT "issue_execution_refs_source_kind_check" CHECK ("issue_execution_refs"."source_kind" in (
        'issue_request',
        'issue_reassignment',
        'issue_reopen',
        'human_comment_mention',
        'routine_dispatch',
        'issue_update',
        'consult_mention',
        'system_nudge'
      ));