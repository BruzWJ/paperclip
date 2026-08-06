ALTER TABLE "feedback_exports" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback_votes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "feedback_exports" CASCADE;--> statement-breakpoint
DROP TABLE "feedback_votes" CASCADE;--> statement-breakpoint
ALTER TABLE "plugin_entities" DROP CONSTRAINT "plugin_entities_external_idx";--> statement-breakpoint
ALTER TABLE "agent_company_tool_selections" DROP CONSTRAINT "agent_company_tool_selections_selected_by_plugin_installation_id_plugins_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_company_tool_selections" DROP CONSTRAINT "agent_company_tool_selections_revoked_by_plugin_installation_id_plugins_id_fk";
--> statement-breakpoint
ALTER TABLE "companies" DROP CONSTRAINT "companies_feedback_data_sharing_consent_by_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_comments" DROP CONSTRAINT "issue_comments_author_plugin_installation_fk";
--> statement-breakpoint
ALTER TABLE "plugin_config" DROP CONSTRAINT "plugin_config_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "plugin_creator_deliveries" DROP CONSTRAINT "plugin_creator_deliveries_plugin_installation_id_plugins_id_fk";
--> statement-breakpoint
ALTER TABLE "plugin_job_runs" DROP CONSTRAINT "plugin_job_runs_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "plugin_run_contexts" DROP CONSTRAINT "plugin_run_contexts_plugin_installation_id_plugins_id_fk";
--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" DROP CONSTRAINT "plugin_webhook_deliveries_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "plugin_withdrawal_operations" DROP CONSTRAINT "plugin_withdrawal_operations_plugin_installation_id_plugins_id_fk";
--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" DROP CONSTRAINT "run_interface_tool_calls_plugin_installation_id_plugins_id_fk";
--> statement-breakpoint
DROP INDEX "plugin_config_plugin_company_idx";--> statement-breakpoint
DROP INDEX "plugin_job_runs_company_idx";--> statement-breakpoint
DROP INDEX "plugin_webhook_deliveries_company_idx";--> statement-breakpoint
DROP INDEX "plugins_plugin_key_idx";--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "plugins" ALTER COLUMN "status" SET DEFAULT 'ready';--> statement-breakpoint
ALTER TABLE "plugins" ALTER COLUMN "install_order" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ALTER COLUMN "package_path" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "source" text NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_run_contexts" ADD CONSTRAINT "plugin_run_contexts_plugin_installation_id_plugins_id_fk" FOREIGN KEY ("plugin_installation_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_config_plugin_id_idx" ON "plugin_config" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_install_order_idx" ON "plugins" USING btree ("install_order");--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_plugin_key_idx" ON "plugins" USING btree ("plugin_key");--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "feedback_data_sharing_enabled";--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "feedback_data_sharing_consent_at";--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "feedback_data_sharing_consent_by_user_id";--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "feedback_data_sharing_terms_version";--> statement-breakpoint
ALTER TABLE "plugin_company_settings" DROP COLUMN "enabled";--> statement-breakpoint
ALTER TABLE "plugin_company_settings" DROP COLUMN "last_error";--> statement-breakpoint
ALTER TABLE "plugin_config" DROP COLUMN "company_id";--> statement-breakpoint
ALTER TABLE "plugin_config" DROP COLUMN "last_error";--> statement-breakpoint
ALTER TABLE "plugin_database_namespaces" DROP COLUMN "namespace_mode";--> statement-breakpoint
ALTER TABLE "plugin_job_runs" DROP COLUMN "company_id";--> statement-breakpoint
ALTER TABLE "plugin_job_runs" DROP COLUMN "logs";--> statement-breakpoint
ALTER TABLE "plugin_jobs" DROP COLUMN "last_run_at";--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" DROP COLUMN "company_id";--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" DROP COLUMN "external_id";--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" DROP COLUMN "payload";--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" DROP COLUMN "headers";--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" DROP COLUMN "started_at";--> statement-breakpoint
ALTER TABLE "plugins" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "plugins" DROP COLUMN "api_version";--> statement-breakpoint
ALTER TABLE "plugins" DROP COLUMN "categories";--> statement-breakpoint
ALTER TABLE "plugin_entities" ADD CONSTRAINT "plugin_entities_external_idx" UNIQUE NULLS NOT DISTINCT("company_id","plugin_id","entity_type","scope_kind","scope_id","external_id");