import { createHash, randomUUID } from "node:crypto";
import {
  Router,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  documents,
  taskComments,
  taskDocuments,
  taskRelations,
  tasks as taskRows,
  taskWorkProducts,
} from "@paperclipai/db";
import {
  validationDetails,
  attachmentArtifactWorkProductMetadataSchema,
  companySearchExtractQuerySchema,
  companySearchQuerySchema,
  createTaskAttachmentMetadataSchema,
  createTaskWorkProductSchema,
  createTaskLabelSchema,
  createDocumentAnnotationCommentSchema,
  createDocumentAnnotationThreadSchema,
  linkTaskApprovalSchema,
  taskDocumentKeySchema,
  restoreTaskDocumentRevisionSchema,
  updateTaskWorkProductSchema,
  updateDocumentAnnotationThreadSchema,
  upsertTaskDocumentSchema,
  createTaskUserCommentSchema,
  commitTaskCreatorFormSchema,
  commitTaskOwnerFormSchema,
  reassignTaskSchema,
  reopenTaskSchema,
  selfAssignTaskWithdrawalSchema,
  updateTaskTitleSchema,
  updateTaskExecutionPolicySchema,
  decideTaskExecutionStageSchema,
  isUuidLike,
  normalizeTaskIdentifier as normalizeTaskReferenceIdentifier,
  type CompactTask,
  type CompanySearchExtractQuery,
  type CompanySearchExtractResponse,
  type CompanySearchQuery,
  type CompanySearchResponse,
  type TaskBlockerDiagnosticFlag,
  type TaskBlockerDiagnosticTaskSummary,
  type TaskBlockerDiagnosticNode,
  type TaskBlockerDiagnosticsReadiness,
  type TaskBlockerDiagnosticsResponse,
  type TaskSubtreeDiagnosticEdge,
  type TaskSubtreeDiagnosticNode,
  type TaskSubtreeDiagnosticsResponse,
  type TaskRelationTaskSummary,
  type SourceTrustMetadata,
} from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import {
  readTaskExecutionRun,
  resolveTaskExecutionRunIdentityById,
} from "../services/task-execution-run-service.js";
import {
  accessService,
  companyService,
  companySearchService,
  goalService,
  taskApprovalService,
  inboxAgentPolicyService,
  TASK_LIST_DEFAULT_LIMIT,
  TASK_LIST_MAX_LIMIT,
  taskReferenceService,
  taskService,
  type TaskFilters,
  clampTaskListLimit,
  documentService,
  documentAnnotationService,
  logActivity,
  projectService,
  toPublicProject,
  OrdinaryTaskRuntimeRejected,
  type OrdinaryTaskRuntime,
  workProductService,
} from "../services/index.js";
import type { PluginDomainEventPublisher } from "../services/plugin-domain-event-publisher.js";
import { logger } from "../middleware/logger.js";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import {
  assertBoard,
  assertCompanyAccess,
  authorizeHumanTaskSteering,
  getAccessibleResource,
} from "./authz.js";
import {
  GENERIC_ATTACHMENT_CONTENT_TYPES,
  isInlineAttachmentContentType,
  normalizeTaskAttachmentMaxBytes,
  normalizeContentType,
  normalizeUploadAttachmentContentType,
  SVG_CONTENT_TYPE,
} from "../attachment-types.js";
import {
  TASK_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
} from "../services/tasks.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { redactSensitiveText } from "../redaction.js";
import {
  createCompanySearchRateLimiter,
  type CompanySearchRateLimiter,
} from "../services/company-search-rate-limit.js";
import {
  taskExecutionPolicyControlService,
  normalizeTaskExecutionPolicy,
  parseTaskExecutionState,
  redactTaskMonitorExternalRef,
} from "../services/task-execution-policy.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  buildPromotedSourceTrust,
  isLowTrustQuarantined,
} from "../services/source-trust.js";
import { taskIngressRoutes } from "./task-ingress.js";
import {
  LOW_TRUST_TASK_ANCESTRY_MAX_DEPTH,
} from "../services/trust-preset-resolver.js";

const MAX_TASK_COMMENT_LIMIT = 500;
const taskCommentRootPageQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_TASK_COMMENT_LIMIT).optional(),
  entryLimit: z.coerce.number().int().positive().max(MAX_TASK_COMMENT_LIMIT).optional(),
}).strict();
const taskCommentThreadPageQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_TASK_COMMENT_LIMIT).optional(),
}).strict();
const inboxArchiveBodySchema = z.object({}).strict().default({});
const promoteLowTrustOutputSchema = z.object({
  sourceArtifactKind: z.enum(["comment", "document", "work_product", "task"]),
  sourceArtifactId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(8_000),
});


type NormalizedExecutionPolicy = NonNullable<ReturnType<typeof normalizeTaskExecutionPolicy>>;
type CompanySearchService = {
  extract(companyId: string, query: CompanySearchExtractQuery): Promise<CompanySearchExtractResponse>;
  search(companyId: string, query: CompanySearchQuery): Promise<CompanySearchResponse>;
};
type ActivityTaskRelationSummary = {
  id: string;
  identifier: string | null;
  title: string | null;
};
type ActivityExecutionParticipant = Pick<
  NormalizedExecutionPolicy["stages"][number]["participants"][number],
  "type" | "agentId" | "userId"
>;
function buildAttachmentContentPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/content`;
}

const GENERIC_RESPONSE_ATTACHMENT_CONTENT_TYPES = new Set(GENERIC_ATTACHMENT_CONTENT_TYPES);

function inferVideoContentTypeFromFilename(filename: string | null | undefined): string | null {
  const lower = (filename ?? "").toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov") || lower.endsWith(".qt") || lower.endsWith(".quicktime")) return "video/quicktime";
  return null;
}

function resolveAttachmentResponseContentType(input: {
  storedContentType: string | null | undefined;
  objectContentType?: string | null;
  originalFilename?: string | null;
}) {
  const storedContentType = normalizeContentType(input.storedContentType || input.objectContentType);
  if (!GENERIC_RESPONSE_ATTACHMENT_CONTENT_TYPES.has(storedContentType)) return storedContentType;
  return inferVideoContentTypeFromFilename(input.originalFilename) ?? storedContentType;
}

function requiresPaperclipAttachmentMetadata(input: {
  type?: unknown;
  provider?: unknown;
}, fallback?: {
  type?: string | null;
  provider?: string | null;
}) {
  const type = typeof input.type === "string" ? input.type : fallback?.type ?? null;
  const provider = typeof input.provider === "string" ? input.provider : fallback?.provider ?? null;
  return type === "artifact" && provider === "paperclip";
}

const attachmentArtifactMetadataInputSchema = z.object({
  attachmentId: z.string().uuid(),
}).passthrough();

type TaskBlockerDiagnosticReadableTask = {
  id: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: string;
  priority: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
};

type TaskBlockerDiagnosticAuthzTask = TaskBlockerDiagnosticReadableTask & {
  companyId: string;
  projectId: string | null;
  parentId: string | null;
};

function toTaskBlockerDiagnosticSummary(
  task: TaskBlockerDiagnosticReadableTask,
): TaskBlockerDiagnosticTaskSummary {
  return {
    id: task.id,
    identifier: task.identifier,
    title: task.title,
    boardPresentationStatus:
      task.boardPresentationStatus as TaskBlockerDiagnosticTaskSummary["boardPresentationStatus"],
    priority: task.priority as TaskBlockerDiagnosticTaskSummary["priority"],
    ownerAgentId: task.ownerAgentId,
    ownerUserId: task.ownerUserId,
  };
}

function blockerDiagnosticLabel(task: TaskBlockerDiagnosticTaskSummary) {
  return task.title ?? task.identifier ?? `Task ${task.id}`;
}

function buildTaskBlockerDiagnosticsResponse(input: {
  task: TaskBlockerDiagnosticReadableTask;
  blockers: TaskBlockerDiagnosticAuthzTask[];
  visibleBlockers: TaskBlockerDiagnosticAuthzTask[];
  readiness: {
    allBlockersDone: boolean;
    isDependencyReady: boolean;
    unresolvedBlockerTaskIds: string[];
  };
  truncated: boolean;
  maxBlockers?: number;
}): TaskBlockerDiagnosticsResponse {
  const task = toTaskBlockerDiagnosticSummary(input.task);
  const visibleBlockerIds = new Set(input.visibleBlockers.map((blocker) => blocker.id));
  const omittedUnauthorizedBlockerCount = input.blockers.filter(
    (blocker) => !visibleBlockerIds.has(blocker.id),
  ).length;
  const completeVisibleSet = !input.truncated && omittedUnauthorizedBlockerCount === 0;
  const unresolvedIds = new Set(input.readiness.unresolvedBlockerTaskIds);

  const blockers: TaskBlockerDiagnosticNode[] = input.visibleBlockers.map((blockerRow) => {
    const blocker = toTaskBlockerDiagnosticSummary(blockerRow);
    const isUnresolved = unresolvedIds.has(blocker.id);
    const flags: TaskBlockerDiagnosticFlag[] = [];
    if (
      task.boardPresentationStatus === "blocked" &&
      blocker.boardPresentationStatus === "done"
    ) flags.push("done_but_blocking");
    if (blocker.boardPresentationStatus === "cancelled") flags.push("cancelled_blocker_in_set");

    return {
      ...blocker,
      isUnresolved,
      isDependencyReady: blocker.boardPresentationStatus === "done",
      flags,
    };
  });

  const readiness: TaskBlockerDiagnosticsReadiness | null = completeVisibleSet
    ? {
        allBlockersDone: input.readiness.allBlockersDone,
        isDependencyReady: input.readiness.isDependencyReady,
        unresolvedBlockerCount: input.readiness.unresolvedBlockerTaskIds.length,
      }
    : null;
  const reportedOmittedUnauthorizedBlockerCount = input.truncated
    ? null
    : omittedUnauthorizedBlockerCount;

  return {
    task,
    diagnosis: buildTaskBlockerDiagnosis({
      task,
      blockers,
      readiness,
      omittedUnauthorizedBlockerCount: reportedOmittedUnauthorizedBlockerCount,
      truncated: input.truncated,
      maxBlockers: input.maxBlockers ?? TASK_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
    }),
    readiness,
    blockers,
    omittedUnauthorizedBlockerCount: reportedOmittedUnauthorizedBlockerCount,
    truncated: input.truncated,
    caps: {
      maxBlockers: input.maxBlockers ?? TASK_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
    },
  };
}

function buildTaskBlockerDiagnosis(input: {
  task: TaskBlockerDiagnosticTaskSummary;
  blockers: TaskBlockerDiagnosticNode[];
  readiness: TaskBlockerDiagnosticsReadiness | null;
  omittedUnauthorizedBlockerCount: number | null;
  truncated: boolean;
  maxBlockers: number;
}) {
  if (input.truncated) {
    return `Blocker diagnostics for ${blockerDiagnosticLabel(input.task)} are truncated at ${
      input.maxBlockers
    } blockers, so readiness is not reported.`;
  }
  const omittedUnauthorizedBlockerCount = input.omittedUnauthorizedBlockerCount ?? 0;
  if (omittedUnauthorizedBlockerCount > 0) {
    return `One or more blockers for ${blockerDiagnosticLabel(
      input.task,
    )} are outside this actor's authorization boundary, so this diagnosis only covers visible blockers.`;
  }
  if (input.blockers.length === 0) {
    return input.task.boardPresentationStatus === "blocked"
      ? `${blockerDiagnosticLabel(input.task)} is blocked but has no first-class blocker relations.`
      : null;
  }

  const cancelled = input.blockers.find(
    (blocker) => blocker.boardPresentationStatus === "cancelled",
  );
  if (cancelled) {
    return `${blockerDiagnosticLabel(input.task)} is blocked by ${blockerDiagnosticLabel(
      cancelled,
    )}, which is cancelled; cancelled blockers do not resolve until the blocker relation is removed or replaced.`;
  }

  const unresolved = input.blockers.find((blocker) => blocker.isUnresolved);
  if (unresolved) {
    return `${blockerDiagnosticLabel(input.task)} is blocked by ${blockerDiagnosticLabel(
      unresolved,
    )}, which is ${unresolved.boardPresentationStatus}.`;
  }

  if (
    input.readiness?.isDependencyReady &&
    input.task.boardPresentationStatus === "blocked"
  ) {
    return `All blockers for ${blockerDiagnosticLabel(
      input.task,
    )} are resolved, but the task is still blocked; this is likely a stale blocker hold.`;
  }
  if (input.readiness?.isDependencyReady) {
    return `All blockers for ${blockerDiagnosticLabel(input.task)} are resolved.`;
  }

  return null;
}


function dateToIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type TaskSubtreeDiagnosticAuthzNode = TaskBlockerDiagnosticAuthzTask & {
  depth: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type TaskSubtreeDiagnosticBlockerAuthzRow = TaskBlockerDiagnosticAuthzTask & {
  blockedTaskId: string;
  relationCreatedAt: Date | string;
};

function groupBlockersByBlockedTaskId(rows: TaskSubtreeDiagnosticBlockerAuthzRow[]) {
  const map = new Map<string, TaskSubtreeDiagnosticBlockerAuthzRow[]>();
  for (const row of rows) {
    const taskRows = map.get(row.blockedTaskId) ?? [];
    taskRows.push(row);
    map.set(row.blockedTaskId, taskRows);
  }
  return map;
}

function taskSubtreeEdgeTimestamp(edge: TaskSubtreeDiagnosticEdge) {
  return edge.timestamp ? new Date(edge.timestamp).getTime() : 0;
}

function buildTaskSubtreeDiagnosis(input: {
  task: TaskBlockerDiagnosticTaskSummary;
  nodes: TaskSubtreeDiagnosticNode[];
  omittedUnauthorizedNodeCount: number | null;
  truncated: boolean;
  caps: TaskSubtreeDiagnosticsResponse["caps"];
}) {
  if (input.truncated) {
    return `Subtree diagnostics for ${blockerDiagnosticLabel(input.task)} are bounded to depth ${
      input.caps.maxDepth
    } and ${input.caps.maxNodes} nodes, so the diagnosis only covers returned visible nodes.`;
  }
  if ((input.omittedUnauthorizedNodeCount ?? 0) > 0) {
    return `One or more subtree nodes under ${blockerDiagnosticLabel(
      input.task,
    )} are outside this actor's authorization boundary, so this diagnosis only covers visible nodes.`;
  }

  const blockedNodeWithDiagnosis = input.nodes.find(
    (node) => node.task.boardPresentationStatus === "blocked" && node.diagnosis,
  );
  const firstNodeWithDiagnosis = blockedNodeWithDiagnosis ?? input.nodes.find((node) => node.diagnosis);
  if (!firstNodeWithDiagnosis?.diagnosis) return null;

  return `${blockerDiagnosticLabel(firstNodeWithDiagnosis.task)} appears to be the subtree stall point: ${
    firstNodeWithDiagnosis.diagnosis
  }`;
}

function buildTaskSubtreeDiagnosticsResponse(input: {
  task: TaskBlockerDiagnosticReadableTask;
  nodes: TaskSubtreeDiagnosticAuthzNode[];
  visibleNodes: TaskSubtreeDiagnosticAuthzNode[];
  blockersByTaskId: Map<string, TaskSubtreeDiagnosticBlockerAuthzRow[]>;
  visibleBlockers: TaskSubtreeDiagnosticBlockerAuthzRow[];
  readinessByTaskId: Map<string, {
    allBlockersDone: boolean;
    isDependencyReady: boolean;
    unresolvedBlockerTaskIds: string[];
  }>;
  truncatedNodes: boolean;
  truncatedDepth: boolean;
  truncatedBlockerTaskIds: Set<string>;
  caps: TaskSubtreeDiagnosticsResponse["caps"];
}): TaskSubtreeDiagnosticsResponse {
  const task = toTaskBlockerDiagnosticSummary(input.task);
  const visibleNodeIds = new Set(input.visibleNodes.map((node) => node.id));
  const visibleBlockerIdsByTaskId = groupBlockersByBlockedTaskId(input.visibleBlockers);
  const omittedUnauthorizedNodeCount = input.truncatedNodes || input.truncatedDepth
    ? null
    : input.nodes.filter((node) => !visibleNodeIds.has(node.id)).length;
  const nodeResponses: TaskSubtreeDiagnosticNode[] = [];
  const edges: TaskSubtreeDiagnosticEdge[] = [];

  for (const node of input.visibleNodes) {
    const rawBlockers = input.blockersByTaskId.get(node.id) ?? [];
    const visibleBlockers = visibleBlockerIdsByTaskId.get(node.id) ?? [];
    const blockerResponse = buildTaskBlockerDiagnosticsResponse({
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
        timestamp: dateToIso(node.createdAt),
      });
    }
    for (const blocker of visibleBlockers) {
      edges.push({
        kind: "blocks",
        fromTaskId: blocker.id,
        toTaskId: node.id,
        timestamp: dateToIso(blocker.relationCreatedAt),
      });
    }
    nodeResponses.push({
      task: toTaskBlockerDiagnosticSummary(node),
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

function summarizeTaskRelationForActivity(relation: {
  id: string;
  identifier: string | null;
  title: string | null;
}): ActivityTaskRelationSummary {
  return {
    id: relation.id,
    identifier: relation.identifier,
    title: relation.title,
  };
}

const defaultCompanySearchRateLimiter = createCompanySearchRateLimiter();

function companySearchRateLimitActor(req: Request, companyId: string) {
  assertBoard(req);
  return {
    companyId,
    actorType: "board" as const,
    actorId: req.actor.userId,
  };
}

function summarizeTaskReferenceActivityDetails(input:
  | {
      addedReferencedTasks: ActivityTaskRelationSummary[];
      removedReferencedTasks: ActivityTaskRelationSummary[];
      currentReferencedTasks: ActivityTaskRelationSummary[];
    }
  | null
  | undefined,
) {
  if (!input) return {};
  return {
    ...(input.addedReferencedTasks.length > 0 ? { addedReferencedTasks: input.addedReferencedTasks } : {}),
    ...(input.removedReferencedTasks.length > 0 ? { removedReferencedTasks: input.removedReferencedTasks } : {}),
    ...(input.currentReferencedTasks.length > 0 ? { currentReferencedTasks: input.currentReferencedTasks } : {}),
  };
}

function summarizeTaskMonitor(
  task: {
    monitorNextCheckAt?: Date | null;
    monitorLastTriggeredAt?: Date | null;
    monitorAttemptCount?: number | null;
    monitorNotes?: string | null;
    monitorScheduledBy?: string | null;
    executionState?: unknown;
  },
  policy: NormalizedExecutionPolicy | null,
) {
  const state = parseTaskExecutionState(task.executionState);
  return {
    nextCheckAt: task.monitorNextCheckAt?.toISOString() ?? policy?.monitor?.nextCheckAt ?? null,
    lastTriggeredAt: task.monitorLastTriggeredAt?.toISOString() ?? state?.monitor?.lastTriggeredAt ?? null,
    attemptCount: task.monitorAttemptCount ?? state?.monitor?.attemptCount ?? 0,
    notes: policy?.monitor?.notes ?? task.monitorNotes ?? state?.monitor?.notes ?? null,
    scheduledBy: task.monitorScheduledBy ?? policy?.monitor?.scheduledBy ?? state?.monitor?.scheduledBy ?? null,
    kind: policy?.monitor?.kind ?? state?.monitor?.kind ?? null,
    serviceName: policy?.monitor?.serviceName ?? state?.monitor?.serviceName ?? null,
    externalRef: redactTaskMonitorExternalRef(policy?.monitor?.externalRef ?? state?.monitor?.externalRef ?? null),
    timeoutAt: policy?.monitor?.timeoutAt ?? state?.monitor?.timeoutAt ?? null,
    maxAttempts: policy?.monitor?.maxAttempts ?? state?.monitor?.maxAttempts ?? null,
    recoveryPolicy: policy?.monitor?.recoveryPolicy ?? state?.monitor?.recoveryPolicy ?? null,
    status: state?.monitor?.status ?? (policy?.monitor ? "scheduled" : null),
    clearReason: state?.monitor?.clearReason ?? null,
  };
}

function activityExecutionParticipantKey(participant: ActivityExecutionParticipant): string {
  return participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
}

function summarizeExecutionParticipants(
  policy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
): ActivityExecutionParticipant[] {
  const stage = policy?.stages.find((candidate) => candidate.type === stageType);
  return (
    stage?.participants.map((participant) => ({
      type: participant.type,
      agentId: participant.agentId ?? null,
      userId: participant.userId ?? null,
    })) ?? []
  );
}

function diffExecutionParticipants(
  previousPolicy: NormalizedExecutionPolicy | null,
  nextPolicy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
) {
  const previousParticipants = summarizeExecutionParticipants(previousPolicy, stageType);
  const nextParticipants = summarizeExecutionParticipants(nextPolicy, stageType);
  const previousByKey = new Map(previousParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));
  const nextByKey = new Map(nextParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));

  return {
    participants: nextParticipants,
    addedParticipants: nextParticipants.filter((participant) => !previousByKey.has(activityExecutionParticipantKey(participant))),
    removedParticipants: previousParticipants.filter((participant) => !nextByKey.has(activityExecutionParticipantKey(participant))),
  };
}

type InternalTaskRuntimeFields = {
  executionWorkspaceId?: unknown;
  currentExecutionWorkspace?: unknown;
};

function toPublicTask<T extends object>(
  task: T,
): Omit<T, keyof InternalTaskRuntimeFields> {
  const {
    executionWorkspaceId: _executionWorkspaceId,
    currentExecutionWorkspace: _currentExecutionWorkspace,
    ...publicTask
  } = task as T & InternalTaskRuntimeFields;
  return publicTask as Omit<T, keyof InternalTaskRuntimeFields>;
}

function toCompactTask(
  task: Omit<CompactTask, "workMode" | "priority" | "ownerAssignmentSource" | "originKind"> &
    {
      workMode: string;
      priority: string;
      ownerAssignmentSource: string | null;
      originKind: string | null;
    } &
    InternalTaskRuntimeFields,
): CompactTask {
  return {
    id: task.id,
    companyId: task.companyId,
    projectId: task.projectId,
    projectWorkspaceId: task.projectWorkspaceId,
    goalId: task.goalId,
    parentId: task.parentId,
    title: task.title,
    request: task.request,
    boardPresentationStatus: task.boardPresentationStatus,
    lifecycleStatus: task.lifecycleStatus,
    disposition: task.disposition,
    workMode: task.workMode as CompactTask["workMode"],
    priority: task.priority as CompactTask["priority"],
    ownerKind: task.ownerKind,
    ownerAgentId: task.ownerAgentId,
    ownerUserId: task.ownerUserId,
    ownerAssignmentSource:
      task.ownerAssignmentSource as CompactTask["ownerAssignmentSource"],
    ownershipEpoch: task.ownershipEpoch,
    creatorKind: task.creatorKind,
    creatorAuthorityId: task.creatorAuthorityId,
    creatorAdapterConfigRevisionId: task.creatorAdapterConfigRevisionId,
    creatorUserId: task.creatorUserId,
    creatorPluginInstallationId: task.creatorPluginInstallationId,
    creatorPluginKey: task.creatorPluginKey,
    creatorCallbackKey: task.creatorCallbackKey,
    creatorCallbackVersion: task.creatorCallbackVersion,
    creatorRoutineId: task.creatorRoutineId,
    creatorRoutineDispatchId: task.creatorRoutineDispatchId,
    creatorSystemSourceKind: task.creatorSystemSourceKind,
    creatorSystemSourceId: task.creatorSystemSourceId,
    taskNumber: task.taskNumber,
    identifier: task.identifier,
    originKind: task.originKind as CompactTask["originKind"],
    originId: task.originId,
    originRunId: task.originRunId,
    requestDepth: task.requestDepth,
    billingCode: task.billingCode,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    cancelledAt: task.cancelledAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.labelIds ? { labelIds: task.labelIds } : {}),
    ...(task.labels ? { labels: task.labels } : {}),
    ...(task.blockedBy ? { blockedBy: task.blockedBy } : {}),
    ...(task.blockerAttention ? { blockerAttention: task.blockerAttention } : {}),
    ...(task.blockedInboxAttention !== undefined ? { blockedInboxAttention: task.blockedInboxAttention } : {}),
    ...(task.liveDescendantCount !== undefined ? { liveDescendantCount: task.liveDescendantCount } : {}),
    ...(task.myLastTouchAt !== undefined ? { myLastTouchAt: task.myLastTouchAt } : {}),
    ...(task.lastExternalCommentAt !== undefined ? { lastExternalCommentAt: task.lastExternalCommentAt } : {}),
    ...(task.lastActivityAt !== undefined ? { lastActivityAt: task.lastActivityAt } : {}),
    ...(task.isUnreadForMe !== undefined ? { isUnreadForMe: task.isUnreadForMe } : {}),
  };
}

function compactTaskListEtag(tasks: CompactTask[]): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(tasks))
    .digest("base64url");
  return `"compact-tasks:${hash}"`;
}

function requestMatchesEtag(ifNoneMatchHeader: string | undefined, etag: string): boolean {
  if (!ifNoneMatchHeader) return false;
  return ifNoneMatchHeader
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag || value === `W/${etag}`);
}

const TASK_LIST_SERVER_CACHE_TTL_MS = 2_000;
const TASK_LIST_SERVER_CACHE_STALE_MS = 5_000;
export const TASK_LIST_SERVER_CACHE_MAX_ENTRIES = 256;
const TASK_LIST_STORM_WINDOW_MS = 500;
const TASK_LIST_STORM_THRESHOLD = 4;
const TASK_LIST_MAX_ACTOR_CLIENT_INFLIGHT = 8;

type TaskListPreparedResponse =
  | {
      kind: "compact";
      body: CompactTask[];
      etag: string;
      cacheControl: string;
    }
  | {
      kind: "full";
      body: unknown[];
    };

type TaskListCacheStatus = "miss" | "hit" | "coalesced" | "stale" | "retry";

type TaskListStormEvent = {
  event: "request_storm_detected";
  route: string;
  companyId: string;
  actorType: string;
  actorIdentityHash: string;
  clientHash: string;
  cacheKeyHash: string;
  queryKeys: string[];
  identicalInFlightCount: number;
  windowMs: number;
  referer: string | null;
  visibilityHint: string | null;
};

type TaskListDiagnostics = {
  onComputeStart?: (context: { companyId: string; cacheKeyHash: string }) => void | Promise<void>;
  onStormDetected?: (event: TaskListStormEvent) => void;
};

type TaskListCacheEntry = {
  response: TaskListPreparedResponse;
  expiresAt: number;
  staleUntil: number;
};

type TaskListInflightEntry = {
  promise: Promise<TaskListPreparedResponse>;
  startedAt: number;
  waiterCount: number;
  stormLogged: boolean;
};

const taskListResponseCache = new Map<string, TaskListCacheEntry>();
const taskListInflight = new Map<string, TaskListInflightEntry>();
const taskListActorClientInflight = new Map<string, number>();

export function __getTaskListResponseCacheSizeForTests() {
  return taskListResponseCache.size;
}

export function __clearTaskListResponseCacheForTests() {
  taskListResponseCache.clear();
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function normalizeTaskListCacheValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map(normalizeTaskListCacheValue).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  }
  if (typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      const next = normalizeTaskListCacheValue(nestedValue);
      if (next !== undefined) normalized[key] = next;
    }
    return normalized;
  }
  return value;
}

function taskListActorIdentity(req: Request, companyId: string) {
  if (req.actor.type === "board") {
    const sessionPart = req.actor.source === "session"
      ? `cookie:${shortHash(String(req.headers.cookie ?? "no-cookie"))}`
      : req.actor.keyId;
    const key = [
      "board",
      companyId,
      req.actor.source,
      req.actor.userId,
      sessionPart,
    ].join(":");
    return { actorType: "board", key, hash: shortHash(key) };
  }

  const key = ["none", companyId, req.actor.source].join(":");
  return { actorType: "none", key, hash: shortHash(key) };
}

function taskListClientIdentity(req: Request) {
  const forwardedFor = Array.isArray(req.headers["x-forwarded-for"])
    ? req.headers["x-forwarded-for"][0]
    : req.headers["x-forwarded-for"];
  const client = [
    String(forwardedFor ?? req.ip ?? "unknown-ip").split(",")[0]?.trim() ?? "unknown-ip",
    req.header("user-agent") ?? "unknown-agent",
  ].join(":");
  return { key: client, hash: shortHash(client) };
}

function safeRefererPath(req: Request): string | null {
  const referer = req.header("referer");
  if (!referer) return null;
  try {
    return new URL(referer).pathname;
  } catch {
    return referer.split("?")[0]?.slice(0, 160) ?? null;
  }
}

function taskListRequestKey(input: {
  req: Request;
  companyId: string;
  normalizedQuery: Record<string, unknown>;
}) {
  const route = "GET /api/companies/:companyId/tasks";
  const actor = taskListActorIdentity(input.req, input.companyId);
  const client = taskListClientIdentity(input.req);
  const normalizedQuery = normalizeTaskListCacheValue(input.normalizedQuery) as Record<string, unknown>;
  const queryKeys = Object.keys(normalizedQuery).sort();
  const key = stableJson({
    actor: actor.key,
    companyId: input.companyId,
    query: normalizedQuery,
    route,
  });
  return {
    actor,
    client,
    key,
    keyHash: shortHash(key),
    queryKeys,
    route,
  };
}

function pruneTaskListResponseCache(now: number) {
  for (const [key, entry] of taskListResponseCache) {
    if (entry.staleUntil <= now) taskListResponseCache.delete(key);
  }
}

function touchTaskListResponseCacheEntry(key: string, entry: TaskListCacheEntry) {
  taskListResponseCache.delete(key);
  taskListResponseCache.set(key, entry);
}

function trimTaskListResponseCache() {
  while (taskListResponseCache.size > TASK_LIST_SERVER_CACHE_MAX_ENTRIES) {
    const oldestKey = taskListResponseCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    taskListResponseCache.delete(oldestKey);
  }
}

function setTaskListResponseCacheEntry(key: string, entry: TaskListCacheEntry) {
  touchTaskListResponseCacheEntry(key, entry);
  trimTaskListResponseCache();
}

function decrementTaskListActorClientInflight(actorClientKey: string) {
  const next = (taskListActorClientInflight.get(actorClientKey) ?? 1) - 1;
  if (next <= 0) taskListActorClientInflight.delete(actorClientKey);
  else taskListActorClientInflight.set(actorClientKey, next);
}

async function coordinateTaskListGet(input: {
  req: Request;
  companyId: string;
  requestKey: ReturnType<typeof taskListRequestKey>;
  allowTtlCache: boolean;
  diagnostics?: TaskListDiagnostics;
  compute: () => Promise<TaskListPreparedResponse>;
}): Promise<{
  response: TaskListPreparedResponse | null;
  cacheStatus: TaskListCacheStatus;
  identicalInFlightCount: number;
  retryAfterSeconds?: number;
}> {
  const now = Date.now();
  pruneTaskListResponseCache(now);

  const cached = input.allowTtlCache ? taskListResponseCache.get(input.requestKey.key) : undefined;
  if (cached && cached.expiresAt > now) {
    touchTaskListResponseCacheEntry(input.requestKey.key, cached);
    return { response: cached.response, cacheStatus: "hit", identicalInFlightCount: 0 };
  }

  const existing = taskListInflight.get(input.requestKey.key);
  if (existing) {
    existing.waiterCount += 1;
    const identicalInFlightCount = existing.waiterCount + 1;
    if (
      !existing.stormLogged &&
      identicalInFlightCount >= TASK_LIST_STORM_THRESHOLD &&
      now - existing.startedAt <= TASK_LIST_STORM_WINDOW_MS
    ) {
      existing.stormLogged = true;
      const event: TaskListStormEvent = {
        event: "request_storm_detected",
        route: input.requestKey.route,
        companyId: input.companyId,
        actorType: input.requestKey.actor.actorType,
        actorIdentityHash: input.requestKey.actor.hash,
        clientHash: input.requestKey.client.hash,
        cacheKeyHash: input.requestKey.keyHash,
        queryKeys: input.requestKey.queryKeys,
        identicalInFlightCount,
        windowMs: now - existing.startedAt,
        referer: safeRefererPath(input.req),
        visibilityHint: input.req.header("x-paperclip-tab-visible") ?? null,
      };
      logger.warn(event, "request_storm_detected");
      input.diagnostics?.onStormDetected?.(event);
    }
    const response = await existing.promise;
    return { response, cacheStatus: "coalesced", identicalInFlightCount };
  }

  const actorClientKey = `${input.requestKey.actor.key}:${input.requestKey.client.key}`;
  const actorClientInflight = taskListActorClientInflight.get(actorClientKey) ?? 0;
  if (actorClientInflight >= TASK_LIST_MAX_ACTOR_CLIENT_INFLIGHT) {
    if (cached && cached.staleUntil > now) {
      touchTaskListResponseCacheEntry(input.requestKey.key, cached);
      return { response: cached.response, cacheStatus: "stale", identicalInFlightCount: 0 };
    }
    return { response: null, cacheStatus: "retry", identicalInFlightCount: 0, retryAfterSeconds: 1 };
  }

  taskListActorClientInflight.set(actorClientKey, actorClientInflight + 1);
  const promise = (async () => {
    await input.diagnostics?.onComputeStart?.({
      companyId: input.companyId,
      cacheKeyHash: input.requestKey.keyHash,
    });
    return input.compute();
  })();
  const inflightEntry: TaskListInflightEntry = {
    promise,
    startedAt: now,
    waiterCount: 0,
    stormLogged: false,
  };
  taskListInflight.set(input.requestKey.key, inflightEntry);

  try {
    const response = await promise;
    if (input.allowTtlCache) {
      setTaskListResponseCacheEntry(input.requestKey.key, {
        response,
        expiresAt: Date.now() + TASK_LIST_SERVER_CACHE_TTL_MS,
        staleUntil: Date.now() + TASK_LIST_SERVER_CACHE_STALE_MS,
      });
    }
    return { response, cacheStatus: "miss", identicalInFlightCount: 1 };
  } finally {
    if (taskListInflight.get(input.requestKey.key) === inflightEntry) {
      taskListInflight.delete(input.requestKey.key);
    }
    decrementTaskListActorClientInflight(actorClientKey);
  }
}

function estimatedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function logTaskListRequest(input: {
  req: Request;
  res: Response;
  companyId: string;
  requestKey: ReturnType<typeof taskListRequestKey>;
  startedAt: number;
  cacheStatus: TaskListCacheStatus;
  bodyBytes: number;
  etagOutcome: "none" | "fresh" | "not_modified";
  identicalInFlightCount: number;
}) {
  input.res.once("finish", () => {
    const contentEncoding = input.res.getHeader("content-encoding");
    const contentLength = Number(input.res.getHeader("content-length"));
    logger.debug({
      event: "safe_get_request_observed",
      route: input.requestKey.route,
      companyId: input.companyId,
      actorType: input.requestKey.actor.actorType,
      actorIdentityHash: input.requestKey.actor.hash,
      clientHash: input.requestKey.client.hash,
      cacheKeyHash: input.requestKey.keyHash,
      queryKeys: input.requestKey.queryKeys,
      requestCount: input.identicalInFlightCount,
      durationMs: Date.now() - input.startedAt,
      statusCode: input.res.statusCode,
      responseBytes: input.bodyBytes,
      compressedBytes: contentEncoding && Number.isFinite(contentLength) ? contentLength : null,
      contentEncoding: contentEncoding ? String(contentEncoding) : null,
      cacheStatus: input.cacheStatus,
      etagOutcome: input.etagOutcome,
      referer: safeRefererPath(input.req),
      visibilityHint: input.req.header("x-paperclip-tab-visible") ?? null,
    }, "safe authenticated GET observed");
  });
}

export function requireNamedBoardUser(req: Request): string {
  if (
    req.actor.type !== "board"
    || req.actor.userId.trim().length === 0
  ) {
    throw forbidden(
      "Task commands require an authenticated named board user",
    );
  }
  assertBoard(req);
  return req.actor.userId;
}

function canonicalTaskMutationError(error: unknown): never {
  if (!(error instanceof OrdinaryTaskRuntimeRejected)) {
    throw error;
  }
  const details = { code: error.reason };
  if (error.reason === "creator_authority_mismatch") {
    throw forbidden(error.message, details);
  }
  if (
    error.reason === "owner_authority_invalid" ||
    error.reason === "user_withdrawal_cancel_only"
  ) {
    throw forbidden(error.message, details);
  }
  if (
    error.reason.endsWith("_idempotency_conflict") ||
    error.reason.endsWith("_lifecycle_conflict") ||
    error.reason === "task_form_conflict" ||
    error.reason === "reassignment_owner_unchanged" ||
    error.reason === "reassignment_target_invalid" ||
    error.reason === "board_reopen_target_invalid" ||
    error.reason === "human_mention_scope_invalid" ||
    error.reason === "withdrawal_self_assignment_target_invalid"
  ) {
    throw conflict(error.message, details);
  }
  throw unprocessable(error.message, details);
}

export function taskRoutes(
  db: Db,
  storage: StorageService,
  opts: {
    searchService?: CompanySearchService;
    searchRateLimiter?: CompanySearchRateLimiter;
    pluginWorkerManager?: PluginWorkerManager;
    taskListDiagnostics?: TaskListDiagnostics;
    ordinaryTasks: OrdinaryTaskRuntime;
    pluginDomainEvents: PluginDomainEventPublisher;
  },
) {
  const router = Router();
  const svc = taskService(db);
  const ordinaryTasks = opts.ordinaryTasks;
  const executionPolicyControl = taskExecutionPolicyControlService(db);
  const access = accessService(db);
  const companiesSvc = companyService(db);
  let searchSvc = opts.searchService ?? null;
  const getSearchService = () => {
    searchSvc ??= companySearchService(db);
    return searchSvc;
  };
  const searchRateLimiter = opts.searchRateLimiter ?? defaultCompanySearchRateLimiter;
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const taskApprovalsSvc = taskApprovalService(db);
  const workProductsSvc = workProductService(db);
  const documentsSvc = documentService(db);
  const documentAnnotationsSvc = documentAnnotationService(db);
  const taskReferencesSvc = taskReferenceService(db);

  async function lookupLowTrustSourceArtifact(input: {
    taskId: string;
    artifactKind: "comment" | "document" | "work_product" | "task";
    artifactId: string;
  }): Promise<SourceTrustMetadata | null> {
    if (input.artifactKind === "task") {
      const row = await db
        .select({
          id: taskRows.id,
          companyId: taskRows.companyId,
          parentId: taskRows.parentId,
          sourceTrust: taskRows.sourceTrust,
        })
        .from(taskRows)
        .where(eq(taskRows.id, input.artifactId))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const sourceTask = await db
        .select({ companyId: taskRows.companyId })
        .from(taskRows)
        .where(eq(taskRows.id, input.taskId))
        .then((rows) => rows[0] ?? null);
      if (!sourceTask || row.companyId !== sourceTask.companyId) return null;
      if (row.id !== input.taskId) {
        let cursor = row.parentId;
        let isDescendant = false;
        for (let depth = 0; cursor && depth < LOW_TRUST_TASK_ANCESTRY_MAX_DEPTH; depth += 1) {
          if (cursor === input.taskId) {
            isDescendant = true;
            break;
          }
          const parent = await db
            .select({ id: taskRows.id, companyId: taskRows.companyId, parentId: taskRows.parentId })
            .from(taskRows)
            .where(eq(taskRows.id, cursor))
            .then((rows) => rows[0] ?? null);
          if (!parent || parent.companyId !== row.companyId) return null;
          cursor = parent.parentId;
        }
        if (!isDescendant) return null;
      }
      return row?.sourceTrust ?? null;
    }

    if (input.artifactKind === "comment") {
      const row = await db
        .select({ sourceTrust: taskComments.sourceTrust })
        .from(taskComments)
        .where(and(eq(taskComments.id, input.artifactId), eq(taskComments.taskId, input.taskId)))
        .then((rows) => rows[0] ?? null);
      return row?.sourceTrust ?? null;
    }

    if (input.artifactKind === "document") {
      const row = await db
        .select({ sourceTrust: documents.sourceTrust })
        .from(taskDocuments)
        .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
        .where(and(eq(documents.id, input.artifactId), eq(taskDocuments.taskId, input.taskId)))
        .then((rows) => rows[0] ?? null);
      return row?.sourceTrust ?? null;
    }

    const row = await db
      .select({ sourceTrust: taskWorkProducts.sourceTrust })
      .from(taskWorkProducts)
      .where(and(eq(taskWorkProducts.id, input.artifactId), eq(taskWorkProducts.taskId, input.taskId)))
      .then((rows) => rows[0] ?? null);
    return row?.sourceTrust ?? null;
  }

  function withContentPath<T extends { id: string }>(attachment: T) {
    const contentPath = `/api/attachments/${attachment.id}/content`;
    return {
      ...attachment,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
    };
  }

  type ParsedAttachmentRange =
    | { kind: "none" }
    | { kind: "invalid" }
    | { kind: "range"; start: number; end: number };

  function parseAttachmentRangeHeader(raw: string | undefined, contentLength: number): ParsedAttachmentRange {
    if (!raw) return { kind: "none" };
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) return { kind: "invalid" };

    const prefix = "bytes=";
    if (!raw.toLowerCase().startsWith(prefix)) return { kind: "invalid" };
    const spec = raw.slice(prefix.length).trim();
    if (!spec || spec.includes(",")) return { kind: "invalid" };

    const [startRaw, endRaw] = spec.split("-", 2);
    if (endRaw === undefined) return { kind: "invalid" };

    if (startRaw === "") {
      const suffixLength = Number.parseInt(endRaw, 10);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: "invalid" };
      const start = Math.max(contentLength - suffixLength, 0);
      return { kind: "range", start, end: contentLength - 1 };
    }

    const start = Number.parseInt(startRaw, 10);
    if (!Number.isSafeInteger(start) || start < 0 || start >= contentLength) return { kind: "invalid" };
    const end = endRaw === "" ? contentLength - 1 : Number.parseInt(endRaw, 10);
    if (!Number.isSafeInteger(end) || end < start) return { kind: "invalid" };
    return { kind: "range", start, end: Math.min(end, contentLength - 1) };
  }

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  function parseOptionalBooleanQuery(value: unknown) {
    if (value === undefined) return undefined;
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    return null;
  }

  function shouldIncludeDocumentAnnotations(req: Request) {
    if (req.query.includeAnnotations === "false" || req.query.includeAnnotations === "0") return false;
    return parseBooleanQuery(req.query.includeAnnotations);
  }

  function shouldIncludeDocumentAnnotationComments(req: Request) {
    return parseBooleanQuery(req.query.includeAnnotationComments);
  }

  function annotationActorInput(req: Request) {
    assertBoard(req);
    return {
      userId: req.actor.userId,
      annotationActor: {
        actorType: "user" as const,
        actorId: req.actor.userId,
        userId: req.actor.userId,
      },
    };
  }

  async function canonicalizePaperclipArtifactMetadata(input: {
    task: { id: string; companyId: string };
    metadata: Record<string, unknown> | null | undefined;
  }) {
    const parsed = attachmentArtifactMetadataInputSchema.safeParse(input.metadata);
    if (!parsed.success) {
      throw unprocessable("Invalid attachment artifact metadata", {
        code: "invalid_attachment_artifact_metadata",
        details: validationDetails(parsed.error),
      });
    }

    const attachment = await svc.getAttachmentById(parsed.data.attachmentId);
    if (!attachment || attachment.companyId !== input.task.companyId || attachment.taskId !== input.task.id) {
      throw unprocessable("Attachment artifact must reference an attachment on the same task", {
        code: "invalid_attachment_artifact_metadata",
        attachmentId: parsed.data.attachmentId,
      });
    }

    const contentPath = buildAttachmentContentPath(attachment.id);
    return attachmentArtifactWorkProductMetadataSchema.parse({
      attachmentId: attachment.id,
      contentType: normalizeContentType(attachment.contentType),
      byteSize: attachment.byteSize,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
      originalFilename: attachment.originalFilename ?? null,
    });
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, `Invalid ${field} query value`);
    }
    return parsed;
  }

  async function runSingleFileUpload(req: Request, res: Response, fileSizeLimit: number) {
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: fileSizeLimit, files: 1 },
    });
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function assertCanManageTaskApprovalLinks(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    return true;
  }

  function actorCanAccessCompany(req: Request, companyId: string) {
    if (req.actor.type !== "board") return false;
    if (req.actor.isInstanceAdmin) return true;
    return (req.actor.companyIds ?? []).includes(companyId);
  }

  async function assertTaskReadAllowed(
    req: Request,
    res: Response,
    task: { companyId: string },
  ) {
    if (req.actor.type === "board" && actorCanAccessCompany(req, task.companyId)) {
      return true;
    }
    res.status(403).json({ error: "Board access required" });
    return false;
  }

  async function filterTasksForActor<T extends { companyId: string }>(
    req: Request,
    rows: T[],
  ) {
    if (req.actor.type !== "board") return [];
    return rows.filter((task) => actorCanAccessCompany(req, task.companyId));
  }

  async function actorCanReadCompanyScope(req: Request, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    return decision.allowed;
  }

  async function assertBoardTaskMutationAllowed(
    req: Request,
    res: Response,
    task: { companyId: string },
  ) {
    if (req.actor.type === "board" && actorCanAccessCompany(req, task.companyId)) {
      return true;
    }
    res.status(403).json({ error: "Board access required" });
    return false;
  }

  async function loadWorkProductRunAttribution(runId: string) {
    const identity = await resolveTaskExecutionRunIdentityById(db, runId);
    if (!identity) return null;
    const run = await readTaskExecutionRun(db, identity);
    if (!run) return null;
    const agent = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, run.targetAgentId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return agent
      ? {
          id: run.runId,
          companyId: run.companyId,
          agentId: run.targetAgentId,
          agentCompanyId: agent.companyId,
        }
      : null;
  }

  async function resolveWorkProductCreatedByRunId(
    req: Request,
    res: Response,
    companyId: string,
    input: { createdByRunId?: string | null },
    mode: "create" | "update",
  ): Promise<string | null | undefined> {
    const hasCreatedByRunId = Object.prototype.hasOwnProperty.call(input, "createdByRunId");
    if (mode === "update" && !hasCreatedByRunId) return undefined;

    const requestedRunId = input.createdByRunId ?? null;
    if (!requestedRunId) return null;
    const run = await loadWorkProductRunAttribution(requestedRunId);
    if (!run || run.companyId !== companyId || run.agentCompanyId !== companyId) {
      res.status(403).json({ error: "createdByRunId is not valid for this company" });
      return undefined;
    }
    return requestedRunId;
  }

  async function resolveTaskRouteId(rawId: string): Promise<string> {
    const identifier = normalizeTaskReferenceIdentifier(rawId);
    if (identifier) {
      const task = await svc.getByIdentifier(identifier);
      if (task) {
        return task.id;
      }
    }
    return rawId;
  }

  async function resolveTaskProjectAndGoal(task: {
    companyId: string;
    projectId: string | null;
    goalId: string | null;
  }) {
    const projectPromise = task.projectId ? projectsSvc.getById(task.projectId) : Promise.resolve(null);
    const directGoalPromise = task.goalId ? goalsSvc.getById(task.goalId) : Promise.resolve(null);
    const [project, directGoal] = await Promise.all([projectPromise, directGoalPromise]);

    if (directGoal) {
      return { project, goal: directGoal };
    }

    if (!task.projectId) {
      const defaultGoal = await goalsSvc.getDefaultCompanyGoal(task.companyId);
      return { project, goal: defaultGoal };
    }

    return { project, goal: null };
  }

  function compactTaskProject(project: Awaited<ReturnType<typeof resolveTaskProjectAndGoal>>["project"]) {
    if (!project) return null;
    return {
      id: project.id,
      companyId: project.companyId,
      urlKey: project.urlKey,
      goalIds: project.goalIds,
      goals: project.goals,
      name: project.name,
      description: project.description,
      status: project.status,
      leadAgentId: project.leadAgentId,
      targetDate: project.targetDate,
      color: project.color,
      icon: project.icon,
      env: null,
      pauseReason: project.pauseReason,
      pausedAt: project.pausedAt,
      managedByPlugin: project.managedByPlugin ?? null,
      taskCount: project.taskCount,
      budget: project.budget,
      archivedAt: project.archivedAt,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  // Resolve task identifiers (e.g. "PAP-39") to UUIDs for all /tasks/:id routes
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await resolveTaskRouteId(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve task identifiers (e.g. "PAP-39") to UUIDs for company-scoped attachment routes.
  router.param("taskId", async (req, res, next, rawId) => {
    try {
      req.params.taskId = await resolveTaskRouteId(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/search/extract", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const companyScopeDecision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!companyScopeDecision.allowed) {
      res.status(403).json({ error: "Company search is outside this actor's authorization boundary" });
      return;
    }
    const parsedQuery = companySearchExtractQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({
        error: validationDetails(parsedQuery.error)[0]?.message ?? "Invalid extract search query",
      });
      return;
    }
    const rateLimit = searchRateLimiter.consume(companySearchRateLimitActor(req, companyId));
    res.setHeader("X-RateLimit-Limit", String(rateLimit.limit));
    res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      res.status(429).json({
        error: "Search rate limit exceeded",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }
    const result = await getSearchService().extract(companyId, parsedQuery.data);
    res.json(result);
  });

  router.get("/companies/:companyId/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const companyScopeDecision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!companyScopeDecision.allowed) {
      res.status(403).json({ error: "Company search is outside this actor's authorization boundary" });
      return;
    }
    const parsedQuery = companySearchQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({
        error: validationDetails(parsedQuery.error)[0]?.message ?? "Invalid search query",
      });
      return;
    }
    let query = parsedQuery.data;
    if (query.ownerUserId === "me") {
      if (req.actor.type !== "board" || !req.actor.userId) {
        res.status(403).json({ error: "ownerUserId=me requires board authentication" });
        return;
      }
      query = { ...query, ownerUserId: req.actor.userId };
    }
    const rateLimit = searchRateLimiter.consume(companySearchRateLimitActor(req, companyId));
    res.setHeader("X-RateLimit-Limit", String(rateLimit.limit));
    res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      res.status(429).json({
        error: "Search rate limit exceeded",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }
    const result = await getSearchService().search(companyId, query);
    res.json(result);
  });

  router.get("/companies/:companyId/tasks", async (req, res) => {
    const startedAt = Date.now();
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const ownerUserFilterRaw = req.query.ownerUserId as string | undefined;
    const touchedByUserFilterRaw = req.query.touchedByUserId as string | undefined;
    const inboxArchivedByUserFilterRaw = req.query.inboxArchivedByUserId as string | undefined;
    const unreadForUserFilterRaw = req.query.unreadForUserId as string | undefined;
    const ownerUserId =
      ownerUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : ownerUserFilterRaw;
    const touchedByUserId =
      touchedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : touchedByUserFilterRaw;
    const inboxArchivedByUserId =
      inboxArchivedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : inboxArchivedByUserFilterRaw;
    const unreadForUserId =
      unreadForUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : unreadForUserFilterRaw;
    const rawLimit = req.query.limit as string | undefined;
    const parsedLimit = rawLimit !== undefined && /^\d+$/.test(rawLimit)
      ? Number.parseInt(rawLimit, 10)
      : null;
    const limit = parsedLimit === null ? TASK_LIST_DEFAULT_LIMIT : clampTaskListLimit(parsedLimit);
    const rawOffset = req.query.offset as string | undefined;
    const parsedOffset = rawOffset !== undefined && /^\d+$/.test(rawOffset)
      ? Number.parseInt(rawOffset, 10)
      : null;
    const attention = req.query.attention as string | undefined;
    const sortField = req.query.sortField as string | undefined;
    const sortDir = req.query.sortDir as string | undefined;
    const view = req.query.view as string | undefined;
    const compactView = view === "compact";
    const hasPlanDocument = parseOptionalBooleanQuery(req.query.hasPlanDocument);
    const includeLiveDescendantSummary = parseOptionalBooleanQuery(req.query.includeLiveDescendantSummary);
    const ownerAgentFilterRaw = req.query.ownerAgentId;
    let ownerAgentId: string | null | undefined;

    if (ownerUserFilterRaw === "me" && (!ownerUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "ownerUserId=me requires board authentication" });
      return;
    }
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "touchedByUserId=me requires board authentication" });
      return;
    }
    if (inboxArchivedByUserFilterRaw === "me" && (!inboxArchivedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "inboxArchivedByUserId=me requires board authentication" });
      return;
    }
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "unreadForUserId=me requires board authentication" });
      return;
    }
    if (attention !== undefined && attention !== "blocked") {
      res.status(400).json({ error: "attention must be 'blocked' when provided" });
      return;
    }
    if (view !== undefined && view !== "compact") {
      res.status(400).json({ error: "view must be 'compact' when provided" });
      return;
    }
    if (rawLimit !== undefined && (parsedLimit === null || !Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
      res.status(400).json({ error: `limit must be a positive integer up to ${TASK_LIST_MAX_LIMIT}` });
      return;
    }
    if (rawOffset !== undefined && (parsedOffset === null || !Number.isInteger(parsedOffset) || parsedOffset < 0)) {
      res.status(400).json({ error: "offset must be a non-negative integer" });
      return;
    }
    if (sortField !== undefined && sortField !== "updated") {
      res.status(400).json({ error: "sortField must be 'updated' when provided" });
      return;
    }
    if (sortDir !== undefined && sortDir !== "asc" && sortDir !== "desc") {
      res.status(400).json({ error: "sortDir must be 'asc' or 'desc' when provided" });
      return;
    }
    if (hasPlanDocument === null) {
      res.status(400).json({ error: "hasPlanDocument must be true or false when provided" });
      return;
    }
    if (includeLiveDescendantSummary === null) {
      res.status(400).json({ error: "includeLiveDescendantSummary must be true or false when provided" });
      return;
    }
    if (ownerAgentFilterRaw !== undefined) {
      if (typeof ownerAgentFilterRaw !== "string") {
        res.status(422).json({ error: "ownerAgentId must be a UUID or 'null'" });
        return;
      }
      const normalizedOwnerAgentFilter = ownerAgentFilterRaw.trim();
      if (normalizedOwnerAgentFilter.length === 0) {
        ownerAgentId = undefined;
      } else if (normalizedOwnerAgentFilter.toLowerCase() === "null") {
        ownerAgentId = null;
      } else if (isUuidLike(normalizedOwnerAgentFilter)) {
        ownerAgentId = normalizedOwnerAgentFilter;
      } else {
        res.status(422).json({ error: "ownerAgentId must be a UUID or 'null'" });
        return;
      }
    }
    const offset = parsedOffset ?? 0;

    const listFilters: TaskFilters = {
      attention: attention === "blocked" ? "blocked" : undefined,
      status: req.query.status as string | string[] | undefined,
      ownerAgentId,
      participantAgentId: req.query.participantAgentId as string | undefined,
      ownerUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      projectId: req.query.projectId as string | undefined,
      parentId: req.query.parentId as string | undefined,
      descendantOf: req.query.descendantOf as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originKindPrefix: req.query.originKindPrefix as string | undefined,
      originId: req.query.originId as string | undefined,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      excludeRoutineExecutions:
        req.query.excludeRoutineExecutions === "true" || req.query.excludeRoutineExecutions === "1",
      includePluginOperations:
        req.query.includePluginOperations === "true" || req.query.includePluginOperations === "1",
      includeBlockedBy: req.query.includeBlockedBy === "true" || req.query.includeBlockedBy === "1",
      includeBlockedInboxAttention:
        req.query.includeBlockedInboxAttention === "true" || req.query.includeBlockedInboxAttention === "1",
      includeLiveDescendantSummary: includeLiveDescendantSummary === true,
      hasPlanDocument,
      q: req.query.q as string | undefined,
      limit,
      offset,
      sortField: sortField === "updated" ? "updated" : undefined,
      sortDir: sortDir === "asc" || sortDir === "desc" ? sortDir : undefined,
    };
    const requestKey = taskListRequestKey({
      req,
      companyId,
      normalizedQuery: {
        ...listFilters,
        view: compactView ? "compact" : undefined,
      },
    });
    const coordinated = await coordinateTaskListGet({
      req,
      companyId,
      requestKey,
      allowTtlCache: compactView,
      diagnostics: opts.taskListDiagnostics,
      compute: async () => {
        const rawResult = await svc.list(companyId, listFilters);
        const result = await actorCanReadCompanyScope(req, companyId)
          ? rawResult
          : await filterTasksForActor(req, rawResult);
        if (compactView) {
          const compactResult = result.map((task) => toCompactTask(task));
          return {
            kind: "compact",
            body: compactResult,
            etag: compactTaskListEtag(compactResult),
            cacheControl: "private, must-revalidate",
          };
        }
        return {
          kind: "full",
          body: result.map((task) => toPublicTask(task)),
        };
      },
    });

    res.setHeader("X-Paperclip-Request-Cache", coordinated.cacheStatus);
    if (!coordinated.response) {
      const body = {
        error: "Too many concurrent task-list requests for this actor/client",
        retryAfterSeconds: coordinated.retryAfterSeconds ?? 1,
      };
      res.setHeader("Retry-After", String(body.retryAfterSeconds));
      logTaskListRequest({
        req,
        res,
        companyId,
        requestKey,
        startedAt,
        cacheStatus: "retry",
        bodyBytes: estimatedJsonBytes(body),
        etagOutcome: "none",
        identicalInFlightCount: coordinated.identicalInFlightCount,
      });
      res.status(429).json(body);
      return;
    }

    if (coordinated.response.kind === "compact") {
      res.setHeader("Cache-Control", coordinated.response.cacheControl);
      res.setHeader("ETag", coordinated.response.etag);
      const etagMatched = requestMatchesEtag(req.header("if-none-match"), coordinated.response.etag);
      logTaskListRequest({
        req,
        res,
        companyId,
        requestKey,
        startedAt,
        cacheStatus: coordinated.cacheStatus,
        bodyBytes: etagMatched ? 0 : estimatedJsonBytes(coordinated.response.body),
        etagOutcome: etagMatched ? "not_modified" : "fresh",
        identicalInFlightCount: coordinated.identicalInFlightCount,
      });
      if (etagMatched) {
        res.status(304).end();
        return;
      }
      res.json(coordinated.response.body);
      return;
    }

    logTaskListRequest({
      req,
      res,
      companyId,
      requestKey,
      startedAt,
      cacheStatus: coordinated.cacheStatus,
      bodyBytes: estimatedJsonBytes(coordinated.response.body),
      etagOutcome: "none",
      identicalInFlightCount: coordinated.identicalInFlightCount,
    });
    res.json(coordinated.response.body);
  });

  router.get("/companies/:companyId/tasks/count", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const attention = req.query.attention as string | undefined;
    const hasPlanDocument = parseOptionalBooleanQuery(req.query.hasPlanDocument);
    if (attention !== "blocked") {
      res.status(400).json({ error: "tasks/count currently requires attention=blocked" });
      return;
    }
    if (req.query.limit !== undefined || req.query.offset !== undefined) {
      res.status(400).json({ error: "tasks/count does not accept limit or offset" });
      return;
    }
    if (hasPlanDocument === null) {
      res.status(400).json({ error: "hasPlanDocument must be true or false when provided" });
      return;
    }

    const blockedCountFilters = {
      attention: "blocked",
      status: req.query.status as string | string[] | undefined,
      ownerAgentId: req.query.ownerAgentId as string | undefined,
      participantAgentId: req.query.participantAgentId as string | undefined,
      ownerUserId: req.query.ownerUserId as string | undefined,
      projectId: req.query.projectId as string | undefined,
      parentId: req.query.parentId as string | undefined,
      descendantOf: req.query.descendantOf as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originKindPrefix: req.query.originKindPrefix as string | undefined,
      originId: req.query.originId as string | undefined,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      excludeRoutineExecutions:
        req.query.excludeRoutineExecutions === "true" || req.query.excludeRoutineExecutions === "1",
      includePluginOperations:
        req.query.includePluginOperations === "true" || req.query.includePluginOperations === "1",
      includeBlockedBy: true,
      includeBlockedInboxAttention: true,
      hasPlanDocument,
      q: req.query.q as string | undefined,
    } as const;

    if (!(await actorCanReadCompanyScope(req, companyId))) {
      let offset = 0;
      let visibleCount = 0;
      while (true) {
        const rows = await svc.list(companyId, {
          ...blockedCountFilters,
          limit: TASK_LIST_MAX_LIMIT,
          offset,
        });
        visibleCount += (await filterTasksForActor(req, rows)).length;
        if (rows.length < TASK_LIST_MAX_LIMIT) break;
        offset += rows.length;
      }
      res.json({ count: visibleCount });
      return;
    }

    const count = await svc.count(companyId, blockedCountFilters);
    res.json({ count });
  });

  router.get("/companies/:companyId/labels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listLabels(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/labels", validate(createTaskLabelSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const label = await svc.createLabel(companyId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    res.status(201).json(label);
  });

  router.delete("/labels/:labelId", async (req, res) => {
    assertBoard(req);
    const labelId = req.params.labelId as string;
    const existing = await getAccessibleResource(req, res, svc.getLabelById(labelId), "Label not found");
    if (!existing) return;
    const removed = await svc.deleteLabel(labelId);
    if (!removed) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    res.json(removed);
  });

  router.get("/tasks/:id/diagnostics/blockers", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;

    const diagnostic = await svc.getBlockerDiagnostics(task.id);
    const visibleBlockers = await filterTasksForActor(req, diagnostic.blockers);
    const response = buildTaskBlockerDiagnosticsResponse({
      task,
      blockers: diagnostic.blockers,
      visibleBlockers,
      readiness: diagnostic.readiness,
      truncated: diagnostic.truncated,
    });

    logger.info(
      {
        companyId: task.companyId,
        taskId: task.id,
        actorType: req.actor.type,
        visibleBlockerCount: response.blockers.length,
        omittedUnauthorizedBlockerCount: response.omittedUnauthorizedBlockerCount,
        truncated: response.truncated,
      },
      "task blocker diagnostics read",
    );

    res.json(response);
  });

  router.get("/tasks/:id/diagnostics/subtree", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;

    const diagnostic = await svc.getSubtreeDiagnostics(task.id);
    const allBlockers = [...diagnostic.blockersByTaskId.values()].flat();
    const [visibleNodes, visibleBlockers] = await Promise.all([
      filterTasksForActor(req, diagnostic.nodes),
      filterTasksForActor(req, allBlockers),
    ]);
    const response = buildTaskSubtreeDiagnosticsResponse({
      task,
      nodes: diagnostic.nodes,
      visibleNodes,
      blockersByTaskId: diagnostic.blockersByTaskId,
      visibleBlockers,
      readinessByTaskId: diagnostic.readinessByTaskId,
      truncatedNodes: diagnostic.truncatedNodes,
      truncatedDepth: diagnostic.truncatedDepth,
      truncatedBlockerTaskIds: diagnostic.truncatedBlockerTaskIds,
      caps: diagnostic.caps,
    });

    logger.info(
      {
        companyId: task.companyId,
        taskId: task.id,
        actorType: req.actor.type,
        nodeCount: response.nodeCount,
        omittedUnauthorizedNodeCount: response.omittedUnauthorizedNodeCount,
        edgeCount: response.edges.length,
        truncated: response.truncated,
      },
      "task subtree diagnostics read",
    );

    res.json(response);
  });

  router.get("/tasks/:id", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const inboxArchiveFieldsPromise = req.actor.type === "board" && req.actor.userId
      ? svc.getActiveInboxArchiveFields(task, req.actor.userId)
      : Promise.resolve({});
    const [
      { project, goal },
      ancestors,
      mentionedProjectIds,
      documentPayload,
      relations,
      blockerAttention,
      referenceSummary,
      inboxArchiveFields,
    ] = await Promise.all([
      resolveTaskProjectAndGoal(task),
      svc.getAncestors(task.id),
      svc.findMentionedProjectIds(task.id, { includeCommentBodies: false }),
      documentsSvc.getTaskDocumentPayload(task),
      svc.getRelationSummaries(task.id),
      svc.listBlockerAttention(task.companyId, [task]).then((map) => map.get(task.id) ?? null),
      taskReferencesSvc.listTaskReferenceSummary(task.id),
      inboxArchiveFieldsPromise,
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(task.companyId, mentionedProjectIds)
      : [];
    const workProducts = await workProductsSvc.listForTask(task.id);
    res.json({
      ...toPublicTask(task),
      ...inboxArchiveFields,
      goalId: goal?.id ?? task.goalId,
      ancestors,
      ...(blockerAttention ? { blockerAttention } : {}),
      blockedBy: relations.blockedBy,
      blocks: relations.blocks,
      relatedWork: referenceSummary,
      referencedTaskIdentifiers: referenceSummary.outbound.map((item) => item.task.identifier ?? item.task.id),
      ...documentPayload,
      project: compactTaskProject(project),
      goal: goal ?? null,
      mentionedProjects: mentionedProjects.map(toPublicProject),
      workProducts,
    });
  });

  router.get("/tasks/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const workProducts = await workProductsSvc.listForTask(task.id);
    res.json(workProducts);
  });

  router.get("/tasks/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const docs = await documentsSvc.listTaskDocuments(task.id, {
      includeSystem: req.query.includeSystem === "true",
    });
    res.json(docs);
  });

  router.get("/tasks/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: validationDetails(keyParsed.error) });
      return;
    }
    const doc = await documentsSvc.getTaskDocumentByKey(task.id, keyParsed.data);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    if (!shouldIncludeDocumentAnnotations(req)) {
      res.json(doc);
      return;
    }
    const annotations = await documentAnnotationsSvc.listThreadsForTaskDocument(task.id, keyParsed.data, {
      status: "open",
      includeComments: shouldIncludeDocumentAnnotationComments(req),
    });
    res.json({ ...doc, annotations });
  });

  router.get("/tasks/:id/documents/:key/annotations", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: validationDetails(keyParsed.error) });
      return;
    }
    const status = req.query.status === "resolved" || req.query.status === "all" ? req.query.status : "open";
    const threads = await documentAnnotationsSvc.listThreadsForTaskDocument(task.id, keyParsed.data, {
      status,
      includeComments: parseBooleanQuery(req.query.includeComments),
    });
    res.json(threads);
  });

  router.post(
    "/tasks/:id/documents/:key/annotations",
    validate(createDocumentAnnotationThreadSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
      if (!task) return;
      if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
      const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: validationDetails(keyParsed.error) });
        return;
      }

      const { userId, annotationActor } = annotationActorInput(req);
      const referenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const thread = await documentAnnotationsSvc.createThread(task.id, keyParsed.data, req.body, annotationActor);
      const firstComment = thread.comments[0];
      const referenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: userId,
        action: "task.document_annotation_thread_created",
        entityType: "task",
        entityId: task.id,
        details: {
          key: thread.documentKey,
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          commentId: firstComment?.id ?? null,
          revisionNumber: thread.currentRevisionNumber,
          quote: thread.selectedText.slice(0, 240),
          ...summarizeTaskReferenceActivityDetails({
            addedReferencedTasks: referenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
            removedReferencedTasks: referenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
            currentReferencedTasks: referenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
          }),
        },
      });

      res.status(201).json(thread);
    },
  );

  router.get("/tasks/:id/documents/:key/annotations/:threadId", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: validationDetails(keyParsed.error) });
      return;
    }
    const thread = await documentAnnotationsSvc.getThreadForTaskDocument(
      task.id,
      keyParsed.data,
      req.params.threadId as string,
    );
    if (!thread) {
      res.status(404).json({ error: "Annotation thread not found" });
      return;
    }
    res.json(thread);
  });

  router.post(
    "/tasks/:id/documents/:key/annotations/:threadId/comments",
    validate(createDocumentAnnotationCommentSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
      if (!task) return;
      if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
      const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: validationDetails(keyParsed.error) });
        return;
      }

      const { userId, annotationActor } = annotationActorInput(req);
      const referenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const comment = await documentAnnotationsSvc.addComment(
        task.id,
        keyParsed.data,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      const referenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: userId,
        action: "task.document_annotation_comment_added",
        entityType: "task",
        entityId: task.id,
        details: {
          key: keyParsed.data,
          documentKey: keyParsed.data,
          threadId: comment.threadId,
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          ...summarizeTaskReferenceActivityDetails({
            addedReferencedTasks: referenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
            removedReferencedTasks: referenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
            currentReferencedTasks: referenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
          }),
        },
      });

      res.status(201).json(comment);
    },
  );

  router.patch(
    "/tasks/:id/documents/:key/annotations/:threadId",
    validate(updateDocumentAnnotationThreadSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
      if (!task) return;
      if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
      const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: validationDetails(keyParsed.error) });
        return;
      }
      const { userId, annotationActor } = annotationActorInput(req);
      const thread = await documentAnnotationsSvc.updateThread(
        task.id,
        keyParsed.data,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: userId,
        action: thread.status === "resolved"
          ? "task.document_annotation_thread_resolved"
          : "task.document_annotation_thread_reopened",
        entityType: "task",
        entityId: task.id,
        details: {
          key: thread.documentKey,
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          status: thread.status,
        },
      });
      res.json(thread);
    },
  );

  router.put("/tasks/:id/documents/:key", validate(upsertTaskDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: validationDetails(keyParsed.error) });
      return;
    }

    assertBoard(req);
    const referenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);
    const result = await documentsSvc.upsertTaskDocument({
      taskId: task.id,
      key: keyParsed.data,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByUserId: req.actor.userId,
      lockedDocumentStrategy: "conflict",
    });
    const doc = result.document;
    const redirectedFromLockedDocument =
      "redirectedFromLockedDocument" in result ? result.redirectedFromLockedDocument : null;
    const referenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
    const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
    const remappedAnnotations = result.created
      ? []
      : await documentAnnotationsSvc.remapOpenThreadsForDocument({
        taskId: task.id,
        key: doc.key,
        documentId: doc.id,
        nextRevisionId: doc.latestRevisionId,
        nextRevisionNumber: doc.latestRevisionNumber,
        nextBody: doc.body,
      });

    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: result.created ? "task.document_created" : "task.document_updated",
      entityType: "task",
      entityId: task.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
        redirectedFromLockedDocument,
        ...summarizeTaskReferenceActivityDetails({
          addedReferencedTasks: referenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
          removedReferencedTasks: referenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
          currentReferencedTasks: referenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
        }),
      },
    });

    for (const remap of remappedAnnotations) {
      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "task.document_annotation_remapped",
        entityType: "task",
        entityId: task.id,
        details: {
          key: doc.key,
          documentId: doc.id,
          threadId: remap.thread.id,
          revisionNumber: doc.latestRevisionNumber,
          anchorState: remap.thread.anchorState,
          anchorConfidence: remap.thread.anchorConfidence,
          snapshotId: remap.snapshot.id,
        },
      });
    }


    res.status(result.created ? 201 : 200).json(doc);
  });

  router.post("/tasks/:id/documents/:key/lock", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: validationDetails(keyParsed.error) });
      return;
    }

    assertBoard(req);
    const result = await documentsSvc.lockTaskDocument({
      taskId: task.id,
      key: keyParsed.data,
      lockedByUserId: req.actor.userId,
    });

    if (result.changed) {
      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "task.document_locked",
        entityType: "task",
        entityId: task.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          lockedAt: result.document.lockedAt,
        },
      });
    }

    res.json(result.document);
  });

  router.post("/tasks/:id/documents/:key/unlock", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: validationDetails(keyParsed.error) });
      return;
    }

    assertBoard(req);
    const result = await documentsSvc.unlockTaskDocument(task.id, keyParsed.data);

    if (result.changed) {
      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "task.document_unlocked",
        entityType: "task",
        entityId: task.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
        },
      });
    }

    res.json(result.document);
  });

  router.get("/tasks/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: validationDetails(keyParsed.error) });
      return;
    }
    const revisions = await documentsSvc.listTaskDocumentRevisions(task.id, keyParsed.data);
    res.json(revisions);
  });

  router.post(
    "/tasks/:id/documents/:key/revisions/:revisionId/restore",
    validate(restoreTaskDocumentRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const revisionId = req.params.revisionId as string;
      const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
      if (!task) return;
      if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
      const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: validationDetails(keyParsed.error) });
        return;
      }

      assertBoard(req);
      const referenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const result = await documentsSvc.restoreTaskDocumentRevision({
        taskId: task.id,
        key: keyParsed.data,
        revisionId,
        createdByUserId: req.actor.userId,
      });
      const referenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
      const remappedAnnotations = await documentAnnotationsSvc.remapOpenThreadsForDocument({
        taskId: task.id,
        key: result.document.key,
        documentId: result.document.id,
        nextRevisionId: result.document.latestRevisionId,
        nextRevisionNumber: result.document.latestRevisionNumber,
        nextBody: result.document.body,
      });

      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "task.document_restored",
        entityType: "task",
        entityId: task.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          format: result.document.format,
          revisionNumber: result.document.latestRevisionNumber,
          restoredFromRevisionId: result.restoredFromRevisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
          ...summarizeTaskReferenceActivityDetails({
            addedReferencedTasks: referenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
            removedReferencedTasks: referenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
            currentReferencedTasks: referenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
          }),
        },
      });

      for (const remap of remappedAnnotations) {
        await logActivity(db, {
          companyId: task.companyId,
          actorType: "user",
          actorId: req.actor.userId,
          action: "task.document_annotation_remapped",
          entityType: "task",
          entityId: task.id,
          details: {
            key: result.document.key,
            documentId: result.document.id,
            threadId: remap.thread.id,
            revisionNumber: result.document.latestRevisionNumber,
            anchorState: remap.thread.anchorState,
            anchorConfidence: remap.thread.anchorConfidence,
            snapshotId: remap.snapshot.id,
          },
        });
      }


      res.json(result.document);
    },
  );

  router.delete("/tasks/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = taskDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: validationDetails(keyParsed.error) });
      return;
    }
    const referenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);
    const removed = await documentsSvc.deleteTaskDocument(task.id, keyParsed.data);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const referenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
    const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
    assertBoard(req);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.document_deleted",
      entityType: "task",
      entityId: task.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
        ...summarizeTaskReferenceActivityDetails({
          addedReferencedTasks: referenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
          removedReferencedTasks: referenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
          currentReferencedTasks: referenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
        }),
      },
    });
    res.json({ ok: true });
  });

  router.post("/tasks/:id/work-products", validate(createTaskWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    assertBoard(req);
    const createInput = {
      ...req.body,
      projectId: req.body.projectId ?? task.projectId ?? null,
    };
    const createdByRunId = await resolveWorkProductCreatedByRunId(req, res, task.companyId, req.body, "create");
    if (createdByRunId === undefined) return;
    createInput.createdByRunId = createdByRunId;
    if (requiresPaperclipAttachmentMetadata(createInput)) {
      createInput.metadata = await canonicalizePaperclipArtifactMetadata({
        task,
        metadata: req.body.metadata ?? null,
      });
    }
    const product = await workProductsSvc.createForTask(task.id, task.companyId, createInput);
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.work_product_created",
      entityType: "task",
      entityId: task.id,
      details: { workProductId: product.id, type: product.type, provider: product.provider },
    });
    res.status(201).json(product);
  });

  router.post("/tasks/:id/low-trust/promotions", validate(promoteLowTrustOutputSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    assertBoard(req);
    const sourceTrust = await lookupLowTrustSourceArtifact({
      taskId: task.id,
      artifactKind: req.body.sourceArtifactKind,
      artifactId: req.body.sourceArtifactId,
    });
    if (!sourceTrust) {
      res.status(404).json({ error: "Low-trust source artifact not found" });
      return;
    }
    if (!isLowTrustQuarantined(sourceTrust)) {
      res.status(422).json({ error: "Source artifact is not quarantined low-trust output" });
      return;
    }

    const promotedAt = new Date();
    const promotionTrust = buildPromotedSourceTrust({
      sourceTaskId: task.id,
      sourceArtifactKind: req.body.sourceArtifactKind,
      sourceArtifactId: req.body.sourceArtifactId,
      promotedByActorType: "user",
      promotedByActorId: req.actor.userId,
      promotedAt,
    });
    const product = await db.transaction(async (tx) => {
      const markPromoted = { sourceTrust: promotionTrust, updatedAt: promotedAt };
      const updatedSource = await (async () => {
        if (req.body.sourceArtifactKind === "task") {
          return tx
            .update(taskRows)
            .set(markPromoted)
            .where(and(
              eq(taskRows.id, req.body.sourceArtifactId),
              eq(taskRows.sourceTrust, sourceTrust),
            ))
            .returning({ id: taskRows.id });
        }
        if (req.body.sourceArtifactKind === "comment") {
          return tx
            .select({ id: taskComments.id })
            .from(taskComments)
            .where(and(
              eq(taskComments.id, req.body.sourceArtifactId),
              eq(taskComments.taskId, task.id),
              eq(taskComments.sourceTrust, sourceTrust),
            ))
            .limit(1);
        }
        if (req.body.sourceArtifactKind === "document") {
          return tx
            .update(documents)
            .set(markPromoted)
            .where(and(
              eq(documents.id, req.body.sourceArtifactId),
              eq(documents.sourceTrust, sourceTrust),
            ))
            .returning({ id: documents.id });
        }
        return tx
          .update(taskWorkProducts)
          .set(markPromoted)
          .where(and(
            eq(taskWorkProducts.id, req.body.sourceArtifactId),
            eq(taskWorkProducts.taskId, task.id),
            eq(taskWorkProducts.sourceTrust, sourceTrust),
          ))
          .returning({ id: taskWorkProducts.id });
      })();
      if (!updatedSource[0]) return null;

      return tx
        .insert(taskWorkProducts)
        .values({
          companyId: task.companyId,
          taskId: task.id,
          projectId: task.projectId ?? null,
          type: "artifact",
          provider: "paperclip",
          externalId: req.body.sourceArtifactId,
          title: req.body.title,
          status: "approved",
          reviewState: "approved",
          isPrimary: false,
          healthStatus: "unknown",
          summary: req.body.summary,
          metadata: {
            promotion: {
              sourceArtifactKind: req.body.sourceArtifactKind,
              sourceArtifactId: req.body.sourceArtifactId,
            },
          },
          sourceTrust: promotionTrust,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
    });
    if (!product) {
      res.status(422).json({ error: "Source artifact is not quarantined low-trust output" });
      return;
    }

    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.low_trust_output_promoted",
      entityType: "task",
      entityId: task.id,
      details: {
        sourceArtifacts: [{
          artifactKind: req.body.sourceArtifactKind,
          artifactId: req.body.sourceArtifactId,
        }],
        reviewerPrincipal: {
          actorType: "user",
          actorId: req.actor.userId,
        },
        targetTaskId: task.id,
        promotedWorkProductId: product.id,
        decision: "promoted",
      },
    });

    res.status(201).json(product);
  });

  router.patch("/work-products/:id", validate(updateTaskWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, workProductsSvc.getById(id), "Work product not found");
    if (!existing) return;
    const task = await svc.getById(existing.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    assertBoard(req);
    const patch = { ...req.body };
    const createdByRunId = await resolveWorkProductCreatedByRunId(req, res, existing.companyId, req.body, "update");
    if (createdByRunId === undefined && Object.prototype.hasOwnProperty.call(req.body, "createdByRunId")) return;
    if (createdByRunId !== undefined) patch.createdByRunId = createdByRunId;
    if (requiresPaperclipAttachmentMetadata(patch, existing)) {
      if (patch.metadata !== undefined) {
        patch.metadata = await canonicalizePaperclipArtifactMetadata({
          task,
          metadata: patch.metadata ?? null,
        });
      } else if (!requiresPaperclipAttachmentMetadata(existing)) {
        res.status(422).json({ error: "Attachment-backed artifact metadata is required" });
        return;
      }
    }
    const product = await workProductsSvc.update(id, patch);
    if (!product) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.work_product_updated",
      entityType: "task",
      entityId: existing.taskId,
      details: { workProductId: product.id, changedKeys: Object.keys(req.body).sort() },
    });
    res.json(product);
  });

  router.delete("/work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, workProductsSvc.getById(id), "Work product not found");
    if (!existing) return;
    const task = await svc.getById(existing.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    const removed = await workProductsSvc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertBoard(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.work_product_deleted",
      entityType: "task",
      entityId: existing.taskId,
      details: { workProductId: removed.id, type: removed.type },
    });
    res.json(removed);
  });

  router.post("/tasks/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readState = await svc.markRead(task.companyId, task.id, req.actor.userId, new Date());
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.read_marked",
      entityType: "task",
      entityId: task.id,
      details: { userId: req.actor.userId, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.delete("/tasks/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.markUnread(task.companyId, task.id, req.actor.userId);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.read_unmarked",
      entityType: "task",
      entityId: task.id,
      details: { userId: req.actor.userId },
    });
    res.json({ id: task.id, removed });
  });

  function resolveInboxArchiveTarget(req: Request) {
    assertBoard(req);
    if (!req.actor.userId) {
      throw forbidden("Board user context required", {
        code: "inbox_target_user_unresolved",
      });
    }
    return {
      userId: req.actor.userId,
      targetResolvedFrom: "responsible_user" as const,
    };
  }

  router.post("/tasks/:id/inbox-archive", validate(inboxArchiveBodySchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    const target = resolveInboxArchiveTarget(req);
    const archiveState = await svc.archiveInbox(task.companyId, task.id, target.userId, new Date(), {
      archivedByActorType: "user",
    });
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: target.userId,
      action: "task.inbox_archived",
      entityType: "task",
      entityId: task.id,
      details: {
        userId: target.userId,
        archivedAt: archiveState.archivedAt,
        targetResolvedFrom: target.targetResolvedFrom,
      },
    });
    res.json(archiveState);
  });

  router.delete("/tasks/:id/inbox-archive", validate(inboxArchiveBodySchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    const target = resolveInboxArchiveTarget(req);
    const removed = await svc.unarchiveInbox(task.companyId, task.id, target.userId);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: target.userId,
      action: "task.inbox_unarchived",
      entityType: "task",
      entityId: task.id,
      details: {
        userId: target.userId,
        targetResolvedFrom: target.targetResolvedFrom,
      },
    });
    res.json(removed ?? { ok: true, userId: target.userId });
  });

  router.get("/tasks/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const approvals = await taskApprovalsSvc.listApprovalsForTask(id);
    res.json(approvals);
  });

  router.post("/tasks/:id/approvals", validate(linkTaskApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    if (!(await assertCanManageTaskApprovalLinks(req, task.companyId))) return;
    assertBoard(req);

    await taskApprovalsSvc.link(id, req.body.approvalId, {
      userId: req.actor.userId,
    });

    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.approval_linked",
      entityType: "task",
      entityId: task.id,
      details: { approvalId: req.body.approvalId },
    });

    const approvals = await taskApprovalsSvc.listApprovalsForTask(id);
    res.status(201).json(approvals);
  });

  router.delete("/tasks/:id/approvals/:approvalId", async (req, res) => {
    const id = req.params.id as string;
    const approvalId = req.params.approvalId as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    if (!(await assertCanManageTaskApprovalLinks(req, task.companyId))) return;

    await taskApprovalsSvc.unlink(id, approvalId);

    assertBoard(req);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.approval_unlinked",
      entityType: "task",
      entityId: task.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  router.use(taskIngressRoutes({
    ordinaryTasks,
    getTaskById: (id) => svc.getById(id),
  }));

  router.put(
    "/tasks/:id/execution-policy",
    validate(updateTaskExecutionPolicySchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Task not found",
      );
      if (!existing) return;

      const previousPolicy = normalizeTaskExecutionPolicy(
        existing.executionPolicy,
      );
      const task = await executionPolicyControl.configure({
        companyId: existing.companyId,
        taskId: existing.id,
        executionPolicy: req.body.executionPolicy,
        actorUserId,
      });
      const nextPolicy = normalizeTaskExecutionPolicy(task.executionPolicy);

      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "task.execution_policy_updated",
        entityType: "task",
        entityId: task.id,
        details: {
          identifier: task.identifier,
          executionPolicy: nextPolicy,
          executionState: task.executionState,
          _previous: {
            executionPolicy: previousPolicy,
            executionState: existing.executionState,
          },
        },
      });

      for (const stageType of ["review", "approval"] as const) {
        const changes = diffExecutionParticipants(
          previousPolicy,
          nextPolicy,
          stageType,
        );
        if (
          changes.addedParticipants.length === 0 &&
          changes.removedParticipants.length === 0
        ) {
          continue;
        }
        await logActivity(db, {
          companyId: task.companyId,
          actorType: "user",
          actorId: actorUserId,
          action:
            stageType === "review"
              ? "task.reviewers_updated"
              : "task.approvers_updated",
          entityType: "task",
          entityId: task.id,
          details: {
            identifier: task.identifier,
            participants: changes.participants,
            addedParticipants: changes.addedParticipants,
            removedParticipants: changes.removedParticipants,
          },
        });
      }

      const previousMonitor = summarizeTaskMonitor(
        existing,
        previousPolicy,
      );
      const nextMonitor = summarizeTaskMonitor(task, nextPolicy);
      if (
        nextMonitor.nextCheckAt &&
        (previousMonitor.nextCheckAt !== nextMonitor.nextCheckAt ||
          previousMonitor.notes !== nextMonitor.notes)
      ) {
        await logActivity(db, {
          companyId: task.companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "task.monitor_scheduled",
          entityType: "task",
          entityId: task.id,
          details: {
            identifier: task.identifier,
            nextCheckAt: nextMonitor.nextCheckAt,
            previousNextCheckAt: previousMonitor.nextCheckAt,
            notes: nextMonitor.notes,
            scheduledBy: nextMonitor.scheduledBy,
            serviceName: nextMonitor.serviceName,
            timeoutAt: nextMonitor.timeoutAt,
            maxAttempts: nextMonitor.maxAttempts,
            recoveryPolicy: nextMonitor.recoveryPolicy,
          },
        });
      } else if (
        !nextMonitor.nextCheckAt &&
        previousMonitor.nextCheckAt
      ) {
        await logActivity(db, {
          companyId: task.companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "task.monitor_cleared",
          entityType: "task",
          entityId: task.id,
          details: {
            identifier: task.identifier,
            previousNextCheckAt: previousMonitor.nextCheckAt,
            reason: nextMonitor.clearReason ?? "manual",
            notes: previousMonitor.notes,
          },
        });
      }

      res.json(task);
    },
  );

  router.post(
    "/tasks/:id/execution-policy/decisions",
    validate(decideTaskExecutionStageSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Task not found",
      );
      if (!existing) return;

      const result = await executionPolicyControl.decide({
        companyId: existing.companyId,
        taskId: existing.id,
        outcome: req.body.outcome,
        body: req.body.body,
        reviewRequest: req.body.reviewRequest,
        idempotencyKey: req.body.idempotencyKey,
        actor: { userId: actorUserId },
      });

      if (!result.retried) {
        await logActivity(db, {
          companyId: result.task.companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "task.execution_policy_decided",
          entityType: "task",
          entityId: result.task.id,
          details: {
            identifier: result.task.identifier,
            decisionId: result.decision.id,
            stageId: result.decision.stageId,
            stageType: result.decision.stageType,
            outcome: result.decision.outcome,
            lifecycleStatus: result.task.lifecycleStatus,
            boardStatus: result.task.boardPresentationStatus,
          },
        });
      }

      res.status(result.retried ? 200 : 201).json(result);
    },
  );

  router.patch("/tasks/:id", validate(updateTaskTitleSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req,
      res,
      svc.getById(id),
      "Task not found",
    );
    if (!existing) return;

    const task = await svc.updateTitle(id, req.body.title);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.title_updated",
      entityType: "task",
      entityId: task.id,
      details: {
        identifier: task.identifier,
        title: task.title,
        _previous: { title: existing.title },
      },
    });

    res.json(task);
  });

  router.post("/tasks/:id/reassign", validate(reassignTaskSchema), async (req, res) => {
    const actorUserId = requireNamedBoardUser(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req,
      res,
      svc.getById(id),
      "Task not found",
    );
    if (!existing) return;

    try {
      const result = await ordinaryTasks.boardReassign({
        companyId: existing.companyId,
        taskId: existing.id,
        ownerAgentId: req.body.ownerAgentId,
        actorUserId,
        idempotencyKey: req.body.idempotencyKey,
      });
      res.status(result.retried ? 200 : 201).json(result);
    } catch (error) {
      canonicalTaskMutationError(error);
    }
  });

  router.post(
    "/tasks/:id/creator-reassign",
    validate(reassignTaskSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Task not found",
      );
      if (!existing) return;

      try {
        const result = await ordinaryTasks.reassign({
          companyId: existing.companyId,
          taskId: existing.id,
          ownerAgentId: req.body.ownerAgentId,
          idempotencyKey: req.body.idempotencyKey,
          creator: { kind: "user/board", userId: actorUserId },
        });
        res.status(result.retried ? 200 : 201).json(result);
      } catch (error) {
        canonicalTaskMutationError(error);
      }
    },
  );

  router.post(
    "/tasks/:id/withdrawal-self-assignment",
    validate(selfAssignTaskWithdrawalSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Task not found",
      );
      if (!existing) return;

      try {
        const result =
          await ordinaryTasks.userCreatorWithdrawalSelfAssign({
            companyId: existing.companyId,
            taskId: existing.id,
            actorUserId,
            idempotencyKey: req.body.idempotencyKey,
          });
        res.status(result.retried ? 200 : 201).json(result);
      } catch (error) {
        canonicalTaskMutationError(error);
      }
    },
  );

  router.post(
    "/task-creator-form-updates",
    validate(commitTaskCreatorFormSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(req.body.taskId),
        "Task not found",
      );
      if (!existing) return;

      try {
        const result = await ordinaryTasks.commitCreatorFormUpdate(
          existing.id,
          req.body.message,
          {
            kind: "user/board",
            companyId: existing.companyId,
            userId: actorUserId,
            gatewayInvocationId:
              `human-creator-form:${existing.companyId}:${randomUUID()}`,
          },
        );
        res.status(201).json(result);
      } catch (error) {
        canonicalTaskMutationError(error);
      }
    },
  );

  router.post(
    "/task-owner-form-updates",
    validate(commitTaskOwnerFormSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(req.body.taskId),
        "Task not found",
      );
      if (!existing) return;

      const ownerAuthority =
        existing.creatorKind === "system" &&
        existing.escalatedFromAffectedTaskId &&
        ((existing.ownerKind === "user" &&
          existing.ownerUserId === actorUserId) ||
          existing.ownerKind === "board")
          ? ({
              kind: "system-escalation-human",
              companyId: existing.companyId,
              actorUserId,
              gatewayInvocationId:
                `human-owner-form:${existing.companyId}:${randomUUID()}`,
            } as const)
          : existing.creatorKind === "user/board" &&
              existing.creatorUserId === actorUserId &&
              existing.ownerKind === "user" &&
              existing.ownerUserId === actorUserId &&
              existing.ownerAssignmentSource ===
                "user_creator_withdrawal"
            ? ({
                kind: "user-creator-withdrawal",
                companyId: existing.companyId,
                actorUserId,
                gatewayInvocationId:
                  `human-owner-form:${existing.companyId}:${randomUUID()}`,
              } as const)
            : null;
      if (!ownerAuthority) {
        throw forbidden(
          "Only a documented human escalation or withdrawal owner may use the owner form",
        );
      }

      try {
        const result = await ordinaryTasks.commitOwnerFormUpdate(
          existing.id,
          {
            message: req.body.message,
            ...(req.body.status === undefined
              ? {}
              : { status: req.body.status }),
            ...(Object.hasOwn(req.body, "structuredResult")
              ? { structuredResult: req.body.structuredResult }
              : {}),
          },
          ownerAuthority,
        );
        res.status(201).json(result);
      } catch (error) {
        canonicalTaskMutationError(error);
      }
    },
  );

  router.post("/tasks/:id/reopen", validate(reopenTaskSchema), async (req, res) => {
    const actorUserId = requireNamedBoardUser(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req,
      res,
      svc.getById(id),
      "Task not found",
    );
    if (!existing) return;

    try {
      const result = await ordinaryTasks.boardReopen({
        companyId: existing.companyId,
        taskId: existing.id,
        actorUserId,
        reason: req.body.reason,
        idempotencyKey: req.body.idempotencyKey,
      });
      res.status(result.retried ? 200 : 201).json(result);
    } catch (error) {
      canonicalTaskMutationError(error);
    }
  });
  router.get("/tasks/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const query = taskCommentRootPageQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid task comment page query" });
      return;
    }
    const page = await svc.listBoardCommentGroups(task.companyId, id, {
      cursor: query.data.cursor ?? null,
      limit: query.data.limit ?? null,
      entryLimit: query.data.entryLimit ?? null,
    });
    res.json(page);
  });

  router.get("/tasks/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const comment = await svc.getBoardComment(task.companyId, id, commentId);
    if (!comment) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.get("/tasks/:id/comments/:rootCommentId/thread", async (req, res) => {
    const id = req.params.id as string;
    const rootCommentId = req.params.rootCommentId as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const query = taskCommentThreadPageQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid task comment thread page query" });
      return;
    }
    const page = await svc.getBoardCommentThread(
      task.companyId,
      id,
      rootCommentId,
      {
        cursor: query.data.cursor ?? null,
        limit: query.data.limit ?? null,
      },
    );
    if (!page) {
      res.status(404).json({ error: "Comment thread not found" });
      return;
    }
    res.json(page);
  });


  router.post(
    "/tasks/:id/comments",
    validate(createTaskUserCommentSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Task not found",
      );
      if (!existing) return;

      try {
        if (req.body.replyToCommentId) {
          await authorizeHumanTaskSteering(db, req, existing.companyId);
        }
        const result = await ordinaryTasks.userComment({
          companyId: existing.companyId,
          taskId: existing.id,
          actorUserId,
          message: req.body.message,
          idempotencyKey: req.body.idempotencyKey,
          mention: req.body.mention ?? null,
          replyToCommentId: req.body.replyToCommentId ?? null,
        });
        const comment = await svc.getBoardComment(
          existing.companyId,
          existing.id,
          result.comment.id,
        );
        if (!comment) {
          throw new OrdinaryTaskRuntimeRejected(
            "Board comment projection is missing after commit",
            "board_comment_projection_missing",
          );
        }
        await opts.pluginDomainEvents.publish({
          eventId: comment.id,
          eventType: "task.board.comment.created",
          occurredAt: new Date().toISOString(),
          actorId: actorUserId,
          actorType: "user",
          entityId: comment.id,
          entityType: "task_comment",
          companyId: existing.companyId,
          payload: {
            companyId: existing.companyId,
            taskId: existing.id,
            commentId: comment.id,
          },
        });
        res.status(result.retried ? 200 : 201).json({
          comment,
          retried: result.retried,
        });
      } catch (error) {
        canonicalTaskMutationError(error);
      }
    },
  );

  router.get("/tasks/:id/attachments", async (req, res) => {
    const taskId = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(taskId), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const attachments = await svc.listAttachments(taskId);
    res.json(attachments.map(withContentPath));
  });

  router.post("/companies/:companyId/tasks/:taskId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const taskId = req.params.taskId as string;
    assertCompanyAccess(req, companyId);
    const task = await svc.getById(taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (task.companyId !== companyId) {
      res.status(422).json({ error: "Task does not belong to company" });
      return;
    }
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;

    const company = await companiesSvc.getById(companyId);
    const attachmentMaxBytes = normalizeTaskAttachmentMaxBytes(company?.attachmentMaxBytes);

    try {
      await runSingleFileUpload(req, res, attachmentMaxBytes);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${attachmentMaxBytes} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = normalizeUploadAttachmentContentType({
      contentType: file.mimetype,
      originalFilename: file.originalname,
    });
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createTaskAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: validationDetails(parsedMeta.error) });
      return;
    }

    assertBoard(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `tasks/${taskId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      taskId,
      taskCommentId: parsedMeta.data.taskCommentId ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByUserId: req.actor.userId,
    });

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.attachment_added",
      entityType: "task",
      entityId: taskId,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });

    res.status(201).json(withContentPath(attachment));
  });

  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await getAccessibleResource(req, res, svc.getAttachmentById(attachmentId), "Attachment not found");
    if (!attachment) return;
    const task = await svc.getById(attachment.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!(await assertTaskReadAllowed(req, res, task))) return;

    const contentLength = attachment.byteSize;
    const range = parseAttachmentRangeHeader(
      typeof req.headers.range === "string" ? req.headers.range : undefined,
      contentLength,
    );
    res.setHeader("Accept-Ranges", "bytes");
    if (range.kind === "invalid") {
      res.setHeader("Content-Range", `bytes */${contentLength}`);
      res.status(416).end();
      return;
    }

    const object = await storage.getObject(
      attachment.companyId,
      attachment.objectKey,
      range.kind === "range" ? { range: { start: range.start, end: range.end } } : undefined,
    );
    const responseContentType = resolveAttachmentResponseContentType({
      storedContentType: attachment.contentType,
      objectContentType: object.contentType,
      originalFilename: attachment.originalFilename,
    });
    res.setHeader("Content-Type", responseContentType);
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === SVG_CONTENT_TYPE) {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    const filename = attachment.originalFilename ?? "attachment";
    const disposition = parseBooleanQuery(req.query.download)
      ? "attachment"
      : isInlineAttachmentContentType(responseContentType) ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    if (range.kind === "range") {
      const rangeLength = range.end - range.start + 1;
      res.status(206);
      res.setHeader("Content-Length", String(rangeLength));
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${contentLength}`);
      object.stream.pipe(res);
      return;
    }

    res.setHeader("Content-Length", String(contentLength || object.contentLength || 0));
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await getAccessibleResource(req, res, svc.getAttachmentById(attachmentId), "Attachment not found");
    if (!attachment) return;
    const task = await svc.getById(attachment.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;

    try {
      await storage.deleteObject(attachment.companyId, attachment.objectKey);
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    assertBoard(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.attachment_removed",
      entityType: "task",
      entityId: removed.taskId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });

  return router;
}
