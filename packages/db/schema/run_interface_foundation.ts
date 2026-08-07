import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { issueExecutionPromptCapabilities } from "./issue_execution_capabilities.js";
import { plugins } from "./plugins.js";

/**
 * Server-side validation ledger for plugin run-context bearers. Only the
 * digest is persisted; the opaque bearer itself is delivered to the plugin
 * worker and cannot be reconstructed from database state.
 */
export const pluginRunContexts = pgTable(
  "plugin_run_contexts",
  {
    capabilityConnectionId: uuid("capability_connection_id").notNull(),
    capabilityGeneration: integer("capability_generation").notNull(),
    runInterfaceToolCallId: uuid("run_interface_tool_call_id").notNull(),
    pluginInstallationId: uuid("plugin_installation_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    handleHash: text("handle_hash").primaryKey(),
    firstUsedAt: timestamp("first_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "plugin_run_contexts_hash_audit_check",
      sql`${table.capabilityGeneration} > 0
        and ${table.handleHash} ~ '^[0-9a-f]{64}$'
        and (
          ${table.firstUsedAt} is null
          or ${table.firstUsedAt} >= ${table.createdAt}
        )`,
    ),
    foreignKey({
      columns: [
        table.capabilityConnectionId,
        table.capabilityGeneration,
      ],
      foreignColumns: [
        issueExecutionPromptCapabilities.capabilityConnectionId,
        issueExecutionPromptCapabilities.capabilityGeneration,
      ],
      name: "plugin_run_contexts_capability_generation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.capabilityConnectionId,
        table.capabilityGeneration,
        table.runInterfaceToolCallId,
        table.pluginInstallationId,
      ],
      foreignColumns: [
        runInterfaceToolCalls.capabilityConnectionId,
        runInterfaceToolCalls.capabilityGeneration,
        runInterfaceToolCalls.id,
        runInterfaceToolCalls.pluginInstallationId,
      ],
      name: "plugin_run_contexts_exact_tool_call_fk",
    }).onDelete("cascade"),
    unique("plugin_run_contexts_tool_call_uq").on(
      table.runInterfaceToolCallId,
    ),
    index("plugin_run_contexts_capability_idx").on(
      table.capabilityConnectionId,
      table.capabilityGeneration,
    ),
    index("plugin_run_contexts_installation_idx").on(
      table.pluginInstallationId,
    ),
  ],
);

/**
 * Durable provider-call identity ledger for the productive run interface.
 * One typed provider/JSON-RPC id is unique inside one bearer generation.
 * Malformed calls without a usable id receive a private ingress identity.
 * Exact retries replay the stored result; identity reuse with a different
 * ordinal, tool, binding, or canonical argument digest is a conflict.
 */
export const runInterfaceToolCalls = pgTable(
  "run_interface_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    capabilityConnectionId: uuid("capability_connection_id").notNull(),
    capabilityGeneration: integer("capability_generation").notNull(),
    ingressOrdinal: bigint("ingress_ordinal", { mode: "number" }).notNull(),
    callIdentitySource: text("call_identity_source")
      .$type<"provider" | "jsonrpc" | "ingress">()
      .notNull(),
    callIdentityType: text("call_identity_type")
      .$type<"string" | "number" | "ordinal">()
      .notNull(),
    callIdentityValue: text("call_identity_value").notNull(),
    toolName: text("tool_name").notNull(),
    /** Immutable plugin binding identity; intentionally not a live installation FK. */
    pluginInstallationId: uuid("plugin_installation_id"),
    argumentsDigest: text("arguments_digest").notNull(),
    classification: text("classification")
      .$type<
        | "unclassified"
        | "non_mention"
        | "validated_mention"
        | "terminal_invalid"
      >()
      .notNull()
      .default("unclassified"),
    mentionTargetAgentId: uuid("mention_target_agent_id"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
    status: text("status")
      .$type<"executing" | "completed" | "failed">()
      .notNull(),
    result: jsonb("result"),
    error: jsonb("error").$type<{
      name: string;
      message: string;
      code?: string;
      status?: number;
      reasonCode?: string;
      details?: Record<string, unknown>;
    } | null>(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "run_interface_tool_calls_identity_check",
      sql`${table.capabilityGeneration} > 0
        and ${table.ingressOrdinal} >= 0
        and ${table.ingressOrdinal} <= 9007199254740991
        and (
          (
            ${table.callIdentitySource} in ('provider', 'jsonrpc')
            and ${table.callIdentityType} in ('string', 'number')
          ) or (
            ${table.callIdentitySource} = 'ingress'
            and ${table.callIdentityType} = 'ordinal'
          )
        )`,
    ),
    check(
      "run_interface_tool_calls_classification_check",
      sql`(
        ${table.classification} = 'unclassified'
        and ${table.mentionTargetAgentId} is null
        and ${table.classifiedAt} is null
      ) or (
        ${table.classification} in ('non_mention', 'terminal_invalid')
        and ${table.mentionTargetAgentId} is null
        and ${table.classifiedAt} is not null
      ) or (
        ${table.classification} = 'validated_mention'
        and ${table.mentionTargetAgentId} is not null
        and ${table.classifiedAt} is not null
      )`,
    ),
    check(
      "run_interface_tool_calls_status_check",
      sql`(
        ${table.status} = 'executing'
        and ${table.classification} <> 'terminal_invalid'
        and ${table.error} is null
        and ${table.completedAt} is null
      ) or (
        ${table.status} = 'completed'
        and ${table.classification} in ('non_mention', 'validated_mention')
        and ${table.error} is null
        and ${table.completedAt} is not null
      ) or (
        ${table.status} = 'failed'
        and ${table.classification} <> 'unclassified'
        and ${table.error} is not null
        and ${table.completedAt} is not null
      )`,
    ),
    foreignKey({
      columns: [
        table.companyId,
        table.capabilityConnectionId,
        table.capabilityGeneration,
      ],
      foreignColumns: [
        issueExecutionPromptCapabilities.companyId,
        issueExecutionPromptCapabilities.capabilityConnectionId,
        issueExecutionPromptCapabilities.capabilityGeneration,
      ],
      name: "run_interface_tool_calls_capability_generation_fk",
    }).onDelete("cascade"),
    uniqueIndex("run_interface_tool_calls_identity_uq").on(
      table.companyId,
      table.capabilityConnectionId,
      table.capabilityGeneration,
      table.callIdentitySource,
      table.callIdentityType,
      table.callIdentityValue,
    ),
    uniqueIndex("run_interface_tool_calls_ingress_ordinal_uq").on(
      table.companyId,
      table.capabilityConnectionId,
      table.capabilityGeneration,
      table.ingressOrdinal,
    ),
    unique("run_interface_tool_calls_plugin_binding_uq").on(
      table.capabilityConnectionId,
      table.capabilityGeneration,
      table.id,
      table.pluginInstallationId,
    ),
    index("run_interface_tool_calls_capability_status_idx").on(
      table.companyId,
      table.capabilityConnectionId,
      table.capabilityGeneration,
      table.status,
    ),
    index("run_interface_tool_calls_mention_target_idx").on(
      table.companyId,
      table.capabilityConnectionId,
      table.capabilityGeneration,
      table.mentionTargetAgentId,
      table.ingressOrdinal,
    ),
  ],
);
