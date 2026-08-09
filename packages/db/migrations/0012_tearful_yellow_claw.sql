UPDATE "routine_revisions"
SET "snapshot" = "snapshot" #- '{routine,contextAccessMask}'
WHERE "snapshot" #> '{routine,contextAccessMask}' IS NOT NULL;--> statement-breakpoint
UPDATE "plugins" AS "plugin"
SET "manifest_json" = jsonb_set(
  "plugin"."manifest_json",
  '{routines}',
  (
    SELECT jsonb_agg(
      "entry"."routine" #- '{issueTemplate,contextAccessMask}'
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
    WHERE "entry"."routine" #> '{issueTemplate,contextAccessMask}' IS NOT NULL
  );--> statement-breakpoint
UPDATE "plugin_managed_resources"
SET "defaults_json" = "defaults_json" #- '{issueTemplate,contextAccessMask}'
WHERE "defaults_json" #> '{issueTemplate,contextAccessMask}' IS NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_context_access_mask_check";--> statement-breakpoint
ALTER TABLE "routines" DROP CONSTRAINT "routines_context_access_mask_check";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "context_access_mask";--> statement-breakpoint
ALTER TABLE "routines" DROP COLUMN "context_access_mask";
