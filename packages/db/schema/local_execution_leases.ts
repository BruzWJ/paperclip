import { check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { issueExecutionRuns } from "./issue_execution_runs.js";
import { issues } from "./issues.js";

export const localExecutionLeases = pgTable(
  "local_execution_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    executionWorkspaceId: uuid("execution_workspace_id").notNull().references(() => executionWorkspaces.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => issueExecutionRuns.id, {
      onDelete: "cascade",
    }),
    status: text("status").notNull().default("active"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("local_execution_leases_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    companyExecutionWorkspaceIdx: index("local_execution_leases_company_execution_workspace_idx").on(
      table.companyId,
      table.executionWorkspaceId,
    ),
    companyIssueIdx: index("local_execution_leases_company_issue_idx").on(table.companyId, table.issueId),
    companyLastUsedIdx: index("local_execution_leases_company_last_used_idx").on(table.companyId, table.lastUsedAt),
    companyRunUq: unique("local_execution_leases_company_run_uq").on(
      table.companyId,
      table.runId,
    ),
    statusCheck: check(
      "local_execution_leases_status_check",
      sql`${table.status} in ('active', 'released', 'failed')`,
    ),
    lifecycleCheck: check(
      "local_execution_leases_lifecycle_check",
      sql`(
        ${table.status} = 'active'
        and ${table.releasedAt} is null
        and ${table.failureReason} is null
      ) or (
        ${table.status} = 'released'
        and ${table.releasedAt} is not null
        and ${table.failureReason} is null
      ) or (
        ${table.status} = 'failed'
        and ${table.releasedAt} is not null
        and ${table.failureReason} is not null
      )`,
    ),
  }),
);
