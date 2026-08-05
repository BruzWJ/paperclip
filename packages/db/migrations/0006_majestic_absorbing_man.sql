ALTER TABLE "plugin_run_contexts" DROP CONSTRAINT "plugin_run_contexts_exact_tool_call_fk";
ALTER TABLE "run_interface_tool_calls" DROP CONSTRAINT "run_interface_tool_calls_plugin_binding_uq";--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" DROP CONSTRAINT "run_interface_tool_calls_plugin_binding_check";--> statement-breakpoint
ALTER TABLE "plugin_run_contexts" DROP CONSTRAINT "plugin_run_contexts_tool_selection_fk";
--> statement-breakpoint
ALTER TABLE "tool_applications" DROP CONSTRAINT "tool_applications_plugin_id_plugins_id_fk";
--> statement-breakpoint
DROP INDEX "environments_managed_sandbox_idx";--> statement-breakpoint
DROP INDEX "plugin_run_contexts_selection_installation_idx";--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" ADD CONSTRAINT "run_interface_tool_calls_plugin_binding_uq" UNIQUE("capability_connection_id","capability_generation","id","plugin_installation_id");--> statement-breakpoint
ALTER TABLE "plugin_run_contexts" ADD CONSTRAINT "plugin_run_contexts_exact_tool_call_fk" FOREIGN KEY ("capability_connection_id","capability_generation","run_interface_tool_call_id","plugin_installation_id") REFERENCES "public"."run_interface_tool_calls"("capability_connection_id","capability_generation","id","plugin_installation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_run_contexts_installation_idx" ON "plugin_run_contexts" USING btree ("plugin_installation_id");--> statement-breakpoint
ALTER TABLE "plugin_run_contexts" DROP COLUMN "company_tool_selection_id";--> statement-breakpoint
ALTER TABLE "tool_applications" DROP COLUMN "plugin_id";--> statement-breakpoint
ALTER TABLE "run_interface_tool_calls" ADD CONSTRAINT "run_interface_tool_calls_plugin_binding_check" CHECK (not (
        "run_interface_tool_calls"."plugin_installation_id" is not null
        and "run_interface_tool_calls"."company_tool_selection_id" is not null
      ));