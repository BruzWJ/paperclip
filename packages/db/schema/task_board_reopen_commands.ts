import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AgentVisibleTaskStatus } from "@paperclipai/shared";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { taskCreatorEdgeReceivability } from "./task_creator_edge.js";
import { systemEscalationIdentities } from "./task_creator_edge.js";
import { taskComments } from "./task_comments.js";
import { taskExecutionRefs } from "./task_execution_runtime.js";
import { tasks } from "./tasks.js";

/**
 * Immutable audit/idempotency ledger for the sole audited operation that may
 * make a terminal task nonterminal without advancing its ownership epoch.
 * Its checked branch is either one invokable-agent execution ref or one
 * provider-free system-escalation board command, never an optional dispatch.
 */
export const taskBoardReopenCommands = pgTable(
  "task_board_reopen_commands",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").notNull(),
    actorUserId: text("actor_user_id").notNull().references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    identityDigest: text("identity_digest").notNull(),
    priorStatus: text("prior_status")
      .$type<Extract<AgentVisibleTaskStatus, "done" | "cancelled">>()
      .notNull(),
    priorDisposition: jsonb("prior_disposition")
      .$type<{ message: string; structuredResult?: unknown }>()
      .notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    branch: text("branch")
      .$type<"agent_execution" | "board_only">()
      .notNull(),
    preservedOwnerKind: text("preserved_owner_kind")
      .$type<"agent" | "user" | "board">()
      .notNull(),
    continuityFenceGeneration: integer("continuity_fence_generation")
      .notNull(),
    creatorEdgeId: uuid("creator_edge_id").notNull(),
    executionRefId: uuid("execution_ref_id"),
    systemEscalationIdentityId: uuid("system_escalation_identity_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "task_board_reopen_commands_actor_check",
      sql`length(btrim(${table.actorUserId})) > 0`,
    ),
    check(
      "task_board_reopen_commands_reason_check",
      sql`length(btrim(${table.reason})) > 0`,
    ),
    check(
      "task_board_reopen_commands_prior_status_check",
      sql`${table.priorStatus} in ('done', 'cancelled')`,
    ),
    check(
      "task_board_reopen_commands_epoch_check",
      sql`${table.ownershipEpoch} > 0
        and ${table.continuityFenceGeneration} > 0`,
    ),
    check(
      "task_board_reopen_commands_branch_check",
      sql`(
        ${table.branch} = 'agent_execution'
        and ${table.preservedOwnerKind} = 'agent'
        and ${table.executionRefId} is not null
        and ${table.systemEscalationIdentityId} is null
      ) or (
        ${table.branch} = 'board_only'
        and ${table.preservedOwnerKind} in ('user', 'board')
        and ${table.executionRefId} is null
        and ${table.systemEscalationIdentityId} is not null
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.taskId],
      foreignColumns: [tasks.companyId, tasks.id],
      name: "task_board_reopen_commands_task_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.ownershipEpoch,
        table.creatorEdgeId,
      ],
      foreignColumns: [
        taskCreatorEdgeReceivability.companyId,
        taskCreatorEdgeReceivability.taskId,
        taskCreatorEdgeReceivability.ownershipEpoch,
        taskCreatorEdgeReceivability.id,
      ],
      name: "task_board_reopen_commands_creator_edge_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.taskId, table.executionRefId],
      foreignColumns: [
        taskExecutionRefs.companyId,
        taskExecutionRefs.taskId,
        taskExecutionRefs.id,
      ],
      name: "task_board_reopen_commands_ref_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.systemEscalationIdentityId,
      ],
      foreignColumns: [
        systemEscalationIdentities.companyId,
        systemEscalationIdentities.escalationTaskId,
        systemEscalationIdentities.id,
      ],
      name: "task_board_reopen_commands_system_escalation_fk",
    }).onDelete("restrict"),
    uniqueIndex("task_board_reopen_commands_idempotency_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    index("task_board_reopen_commands_task_created_idx").on(
      table.companyId,
      table.taskId,
      table.createdAt,
    ),
  ],
);

/**
 * Typed board-user comment command ledger. The nullable mention tuple is the
 * explicit authority-bearing input; prose is never parsed to infer dispatch.
 */
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
    check(
      "task_board_user_comments_actor_check",
      sql`length(btrim(${table.actorUserId})) > 0`,
    ),
    check(
      "task_board_user_comments_epoch_check",
      sql`${table.ownershipEpoch} > 0`,
    ),
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
      foreignColumns: [
        taskComments.companyId,
        taskComments.taskId,
        taskComments.id,
      ],
      name: "task_board_user_comments_comment_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.taskId,
        table.ownershipEpoch,
        table.executionRefId,
      ],
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
