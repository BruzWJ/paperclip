import { sql } from "drizzle-orm";
import { INVITE_SOURCES, type InviteSource } from "@paperclipai/shared";
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
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

export { INVITE_SOURCES };
export type { InviteSource };

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id),
    inviteType: text("invite_type").notNull().default("company_join"),
    tokenHash: text("token_hash").notNull(),
    defaultsPayload: jsonb("defaults_payload").$type<Record<
      string,
      unknown
    > | null>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    source: text("source").$type<InviteSource>().notNull(),
    invitedByUserId: text("invited_by_user_id").references(() => authUsers.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tokenHashUniqueIdx: uniqueIndex("invites_token_hash_unique_idx").on(
      table.tokenHash,
    ),
    companyInviteStateIdx: index("invites_company_invite_state_idx").on(
      table.companyId,
      table.inviteType,
      table.revokedAt,
      table.expiresAt,
    ),
    sourceCheck: check(
      "invites_source_check",
      sql`${table.source} IN ('board_api', 'plugin_host', 'bootstrap_admin_cli')`,
    ),
    sourcePrincipalCheck: check(
      "invites_source_principal_check",
      sql`(
        (${table.source} = 'board_api' AND ${table.invitedByUserId} IS NOT NULL)
        OR
        (${table.source} IN ('plugin_host', 'bootstrap_admin_cli') AND ${table.invitedByUserId} IS NULL)
      )`,
    ),
    bootstrapShapeCheck: check(
      "invites_bootstrap_shape_check",
      sql`(
        (
          ${table.source} = 'bootstrap_admin_cli'
          AND ${table.inviteType} = 'bootstrap_admin'
          AND ${table.companyId} IS NULL
        )
        OR
        (
          ${table.source} <> 'bootstrap_admin_cli'
          AND ${table.inviteType} = 'company_join'
          AND ${table.companyId} IS NOT NULL
        )
      )`,
    ),
  }),
);
