import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

export const companySessionLifecycleOperations = pgTable(
  "company_session_lifecycle_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    generation: bigint("generation", { mode: "number" }).notNull(),
    operation: text("operation").$type<"archive" | "hard_delete">().notNull(),
    status: text("status")
      .$type<"fenced" | "cancelling" | "purge_ready" | "completed" | "failed">()
      .notNull()
      .default("fenced"),
    fenceToken: text("fence_token").notNull(),
    sessionGraphSnapshot: jsonb("session_graph_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    failureReason: text("failure_reason"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    requestedByUserId: text("requested_by_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    fencedAt: timestamp("fenced_at", { withTimezone: true }).notNull().defaultNow(),
    cancellingAt: timestamp("cancelling_at", { withTimezone: true }),
    purgeReadyAt: timestamp("purge_ready_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "company_session_lifecycle_operations_operation_check",
      sql`${table.operation} in ('archive', 'hard_delete')`,
    ),
    check(
      "company_session_lifecycle_operations_status_check",
      sql`${table.status} in ('fenced', 'cancelling', 'purge_ready', 'completed', 'failed')`,
    ),
    check(
      "company_session_lifecycle_operations_terminal_time_check",
      sql`(
        ${table.status} = 'completed'
        and ${table.completedAt} is not null
        and ${table.failedAt} is null
      ) or (
        ${table.status} = 'failed'
        and ${table.failedAt} is not null
        and ${table.completedAt} is null
        and ${table.failureReason} is not null
      ) or ${table.status} in ('fenced', 'cancelling', 'purge_ready')`,
    ),
    uniqueIndex("company_session_lifecycle_operations_generation_uq").on(
      table.companyId,
      table.generation,
    ),
    unique("company_session_lifecycle_operations_company_id_uq").on(
      table.companyId,
      table.id,
    ),
    uniqueIndex("company_session_lifecycle_operations_fence_token_uq").on(
      table.fenceToken,
    ),
    uniqueIndex("company_session_lifecycle_operations_active_uq")
      .on(table.companyId)
      .where(sql`${table.status} in ('fenced', 'cancelling', 'purge_ready')`),
    index("company_session_lifecycle_operations_status_idx").on(
      table.companyId,
      table.status,
      table.generation,
    ),
  ],
);
