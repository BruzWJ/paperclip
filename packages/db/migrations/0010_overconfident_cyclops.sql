ALTER TABLE "agents" ADD COLUMN "instruction" text;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "permissions";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "metadata";