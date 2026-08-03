import { index, pgTable, text, timestamp, uniqueIndex, uuid, boolean, integer } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { issueExecutionRuns } from "./issue_execution_runs.js";
import { issues } from "./issues.js";
import { issueTreeHolds } from "./issue_tree_holds.js";

export const issueTreeHoldMembers = pgTable(
  "issue_tree_hold_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    holdId: uuid("hold_id").notNull().references(() => issueTreeHolds.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    parentIssueId: uuid("parent_issue_id").references(() => issues.id, { onDelete: "set null" }),
    depth: integer("depth").notNull().default(0),
    issueIdentifier: text("issue_identifier"),
    issueTitle: text("issue_title"),
    issueStatus: text("issue_status").notNull(),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ownerUserId: text("owner_user_id").references(() => authUsers.id, {
      onDelete: "restrict",
    }),
    activeRunId: uuid("active_run_id").references(() => issueExecutionRuns.id, { onDelete: "set null" }),
    activeRunStatus: text("active_run_status"),
    skipped: boolean("skipped").notNull().default(false),
    skipReason: text("skip_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    holdIssueUniqueIdx: uniqueIndex("issue_tree_hold_members_hold_issue_uq").on(table.holdId, table.issueId),
    companyIssueIdx: index("issue_tree_hold_members_company_issue_idx").on(table.companyId, table.issueId),
    holdDepthIdx: index("issue_tree_hold_members_hold_depth_idx").on(table.holdId, table.depth),
  }),
);
