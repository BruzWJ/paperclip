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
import type { AgentVisibleIssueStatus } from "@paperclipai/shared";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { issueCreatorEdgeReceivability } from "./issue_creator_delivery.js";
import { systemEscalationIdentities } from "./issue_creator_delivery.js";
import { issueComments } from "./issue_comments.js";
import { issueExecutionRefs } from "./issue_execution_runtime.js";
import { issues } from "./issues.js";

/**
 * Immutable audit/idempotency ledger for the sole audited operation that may
 * make a terminal issue nonterminal without advancing its ownership epoch.
 * Its checked branch is either one invokable-agent execution ref or one
 * provider-free system-escalation board command, never an optional dispatch.
 */
export const issueBoardReopenCommands = pgTable(
  "issue_board_reopen_commands",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    issueId: uuid("issue_id").notNull(),
    actorUserId: text("actor_user_id").notNull().references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    identityDigest: text("identity_digest").notNull(),
    priorStatus: text("prior_status")
      .$type<Extract<AgentVisibleIssueStatus, "done" | "cancelled">>()
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
      "issue_board_reopen_commands_actor_check",
      sql`length(btrim(${table.actorUserId})) > 0`,
    ),
    check(
      "issue_board_reopen_commands_reason_check",
      sql`length(btrim(${table.reason})) > 0`,
    ),
    check(
      "issue_board_reopen_commands_prior_status_check",
      sql`${table.priorStatus} in ('done', 'cancelled')`,
    ),
    check(
      "issue_board_reopen_commands_epoch_check",
      sql`${table.ownershipEpoch} > 0
        and ${table.continuityFenceGeneration} > 0`,
    ),
    check(
      "issue_board_reopen_commands_branch_check",
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
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "issue_board_reopen_commands_issue_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.creatorEdgeId,
      ],
      foreignColumns: [
        issueCreatorEdgeReceivability.companyId,
        issueCreatorEdgeReceivability.issueId,
        issueCreatorEdgeReceivability.ownershipEpoch,
        issueCreatorEdgeReceivability.id,
      ],
      name: "issue_board_reopen_commands_creator_edge_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.issueId, table.executionRefId],
      foreignColumns: [
        issueExecutionRefs.companyId,
        issueExecutionRefs.issueId,
        issueExecutionRefs.id,
      ],
      name: "issue_board_reopen_commands_ref_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.systemEscalationIdentityId,
      ],
      foreignColumns: [
        systemEscalationIdentities.companyId,
        systemEscalationIdentities.escalationIssueId,
        systemEscalationIdentities.id,
      ],
      name: "issue_board_reopen_commands_system_escalation_fk",
    }).onDelete("restrict"),
    uniqueIndex("issue_board_reopen_commands_idempotency_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    index("issue_board_reopen_commands_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
  ],
);

/**
 * Typed board-user comment command ledger. The nullable mention tuple is the
 * explicit authority-bearing input; prose is never parsed to infer dispatch.
 */
export const issueBoardUserComments = pgTable(
  "issue_board_user_comments",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    issueId: uuid("issue_id").notNull(),
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
      "issue_board_user_comments_actor_check",
      sql`length(btrim(${table.actorUserId})) > 0`,
    ),
    check(
      "issue_board_user_comments_epoch_check",
      sql`${table.ownershipEpoch} > 0`,
    ),
    check(
      "issue_board_user_comments_mention_shape_check",
      sql`(
        ${table.mentionTargetAgentId} is null
        and ${table.executionRefId} is null
      ) or (
        ${table.mentionTargetAgentId} is not null
        and ${table.executionRefId} is not null
      )`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId, table.ownershipEpoch],
      foreignColumns: [
        issueCreatorEdgeReceivability.companyId,
        issueCreatorEdgeReceivability.issueId,
        issueCreatorEdgeReceivability.ownershipEpoch,
      ],
      name: "issue_board_user_comments_creator_edge_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.issueId, table.commentId],
      foreignColumns: [
        issueComments.companyId,
        issueComments.issueId,
        issueComments.id,
      ],
      name: "issue_board_user_comments_comment_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.ownershipEpoch,
        table.executionRefId,
      ],
      foreignColumns: [
        issueExecutionRefs.companyId,
        issueExecutionRefs.issueId,
        issueExecutionRefs.ownershipEpoch,
        issueExecutionRefs.id,
      ],
      name: "issue_board_user_comments_ref_fk",
    }).onDelete("restrict"),
    uniqueIndex("issue_board_user_comments_idempotency_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    uniqueIndex("issue_board_user_comments_comment_uq").on(table.commentId),
    index("issue_board_user_comments_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
  ],
);
