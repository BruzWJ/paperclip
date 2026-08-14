import {
  type TaskBlockerDiagnosticTaskSummary,
  type TaskSubtreeDiagnosticEdge,
  type TaskSubtreeDiagnosticNode,
  type TaskSubtreeDiagnosticsResponse,
} from "@paperclipai/shared";
import { type Request } from "express";
import { createCompanySearchRateLimiter } from "../services/company-search-rate-limit.js";
import { parseTaskExecutionState, redactTaskMonitorExternalRef } from "../services/task-execution-policy.js";
import { assertBoard } from "./authz.js";
import * as taskDiagnostics from "./task-route-diagnostics.js";

export type TaskSubtreeDiagnosticAuthzNode = taskDiagnostics.TaskBlockerDiagnosticAuthzTask & {
  depth: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type TaskSubtreeDiagnosticBlockerAuthzRow = taskDiagnostics.TaskBlockerDiagnosticAuthzTask & {
  blockedTaskId: string;
  relationCreatedAt: Date | string;
};

export function groupBlockersByBlockedTaskId(rows: TaskSubtreeDiagnosticBlockerAuthzRow[]) {
  const map = new Map<string, TaskSubtreeDiagnosticBlockerAuthzRow[]>();
  for (const row of rows) {
    const taskRows = map.get(row.blockedTaskId) ?? [];
    taskRows.push(row);
    map.set(row.blockedTaskId, taskRows);
  }
  return map;
}

export function taskSubtreeEdgeTimestamp(edge: TaskSubtreeDiagnosticEdge) {
  return edge.timestamp ? new Date(edge.timestamp).getTime() : 0;
}

export function buildTaskSubtreeDiagnosis(input: {
  task: TaskBlockerDiagnosticTaskSummary;
  nodes: TaskSubtreeDiagnosticNode[];
  omittedUnauthorizedNodeCount: number | null;
  truncated: boolean;
  caps: TaskSubtreeDiagnosticsResponse["caps"];
}) {
  if (input.truncated) {
    return `Subtree diagnostics for ${taskDiagnostics.blockerDiagnosticLabel(input.task)} are bounded to depth ${
      input.caps.maxDepth
    } and ${input.caps.maxNodes} nodes, so the diagnosis only covers returned visible nodes.`;
  }
  if ((input.omittedUnauthorizedNodeCount ?? 0) > 0) {
    return `One or more subtree nodes under ${taskDiagnostics.blockerDiagnosticLabel(
      input.task,
    )} are outside this actor's authorization boundary, so this diagnosis only covers visible nodes.`;
  }

  const blockedNodeWithDiagnosis = input.nodes.find(
    (node) => node.task.boardPresentationStatus === "blocked" && node.diagnosis,
  );
  const firstNodeWithDiagnosis = blockedNodeWithDiagnosis ?? input.nodes.find((node) => node.diagnosis);
  if (!firstNodeWithDiagnosis?.diagnosis) return null;

  return `${taskDiagnostics.blockerDiagnosticLabel(firstNodeWithDiagnosis.task)} appears to be the subtree stall point: ${
    firstNodeWithDiagnosis.diagnosis
  }`;
}

export function buildTaskSubtreeDiagnosticsResponse(input: {
  task: taskDiagnostics.TaskBlockerDiagnosticReadableTask;
  nodes: TaskSubtreeDiagnosticAuthzNode[];
  visibleNodes: TaskSubtreeDiagnosticAuthzNode[];
  blockersByTaskId: Map<string, TaskSubtreeDiagnosticBlockerAuthzRow[]>;
  visibleBlockers: TaskSubtreeDiagnosticBlockerAuthzRow[];
  readinessByTaskId: Map<
    string,
    {
      allBlockersDone: boolean;
      isDependencyReady: boolean;
      unresolvedBlockerTaskIds: string[];
    }
  >;
  truncatedNodes: boolean;
  truncatedDepth: boolean;
  truncatedBlockerTaskIds: Set<string>;
  caps: TaskSubtreeDiagnosticsResponse["caps"];
}): TaskSubtreeDiagnosticsResponse {
  const task = taskDiagnostics.toTaskBlockerDiagnosticSummary(input.task);
  const visibleNodeIds = new Set(input.visibleNodes.map((node) => node.id));
  const visibleBlockerIdsByTaskId = groupBlockersByBlockedTaskId(input.visibleBlockers);
  const omittedUnauthorizedNodeCount =
    input.truncatedNodes || input.truncatedDepth
      ? null
      : input.nodes.filter((node) => !visibleNodeIds.has(node.id)).length;
  const nodeResponses: TaskSubtreeDiagnosticNode[] = [];
  const edges: TaskSubtreeDiagnosticEdge[] = [];

  for (const node of input.visibleNodes) {
    const rawBlockers = input.blockersByTaskId.get(node.id) ?? [];
    const visibleBlockers = visibleBlockerIdsByTaskId.get(node.id) ?? [];
    const blockerResponse = taskDiagnostics.buildTaskBlockerDiagnosticsResponse({
      task: node,
      blockers: rawBlockers,
      visibleBlockers,
      readiness: input.readinessByTaskId.get(node.id) ?? {
        allBlockersDone: true,
        isDependencyReady: true,
        unresolvedBlockerTaskIds: [],
      },
      truncated: input.truncatedBlockerTaskIds.has(node.id),
      maxBlockers: input.caps.maxBlockersPerNode,
    });
    const nodeDiagnosis = blockerResponse.diagnosis;

    if (node.parentId && visibleNodeIds.has(node.parentId)) {
      edges.push({
        kind: "parent",
        fromTaskId: node.parentId,
        toTaskId: node.id,
        timestamp: taskDiagnostics.dateToIso(node.createdAt),
      });
    }
    for (const blocker of visibleBlockers) {
      edges.push({
        kind: "blocks",
        fromTaskId: blocker.id,
        toTaskId: node.id,
        timestamp: taskDiagnostics.dateToIso(blocker.relationCreatedAt),
      });
    }
    nodeResponses.push({
      task: taskDiagnostics.toTaskBlockerDiagnosticSummary(node),
      parentId: node.parentId && visibleNodeIds.has(node.parentId) ? node.parentId : null,
      depth: node.depth,
      diagnosis: nodeDiagnosis,
      likelyReason: nodeDiagnosis,
      blockers: blockerResponse.blockers,
      blockerReadiness: blockerResponse.readiness,
      omittedUnauthorizedBlockerCount: blockerResponse.omittedUnauthorizedBlockerCount,
      truncated: blockerResponse.truncated,
      truncatedSections: {
        blockers: blockerResponse.truncated,
      },
    });
  }

  edges.sort((left, right) => taskSubtreeEdgeTimestamp(right) - taskSubtreeEdgeTimestamp(left));
  const truncatedSections = {
    nodes: input.truncatedNodes,
    depth: input.truncatedDepth,
    blockers: input.truncatedBlockerTaskIds.size > 0,
  };
  const truncated = Object.values(truncatedSections).some(Boolean);
  const diagnosis = buildTaskSubtreeDiagnosis({
    task,
    nodes: nodeResponses,
    omittedUnauthorizedNodeCount,
    truncated,
    caps: input.caps,
  });

  return {
    task,
    diagnosis,
    likelyReason: diagnosis,
    nodes: nodeResponses,
    edges,
    nodeCount: nodeResponses.length,
    omittedUnauthorizedNodeCount,
    truncated,
    truncatedSections,
    caps: input.caps,
  };
}

export function summarizeTaskRelationForActivity(relation: {
  id: string;
  taskNumber: number;
  identifier: string;
  title: string | null;
}): taskDiagnostics.ActivityTaskRelationSummary {
  return {
    id: relation.id,
    taskNumber: relation.taskNumber,
    identifier: relation.identifier,
    title: relation.title,
  };
}

export const defaultCompanySearchRateLimiter = createCompanySearchRateLimiter();

export function companySearchRateLimitActor(req: Request, companyId: string) {
  assertBoard(req);
  return {
    companyId,
    actorType: "board" as const,
    actorId: req.actor.userId,
  };
}

export function summarizeTaskReferenceActivityDetails(
  input:
    | {
        addedReferencedTasks: taskDiagnostics.ActivityTaskRelationSummary[];
        removedReferencedTasks: taskDiagnostics.ActivityTaskRelationSummary[];
        currentReferencedTasks: taskDiagnostics.ActivityTaskRelationSummary[];
      }
    | null
    | undefined,
) {
  if (!input) return {};
  return {
    ...(input.addedReferencedTasks.length > 0 ? { addedReferencedTasks: input.addedReferencedTasks } : {}),
    ...(input.removedReferencedTasks.length > 0
      ? { removedReferencedTasks: input.removedReferencedTasks }
      : {}),
    ...(input.currentReferencedTasks.length > 0
      ? { currentReferencedTasks: input.currentReferencedTasks }
      : {}),
  };
}

export function summarizeTaskMonitor(
  task: {
    monitorNextCheckAt?: Date | null;
    monitorLastTriggeredAt?: Date | null;
    monitorAttemptCount?: number | null;
    monitorNotes?: string | null;
    monitorScheduledBy?: string | null;
    executionState?: unknown;
  },
  policy: taskDiagnostics.NormalizedExecutionPolicy | null,
) {
  const state = parseTaskExecutionState(task.executionState);
  return {
    nextCheckAt: task.monitorNextCheckAt?.toISOString() ?? policy?.monitor?.nextCheckAt ?? null,
    lastTriggeredAt: task.monitorLastTriggeredAt?.toISOString() ?? state?.monitor?.lastTriggeredAt ?? null,
    attemptCount: task.monitorAttemptCount ?? state?.monitor?.attemptCount ?? 0,
    notes: policy?.monitor?.notes ?? task.monitorNotes ?? state?.monitor?.notes ?? null,
    scheduledBy:
      task.monitorScheduledBy ?? policy?.monitor?.scheduledBy ?? state?.monitor?.scheduledBy ?? null,
    kind: policy?.monitor?.kind ?? state?.monitor?.kind ?? null,
    serviceName: policy?.monitor?.serviceName ?? state?.monitor?.serviceName ?? null,
    externalRef: redactTaskMonitorExternalRef(
      policy?.monitor?.externalRef ?? state?.monitor?.externalRef ?? null,
    ),
    timeoutAt: policy?.monitor?.timeoutAt ?? state?.monitor?.timeoutAt ?? null,
    maxAttempts: policy?.monitor?.maxAttempts ?? state?.monitor?.maxAttempts ?? null,
    recoveryPolicy: policy?.monitor?.recoveryPolicy ?? state?.monitor?.recoveryPolicy ?? null,
    status: state?.monitor?.status ?? (policy?.monitor ? "scheduled" : null),
    clearReason: state?.monitor?.clearReason ?? null,
  };
}

export function activityExecutionParticipantKey(
  participant: taskDiagnostics.ActivityExecutionParticipant,
): string {
  return participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
}

export function summarizeExecutionParticipants(
  policy: taskDiagnostics.NormalizedExecutionPolicy | null,
  stageType: taskDiagnostics.NormalizedExecutionPolicy["stages"][number]["type"],
): taskDiagnostics.ActivityExecutionParticipant[] {
  const stage = policy?.stages.find((candidate) => candidate.type === stageType);
  return (
    stage?.participants.map((participant) => ({
      type: participant.type,
      agentId: participant.agentId ?? null,
      userId: participant.userId ?? null,
    })) ?? []
  );
}

export function diffExecutionParticipants(
  previousPolicy: taskDiagnostics.NormalizedExecutionPolicy | null,
  nextPolicy: taskDiagnostics.NormalizedExecutionPolicy | null,
  stageType: taskDiagnostics.NormalizedExecutionPolicy["stages"][number]["type"],
) {
  const previousParticipants = summarizeExecutionParticipants(previousPolicy, stageType);
  const nextParticipants = summarizeExecutionParticipants(nextPolicy, stageType);
  const previousByKey = new Map(
    previousParticipants.map((participant) => [activityExecutionParticipantKey(participant), participant]),
  );
  const nextByKey = new Map(
    nextParticipants.map((participant) => [activityExecutionParticipantKey(participant), participant]),
  );

  return {
    participants: nextParticipants,
    addedParticipants: nextParticipants.filter(
      (participant) => !previousByKey.has(activityExecutionParticipantKey(participant)),
    ),
    removedParticipants: previousParticipants.filter(
      (participant) => !nextByKey.has(activityExecutionParticipantKey(participant)),
    ),
  };
}

export type InternalTaskRuntimeFields = {
  executionWorkspaceId?: unknown;
  currentExecutionWorkspace?: unknown;
};
