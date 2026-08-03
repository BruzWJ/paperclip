import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

export const pluginManagedResources = pgTable(
  "plugin_managed_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    pluginKey: text("plugin_key").notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceKey: text("resource_key").notNull(),
    resourceId: uuid("resource_id").notNull(),
    defaultsJson: jsonb("defaults_json").$type<Record<string, unknown>>().notNull().default({}),
    lifecycleState: text("lifecycle_state")
      .$type<"active" | "triage_paused" | "adopted" | "terminated">()
      .notNull()
      .default("active"),
    originalDeclarationRef: jsonb("original_declaration_ref")
      .$type<Record<string, unknown> | null>(),
    lifecycleReason: text("lifecycle_reason"),
    triagePausedAt: timestamp("triage_paused_at", { withTimezone: true }),
    adoptedAt: timestamp("adopted_at", { withTimezone: true }),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    lifecycleActorType: text("lifecycle_actor_type"),
    lifecycleActorId: text("lifecycle_actor_id"),
    lifecycleAudit: jsonb("lifecycle_audit").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("plugin_managed_resources_company_idx").on(table.companyId),
    pluginIdx: index("plugin_managed_resources_plugin_idx").on(table.pluginId),
    resourceIdx: index("plugin_managed_resources_resource_idx").on(table.resourceKind, table.resourceId),
    activeAgentBindingUq: uniqueIndex(
      "plugin_managed_resources_active_agent_binding_uq",
    )
      .on(table.companyId, table.resourceId)
      .where(
        sql`${table.resourceKind} = 'agent' and ${table.lifecycleState} in ('active', 'triage_paused')`,
      ),
    companyPluginResourceUq: uniqueIndex("plugin_managed_resources_company_plugin_resource_uq").on(
      table.companyId,
      table.pluginId,
      table.resourceKind,
      table.resourceKey,
    ),
    lifecycleIdx: index("plugin_managed_resources_lifecycle_idx").on(
      table.companyId,
      table.pluginId,
      table.lifecycleState,
    ),
    lifecycleStateCheck: check(
      "plugin_managed_resources_lifecycle_state_check",
      sql`${table.lifecycleState} in ('active', 'triage_paused', 'adopted', 'terminated')`,
    ),
    lifecycleTimestampCheck: check(
      "plugin_managed_resources_lifecycle_timestamp_check",
      sql`(
        ${table.lifecycleState} = 'active'
        and ${table.triagePausedAt} is null
        and ${table.adoptedAt} is null
        and ${table.terminatedAt} is null
      ) or (
        ${table.lifecycleState} = 'triage_paused'
        and ${table.triagePausedAt} is not null
        and ${table.adoptedAt} is null
        and ${table.terminatedAt} is null
      ) or (
        ${table.lifecycleState} = 'adopted'
        and ${table.adoptedAt} is not null
        and ${table.terminatedAt} is null
      ) or (
        ${table.lifecycleState} = 'terminated'
        and ${table.terminatedAt} is not null
      )`,
    ),
  }),
);
