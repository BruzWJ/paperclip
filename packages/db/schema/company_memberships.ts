import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

export const companyMemberships = pgTable(
  "company_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    principalType: text("principal_type").$type<"user" | "agent">().notNull(),
    principalUserId: text("principal_user_id").references(() => authUsers.id, {
      onDelete: "cascade",
    }),
    principalAgentId: uuid("principal_agent_id"),
    status: text("status").notNull().default("active"),
    membershipRole: text("membership_role"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    principalShapeCheck: check(
      "company_memberships_principal_shape_check",
      sql`(
        ${table.principalType} = 'user'
        and ${table.principalUserId} is not null
        and ${table.principalAgentId} is null
      ) or (
        ${table.principalType} = 'agent'
        and ${table.principalUserId} is null
        and ${table.principalAgentId} is not null
      )`,
    ),
    principalAgentCompanyFk: foreignKey({
      columns: [table.companyId, table.principalAgentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "company_memberships_principal_agent_company_fk",
    }).onDelete("cascade"),
    companyUserUniqueIdx: uniqueIndex("company_memberships_company_user_unique_idx")
      .on(table.companyId, table.principalUserId)
      .where(sql`${table.principalType} = 'user'`),
    companyAgentUniqueIdx: uniqueIndex("company_memberships_company_agent_unique_idx")
      .on(table.companyId, table.principalAgentId)
      .where(sql`${table.principalType} = 'agent'`),
    principalUserStatusIdx: index("company_memberships_principal_user_status_idx").on(
      table.principalUserId,
      table.status,
    ),
    principalAgentStatusIdx: index("company_memberships_principal_agent_status_idx").on(
      table.principalAgentId,
      table.status,
    ),
    companyStatusIdx: index("company_memberships_company_status_idx").on(table.companyId, table.status),
  }),
);
