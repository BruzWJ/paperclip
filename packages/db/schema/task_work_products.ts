import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { SourceTrustMetadata } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { taskExecutionRuns } from "./task_execution_runs.js";
import { tasks } from "./tasks.js";
import { projects } from "./projects.js";

export const taskWorkProducts = pgTable(
  "task_work_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    title: text("title").notNull(),
    url: text("url"),
    status: text("status").notNull(),
    reviewState: text("review_state").notNull().default("none"),
    isPrimary: boolean("is_primary").notNull().default(false),
    healthStatus: text("health_status").notNull().default("unknown"),
    summary: text("summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    sourceTrust: jsonb("source_trust").$type<SourceTrustMetadata | null>(),
    createdByRunId: uuid("created_by_run_id").references(() => taskExecutionRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTaskTypeIdx: index("task_work_products_company_task_type_idx").on(
      table.companyId,
      table.taskId,
      table.type,
    ),
    companyProviderExternalIdIdx: index("task_work_products_company_provider_external_id_idx").on(
      table.companyId,
      table.provider,
      table.externalId,
    ),
    companyUpdatedIdx: index("task_work_products_company_updated_idx").on(
      table.companyId,
      table.updatedAt,
    ),
  }),
);
