import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { invites } from "./invites.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { environments } from "./environments.js";
import { agentAdapterConfigRevisions } from "./agent_adapter_config_revisions.js";

export const joinRequests = pgTable(
  "join_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inviteId: uuid("invite_id").notNull().references(() => invites.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    requestType: text("request_type").notNull(),
    status: text("status").notNull().default("pending_approval"),
    requestIp: text("request_ip").notNull(),
    requestingUserId: text("requesting_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    requestEmailSnapshot: text("request_email_snapshot"),
    agentName: text("agent_name"),
    adapterType: text("adapter_type"),
    capabilities: text("capabilities"),
    agentDefaultsPayload: jsonb("agent_defaults_payload").$type<Record<string, unknown> | null>(),
    createdAgentId: uuid("created_agent_id").references(() => agents.id),
    approvedEnvironmentId: uuid("approved_environment_id").references(() => environments.id),
    createdAgentAdapterConfigRevisionId: uuid("created_agent_adapter_config_revision_id").references(
      () => agentAdapterConfigRevisions.id,
    ),
    approvedByUserId: text("approved_by_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedByUserId: text("rejected_by_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    inviteUniqueIdx: uniqueIndex("join_requests_invite_unique_idx").on(table.inviteId),
    companyStatusTypeCreatedIdx: index("join_requests_company_status_type_created_idx").on(
      table.companyId,
      table.status,
      table.requestType,
      table.createdAt,
    ),
    pendingHumanUserUniqueIdx: uniqueIndex("join_requests_pending_human_user_uq")
      .on(table.companyId, table.requestingUserId)
      .where(sql`${table.requestType} = 'human' AND ${table.status} = 'pending_approval' AND ${table.requestingUserId} IS NOT NULL`),
    pendingHumanEmailUniqueIdx: uniqueIndex("join_requests_pending_human_email_uq")
      .on(table.companyId, sql`lower(${table.requestEmailSnapshot})`)
      .where(sql`${table.requestType} = 'human' AND ${table.status} = 'pending_approval' AND ${table.requestEmailSnapshot} IS NOT NULL`),
  }),
);
