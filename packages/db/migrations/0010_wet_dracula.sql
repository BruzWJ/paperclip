ALTER TABLE "agent_action_grants" DROP CONSTRAINT "agent_action_grants_key_check";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "instruction" text;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "permissions";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "agent_action_grants" ADD CONSTRAINT "agent_action_grants_key_check" CHECK ("agent_action_grants"."key" in (
        'issue_create',
        'mention_agent',
        'mention_board',
        'agent_hire',
        'agent_configure',
        'list_all_agents',
        'list_parent_agents'
      ));