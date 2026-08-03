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
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

export const principalPermissionGrants = pgTable(
  "principal_permission_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    principalType: text("principal_type").$type<"user" | "agent">().notNull(),
    principalUserId: text("principal_user_id").references(() => authUsers.id, {
      onDelete: "cascade",
    }),
    principalAgentId: uuid("principal_agent_id"),
    permissionKey: text("permission_key").notNull(),
    scope: jsonb("scope").$type<Record<string, unknown> | null>(),
    grantedByUserId: text("granted_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    principalShapeCheck: check(
      "principal_permission_grants_principal_shape_check",
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
      name: "principal_permission_grants_principal_agent_company_fk",
    }).onDelete("cascade"),
    uniqueUserGrantIdx: uniqueIndex("principal_permission_grants_user_unique_idx")
      .on(table.companyId, table.principalUserId, table.permissionKey)
      .where(sql`${table.principalType} = 'user'`),
    uniqueAgentGrantIdx: uniqueIndex("principal_permission_grants_agent_unique_idx")
      .on(table.companyId, table.principalAgentId, table.permissionKey)
      .where(sql`${table.principalType} = 'agent'`),
    userPermissionIdx: index("principal_permission_grants_user_permission_idx").on(
      table.principalUserId,
      table.permissionKey,
    ),
    agentPermissionIdx: index("principal_permission_grants_agent_permission_idx").on(
      table.principalAgentId,
      table.permissionKey,
    ),
    companyPermissionIdx: index("principal_permission_grants_company_permission_idx").on(
      table.companyId,
      table.permissionKey,
    ),
  }),
);
