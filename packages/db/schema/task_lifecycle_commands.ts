import type { TaskBoardLifecycleCommandSubtype } from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { taskCreatorEdgeReceivability } from "./task_creator_edge.js";

/**
 * One immutable row per task actually mutated by a directly authenticated
 * named-board lifecycle command. The source command remains domain-owned;
 * this ledger supplies a closed, task/epoch-scoped liveness provenance row.
 */
export const taskBoardLifecycleCommands = pgTable(
  "task_board_lifecycle_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    actorUserId: text("actor_user_id").notNull().references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    subtype: text("subtype")
      .$type<TaskBoardLifecycleCommandSubtype>()
      .notNull(),
    sourceCommandId: uuid("source_command_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "task_board_lifecycle_commands_epoch_check",
      sql`${table.ownershipEpoch} > 0`,
    ),
    check(
      "task_board_lifecycle_commands_actor_check",
      sql`length(btrim(${table.actorUserId})) > 0`,
    ),
    check(
      "task_board_lifecycle_commands_subtype_check",
      sql`${table.subtype} in (
        'execution_policy_configure',
        'execution_policy_decision',
        'tree_control_pause',
        'tree_control_resume',
        'tree_control_cancel',
        'tree_control_restore',
        'tree_control_release'
      )`,
    ),
    check(
      "task_board_lifecycle_commands_idempotency_check",
      sql`length(btrim(${table.idempotencyKey})) > 0`,
    ),
    foreignKey({
      columns: [table.companyId, table.taskId, table.ownershipEpoch],
      foreignColumns: [
        taskCreatorEdgeReceivability.companyId,
        taskCreatorEdgeReceivability.taskId,
        taskCreatorEdgeReceivability.ownershipEpoch,
      ],
      name: "task_board_lifecycle_commands_creator_edge_fk",
    }).onDelete("restrict"),
    unique("task_board_lifecycle_commands_source_task_uq").on(
      table.companyId,
      table.taskId,
      table.sourceCommandId,
    ),
    unique("task_board_lifecycle_commands_idempotency_task_uq").on(
      table.companyId,
      table.taskId,
      table.idempotencyKey,
    ),
    index("task_board_lifecycle_commands_task_committed_idx").on(
      table.companyId,
      table.taskId,
      table.committedAt,
    ),
  ],
);

export type TaskBoardLifecycleCommand =
  typeof taskBoardLifecycleCommands.$inferSelect;
export type NewTaskBoardLifecycleCommand =
  typeof taskBoardLifecycleCommands.$inferInsert;
