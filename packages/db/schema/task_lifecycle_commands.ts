import type {
  TaskBoardLifecycleCommandSubtype,
  TaskCreatorWithdrawalActorKind,
} from "@paperclipai/shared";
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import {
  taskCreatorEdgeReceivability,
  taskUpdates,
  pluginWithdrawalOperations,
} from "./task_creator_edge.js";

/**
 * Append-only acceptance of the two control-plane creator-withdrawal forms.
 * A named-user row records the epoch-ending self-assignment. A plugin row
 * records the plugin's atomic epoch advance plus cancellation and therefore
 * binds its exact accepted RPC operation and task update.
 */
export const taskCreatorWithdrawalCommands = pgTable(
  "task_creator_withdrawal_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").notNull(),
    outgoingOwnershipEpoch: integer("outgoing_ownership_epoch").notNull(),
    resultingOwnershipEpoch: integer("resulting_ownership_epoch").notNull(),
    resultingCreatorEdgeId: uuid("resulting_creator_edge_id"),
    actorKind: text("actor_kind")
      .$type<TaskCreatorWithdrawalActorKind>()
      .notNull(),
    actorUserId: text("actor_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    actorPluginInstallationId: uuid("actor_plugin_installation_id"),
    actorPluginKey: text("actor_plugin_key"),
    pluginWithdrawalOperationId: uuid("plugin_withdrawal_operation_id"),
    taskUpdateId: uuid("task_update_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "task_creator_withdrawal_commands_epoch_check",
      sql`${table.outgoingOwnershipEpoch} > 0
        and ${table.resultingOwnershipEpoch} =
          ${table.outgoingOwnershipEpoch} + 1`,
    ),
    check(
      "task_creator_withdrawal_commands_actor_check",
      sql`(
        ${table.actorKind} = 'user'
        and ${table.actorUserId} is not null
        and ${table.resultingCreatorEdgeId} is not null
        and ${table.actorPluginInstallationId} is null
        and ${table.actorPluginKey} is null
        and ${table.pluginWithdrawalOperationId} is null
        and ${table.taskUpdateId} is null
      ) or (
        ${table.actorKind} = 'plugin'
        and ${table.actorUserId} is null
        and ${table.resultingCreatorEdgeId} is null
        and ${table.actorPluginInstallationId} is not null
        and ${table.actorPluginKey} is not null
        and length(btrim(${table.actorPluginKey})) > 0
        and ${table.pluginWithdrawalOperationId} is not null
        and ${table.taskUpdateId} is not null
      )`,
    ),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.resultingOwnershipEpoch,
        table.resultingCreatorEdgeId,
      ],
      foreignColumns: [
        taskCreatorEdgeReceivability.companyId,
        taskCreatorEdgeReceivability.taskId,
        taskCreatorEdgeReceivability.ownershipEpoch,
        taskCreatorEdgeReceivability.id,
      ],
      name: "task_creator_withdrawal_commands_resulting_edge_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.outgoingOwnershipEpoch,
      ],
      foreignColumns: [
        taskCreatorEdgeReceivability.companyId,
        taskCreatorEdgeReceivability.taskId,
        taskCreatorEdgeReceivability.ownershipEpoch,
      ],
      name: "task_creator_withdrawal_commands_outgoing_edge_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.resultingOwnershipEpoch,
        table.taskUpdateId,
      ],
      foreignColumns: [
        taskUpdates.companyId,
        taskUpdates.taskId,
        taskUpdates.ownershipEpoch,
        taskUpdates.id,
      ],
      name: "task_creator_withdrawal_commands_update_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.pluginWithdrawalOperationId,
        table.actorPluginInstallationId,
        table.actorPluginKey,
        table.taskUpdateId,
      ],
      foreignColumns: [
        pluginWithdrawalOperations.companyId,
        pluginWithdrawalOperations.taskId,
        pluginWithdrawalOperations.id,
        pluginWithdrawalOperations.pluginInstallationId,
        pluginWithdrawalOperations.pluginKey,
        pluginWithdrawalOperations.taskUpdateId,
      ],
      name: "task_creator_withdrawal_commands_plugin_operation_fk",
    }).onDelete("restrict"),
    unique("task_creator_withdrawal_commands_epoch_uq").on(
      table.companyId,
      table.taskId,
      table.outgoingOwnershipEpoch,
    ),
    uniqueIndex("task_creator_withdrawal_commands_plugin_operation_uq")
      .on(table.pluginWithdrawalOperationId)
      .where(sql`${table.pluginWithdrawalOperationId} is not null`),
    uniqueIndex("task_creator_withdrawal_commands_update_uq")
      .on(table.taskUpdateId)
      .where(sql`${table.taskUpdateId} is not null`),
    index("task_creator_withdrawal_commands_task_accepted_idx").on(
      table.companyId,
      table.taskId,
      table.acceptedAt,
    ),
  ],
);

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

export type TaskCreatorWithdrawalCommand =
  typeof taskCreatorWithdrawalCommands.$inferSelect;
export type NewTaskCreatorWithdrawalCommand =
  typeof taskCreatorWithdrawalCommands.$inferInsert;
export type TaskBoardLifecycleCommand =
  typeof taskBoardLifecycleCommands.$inferSelect;
export type NewTaskBoardLifecycleCommand =
  typeof taskBoardLifecycleCommands.$inferInsert;
