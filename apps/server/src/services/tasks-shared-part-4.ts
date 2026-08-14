import * as d from "./tasks-dependencies.js";

import {
  type DbReader,
  type TaskActiveRunRow,
  type TaskRow,
  TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
} from "./tasks-shared-part-1.js";
import {
  type TaskBlockerAttentionEdge,
  type TaskBlockerAttentionNode,
  BLOCKER_ATTENTION_MAX_DEPTH,
  BLOCKER_ATTENTION_MAX_NODES,
} from "./tasks-shared-part-3-section-1.js";
import { chunkList } from "./tasks-shared-part-2-section-1.js";

export async function activeRunMapForTasks<T extends Pick<TaskRow, "id" | "companyId">>(
  dbOrTx: any,
  taskRows: T[],
): Promise<Map<string, TaskActiveRunRow>> {
  const map = new Map<string, TaskActiveRunRow>();
  const taskIdsByCompany = new Map<string, string[]>();
  for (const row of taskRows) {
    const ids = taskIdsByCompany.get(row.companyId) ?? [];
    ids.push(row.id);
    taskIdsByCompany.set(row.companyId, ids);
  }

  for (const [companyId, taskIds] of taskIdsByCompany) {
    for (const taskIdChunk of chunkList([...new Set(taskIds)], TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const linkages = await d.resolveCurrentTaskOwnerRunLinkages(dbOrTx as d.Db, {
        companyId,
        taskIds: taskIdChunk,
      });
      for (const [taskId, linkage] of linkages) {
        map.set(taskId, {
          id: linkage.runId,
          status: linkage.runStatus,
          agentId: linkage.agentId,
          sourceKind: linkage.sourceKind,
          sourceRecordId: linkage.sourceRecordId,
          startedAt: linkage.startedAt,
          finishedAt: linkage.finishedAt,
          createdAt: linkage.createdAt,
        });
      }
    }
  }
  return map;
}

export async function liveDescendantCountMapForTasks(
  dbOrTx: any,
  companyId: string,
  taskIds: string[],
): Promise<Map<string, number>> {
  const uniqueTaskIds = [...new Set(taskIds)];
  const map = new Map<string, number>();
  if (uniqueTaskIds.length === 0) return map;
  const liveRunTaskIds = await d.listLiveOwnerTaskIds(dbOrTx as d.Db, {
    companyId,
  });
  if (liveRunTaskIds.length === 0) return map;
  const liveRunTaskRows = liveRunTaskIds.map((taskId) => d.sql`(${taskId}::uuid)`);

  for (const taskIdChunk of chunkList(uniqueTaskIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const targetRows = taskIdChunk.map((taskId) => d.sql`(${taskId}::uuid)`);
    const rows = await dbOrTx.execute(d.sql<{
      taskId: string;
      liveDescendantCount: number;
    }>`
      WITH RECURSIVE
        target_tasks(task_id) AS (
          VALUES ${d.sql.join(targetRows, d.sql`, `)}
        ),
        live_run_tasks(task_id) AS (
          VALUES ${d.sql.join(liveRunTaskRows, d.sql`, `)}
        ),
        live_tasks(live_task_id, parent_id) AS (
          SELECT DISTINCT live_task.id, live_task.parent_id
          FROM live_run_tasks live_run
          JOIN tasks live_task ON live_task.id = live_run.task_id
          WHERE live_task.company_id = ${companyId}
            AND live_task.hidden_at IS NULL
        ),
        live_ancestors(live_task_id, ancestor_id, next_parent_id, visited_task_ids) AS (
          SELECT live_tasks.live_task_id, parent.id, parent.parent_id, ARRAY[live_tasks.live_task_id, parent.id]
          FROM live_tasks
          JOIN tasks parent ON parent.id = live_tasks.parent_id
          WHERE parent.company_id = ${companyId}
            AND parent.hidden_at IS NULL
          UNION ALL
          SELECT
            live_ancestors.live_task_id,
            parent.id,
            parent.parent_id,
            live_ancestors.visited_task_ids || parent.id
          FROM live_ancestors
          JOIN tasks parent ON parent.id = live_ancestors.next_parent_id
          WHERE parent.company_id = ${companyId}
            AND parent.hidden_at IS NULL
            AND NOT parent.id = ANY(live_ancestors.visited_task_ids)
        )
      SELECT
        live_ancestors.ancestor_id::text AS "taskId",
        count(DISTINCT live_ancestors.live_task_id)::int AS "liveDescendantCount"
      FROM live_ancestors
      JOIN target_tasks ON target_tasks.task_id = live_ancestors.ancestor_id
      WHERE live_ancestors.ancestor_id <> live_ancestors.live_task_id
      GROUP BY live_ancestors.ancestor_id
    `);

    const resultRows = Array.isArray(rows) ? rows : Array.from(rows as Iterable<unknown>);
    for (const row of resultRows) {
      if (typeof row !== "object" || row === null) continue;
      const taskId = (row as { taskId?: unknown }).taskId;
      const liveDescendantCount = (row as { liveDescendantCount?: unknown }).liveDescendantCount;
      if (typeof taskId !== "string") continue;
      const count =
        typeof liveDescendantCount === "number" ? liveDescendantCount : Number(liveDescendantCount);
      if (Number.isFinite(count)) map.set(taskId, count);
    }
  }

  return map;
}

export function createTaskBlockerAttention(
  input: Partial<d.TaskBlockerAttention> = {},
): d.TaskBlockerAttention {
  return {
    state: input.state ?? "none",
    reason: input.reason ?? null,
    unresolvedBlockerCount: input.unresolvedBlockerCount ?? 0,
    coveredBlockerCount: input.coveredBlockerCount ?? 0,
    stalledBlockerCount: input.stalledBlockerCount ?? 0,
    attentionBlockerCount: input.attentionBlockerCount ?? 0,
    sampleBlockerIdentifier: input.sampleBlockerIdentifier ?? null,
    sampleStalledBlockerIdentifier: input.sampleStalledBlockerIdentifier ?? null,
  };
}

export function blockerSampleIdentifier(node: TaskBlockerAttentionNode | null | undefined) {
  return node?.identifier ?? null;
}

export function appendBlockerAttentionEdges(
  edgesByTaskId: Map<string, TaskBlockerAttentionEdge[]>,
  rows: TaskBlockerAttentionEdge[],
) {
  for (const row of rows) {
    const existing = edgesByTaskId.get(row.taskId) ?? [];
    if (!existing.some((edge) => edge.blockerTaskId === row.blockerTaskId)) {
      existing.push(row);
      edgesByTaskId.set(row.taskId, existing);
    }
  }
}

export type TaskRelationSummaryRow = {
  relatedId: string;
  taskNumber: number;
  identifier: string;
  title: string | null;
  boardPresentationStatus: string;
  priority: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
};

export function summarizeTaskRelationRow(row: TaskRelationSummaryRow): d.TaskRelationTaskSummary {
  return {
    id: row.relatedId,
    taskNumber: row.taskNumber,
    identifier: row.identifier,
    title: row.title,
    boardPresentationStatus:
      row.boardPresentationStatus as d.TaskRelationTaskSummary["boardPresentationStatus"],
    priority: row.priority as d.TaskRelationTaskSummary["priority"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
  };
}

export function taskRelationSortLabel(task: Pick<d.TaskRelationTaskSummary, "id" | "identifier" | "title">) {
  return task.title ?? task.identifier;
}

export async function terminalExplicitBlockersByRoot(
  companyId: string,
  roots: d.TaskRelationTaskSummary[],
  dbOrTx: DbReader,
): Promise<Map<string, d.TaskRelationTaskSummary[]>> {
  const rootIds = [...new Set(roots.map((root) => root.id))];
  const terminalByRoot = new Map<string, d.TaskRelationTaskSummary[]>();
  if (rootIds.length === 0) return terminalByRoot;

  const nodesById = new Map<string, d.TaskRelationTaskSummary>();
  const edgesByTaskId = new Map<string, string[]>();
  for (const root of roots) nodesById.set(root.id, root);

  let frontier = rootIds;
  for (let depth = 0; frontier.length > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH; depth += 1) {
    const nextFrontier = new Set<string>();
    for (const chunk of chunkList([...new Set(frontier)], TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const rows = await dbOrTx
        .select({
          currentTaskId: d.taskRelations.relatedTaskId,
          relatedId: d.tasks.id,
          taskNumber: d.tasks.taskNumber,
          identifier: d.tasks.identifier,
          title: d.tasks.title,
          boardPresentationStatus: d.tasks.boardPresentationStatus,
          priority: d.tasks.priority,
          ownerAgentId: d.tasks.ownerAgentId,
          ownerUserId: d.tasks.ownerUserId,
        })
        .from(d.taskRelations)
        .innerJoin(d.tasks, d.eq(d.taskRelations.taskId, d.tasks.id))
        .where(
          d.and(
            d.eq(d.taskRelations.companyId, companyId),
            d.eq(d.taskRelations.type, "blocks"),
            d.inArray(d.taskRelations.relatedTaskId, chunk),
            d.eq(d.tasks.companyId, companyId),
            d.ne(d.tasks.boardPresentationStatus, "done"),
          ),
        );

      for (const row of rows) {
        const existingEdges = edgesByTaskId.get(row.currentTaskId) ?? [];
        if (!existingEdges.includes(row.relatedId)) {
          existingEdges.push(row.relatedId);
          edgesByTaskId.set(row.currentTaskId, existingEdges);
        }
        if (!nodesById.has(row.relatedId)) {
          nodesById.set(row.relatedId, summarizeTaskRelationRow(row));
          nextFrontier.add(row.relatedId);
        }
      }
    }

    if (nodesById.size > BLOCKER_ATTENTION_MAX_NODES) break;
    frontier = [...nextFrontier];
  }

  const collectTerminal = (taskId: string, seen: Set<string>): d.TaskRelationTaskSummary[] => {
    if (seen.has(taskId)) return [];
    const node = nodesById.get(taskId);
    if (!node || node.boardPresentationStatus === "done") return [];
    const nextSeen = new Set(seen);
    nextSeen.add(taskId);
    const downstreamIds = edgesByTaskId.get(taskId) ?? [];
    if (downstreamIds.length === 0) return [node];
    return downstreamIds.flatMap((downstreamId) => collectTerminal(downstreamId, nextSeen));
  };

  for (const rootId of rootIds) {
    const deduped = new Map<string, d.TaskRelationTaskSummary>();
    for (const blocker of collectTerminal(rootId, new Set())) {
      if (blocker.id !== rootId) deduped.set(blocker.id, blocker);
    }
    if (deduped.size > 0) {
      terminalByRoot.set(
        rootId,
        [...deduped.values()].sort((a, b) =>
          taskRelationSortLabel(a).localeCompare(taskRelationSortLabel(b)),
        ),
      );
    }
  }

  return terminalByRoot;
}
