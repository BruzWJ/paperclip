ALTER TABLE "task_execution_refs" DROP CONSTRAINT "task_execution_refs_source_kind_check";--> statement-breakpoint
-- Canonicalize the Session admission envelope before its execution ref. Opaque
-- source digests and deterministic IDs continue to identify the original
-- accepted bytes and are intentionally not rewritten.
UPDATE "task_session_events"
SET "source_kind" = 'mention_agent'
WHERE "source_kind" IN ('human_comment_mention', 'consult_mention');--> statement-breakpoint
UPDATE "task_execution_refs"
SET "source_kind" = 'mention_agent'
WHERE "source_kind" IN ('human_comment_mention', 'consult_mention');--> statement-breakpoint
ALTER TABLE "task_execution_refs" ADD CONSTRAINT "task_execution_refs_source_kind_check" CHECK ("task_execution_refs"."source_kind" in (
        'task_request',
        'task_reassignment',
        'task_reopen',
        'mention_agent',
        'routine_dispatch',
        'task_update',
        'system_nudge'
      ));
