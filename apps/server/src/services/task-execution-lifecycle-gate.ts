import { taskTreeHolds, tasks } from "@paperclipai/db";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

type SqlValue = SQLWrapper | string;

/** Active pause holds gate their root and every current descendant. */
export function activeTaskTreePauseHoldExistsSql(
  companyId: SqlValue,
  taskId: SqlValue,
): SQL<boolean> {
  return sql<boolean>`exists (
    with recursive task_pause_ancestors(id, parent_id) as (
      select pause_task.id, pause_task.parent_id
      from ${tasks} pause_task
      where pause_task.company_id = ${companyId}
        and pause_task.id = ${taskId}
      union
      select pause_parent.id, pause_parent.parent_id
      from ${tasks} pause_parent
      join task_pause_ancestors pause_child
        on pause_child.parent_id = pause_parent.id
      where pause_parent.company_id = ${companyId}
    )
    select 1
    from ${taskTreeHolds} pause_hold
    join task_pause_ancestors pause_ancestor
      on pause_ancestor.id = pause_hold.root_task_id
    where pause_hold.company_id = ${companyId}
      and pause_hold.mode = 'pause'
      and pause_hold.status = 'active'
  )`;
}

/** Serializes a pause commit with every lease transaction in the same task tree. */
export async function lockTaskTreeExecutionGate(
  transaction: TaskSessionDbTransaction,
  companyId: string,
  taskId: string,
): Promise<void> {
  await transaction.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`task-tree-execution:${companyId}:`} || gate.id::text, 0)
    )
    from (
      with recursive task_gate_ancestors(id, parent_id, depth, path) as (
        select gate_task.id, gate_task.parent_id, 0, array[gate_task.id]
        from ${tasks} gate_task
        where gate_task.company_id = ${companyId}
          and gate_task.id = ${taskId}
        union all
        select
          gate_parent.id,
          gate_parent.parent_id,
          gate_child.depth + 1,
          gate_child.path || gate_parent.id
        from ${tasks} gate_parent
        join task_gate_ancestors gate_child
          on gate_child.parent_id = gate_parent.id
        where gate_parent.company_id = ${companyId}
          and not gate_parent.id = any(gate_child.path)
      )
      select id
      from task_gate_ancestors
      order by depth desc, id
      limit 1
    ) gate
  `);
}
