import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  index,
  jsonb,
  check,
} from "drizzle-orm/pg-core";
import type {
  AgentEnvConfig,
  PauseReason,
  ProjectStatus,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").$type<ProjectStatus>().notNull().default("backlog"),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id),
    targetDate: date("target_date"),
    color: text("color"),
    icon: text("icon"),
    env: jsonb("env").$type<AgentEnvConfig>(),
    pauseReason: text("pause_reason").$type<PauseReason>(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    colorCheck: check(
      "projects_color_check",
      sql`${table.color} is null or ${table.color} ~ '^#[0-9a-f]{6}$'`,
    ),
    companyIdx: index("projects_company_idx").on(table.companyId),
  }),
);
