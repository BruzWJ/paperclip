import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { taskComments } from "./task_comments.js";
import { taskExecutionRuns } from "./task_execution_runs.js";
import { tasks } from "./tasks.js";

/**
 * Immutable agent-originated mention of the collective Board for information
 * or direction. It is a task Session/comment source, not a Board-owned task
 * or provider invocation.
 */
export const taskBoardMentions = pgTable(
  "task_board_mentions",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    agentId: uuid("agent_id").notNull(),
    runId: uuid("run_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commentId: uuid("comment_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "task_board_mentions_epoch_check",
      sql`${table.ownershipEpoch} > 0`,
    ),
    foreignKey({
      columns: [table.companyId, table.taskId],
      foreignColumns: [tasks.companyId, tasks.id],
      name: "task_board_mentions_task_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "task_board_mentions_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.runId],
      foreignColumns: [
        taskExecutionRuns.companyId,
        taskExecutionRuns.id,
      ],
      name: "task_board_mentions_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.taskId, table.commentId],
      foreignColumns: [
        taskComments.companyId,
        taskComments.taskId,
        taskComments.id,
      ],
      name: "task_board_mentions_comment_fk",
    }).onDelete("cascade"),
    uniqueIndex("task_board_mentions_idempotency_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    uniqueIndex("task_board_mentions_comment_uq").on(table.commentId),
    index("task_board_mentions_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    index("task_board_mentions_task_created_idx").on(
      table.companyId,
      table.taskId,
      table.ownershipEpoch,
      table.createdAt,
    ),
  ],
);
