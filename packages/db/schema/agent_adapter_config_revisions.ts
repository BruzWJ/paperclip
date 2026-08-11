import {
  type AnyPgColumn,
  check,
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
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import type {
  AdapterImplementationIdentity,
  AgentAdapterAcpConfiguration,
} from "@paperclipai/shared";

export const agentAdapterConfigRevisions = pgTable(
  "agent_adapter_config_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references((): AnyPgColumn => agents.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    adapterType: text("adapter_type").notNull(),
    implementationIdentity: jsonb("implementation_identity")
      .$type<AdapterImplementationIdentity>()
      .notNull(),
    adapterConfigSchemaVersion: text("adapter_config_schema_version").notNull(),
    normalizedConfig: jsonb("normalized_config")
      .$type<Record<string, unknown>>()
      .notNull(),
    runtimeConfig: jsonb("runtime_config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    acpConfiguration: jsonb("acp_configuration")
      .$type<AgentAdapterAcpConfiguration>()
      .notNull(),
    digest: text("digest").notNull(),
    parentRevisionId: uuid("parent_revision_id").references(
      (): AnyPgColumn => agentAdapterConfigRevisions.id,
      { onDelete: "restrict" },
    ),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("agent_adapter_config_revisions_scope_id_uq").on(
      table.companyId,
      table.agentId,
      table.id,
    ),
    uniqueIndex("agent_adapter_config_revisions_agent_number_uq").on(
      table.companyId,
      table.agentId,
      table.revisionNumber,
    ),
    index("agent_adapter_config_revisions_agent_digest_idx").on(
      table.companyId,
      table.agentId,
      table.digest,
    ),
    index("agent_adapter_config_revisions_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    check(
      "agent_adapter_config_revisions_acp_configuration_shape_check",
      sql`
        jsonb_typeof(${table.acpConfiguration}) = 'object'
        and ${table.acpConfiguration} ?& array[
          'contractVersion',
          'launchProfile',
          'sessionConfigSelections',
          'model',
          'workspaceSelector',
          'companySkillPins'
        ]::text[]
        and ${table.acpConfiguration} - array[
          'contractVersion',
          'launchProfile',
          'sessionConfigSelections',
          'model',
          'workspaceSelector',
          'companySkillPins'
        ]::text[] = '{}'::jsonb
        and ${table.acpConfiguration} ->> 'contractVersion' = 'acpx-runtime/v1'
        and jsonb_typeof(${table.acpConfiguration} -> 'launchProfile') = 'object'
        and (${table.acpConfiguration} -> 'launchProfile') ?& array[
          'registryName'
        ]::text[]
        and (${table.acpConfiguration} -> 'launchProfile') - array[
          'registryName'
        ]::text[] = '{}'::jsonb
        and jsonb_typeof(${table.acpConfiguration} #> '{launchProfile,registryName}') = 'string'
        and ${table.acpConfiguration} #>> '{launchProfile,registryName}' = btrim(${table.acpConfiguration} #>> '{launchProfile,registryName}')
        and ${table.acpConfiguration} #>> '{launchProfile,registryName}' <> ''
        and jsonb_typeof(${table.acpConfiguration} -> 'sessionConfigSelections') = 'array'
        and (
          jsonb_typeof(${table.acpConfiguration} -> 'model') = 'null'
          or (
            jsonb_typeof(${table.acpConfiguration} -> 'model') = 'object'
            and (${table.acpConfiguration} -> 'model') ?& array[
              'id', 'label', 'value', 'limits'
            ]::text[]
            and (${table.acpConfiguration} -> 'model') - array[
              'id', 'label', 'value', 'limits'
            ]::text[] = '{}'::jsonb
            and jsonb_typeof(${table.acpConfiguration} #> '{model,id}') = 'string'
            and jsonb_typeof(${table.acpConfiguration} #> '{model,label}') = 'string'
            and jsonb_typeof(${table.acpConfiguration} #> '{model,value}') = 'string'
            and ${table.acpConfiguration} #>> '{model,id}' = btrim(${table.acpConfiguration} #>> '{model,id}')
            and ${table.acpConfiguration} #>> '{model,id}' <> ''
            and ${table.acpConfiguration} #>> '{model,label}' = btrim(${table.acpConfiguration} #>> '{model,label}')
            and ${table.acpConfiguration} #>> '{model,label}' <> ''
            and ${table.acpConfiguration} #>> '{model,value}' = btrim(${table.acpConfiguration} #>> '{model,value}')
            and ${table.acpConfiguration} #>> '{model,value}' <> ''
            and (
              jsonb_typeof(${table.acpConfiguration} #> '{model,limits}') = 'null'
              or (
                jsonb_typeof(${table.acpConfiguration} #> '{model,limits}') = 'object'
                and (${table.acpConfiguration} #> '{model,limits}') ?& array[
                  'contextTokenLimit', 'outputTokenLimit'
                ]::text[]
                and (${table.acpConfiguration} #> '{model,limits}') - array[
                  'contextTokenLimit', 'inputTokenLimit', 'outputTokenLimit'
                ]::text[] = '{}'::jsonb
                and jsonb_typeof(${table.acpConfiguration} #> '{model,limits,contextTokenLimit}') = 'number'
                and jsonb_typeof(${table.acpConfiguration} #> '{model,limits,outputTokenLimit}') = 'number'
                and ${table.acpConfiguration} #>> '{model,limits,contextTokenLimit}' ~ '^[1-9][0-9]*$'
                and ${table.acpConfiguration} #>> '{model,limits,outputTokenLimit}' ~ '^[1-9][0-9]*$'
                and (${table.acpConfiguration} #>> '{model,limits,outputTokenLimit}')::numeric <= (${table.acpConfiguration} #>> '{model,limits,contextTokenLimit}')::numeric
                and (
                  not (${table.acpConfiguration} #> '{model,limits}') ? 'inputTokenLimit'
                  or (
                    jsonb_typeof(${table.acpConfiguration} #> '{model,limits,inputTokenLimit}') = 'number'
                    and ${table.acpConfiguration} #>> '{model,limits,inputTokenLimit}' ~ '^[1-9][0-9]*$'
                    and (${table.acpConfiguration} #>> '{model,limits,inputTokenLimit}')::numeric <= (${table.acpConfiguration} #>> '{model,limits,contextTokenLimit}')::numeric
                  )
                )
              )
            )
          )
        )
        and jsonb_typeof(${table.acpConfiguration} -> 'workspaceSelector') = 'object'
        and (${table.acpConfiguration} -> 'workspaceSelector') - 'kind' = '{}'::jsonb
        and ${table.acpConfiguration} #>> '{workspaceSelector,kind}' = 'issue_execution_workspace'
        and jsonb_typeof(${table.acpConfiguration} -> 'companySkillPins') = 'array'
      `,
    ),
  ],
);
