import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AgentContextGrantKey,
  AgentMentionReachGrantKey,
  PaperclipActionKey,
} from "@paperclipai/shared";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

export const agentContextGrants = pgTable(
  "agent_context_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    key: text("key").$type<AgentContextGrantKey>().notNull(),
    grantedByAgentId: uuid("granted_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    grantedByUserId: text("granted_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "agent_context_grants_key_check",
      sql`${table.key} in (
        'carry_context',
        'read_issue_comments',
        'read_issue_agent_run',
        'list_sub_issues',
        'read_sub_issue_comments',
        'read_sub_issue_agent_run',
        'list_company_issues',
        'read_company_issue_comments',
        'read_company_issue_agent_run'
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "agent_context_grants_company_agent_fk",
    }).onDelete("cascade"),
    uniqueIndex("agent_context_grants_company_agent_key_uq").on(
      table.companyId,
      table.agentId,
      table.key,
    ),
    index("agent_context_grants_company_agent_idx").on(table.companyId, table.agentId),
  ],
);

export const agentActionGrants = pgTable(
  "agent_action_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    key: text("key").$type<PaperclipActionKey>().notNull(),
    grantedByAgentId: uuid("granted_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    grantedByUserId: text("granted_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "agent_action_grants_key_check",
      sql`${table.key} in (
        'issue_create',
        'mention_board',
        'agent_hire',
        'agent_configure',
        'list_all_agents',
        'list_parent_agents'
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "agent_action_grants_company_agent_fk",
    }).onDelete("cascade"),
    uniqueIndex("agent_action_grants_company_agent_key_uq").on(
      table.companyId,
      table.agentId,
      table.key,
    ),
    index("agent_action_grants_company_agent_idx").on(table.companyId, table.agentId),
  ],
);

export const agentMentionReachGrants = pgTable(
  "agent_mention_reach_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    key: text("key").$type<AgentMentionReachGrantKey>().notNull(),
    grantedByAgentId: uuid("granted_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    grantedByUserId: text("granted_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "agent_mention_reach_grants_key_check",
      sql`${table.key} in ('mention_any_descendant', 'mention_any_ancestor')`,
    ),
    foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "agent_mention_reach_grants_company_agent_fk",
    }).onDelete("cascade"),
    uniqueIndex("agent_mention_reach_grants_company_agent_key_uq").on(
      table.companyId,
      table.agentId,
      table.key,
    ),
    index("agent_mention_reach_grants_company_agent_idx").on(table.companyId, table.agentId),
  ],
);

export interface RuntimeAgentConfigurationSnapshot {
  identity: {
    name: string;
    title: string | null;
    capabilities: string | null;
    reportsTo: string | null;
    instruction: string | null;
  };
  contextGrants: Partial<Record<AgentContextGrantKey, true>>;
  actionGrants: Partial<Record<PaperclipActionKey, true>>;
  mentionReachGrants: Partial<Record<AgentMentionReachGrantKey, true>>;
}

/**
 * Aggregate audit for the single runtime-agent configuration transaction.
 * The grant/selection tables retain their row-level provenance; this record
 * proves the exact safe before/after contract without copying adapter,
 * provider, lifecycle, budget, cost, or other operational agent state.
 */
export const runtimeAgentConfigurationAudits = pgTable(
  "runtime_agent_configuration_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    operation: text("operation").$type<"create" | "update">().notNull(),
    source: text("source")
      .$type<
        | "board"
        | "onboarding"
        | "agent_hire"
        | "agent_configure"
        | "plugin_control"
      >()
      .notNull(),
    actorKind: text("actor_kind")
      .$type<"board" | "agent" | "plugin">()
      .notNull(),
    actorId: text("actor_id").notNull(),
    actorAgentId: uuid("actor_agent_id"),
    actorUserId: text("actor_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    actorPluginInstallationId: uuid("actor_plugin_installation_id"),
    runId: uuid("run_id"),
    issueExecutionRefId: uuid("issue_execution_ref_id"),
    idempotencyKey: text("idempotency_key"),
    requestDigest: text("request_digest").notNull(),
    changedKeys: jsonb("changed_keys").$type<string[]>().notNull(),
    beforeSnapshot: jsonb("before_snapshot")
      .$type<RuntimeAgentConfigurationSnapshot | null>(),
    afterSnapshot: jsonb("after_snapshot")
      .$type<RuntimeAgentConfigurationSnapshot>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "runtime_agent_configuration_audits_operation_check",
      sql`${table.operation} in ('create', 'update')`,
    ),
    check(
      "runtime_agent_configuration_audits_source_check",
      sql`${table.source} in (
        'board',
        'onboarding',
        'agent_hire',
        'agent_configure',
        'plugin_control'
      )`,
    ),
    check(
      "runtime_agent_configuration_audits_actor_check",
      sql`length(${table.actorId}) > 0 and (
        (
          ${table.actorKind} = 'board'
          and ${table.actorAgentId} is null
          and ${table.actorPluginInstallationId} is null
          and ${table.runId} is null
          and ${table.issueExecutionRefId} is null
        ) or (
          ${table.actorKind} = 'agent'
          and ${table.actorAgentId} is not null
          and ${table.actorUserId} is null
          and ${table.actorPluginInstallationId} is null
          and ${table.runId} is not null
          and ${table.issueExecutionRefId} is not null
        ) or (
          ${table.actorKind} = 'plugin'
          and ${table.actorAgentId} is null
          and ${table.actorUserId} is null
          and ${table.actorPluginInstallationId} is not null
          and ${table.runId} is null
          and ${table.issueExecutionRefId} is null
        )
      )`,
    ),
    check(
      "runtime_agent_configuration_audits_digest_check",
      sql`length(${table.requestDigest}) = 64`,
    ),
    foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "runtime_agent_configuration_audits_company_agent_fk",
    }).onDelete("restrict"),
    uniqueIndex("runtime_agent_configuration_audits_idempotency_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index("runtime_agent_configuration_audits_agent_time_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
  ],
);
