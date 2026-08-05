import { issueTreeHolds, issues } from "@paperclipai/db";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";

type SqlValue = SQLWrapper | string;

/** Active pause holds gate their root and every current descendant. */
export function activeIssueTreePauseHoldExistsSql(
  companyId: SqlValue,
  issueId: SqlValue,
): SQL<boolean> {
  return sql<boolean>`exists (
    with recursive issue_pause_ancestors(id, parent_id) as (
      select pause_issue.id, pause_issue.parent_id
      from ${issues} pause_issue
      where pause_issue.company_id = ${companyId}
        and pause_issue.id = ${issueId}
      union
      select pause_parent.id, pause_parent.parent_id
      from ${issues} pause_parent
      join issue_pause_ancestors pause_child
        on pause_child.parent_id = pause_parent.id
      where pause_parent.company_id = ${companyId}
    )
    select 1
    from ${issueTreeHolds} pause_hold
    join issue_pause_ancestors pause_ancestor
      on pause_ancestor.id = pause_hold.root_issue_id
    where pause_hold.company_id = ${companyId}
      and pause_hold.mode = 'pause'
      and pause_hold.status = 'active'
  )`;
}

/** Serializes a pause commit with every lease transaction in the same issue tree. */
export async function lockIssueTreeExecutionGate(
  transaction: IssueSessionDbTransaction,
  companyId: string,
  issueId: string,
): Promise<void> {
  await transaction.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`issue-tree-execution:${companyId}:`} || gate.id::text, 0)
    )
    from (
      with recursive issue_gate_ancestors(id, parent_id, depth, path) as (
        select gate_issue.id, gate_issue.parent_id, 0, array[gate_issue.id]
        from ${issues} gate_issue
        where gate_issue.company_id = ${companyId}
          and gate_issue.id = ${issueId}
        union all
        select
          gate_parent.id,
          gate_parent.parent_id,
          gate_child.depth + 1,
          gate_child.path || gate_parent.id
        from ${issues} gate_parent
        join issue_gate_ancestors gate_child
          on gate_child.parent_id = gate_parent.id
        where gate_parent.company_id = ${companyId}
          and not gate_parent.id = any(gate_child.path)
      )
      select id
      from issue_gate_ancestors
      order by depth desc, id
      limit 1
    ) gate
  `);
}
