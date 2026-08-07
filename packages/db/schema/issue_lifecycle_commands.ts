import type {
  IssueBoardLifecycleCommandSubtype,
  IssueCreatorWithdrawalActorKind,
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
  issueCreatorEdgeReceivability,
  issueUpdates,
  pluginWithdrawalOperations,
} from "./issue_creator_edge.js";

/**
 * Append-only acceptance of the two control-plane creator-withdrawal forms.
 * A named-user row records the epoch-ending self-assignment. A plugin row
 * records the plugin's atomic epoch advance plus cancellation and therefore
 * binds its exact accepted RPC operation and issue update.
 */
export const issueCreatorWithdrawalCommands = pgTable(
  "issue_creator_withdrawal_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    issueId: uuid("issue_id").notNull(),
    outgoingOwnershipEpoch: integer("outgoing_ownership_epoch").notNull(),
    resultingOwnershipEpoch: integer("resulting_ownership_epoch").notNull(),
    resultingCreatorEdgeId: uuid("resulting_creator_edge_id"),
    actorKind: text("actor_kind")
      .$type<IssueCreatorWithdrawalActorKind>()
      .notNull(),
    actorUserId: text("actor_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    actorPluginInstallationId: uuid("actor_plugin_installation_id"),
    actorPluginKey: text("actor_plugin_key"),
    pluginWithdrawalOperationId: uuid("plugin_withdrawal_operation_id"),
    issueUpdateId: uuid("issue_update_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "issue_creator_withdrawal_commands_epoch_check",
      sql`${table.outgoingOwnershipEpoch} > 0
        and ${table.resultingOwnershipEpoch} =
          ${table.outgoingOwnershipEpoch} + 1`,
    ),
    check(
      "issue_creator_withdrawal_commands_actor_check",
      sql`(
        ${table.actorKind} = 'user'
        and ${table.actorUserId} is not null
        and ${table.resultingCreatorEdgeId} is not null
        and ${table.actorPluginInstallationId} is null
        and ${table.actorPluginKey} is null
        and ${table.pluginWithdrawalOperationId} is null
        and ${table.issueUpdateId} is null
      ) or (
        ${table.actorKind} = 'plugin'
        and ${table.actorUserId} is null
        and ${table.resultingCreatorEdgeId} is null
        and ${table.actorPluginInstallationId} is not null
        and ${table.actorPluginKey} is not null
        and length(btrim(${table.actorPluginKey})) > 0
        and ${table.pluginWithdrawalOperationId} is not null
        and ${table.issueUpdateId} is not null
      )`,
    ),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.resultingOwnershipEpoch,
        table.resultingCreatorEdgeId,
      ],
      foreignColumns: [
        issueCreatorEdgeReceivability.companyId,
        issueCreatorEdgeReceivability.issueId,
        issueCreatorEdgeReceivability.ownershipEpoch,
        issueCreatorEdgeReceivability.id,
      ],
      name: "issue_creator_withdrawal_commands_resulting_edge_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.outgoingOwnershipEpoch,
      ],
      foreignColumns: [
        issueCreatorEdgeReceivability.companyId,
        issueCreatorEdgeReceivability.issueId,
        issueCreatorEdgeReceivability.ownershipEpoch,
      ],
      name: "issue_creator_withdrawal_commands_outgoing_edge_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.resultingOwnershipEpoch,
        table.issueUpdateId,
      ],
      foreignColumns: [
        issueUpdates.companyId,
        issueUpdates.issueId,
        issueUpdates.ownershipEpoch,
        issueUpdates.id,
      ],
      name: "issue_creator_withdrawal_commands_update_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.pluginWithdrawalOperationId,
        table.actorPluginInstallationId,
        table.actorPluginKey,
        table.issueUpdateId,
      ],
      foreignColumns: [
        pluginWithdrawalOperations.companyId,
        pluginWithdrawalOperations.issueId,
        pluginWithdrawalOperations.id,
        pluginWithdrawalOperations.pluginInstallationId,
        pluginWithdrawalOperations.pluginKey,
        pluginWithdrawalOperations.issueUpdateId,
      ],
      name: "issue_creator_withdrawal_commands_plugin_operation_fk",
    }).onDelete("restrict"),
    unique("issue_creator_withdrawal_commands_epoch_uq").on(
      table.companyId,
      table.issueId,
      table.outgoingOwnershipEpoch,
    ),
    uniqueIndex("issue_creator_withdrawal_commands_plugin_operation_uq")
      .on(table.pluginWithdrawalOperationId)
      .where(sql`${table.pluginWithdrawalOperationId} is not null`),
    uniqueIndex("issue_creator_withdrawal_commands_update_uq")
      .on(table.issueUpdateId)
      .where(sql`${table.issueUpdateId} is not null`),
    index("issue_creator_withdrawal_commands_issue_accepted_idx").on(
      table.companyId,
      table.issueId,
      table.acceptedAt,
    ),
  ],
);

/**
 * One immutable row per issue actually mutated by a directly authenticated
 * named-board lifecycle command. The source command remains domain-owned;
 * this ledger supplies a closed, issue/epoch-scoped liveness provenance row.
 */
export const issueBoardLifecycleCommands = pgTable(
  "issue_board_lifecycle_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    issueId: uuid("issue_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    actorUserId: text("actor_user_id").notNull().references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    subtype: text("subtype")
      .$type<IssueBoardLifecycleCommandSubtype>()
      .notNull(),
    sourceCommandId: uuid("source_command_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "issue_board_lifecycle_commands_epoch_check",
      sql`${table.ownershipEpoch} > 0`,
    ),
    check(
      "issue_board_lifecycle_commands_actor_check",
      sql`length(btrim(${table.actorUserId})) > 0`,
    ),
    check(
      "issue_board_lifecycle_commands_subtype_check",
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
      "issue_board_lifecycle_commands_idempotency_check",
      sql`length(btrim(${table.idempotencyKey})) > 0`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.ownershipEpoch],
      foreignColumns: [
        issueCreatorEdgeReceivability.companyId,
        issueCreatorEdgeReceivability.issueId,
        issueCreatorEdgeReceivability.ownershipEpoch,
      ],
      name: "issue_board_lifecycle_commands_creator_edge_fk",
    }).onDelete("restrict"),
    unique("issue_board_lifecycle_commands_source_issue_uq").on(
      table.companyId,
      table.issueId,
      table.sourceCommandId,
    ),
    unique("issue_board_lifecycle_commands_idempotency_issue_uq").on(
      table.companyId,
      table.issueId,
      table.idempotencyKey,
    ),
    index("issue_board_lifecycle_commands_issue_committed_idx").on(
      table.companyId,
      table.issueId,
      table.committedAt,
    ),
  ],
);

export type IssueCreatorWithdrawalCommand =
  typeof issueCreatorWithdrawalCommands.$inferSelect;
export type NewIssueCreatorWithdrawalCommand =
  typeof issueCreatorWithdrawalCommands.$inferInsert;
export type IssueBoardLifecycleCommand =
  typeof issueBoardLifecycleCommands.$inferSelect;
export type NewIssueBoardLifecycleCommand =
  typeof issueBoardLifecycleCommands.$inferInsert;
