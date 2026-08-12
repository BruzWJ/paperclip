import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { invites } from "./invites.js";
import { authUsers } from "./auth.js";

export const joinRequests = pgTable(
  "join_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inviteId: uuid("invite_id")
      .notNull()
      .references(() => invites.id),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    status: text("status").notNull().default("pending_approval"),
    requestIp: text("request_ip").notNull(),
    requestingUserId: text("requesting_user_id").references(
      () => authUsers.id,
      {
        onDelete: "restrict",
      },
    ),
    requestEmailSnapshot: text("request_email_snapshot"),
    approvedByUserId: text("approved_by_user_id").references(
      () => authUsers.id,
      {
        onDelete: "restrict",
      },
    ),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedByUserId: text("rejected_by_user_id").references(
      () => authUsers.id,
      {
        onDelete: "restrict",
      },
    ),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    inviteUniqueIdx: uniqueIndex("join_requests_invite_unique_idx").on(
      table.inviteId,
    ),
    companyStatusCreatedIdx: index(
      "join_requests_company_status_created_idx",
    ).on(table.companyId, table.status, table.createdAt),
    pendingUserIdUniqueIdx: uniqueIndex("join_requests_pending_user_id_uq")
      .on(table.companyId, table.requestingUserId)
      .where(
        sql`${table.status} = 'pending_approval' AND ${table.requestingUserId} IS NOT NULL`,
      ),
    pendingUserEmailUniqueIdx: uniqueIndex(
      "join_requests_pending_user_email_uq",
    )
      .on(table.companyId, sql`lower(${table.requestEmailSnapshot})`)
      .where(
        sql`${table.status} = 'pending_approval' AND ${table.requestEmailSnapshot} IS NOT NULL`,
      ),
  }),
);
