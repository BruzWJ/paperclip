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
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { taskCreatorEdgeReceivability } from "./task_creator_edge.js";
import { taskComments } from "./task_comments.js";
import { taskExecutionRefs } from "./task_execution_runtime.js";

/** Typed Board comment ledger; only the structured mention tuple dispatches. */
export const taskBoardUserComments = pgTable(
  "task_board_user_comments",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    actorUserId: text("actor_user_id").notNull().references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    identityDigest: text("identity_digest").notNull(),
    mentionTargetAgentId: uuid("mention_target_agent_id"),
    commentId: uuid("comment_id").notNull(),
    executionRefId: uuid("execution_ref_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("task_board_user_comments_actor_check", sql`length(btrim(${table.actorUserId})) > 0`),
    check("task_board_user_comments_epoch_check", sql`${table.ownershipEpoch} > 0`),
    check(
      "task_board_user_comments_mention_shape_check",
      sql`(
        ${table.mentionTargetAgentId} is null
        and ${table.executionRefId} is null
      ) or (
        ${table.mentionTargetAgentId} is not null
        and ${table.executionRefId} is not null
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.taskId, table.ownershipEpoch],
      foreignColumns: [
        taskCreatorEdgeReceivability.companyId,
        taskCreatorEdgeReceivability.taskId,
        taskCreatorEdgeReceivability.ownershipEpoch,
      ],
      name: "task_board_user_comments_creator_edge_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.taskId, table.commentId],
      foreignColumns: [taskComments.companyId, taskComments.taskId, taskComments.id],
      name: "task_board_user_comments_comment_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.taskId, table.ownershipEpoch, table.executionRefId],
      foreignColumns: [
        taskExecutionRefs.companyId,
        taskExecutionRefs.taskId,
        taskExecutionRefs.ownershipEpoch,
        taskExecutionRefs.id,
      ],
      name: "task_board_user_comments_ref_fk",
    }).onDelete("restrict"),
    uniqueIndex("task_board_user_comments_idempotency_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    uniqueIndex("task_board_user_comments_comment_uq").on(table.commentId),
    index("task_board_user_comments_task_created_idx").on(
      table.companyId,
      table.taskId,
      table.createdAt,
    ),
  ],
);
