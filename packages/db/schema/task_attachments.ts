import { pgTable, uuid, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";
import { assets } from "./assets.js";
import { taskComments } from "./task_comments.js";

export const taskAttachments = pgTable(
  "task_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    taskCommentId: uuid("task_comment_id").references(() => taskComments.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTaskIdx: index("task_attachments_company_task_idx").on(table.companyId, table.taskId),
    taskCommentIdx: index("task_attachments_task_comment_idx").on(table.taskCommentId),
    assetUq: uniqueIndex("task_attachments_asset_uq").on(table.assetId),
  }),
);
