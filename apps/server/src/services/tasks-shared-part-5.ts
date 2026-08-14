import * as d from "./tasks-dependencies.js";

import {
  type TaskBlockerAttentionAgentRow,
  type TaskBlockerAttentionEdge,
  type TaskBlockerAttentionInputNode,
  type TaskBlockerAttentionNode,
  type TaskBlockerAttentionQueryRow,
  BLOCKER_ATTENTION_CHILD_TERMINAL_STATUSES,
  BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES,
  BLOCKER_ATTENTION_MAX_DEPTH,
  BLOCKER_ATTENTION_MAX_NODES,
  BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES,
} from "./tasks-shared-part-3-section-1.js";
import {
  appendBlockerAttentionEdges,
  blockerSampleIdentifier,
  createTaskBlockerAttention,
} from "./tasks-shared-part-4.js";
import { chunkList } from "./tasks-shared-part-2-section-1.js";
import { TASK_LIST_RELATED_QUERY_CHUNK_SIZE } from "./tasks-shared-part-1.js";

export async function listTaskBlockerAttentionMap(
  dbOrTx: any,
  companyId: string,
  taskRows: TaskBlockerAttentionInputNode[],
): Promise<Map<string, d.TaskBlockerAttention>> {
  const statusRows: TaskBlockerAttentionNode[] = taskRows;
  const roots = statusRows.filter(
    (row) => row.companyId === companyId && row.boardPresentationStatus === "blocked",
  );
  const attentionMap = new Map<string, d.TaskBlockerAttention>();
  for (const row of statusRows) {
    if (row.boardPresentationStatus !== "blocked") {
      attentionMap.set(row.id, createTaskBlockerAttention());
    }
  }
  if (roots.length === 0) return attentionMap;

  const nodesById = new Map<string, TaskBlockerAttentionNode>();
  const edgesByTaskId = new Map<string, TaskBlockerAttentionEdge[]>();
  for (const root of roots) nodesById.set(root.id, { ...root });

  let frontier = roots.map((root) => root.id);
  let truncated = false;
  for (let depth = 0; frontier.length > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH; depth += 1) {
    const nextFrontier = new Set<string>();

    for (const chunk of chunkList([...new Set(frontier)], TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const explicitBlockerRowsPromise: Promise<TaskBlockerAttentionQueryRow[]> = dbOrTx
        .select({
          taskId: d.taskRelations.relatedTaskId,
          blockerTaskId: d.tasks.id,
          id: d.tasks.id,
          companyId: d.tasks.companyId,
          parentId: d.tasks.parentId,
          identifier: d.tasks.identifier,
          title: d.tasks.title,
          boardPresentationStatus: d.tasks.boardPresentationStatus,
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
      const childRowsPromise: Promise<TaskBlockerAttentionQueryRow[]> = dbOrTx
        .select({
          taskId: d.tasks.parentId,
          blockerTaskId: d.tasks.id,
          id: d.tasks.id,
          companyId: d.tasks.companyId,
          parentId: d.tasks.parentId,
          identifier: d.tasks.identifier,
          title: d.tasks.title,
          boardPresentationStatus: d.tasks.boardPresentationStatus,
          ownerAgentId: d.tasks.ownerAgentId,
          ownerUserId: d.tasks.ownerUserId,
        })
        .from(d.tasks)
        .where(
          d.and(
            d.eq(d.tasks.companyId, companyId),
            d.inArray(d.tasks.parentId, chunk),
            d.notInArray(d.tasks.boardPresentationStatus, [...BLOCKER_ATTENTION_CHILD_TERMINAL_STATUSES]),
          ),
        );
      const [explicitBlockerRows, childRows] = await Promise.all([
        explicitBlockerRowsPromise,
        childRowsPromise,
      ]);

      appendBlockerAttentionEdges(edgesByTaskId, [
        ...explicitBlockerRows
          .filter((row): row is TaskBlockerAttentionQueryRow & { taskId: string } => row.taskId !== null)
          .map((row) => ({
            taskId: row.taskId,
            blockerTaskId: row.blockerTaskId,
          })),
        ...childRows
          .filter((row): row is TaskBlockerAttentionQueryRow & { taskId: string } => row.taskId !== null)
          .map((row) => ({
            taskId: row.taskId,
            blockerTaskId: row.blockerTaskId,
          })),
      ]);

      for (const row of [...explicitBlockerRows, ...childRows]) {
        if (!row.taskId || nodesById.has(row.blockerTaskId)) continue;
        nodesById.set(row.blockerTaskId, {
          id: row.blockerTaskId,
          companyId: row.companyId,
          parentId: row.parentId,
          identifier: row.identifier,
          title: row.title,
          boardPresentationStatus: row.boardPresentationStatus,
          ownerAgentId: row.ownerAgentId,
          ownerUserId: row.ownerUserId,
        });
        nextFrontier.add(row.blockerTaskId);
      }
    }

    if (nodesById.size > BLOCKER_ATTENTION_MAX_NODES) {
      truncated = true;
      break;
    }
    frontier = [...nextFrontier];
  }
  if (frontier.length > 0) truncated = true;

  const nodeIds = [...nodesById.keys()];
  const activeTaskIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const node of nodesById.values()) {
    if (node.ownerAgentId) agentIds.add(node.ownerAgentId);
  }

  for (const chunk of chunkList(nodeIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const linkages = await d.resolveCurrentTaskOwnerRunLinkages(dbOrTx as d.Db, {
      companyId,
      taskIds: chunk,
    });
    for (const taskId of linkages.keys()) activeTaskIds.add(taskId);
  }

  const explicitWaitCandidateIds = [...nodesById.values()]
    .filter((node) => node.boardPresentationStatus !== "done")
    .map((node) => node.id);
  const explicitWaitingTaskIds = new Set<string>();
  if (explicitWaitCandidateIds.length > 0) {
    for (const chunk of chunkList(explicitWaitCandidateIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const approvalRows: Array<{ taskId: string }> = await dbOrTx
        .select({ taskId: d.taskApprovals.taskId })
        .from(d.taskApprovals)
        .innerJoin(d.approvals, d.eq(d.taskApprovals.approvalId, d.approvals.id))
        .where(
          d.and(
            d.eq(d.taskApprovals.companyId, companyId),
            d.inArray(d.approvals.status, BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES),
            d.inArray(d.taskApprovals.taskId, chunk),
          ),
        );
      for (const row of approvalRows) explicitWaitingTaskIds.add(row.taskId);
    }
  }

  const agentRows: TaskBlockerAttentionAgentRow[] =
    agentIds.size > 0
      ? await dbOrTx
          .select({
            id: d.agents.id,
            companyId: d.agents.companyId,
            status: d.agents.status,
          })
          .from(d.agents)
          .where(d.and(d.eq(d.agents.companyId, companyId), d.inArray(d.agents.id, [...agentIds])))
      : [];
  const agentsById = new Map(agentRows.map((agent) => [agent.id, agent]));

  type PathClassification = {
    covered: boolean;
    stalled: boolean;
    sampleBlockerIdentifier: string | null;
    sampleStalledBlockerIdentifier: string | null;
  };
  const classifyPath = (nodeId: string, seen: Set<string>): PathClassification => {
    const sample = blockerSampleIdentifier(nodesById.get(nodeId));
    if (truncated || seen.has(nodeId)) {
      return {
        covered: false,
        stalled: false,
        sampleBlockerIdentifier: sample,
        sampleStalledBlockerIdentifier: null,
      };
    }
    const node = nodesById.get(nodeId);
    if (!node || node.companyId !== companyId) {
      return {
        covered: false,
        stalled: false,
        sampleBlockerIdentifier: nodeId,
        sampleStalledBlockerIdentifier: null,
      };
    }
    const nodeSample = blockerSampleIdentifier(node);
    if (node.boardPresentationStatus === "done") {
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }
    if (explicitWaitingTaskIds.has(node.id)) {
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }
    if (node.ownerUserId && node.boardPresentationStatus !== "cancelled") {
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }
    if (node.boardPresentationStatus === "in_review") {
      const hasWaitingPath = activeTaskIds.has(node.id) || Boolean(node.ownerUserId);
      if (hasWaitingPath) {
        return {
          covered: true,
          stalled: false,
          sampleBlockerIdentifier: nodeSample,
          sampleStalledBlockerIdentifier: null,
        };
      }
      return {
        covered: false,
        stalled: true,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: nodeSample,
      };
    }
    if (activeTaskIds.has(node.id)) {
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }
    if (node.boardPresentationStatus === "cancelled") {
      return {
        covered: false,
        stalled: false,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }
    if (node.boardPresentationStatus === "backlog" && node.ownerAgentId) {
      return {
        covered: false,
        stalled: false,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }

    const downstream = (edgesByTaskId.get(node.id) ?? []).filter(
      (edge) => nodesById.get(edge.blockerTaskId)?.boardPresentationStatus !== "done",
    );
    if (downstream.length > 0) {
      const nextSeen = new Set(seen);
      nextSeen.add(nodeId);
      const classified = downstream.map((edge) => classifyPath(edge.blockerTaskId, nextSeen));
      const stalledChild = classified.find(
        (result) => result.stalled || result.sampleStalledBlockerIdentifier,
      );
      const sampleStalled = stalledChild?.sampleStalledBlockerIdentifier ?? null;
      const hardAttention = classified.find((result) => !result.covered && !result.stalled);
      if (hardAttention) {
        return {
          covered: false,
          stalled: false,
          sampleBlockerIdentifier: hardAttention.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      const stalledEntry = classified.find((result) => result.stalled);
      if (stalledEntry) {
        return {
          covered: false,
          stalled: true,
          sampleBlockerIdentifier: stalledEntry.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: classified[0]?.sampleBlockerIdentifier ?? nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }

    if (node.ownerAgentId) {
      const owner = agentsById.get(node.ownerAgentId);
      if (
        !owner ||
        owner.companyId !== companyId ||
        !BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES.has(owner.status)
      ) {
        return {
          covered: false,
          stalled: false,
          sampleBlockerIdentifier: nodeSample,
          sampleStalledBlockerIdentifier: null,
        };
      }
    }

    return {
      covered: false,
      stalled: false,
      sampleBlockerIdentifier: nodeSample,
      sampleStalledBlockerIdentifier: null,
    };
  };

  for (const root of roots) {
    const topLevelEdges = (edgesByTaskId.get(root.id) ?? []).filter(
      (edge) => nodesById.get(edge.blockerTaskId)?.boardPresentationStatus !== "done",
    );
    if (topLevelEdges.length === 0) {
      attentionMap.set(
        root.id,
        createTaskBlockerAttention({
          state: "needs_attention",
          reason: "attention_required",
        }),
      );
      continue;
    }

    const classified = topLevelEdges.map((edge) => ({
      edge,
      result: classifyPath(edge.blockerTaskId, new Set([root.id])),
    }));
    const coveredBlockerCount = classified.filter((entry) => entry.result.covered).length;
    const stalledBlockerCount = classified.filter((entry) => entry.result.stalled).length;
    const attentionBlockerCount = classified.length - coveredBlockerCount - stalledBlockerCount;
    const hardAttentionEntry = classified.find((entry) => !entry.result.covered && !entry.result.stalled);
    const stalledEntry = classified.find((entry) => entry.result.stalled);
    const sampleEntry = hardAttentionEntry ?? stalledEntry ?? classified[0] ?? null;
    const sampleNode = sampleEntry ? nodesById.get(sampleEntry.edge.blockerTaskId) : null;
    const sampleStalledFromChain = classified
      .map((entry) => entry.result.sampleStalledBlockerIdentifier)
      .find((value) => value);

    let state: d.TaskBlockerAttention["state"];
    let reason: d.TaskBlockerAttention["reason"];
    if (attentionBlockerCount > 0) {
      state = "needs_attention";
      reason = "attention_required";
    } else if (stalledBlockerCount > 0) {
      state = "stalled";
      reason = "stalled_review";
    } else {
      state = "covered";
      reason = topLevelEdges.every((edge) => nodesById.get(edge.blockerTaskId)?.parentId === root.id)
        ? "active_child"
        : "active_dependency";
    }

    attentionMap.set(
      root.id,
      createTaskBlockerAttention({
        state,
        reason,
        unresolvedBlockerCount: topLevelEdges.length,
        coveredBlockerCount,
        stalledBlockerCount,
        attentionBlockerCount,
        sampleBlockerIdentifier:
          sampleEntry?.result.sampleBlockerIdentifier ?? blockerSampleIdentifier(sampleNode),
        sampleStalledBlockerIdentifier:
          stalledEntry?.result.sampleStalledBlockerIdentifier ?? sampleStalledFromChain ?? null,
      }),
    );
  }

  return attentionMap;
}
