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
import { issueComments } from "./issue_comments.js";
import { issueExecutionRuns } from "./issue_execution_runs.js";
import { issues } from "./issues.js";

/**
 * Immutable agent-originated request for collective Board direction. It is an
 * issue Session/comment source, not a Board-owned issue, creator delivery, or
 * provider invocation.
 */
export const issueBoardMentions = pgTable(
  "issue_board_mentions",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    issueId: uuid("issue_id").notNull(),
    ownershipEpoch: integer("ownership_epoch").notNull(),
    agentId: uuid("agent_id").notNull(),
    runId: uuid("run_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    reason: text("reason"),
    commentId: uuid("comment_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "issue_board_mentions_epoch_check",
      sql`${table.ownershipEpoch} > 0`,
    ),
    check(
      "issue_board_mentions_reason_check",
      sql`${table.reason} is null or length(btrim(${table.reason})) > 0`,
    ),
    foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "issue_board_mentions_issue_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "issue_board_mentions_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.companyId, table.issueId, table.runId],
      foreignColumns: [
        issueExecutionRuns.companyId,
        issueExecutionRuns.issueId,
        issueExecutionRuns.id,
      ],
      name: "issue_board_mentions_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.issueId, table.commentId],
      foreignColumns: [
        issueComments.companyId,
        issueComments.issueId,
        issueComments.id,
      ],
      name: "issue_board_mentions_comment_fk",
    }).onDelete("cascade"),
    uniqueIndex("issue_board_mentions_idempotency_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    uniqueIndex("issue_board_mentions_comment_uq").on(table.commentId),
    index("issue_board_mentions_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    index("issue_board_mentions_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.ownershipEpoch,
      table.createdAt,
    ),
  ],
);
