import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { environments } from "./environments.js";

export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singletonKey: text("singleton_key").notNull().default("default"),
    defaultEnvironmentId: uuid("default_environment_id").references(() => environments.id, { onDelete: "set null" }),
    general: jsonb("general").$type<Record<string, unknown>>().notNull().default({}),
    creatorDelivery: jsonb("creator_delivery").$type<{
      maxRetryAttempts: number;
      retryBaseDelayMs: number;
      retryMaxDelayMs: number;
      pausedOrBudgetStoppedStalenessMs: number;
    } | null>(),
    experimental: jsonb("experimental").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "instance_settings_creator_delivery_check",
      sql`${table.creatorDelivery} is null
        or (
          jsonb_typeof(${table.creatorDelivery}) = 'object'
          and (${table.creatorDelivery} ->> 'maxRetryAttempts')::integer > 0
          and (${table.creatorDelivery} ->> 'retryBaseDelayMs')::integer > 0
          and (${table.creatorDelivery} ->> 'retryMaxDelayMs')::integer
            >= (${table.creatorDelivery} ->> 'retryBaseDelayMs')::integer
          and (${table.creatorDelivery} ->> 'pausedOrBudgetStoppedStalenessMs')::integer > 0
        )`,
    ),
    uniqueIndex("instance_settings_singleton_key_idx").on(table.singletonKey),
  ],
);
