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
import type { AgentAdapterAcpConfiguration } from "@paperclipai/shared";

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
          'model'
        ]::text[]
        and ${table.acpConfiguration} - array[
          'contractVersion',
          'launchProfile',
          'sessionConfigSelections',
          'model'
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
              'value', 'label'
            ]::text[]
            and (${table.acpConfiguration} -> 'model') - array[
              'value', 'label'
            ]::text[] = '{}'::jsonb
            and jsonb_typeof(${table.acpConfiguration} #> '{model,label}') = 'string'
            and jsonb_typeof(${table.acpConfiguration} #> '{model,value}') = 'string'
            and ${table.acpConfiguration} #>> '{model,label}' = btrim(${table.acpConfiguration} #>> '{model,label}')
            and ${table.acpConfiguration} #>> '{model,label}' <> ''
            and ${table.acpConfiguration} #>> '{model,value}' = btrim(${table.acpConfiguration} #>> '{model,value}')
            and ${table.acpConfiguration} #>> '{model,value}' <> ''
          )
        )
      `,
    ),
  ],
);
