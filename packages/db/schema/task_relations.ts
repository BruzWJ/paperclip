import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";

export const taskRelations = pgTable(
  "task_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    relatedTaskId: uuid("related_task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type").$type<"blocks">().notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTaskIdx: index("task_relations_company_task_idx").on(table.companyId, table.taskId),
    companyRelatedTaskIdx: index("task_relations_company_related_task_idx").on(table.companyId, table.relatedTaskId),
    companyTypeIdx: index("task_relations_company_type_idx").on(table.companyId, table.type),
    companyEdgeUq: uniqueIndex("task_relations_company_edge_uq").on(
      table.companyId,
      table.taskId,
      table.relatedTaskId,
      table.type,
    ),
  }),
);
