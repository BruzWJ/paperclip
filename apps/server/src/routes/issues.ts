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
  executionWorkspaces,
  issueComments,
  issueDocuments,
  issueRelations,
  issues as issueRows,
  issueWorkProducts,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineStages,
  pipelines,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  attachmentArtifactWorkProductMetadataSchema,
  companySearchExtractQuerySchema,
  companySearchQuerySchema,
  createIssueAttachmentMetadataSchema,
  createIssueWorkProductSchema,
  createIssueLabelSchema,
  createDocumentAnnotationCommentSchema,
  createDocumentAnnotationThreadSchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  upsertIssueFeedbackVoteSchema,
  upsertIssueWatchdogSchema,
  linkIssueApprovalSchema,
  issueDocumentKeySchema,
  restoreIssueDocumentRevisionSchema,
  updateIssueWorkProductSchema,
  updateDocumentAnnotationThreadSchema,
  upsertIssueDocumentSchema,
  createIssueUserCommentSchema,
  commitIssueCreatorFormSchema,
  commitIssueOwnerFormSchema,
  reassignIssueSchema,
  reopenIssueSchema,
  selfAssignIssueWithdrawalSchema,
  updateIssueTitleSchema,
  updateIssueExecutionPolicySchema,
  decideIssueExecutionStageSchema,
  isUuidLike,
  normalizeIssueIdentifier as normalizeIssueReferenceIdentifier,
  type CompactIssue,
  type CompanySearchExtractQuery,
  type CompanySearchExtractResponse,
  type CompanySearchQuery,
  type CompanySearchResponse,
  type ExecutionWorkspace,
  type IssueBlockerDiagnosticFlag,
  type IssueBlockerDiagnosticIssueSummary,
  type IssueBlockerDiagnosticNode,
  type IssueBlockerDiagnosticsReadiness,
  type IssueBlockerDiagnosticsResponse,
  type IssueSubtreeDiagnosticEdge,
  type IssueSubtreeDiagnosticNode,
  type IssueSubtreeDiagnosticsResponse,
  type IssueRelationIssueSummary,
  type ProjectWorkspace,
  type SourceTrustMetadata,
  type WorkspaceRuntimeService,
} from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import * as serviceIndex from "../services/index.js";
import {
  readIssueExecutionRun,
  resolveIssueExecutionRunIdentityById,
} from "../services/issue-execution-run-service.js";
import {
  accessService,
  companySkillService,
  companyService,
  companySearchService,
  executionWorkspaceService,
  goalService,
  issueApprovalService,
  inboxAgentPolicyService,
  ISSUE_LIST_DEFAULT_LIMIT,
  ISSUE_LIST_MAX_LIMIT,
  issueReferenceService,
  issueService,
  type IssueFilters,
  clampIssueListLimit,
  documentService,
  documentAnnotationService,
  logActivity,
  projectService,
  routineService,
  OrdinaryIssueRuntimeRejected,
  type OrdinaryIssueRuntime,
  workProductService,
} from "../services/index.js";
import { issueWatchdogService } from "../services/issue-watchdogs.js";
import { publishPluginDomainEvent } from "../services/activity-log.js";
import { logger } from "../middleware/logger.js";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import {
  assertBoard,
  assertCompanyAccess,
  authorizeHumanIssueSteering,
  getAccessibleResource,
} from "./authz.js";
import {
  GENERIC_ATTACHMENT_CONTENT_TYPES,
  isInlineAttachmentContentType,
  normalizeIssueAttachmentMaxBytes,
  normalizeContentType,
  normalizeUploadAttachmentContentType,
  SVG_CONTENT_TYPE,
} from "../attachment-types.js";
import { executionWorkspaceService as executionWorkspaceServiceDirect } from "../services/execution-workspaces.js";
import { decisionTrainingService } from "../services/decision-training.js";
import { feedbackService } from "../services/feedback.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
} from "../services/issues.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { redactSensitiveText } from "../redaction.js";
import {
  createCompanySearchRateLimiter,
  type CompanySearchRateLimiter,
} from "../services/company-search-rate-limit.js";
import {
  issueExecutionPolicyControlService,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  redactIssueMonitorExternalRef,
} from "../services/issue-execution-policy.js";
import { parseIssueExecutionWorkspaceSettings } from "../services/execution-workspace-policy.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  buildPromotedSourceTrust,
  isLowTrustQuarantined,
} from "../services/source-trust.js";
import { issueIngressRoutes } from "./issue-ingress.js";
import {
  LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH,
} from "../services/trust-preset-resolver.js";
import { externalObjectService } from "../services/external-objects.js";

const MAX_ISSUE_COMMENT_LIMIT = 500;
const issueCommentRootPageQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_ISSUE_COMMENT_LIMIT).optional(),
  entryLimit: z.coerce.number().int().positive().max(MAX_ISSUE_COMMENT_LIMIT).optional(),
}).strict();
const issueCommentThreadPageQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_ISSUE_COMMENT_LIMIT).optional(),
}).strict();
const refreshExternalObjectsSchema = z.object({
  objectIds: z.array(z.string().uuid()).max(50).optional(),
}).strict();
const inboxArchiveBodySchema = z.object({}).strict().default({});
const externalObjectSummariesSchema = z.object({
  issueIds: z.array(z.string().uuid()).max(1000),
}).strict();

const promoteLowTrustOutputSchema = z.object({
  sourceArtifactKind: z.enum(["comment", "document", "work_product", "issue"]),
  sourceArtifactId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(8_000),
});

async function listIssueLinkedCases(db: Db, companyId: string, issueId: string) {
  const rows = await db
    .select({
      link: pipelineCaseIssueLinks,
      case: pipelineCases,
      pipeline: pipelines,
      stage: pipelineStages,
    })
    .from(pipelineCaseIssueLinks)
    .innerJoin(pipelineCases, eq(pipelineCaseIssueLinks.caseId, pipelineCases.id))
    .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
    .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
    .where(and(
      eq(pipelineCaseIssueLinks.companyId, companyId),
      eq(pipelineCaseIssueLinks.issueId, issueId),
      eq(pipelineCases.companyId, companyId),
      eq(pipelines.companyId, companyId),
    ));
  return rows.map((row) => ({
    id: row.case.id,
    caseKey: row.case.caseKey,
    title: row.case.title,
    status: row.case.terminalKind ?? "open",
    role: row.link.role,
    pipeline: {
      id: row.pipeline.id,
      key: row.pipeline.key,
      name: row.pipeline.name,
    },
    stage: {
      id: row.stage.id,
      key: row.stage.key,
      name: row.stage.name,
      kind: row.stage.kind,
    },
  }));
}

type NormalizedExecutionPolicy = NonNullable<ReturnType<typeof normalizeIssueExecutionPolicy>>;
type CompanySearchService = {
  extract(companyId: string, query: CompanySearchExtractQuery): Promise<CompanySearchExtractResponse>;
  search(companyId: string, query: CompanySearchQuery): Promise<CompanySearchResponse>;
};
type ActivityIssueRelationSummary = {
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

const ISSUE_WORKSPACE_AUDIT_FIELDS = new Set([
  "projectWorkspaceId",
  "executionWorkspacePreference",
  "executionWorkspaceSettings",
]);

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasIssueWorkspaceAuditChange(previous: Record<string, unknown>) {
  return Object.keys(previous).some((key) => ISSUE_WORKSPACE_AUDIT_FIELDS.has(key));
}

function labelIssueWorkspaceMode(mode: string | null) {
  switch (mode) {
    case "shared_workspace":
      return "Project default";
    case "isolated_workspace":
      return "New isolated workspace";
    case "operator_branch":
      return "Operator branch";
    case "reuse_existing":
      return "Reuse existing workspace";
    case "agent_default":
      return "Agent default";
    case "inherit":
      return "Inherited workspace";
    default:
      return "No workspace";
  }
}

type IssueWorkspaceAuditInput = {
  projectWorkspaceId?: string | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: unknown;
};

type WorkspaceNameMaps = {
  projectWorkspaceNames: Map<string, string>;
  executionWorkspaceNames: Map<string, string>;
};

function emptyWorkspaceNameMaps(): WorkspaceNameMaps {
  return {
    projectWorkspaceNames: new Map(),
    executionWorkspaceNames: new Map(),
  };
}

function summarizeIssueWorkspaceForActivity(
  issue: IssueWorkspaceAuditInput,
  names: WorkspaceNameMaps,
) {
  const settings = parseIssueExecutionWorkspaceSettings(issue.executionWorkspaceSettings, { includeEnvironmentId: true });
  const mode = settings?.mode ?? issue.executionWorkspacePreference ?? null;
  const executionWorkspaceId = issue.executionWorkspaceId ?? null;
  const projectWorkspaceId = issue.projectWorkspaceId ?? null;

  const label = (() => {
    if (executionWorkspaceId) {
      return names.executionWorkspaceNames.get(executionWorkspaceId) ?? `Workspace ${executionWorkspaceId.slice(0, 8)}`;
    }
    if (projectWorkspaceId) {
      return names.projectWorkspaceNames.get(projectWorkspaceId) ?? `Workspace ${projectWorkspaceId.slice(0, 8)}`;
    }
    return labelIssueWorkspaceMode(mode);
  })();

  return {
    label,
    projectWorkspaceId,
    executionWorkspaceId,
    mode,
  };
}

async function buildIssueWorkspaceChangeActivityDetails(
  db: Db,
  companyId: string,
  previousIssue: IssueWorkspaceAuditInput,
  nextIssue: IssueWorkspaceAuditInput,
) {
  const projectWorkspaceIds = [
    previousIssue.projectWorkspaceId,
    nextIssue.projectWorkspaceId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const executionWorkspaceIds = [
    previousIssue.executionWorkspaceId,
    nextIssue.executionWorkspaceId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const [projectRows, executionRows] = await Promise.all([
    projectWorkspaceIds.length > 0
      ? db
          .select({ id: projectWorkspaces.id, name: projectWorkspaces.name })
          .from(projectWorkspaces)
          .where(and(eq(projectWorkspaces.companyId, companyId), inArray(projectWorkspaces.id, projectWorkspaceIds)))
      : Promise.resolve([]),
    executionWorkspaceIds.length > 0
      ? db
          .select({ id: executionWorkspaces.id, name: executionWorkspaces.name })
          .from(executionWorkspaces)
          .where(and(eq(executionWorkspaces.companyId, companyId), inArray(executionWorkspaces.id, executionWorkspaceIds)))
      : Promise.resolve([]),
  ]);

  const names: WorkspaceNameMaps = {
    projectWorkspaceNames: new Map(projectRows.map((row) => [row.id, row.name])),
    executionWorkspaceNames: new Map(executionRows.map((row) => [row.id, row.name])),
  };

  return {
    from: summarizeIssueWorkspaceForActivity(previousIssue, names),
    to: summarizeIssueWorkspaceForActivity(nextIssue, names),
  };
}

type IssueBlockerDiagnosticReadableIssue = {
  id: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: string;
  priority: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
};

type IssueBlockerDiagnosticAuthzIssue = IssueBlockerDiagnosticReadableIssue & {
  companyId: string;
  projectId: string | null;
  parentId: string | null;
};

function toIssueBlockerDiagnosticSummary(
  issue: IssueBlockerDiagnosticReadableIssue,
): IssueBlockerDiagnosticIssueSummary {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    boardPresentationStatus:
      issue.boardPresentationStatus as IssueBlockerDiagnosticIssueSummary["boardPresentationStatus"],
    priority: issue.priority as IssueBlockerDiagnosticIssueSummary["priority"],
    ownerAgentId: issue.ownerAgentId,
    ownerUserId: issue.ownerUserId,
  };
}

function blockerDiagnosticLabel(issue: IssueBlockerDiagnosticIssueSummary) {
  return issue.title ?? issue.identifier ?? `Issue ${issue.id}`;
}

function buildIssueBlockerDiagnosticsResponse(input: {
  issue: IssueBlockerDiagnosticReadableIssue;
  blockers: IssueBlockerDiagnosticAuthzIssue[];
  visibleBlockers: IssueBlockerDiagnosticAuthzIssue[];
  readiness: {
    allBlockersDone: boolean;
    isDependencyReady: boolean;
    unresolvedBlockerIssueIds: string[];
    pendingFinalizeBlockerIssueIds: string[];
  };
  truncated: boolean;
  maxBlockers?: number;
}): IssueBlockerDiagnosticsResponse {
  const issue = toIssueBlockerDiagnosticSummary(input.issue);
  const visibleBlockerIds = new Set(input.visibleBlockers.map((blocker) => blocker.id));
  const omittedUnauthorizedBlockerCount = input.blockers.filter(
    (blocker) => !visibleBlockerIds.has(blocker.id),
  ).length;
  const completeVisibleSet = !input.truncated && omittedUnauthorizedBlockerCount === 0;
  const unresolvedIds = new Set(input.readiness.unresolvedBlockerIssueIds);
  const pendingFinalizeIds = new Set(input.readiness.pendingFinalizeBlockerIssueIds);

  const blockers: IssueBlockerDiagnosticNode[] = input.visibleBlockers.map((blockerRow) => {
    const blocker = toIssueBlockerDiagnosticSummary(blockerRow);
    const isPendingFinalize = pendingFinalizeIds.has(blocker.id);
    const isUnresolved = unresolvedIds.has(blocker.id);
    const flags: IssueBlockerDiagnosticFlag[] = [];
    if (
      issue.boardPresentationStatus === "blocked" &&
      blocker.boardPresentationStatus === "done"
    ) flags.push("done_but_blocking");
    if (blocker.boardPresentationStatus === "cancelled") flags.push("cancelled_blocker_in_set");
    if (isPendingFinalize) flags.push("workspace_finalize_pending");

    return {
      ...blocker,
      isUnresolved,
      isPendingFinalize,
      isDependencyReady: blocker.boardPresentationStatus === "done" && !isPendingFinalize,
      flags,
    };
  });

  const readiness: IssueBlockerDiagnosticsReadiness | null = completeVisibleSet
    ? {
        allBlockersDone: input.readiness.allBlockersDone,
        isDependencyReady: input.readiness.isDependencyReady,
        unresolvedBlockerCount: input.readiness.unresolvedBlockerIssueIds.length,
        pendingFinalizeBlockerCount: input.readiness.pendingFinalizeBlockerIssueIds.length,
      }
    : null;
  const reportedOmittedUnauthorizedBlockerCount = input.truncated
    ? null
    : omittedUnauthorizedBlockerCount;

  return {
    issue,
    diagnosis: buildIssueBlockerDiagnosis({
      issue,
      blockers,
      readiness,
      omittedUnauthorizedBlockerCount: reportedOmittedUnauthorizedBlockerCount,
      truncated: input.truncated,
      maxBlockers: input.maxBlockers ?? ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
    }),
    readiness,
    blockers,
    omittedUnauthorizedBlockerCount: reportedOmittedUnauthorizedBlockerCount,
    truncated: input.truncated,
    caps: {
      maxBlockers: input.maxBlockers ?? ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
    },
  };
}

function buildIssueBlockerDiagnosis(input: {
  issue: IssueBlockerDiagnosticIssueSummary;
  blockers: IssueBlockerDiagnosticNode[];
  readiness: IssueBlockerDiagnosticsReadiness | null;
  omittedUnauthorizedBlockerCount: number | null;
  truncated: boolean;
  maxBlockers: number;
}) {
  if (input.truncated) {
    return `Blocker diagnostics for ${blockerDiagnosticLabel(input.issue)} are truncated at ${
      input.maxBlockers
    } blockers, so readiness is not reported.`;
  }
  const omittedUnauthorizedBlockerCount = input.omittedUnauthorizedBlockerCount ?? 0;
  if (omittedUnauthorizedBlockerCount > 0) {
    return `One or more blockers for ${blockerDiagnosticLabel(
      input.issue,
    )} are outside this actor's authorization boundary, so this diagnosis only covers visible blockers.`;
  }
  if (input.blockers.length === 0) {
    return input.issue.boardPresentationStatus === "blocked"
      ? `${blockerDiagnosticLabel(input.issue)} is blocked but has no first-class blocker relations.`
      : null;
  }

  const pendingFinalize = input.blockers.find((blocker) => blocker.isPendingFinalize);
  if (pendingFinalize) {
    return `${blockerDiagnosticLabel(input.issue)} is waiting for ${blockerDiagnosticLabel(
      pendingFinalize,
    )} to finish workspace finalization.`;
  }

  const cancelled = input.blockers.find(
    (blocker) => blocker.boardPresentationStatus === "cancelled",
  );
  if (cancelled) {
    return `${blockerDiagnosticLabel(input.issue)} is blocked by ${blockerDiagnosticLabel(
      cancelled,
    )}, which is cancelled; cancelled blockers do not resolve until the blocker relation is removed or replaced.`;
  }

  const unresolved = input.blockers.find((blocker) => blocker.isUnresolved);
  if (unresolved) {
    return `${blockerDiagnosticLabel(input.issue)} is blocked by ${blockerDiagnosticLabel(
      unresolved,
    )}, which is ${unresolved.boardPresentationStatus}.`;
  }

  if (
    input.readiness?.isDependencyReady &&
    input.issue.boardPresentationStatus === "blocked"
  ) {
    return `All blockers for ${blockerDiagnosticLabel(
      input.issue,
    )} are resolved, but the issue is still blocked; this is likely a stale blocker hold.`;
  }
  if (input.readiness?.isDependencyReady) {
    return `All blockers for ${blockerDiagnosticLabel(input.issue)} are resolved.`;
  }

  return null;
}


function dateToIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type IssueSubtreeDiagnosticAuthzNode = IssueBlockerDiagnosticAuthzIssue & {
  depth: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type IssueSubtreeDiagnosticBlockerAuthzRow = IssueBlockerDiagnosticAuthzIssue & {
  blockedIssueId: string;
  relationCreatedAt: Date | string;
};

function groupBlockersByBlockedIssueId(rows: IssueSubtreeDiagnosticBlockerAuthzRow[]) {
  const map = new Map<string, IssueSubtreeDiagnosticBlockerAuthzRow[]>();
  for (const row of rows) {
    const issueRows = map.get(row.blockedIssueId) ?? [];
    issueRows.push(row);
    map.set(row.blockedIssueId, issueRows);
  }
  return map;
}

function issueSubtreeEdgeTimestamp(edge: IssueSubtreeDiagnosticEdge) {
  return edge.timestamp ? new Date(edge.timestamp).getTime() : 0;
}

function buildIssueSubtreeDiagnosis(input: {
  issue: IssueBlockerDiagnosticIssueSummary;
  nodes: IssueSubtreeDiagnosticNode[];
  omittedUnauthorizedNodeCount: number | null;
  truncated: boolean;
  caps: IssueSubtreeDiagnosticsResponse["caps"];
}) {
  if (input.truncated) {
    return `Subtree diagnostics for ${blockerDiagnosticLabel(input.issue)} are bounded to depth ${
      input.caps.maxDepth
    } and ${input.caps.maxNodes} nodes, so the diagnosis only covers returned visible nodes.`;
  }
  if ((input.omittedUnauthorizedNodeCount ?? 0) > 0) {
    return `One or more subtree nodes under ${blockerDiagnosticLabel(
      input.issue,
    )} are outside this actor's authorization boundary, so this diagnosis only covers visible nodes.`;
  }

  const blockedNodeWithDiagnosis = input.nodes.find(
    (node) => node.issue.boardPresentationStatus === "blocked" && node.diagnosis,
  );
  const firstNodeWithDiagnosis = blockedNodeWithDiagnosis ?? input.nodes.find((node) => node.diagnosis);
  if (!firstNodeWithDiagnosis?.diagnosis) return null;

  return `${blockerDiagnosticLabel(firstNodeWithDiagnosis.issue)} appears to be the subtree stall point: ${
    firstNodeWithDiagnosis.diagnosis
  }`;
}

function buildIssueSubtreeDiagnosticsResponse(input: {
  issue: IssueBlockerDiagnosticReadableIssue;
  nodes: IssueSubtreeDiagnosticAuthzNode[];
  visibleNodes: IssueSubtreeDiagnosticAuthzNode[];
  blockersByIssueId: Map<string, IssueSubtreeDiagnosticBlockerAuthzRow[]>;
  visibleBlockers: IssueSubtreeDiagnosticBlockerAuthzRow[];
  readinessByIssueId: Map<string, {
    allBlockersDone: boolean;
    isDependencyReady: boolean;
    unresolvedBlockerIssueIds: string[];
    pendingFinalizeBlockerIssueIds: string[];
  }>;
  truncatedNodes: boolean;
  truncatedDepth: boolean;
  truncatedBlockerIssueIds: Set<string>;
  caps: IssueSubtreeDiagnosticsResponse["caps"];
}): IssueSubtreeDiagnosticsResponse {
  const issue = toIssueBlockerDiagnosticSummary(input.issue);
  const visibleNodeIds = new Set(input.visibleNodes.map((node) => node.id));
  const visibleBlockerIdsByIssueId = groupBlockersByBlockedIssueId(input.visibleBlockers);
  const omittedUnauthorizedNodeCount = input.truncatedNodes || input.truncatedDepth
    ? null
    : input.nodes.filter((node) => !visibleNodeIds.has(node.id)).length;
  const nodeResponses: IssueSubtreeDiagnosticNode[] = [];
  const edges: IssueSubtreeDiagnosticEdge[] = [];

  for (const node of input.visibleNodes) {
    const rawBlockers = input.blockersByIssueId.get(node.id) ?? [];
    const visibleBlockers = visibleBlockerIdsByIssueId.get(node.id) ?? [];
    const blockerResponse = buildIssueBlockerDiagnosticsResponse({
      issue: node,
      blockers: rawBlockers,
      visibleBlockers,
      readiness: input.readinessByIssueId.get(node.id) ?? {
        allBlockersDone: true,
        isDependencyReady: true,
        unresolvedBlockerIssueIds: [],
        pendingFinalizeBlockerIssueIds: [],
      },
      truncated: input.truncatedBlockerIssueIds.has(node.id),
      maxBlockers: input.caps.maxBlockersPerNode,
    });
    const nodeDiagnosis = blockerResponse.diagnosis;

    if (node.parentId && visibleNodeIds.has(node.parentId)) {
      edges.push({
        kind: "parent",
        fromIssueId: node.parentId,
        toIssueId: node.id,
        timestamp: dateToIso(node.createdAt),
      });
    }
    for (const blocker of visibleBlockers) {
      edges.push({
        kind: "blocks",
        fromIssueId: blocker.id,
        toIssueId: node.id,
        timestamp: dateToIso(blocker.relationCreatedAt),
      });
    }
    nodeResponses.push({
      issue: toIssueBlockerDiagnosticSummary(node),
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

  edges.sort((left, right) => issueSubtreeEdgeTimestamp(right) - issueSubtreeEdgeTimestamp(left));
  const truncatedSections = {
    nodes: input.truncatedNodes,
    depth: input.truncatedDepth,
    blockers: input.truncatedBlockerIssueIds.size > 0,
  };
  const truncated = Object.values(truncatedSections).some(Boolean);
  const diagnosis = buildIssueSubtreeDiagnosis({
    issue,
    nodes: nodeResponses,
    omittedUnauthorizedNodeCount,
    truncated,
    caps: input.caps,
  });

  return {
    issue,
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

function summarizeIssueRelationForActivity(relation: {
  id: string;
  identifier: string | null;
  title: string | null;
}): ActivityIssueRelationSummary {
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

function summarizeIssueReferenceActivityDetails(input:
  | {
      addedReferencedIssues: ActivityIssueRelationSummary[];
      removedReferencedIssues: ActivityIssueRelationSummary[];
      currentReferencedIssues: ActivityIssueRelationSummary[];
    }
  | null
  | undefined,
) {
  if (!input) return {};
  return {
    ...(input.addedReferencedIssues.length > 0 ? { addedReferencedIssues: input.addedReferencedIssues } : {}),
    ...(input.removedReferencedIssues.length > 0 ? { removedReferencedIssues: input.removedReferencedIssues } : {}),
    ...(input.currentReferencedIssues.length > 0 ? { currentReferencedIssues: input.currentReferencedIssues } : {}),
  };
}

function summarizeIssueMonitor(
  issue: {
    monitorNextCheckAt?: Date | null;
    monitorLastTriggeredAt?: Date | null;
    monitorAttemptCount?: number | null;
    monitorNotes?: string | null;
    monitorScheduledBy?: string | null;
    executionState?: unknown;
  },
  policy: NormalizedExecutionPolicy | null,
) {
  const state = parseIssueExecutionState(issue.executionState);
  return {
    nextCheckAt: issue.monitorNextCheckAt?.toISOString() ?? policy?.monitor?.nextCheckAt ?? null,
    lastTriggeredAt: issue.monitorLastTriggeredAt?.toISOString() ?? state?.monitor?.lastTriggeredAt ?? null,
    attemptCount: issue.monitorAttemptCount ?? state?.monitor?.attemptCount ?? 0,
    notes: policy?.monitor?.notes ?? issue.monitorNotes ?? state?.monitor?.notes ?? null,
    scheduledBy: issue.monitorScheduledBy ?? policy?.monitor?.scheduledBy ?? state?.monitor?.scheduledBy ?? null,
    kind: policy?.monitor?.kind ?? state?.monitor?.kind ?? null,
    serviceName: policy?.monitor?.serviceName ?? state?.monitor?.serviceName ?? null,
    externalRef: redactIssueMonitorExternalRef(policy?.monitor?.externalRef ?? state?.monitor?.externalRef ?? null),
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

function toCompactIssue(issue: any): CompactIssue {
  return {
    id: issue.id,
    companyId: issue.companyId,
    projectId: issue.projectId,
    projectWorkspaceId: issue.projectWorkspaceId,
    goalId: issue.goalId,
    parentId: issue.parentId,
    title: issue.title,
    request: issue.request,
    boardPresentationStatus: issue.boardPresentationStatus,
    lifecycleStatus: issue.lifecycleStatus,
    disposition: issue.disposition,
    workMode: issue.workMode,
    priority: issue.priority,
    ownerKind: issue.ownerKind,
    ownerAgentId: issue.ownerAgentId,
    ownerUserId: issue.ownerUserId,
    ownerAssignmentSource: issue.ownerAssignmentSource,
    ownershipEpoch: issue.ownershipEpoch,
    creatorKind: issue.creatorKind,
    creatorAuthorityId: issue.creatorAuthorityId,
    creatorAdapterConfigRevisionId: issue.creatorAdapterConfigRevisionId,
    creatorUserId: issue.creatorUserId,
    creatorPluginInstallationId: issue.creatorPluginInstallationId,
    creatorPluginKey: issue.creatorPluginKey,
    creatorCallbackKey: issue.creatorCallbackKey,
    creatorCallbackVersion: issue.creatorCallbackVersion,
    creatorRoutineId: issue.creatorRoutineId,
    creatorRoutineDispatchId: issue.creatorRoutineDispatchId,
    creatorSystemSourceKind: issue.creatorSystemSourceKind,
    creatorSystemSourceId: issue.creatorSystemSourceId,
    issueNumber: issue.issueNumber,
    identifier: issue.identifier,
    originKind: issue.originKind,
    originId: issue.originId,
    originRunId: issue.originRunId,
    requestDepth: issue.requestDepth,
    billingCode: issue.billingCode,
    startedAt: issue.startedAt,
    completedAt: issue.completedAt,
    cancelledAt: issue.cancelledAt,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    ...(issue.labelIds ? { labelIds: issue.labelIds } : {}),
    ...(issue.labels ? { labels: issue.labels } : {}),
    ...(issue.blockedBy ? { blockedBy: issue.blockedBy } : {}),
    ...(issue.blockerAttention ? { blockerAttention: issue.blockerAttention } : {}),
    ...(issue.blockedInboxAttention !== undefined ? { blockedInboxAttention: issue.blockedInboxAttention } : {}),
    ...(issue.liveDescendantCount !== undefined ? { liveDescendantCount: issue.liveDescendantCount } : {}),
    ...(issue.myLastTouchAt !== undefined ? { myLastTouchAt: issue.myLastTouchAt } : {}),
    ...(issue.lastExternalCommentAt !== undefined ? { lastExternalCommentAt: issue.lastExternalCommentAt } : {}),
    ...(issue.lastActivityAt !== undefined ? { lastActivityAt: issue.lastActivityAt } : {}),
    ...(issue.isUnreadForMe !== undefined ? { isUnreadForMe: issue.isUnreadForMe } : {}),
  };
}

function compactIssueListEtag(issues: CompactIssue[]): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(issues))
    .digest("base64url");
  return `"compact-issues:${hash}"`;
}

function requestMatchesEtag(ifNoneMatchHeader: string | undefined, etag: string): boolean {
  if (!ifNoneMatchHeader) return false;
  return ifNoneMatchHeader
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag || value === `W/${etag}`);
}

const ISSUE_LIST_SERVER_CACHE_TTL_MS = 2_000;
const ISSUE_LIST_SERVER_CACHE_STALE_MS = 5_000;
export const ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES = 256;
const ISSUE_LIST_STORM_WINDOW_MS = 500;
const ISSUE_LIST_STORM_THRESHOLD = 4;
const ISSUE_LIST_MAX_ACTOR_CLIENT_INFLIGHT = 8;

type IssueListPreparedResponse =
  | {
      kind: "compact";
      body: CompactIssue[];
      etag: string;
      cacheControl: string;
    }
  | {
      kind: "full";
      body: unknown[];
    };

type IssueListCacheStatus = "miss" | "hit" | "coalesced" | "stale" | "retry";

type IssueListStormEvent = {
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

type IssueListDiagnostics = {
  onComputeStart?: (context: { companyId: string; cacheKeyHash: string }) => void | Promise<void>;
  onStormDetected?: (event: IssueListStormEvent) => void;
};

type IssueListCacheEntry = {
  response: IssueListPreparedResponse;
  expiresAt: number;
  staleUntil: number;
};

type IssueListInflightEntry = {
  promise: Promise<IssueListPreparedResponse>;
  startedAt: number;
  waiterCount: number;
  stormLogged: boolean;
};

const issueListResponseCache = new Map<string, IssueListCacheEntry>();
const issueListInflight = new Map<string, IssueListInflightEntry>();
const issueListActorClientInflight = new Map<string, number>();

export function __getIssueListResponseCacheSizeForTests() {
  return issueListResponseCache.size;
}

export function __clearIssueListResponseCacheForTests() {
  issueListResponseCache.clear();
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

function normalizeIssueListCacheValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map(normalizeIssueListCacheValue).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  }
  if (typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      const next = normalizeIssueListCacheValue(nestedValue);
      if (next !== undefined) normalized[key] = next;
    }
    return normalized;
  }
  return value;
}

function issueListActorIdentity(req: Request, companyId: string) {
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

function issueListClientIdentity(req: Request) {
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

function issueListRequestKey(input: {
  req: Request;
  companyId: string;
  normalizedQuery: Record<string, unknown>;
}) {
  const route = "GET /api/companies/:companyId/issues";
  const actor = issueListActorIdentity(input.req, input.companyId);
  const client = issueListClientIdentity(input.req);
  const normalizedQuery = normalizeIssueListCacheValue(input.normalizedQuery) as Record<string, unknown>;
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

function pruneIssueListResponseCache(now: number) {
  for (const [key, entry] of issueListResponseCache) {
    if (entry.staleUntil <= now) issueListResponseCache.delete(key);
  }
}

function touchIssueListResponseCacheEntry(key: string, entry: IssueListCacheEntry) {
  issueListResponseCache.delete(key);
  issueListResponseCache.set(key, entry);
}

function trimIssueListResponseCache() {
  while (issueListResponseCache.size > ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES) {
    const oldestKey = issueListResponseCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    issueListResponseCache.delete(oldestKey);
  }
}

function setIssueListResponseCacheEntry(key: string, entry: IssueListCacheEntry) {
  touchIssueListResponseCacheEntry(key, entry);
  trimIssueListResponseCache();
}

function decrementIssueListActorClientInflight(actorClientKey: string) {
  const next = (issueListActorClientInflight.get(actorClientKey) ?? 1) - 1;
  if (next <= 0) issueListActorClientInflight.delete(actorClientKey);
  else issueListActorClientInflight.set(actorClientKey, next);
}

async function coordinateIssueListGet(input: {
  req: Request;
  companyId: string;
  requestKey: ReturnType<typeof issueListRequestKey>;
  allowTtlCache: boolean;
  diagnostics?: IssueListDiagnostics;
  compute: () => Promise<IssueListPreparedResponse>;
}): Promise<{
  response: IssueListPreparedResponse | null;
  cacheStatus: IssueListCacheStatus;
  identicalInFlightCount: number;
  retryAfterSeconds?: number;
}> {
  const now = Date.now();
  pruneIssueListResponseCache(now);

  const cached = input.allowTtlCache ? issueListResponseCache.get(input.requestKey.key) : undefined;
  if (cached && cached.expiresAt > now) {
    touchIssueListResponseCacheEntry(input.requestKey.key, cached);
    return { response: cached.response, cacheStatus: "hit", identicalInFlightCount: 0 };
  }

  const existing = issueListInflight.get(input.requestKey.key);
  if (existing) {
    existing.waiterCount += 1;
    const identicalInFlightCount = existing.waiterCount + 1;
    if (
      !existing.stormLogged &&
      identicalInFlightCount >= ISSUE_LIST_STORM_THRESHOLD &&
      now - existing.startedAt <= ISSUE_LIST_STORM_WINDOW_MS
    ) {
      existing.stormLogged = true;
      const event: IssueListStormEvent = {
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
  const actorClientInflight = issueListActorClientInflight.get(actorClientKey) ?? 0;
  if (actorClientInflight >= ISSUE_LIST_MAX_ACTOR_CLIENT_INFLIGHT) {
    if (cached && cached.staleUntil > now) {
      touchIssueListResponseCacheEntry(input.requestKey.key, cached);
      return { response: cached.response, cacheStatus: "stale", identicalInFlightCount: 0 };
    }
    return { response: null, cacheStatus: "retry", identicalInFlightCount: 0, retryAfterSeconds: 1 };
  }

  issueListActorClientInflight.set(actorClientKey, actorClientInflight + 1);
  const promise = (async () => {
    await input.diagnostics?.onComputeStart?.({
      companyId: input.companyId,
      cacheKeyHash: input.requestKey.keyHash,
    });
    return input.compute();
  })();
  const inflightEntry: IssueListInflightEntry = {
    promise,
    startedAt: now,
    waiterCount: 0,
    stormLogged: false,
  };
  issueListInflight.set(input.requestKey.key, inflightEntry);

  try {
    const response = await promise;
    if (input.allowTtlCache) {
      setIssueListResponseCacheEntry(input.requestKey.key, {
        response,
        expiresAt: Date.now() + ISSUE_LIST_SERVER_CACHE_TTL_MS,
        staleUntil: Date.now() + ISSUE_LIST_SERVER_CACHE_STALE_MS,
      });
    }
    return { response, cacheStatus: "miss", identicalInFlightCount: 1 };
  } finally {
    if (issueListInflight.get(input.requestKey.key) === inflightEntry) {
      issueListInflight.delete(input.requestKey.key);
    }
    decrementIssueListActorClientInflight(actorClientKey);
  }
}

function estimatedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function logIssueListRequest(input: {
  req: Request;
  res: Response;
  companyId: string;
  requestKey: ReturnType<typeof issueListRequestKey>;
  startedAt: number;
  cacheStatus: IssueListCacheStatus;
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
      "Issue commands require an authenticated named board user",
    );
  }
  assertBoard(req);
  return req.actor.userId;
}

function canonicalIssueMutationError(error: unknown): never {
  if (!(error instanceof OrdinaryIssueRuntimeRejected)) {
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
    error.reason === "issue_form_conflict" ||
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

export function issueRoutes(
  db: Db,
  storage: StorageService,
  opts: {
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    searchService?: CompanySearchService;
    searchRateLimiter?: CompanySearchRateLimiter;
    pluginWorkerManager?: PluginWorkerManager;
    issueListDiagnostics?: IssueListDiagnostics;
    ordinaryIssues: OrdinaryIssueRuntime;
  },
) {
  const router = Router();
  const svc = issueService(db);
  const ordinaryIssues = opts.ordinaryIssues;
  const executionPolicyControl = issueExecutionPolicyControlService(db);
  const access = accessService(db);
  const feedback = feedbackService(db);
  const companiesSvc = companyService(db);
  let searchSvc = opts.searchService ?? null;
  const getSearchService = () => {
    searchSvc ??= companySearchService(db);
    return searchSvc;
  };
  const searchRateLimiter = opts.searchRateLimiter ?? defaultCompanySearchRateLimiter;
  const instanceSettings = instanceSettingsService(db);
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const executionWorkspacesSvc = executionWorkspaceServiceDirect(db);
  const workProductsSvc = workProductService(db);
  const documentsSvc = documentService(db);
  const companySkillsSvc = companySkillService(db);
  const documentAnnotationsSvc = documentAnnotationService(db);
  const decisionTrainingSvc = decisionTrainingService(db);
  const issueReferencesSvc = issueReferenceService(db);
  const issueWatchdogsSvc = issueWatchdogService(db, ordinaryIssues);
  const externalObjectsSvc = externalObjectService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
    enabled: async () => (await instanceSettings.getExperimental()).enableExternalObjects === true,
  });
  const routinesSvc = routineService(db, { ordinaryIssues });
  const issueTreeControlFactory = Object.prototype.hasOwnProperty.call(
    serviceIndex,
    "issueTreeControlService",
  )
    ? serviceIndex.issueTreeControlService
    : undefined;
  const treeControlSvc = issueTreeControlFactory?.(db) ?? {
    getActivePauseHoldGate: async () => null,
  };
  const feedbackExportService = opts?.feedbackExportService;

  async function queueIssueWatchdogEvaluation(issue: { id: string; companyId: string }, runId?: string | null) {
    await issueWatchdogsSvc
      .reconcileForIssueAndAncestors(issue.companyId, issue.id, { runId: runId ?? null })
      .catch((err) => {
        logger.warn(
          { err, issueId: issue.id },
          "issue watchdog evaluation hook failed",
        );
      });
  }

  async function lookupLowTrustSourceArtifact(input: {
    issueId: string;
    artifactKind: "comment" | "document" | "work_product" | "issue";
    artifactId: string;
  }): Promise<SourceTrustMetadata | null> {
    if (input.artifactKind === "issue") {
      const row = await db
        .select({
          id: issueRows.id,
          companyId: issueRows.companyId,
          parentId: issueRows.parentId,
          sourceTrust: issueRows.sourceTrust,
        })
        .from(issueRows)
        .where(eq(issueRows.id, input.artifactId))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const sourceIssue = await db
        .select({ companyId: issueRows.companyId })
        .from(issueRows)
        .where(eq(issueRows.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!sourceIssue || row.companyId !== sourceIssue.companyId) return null;
      if (row.id !== input.issueId) {
        let cursor = row.parentId;
        let isDescendant = false;
        for (let depth = 0; cursor && depth < LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH; depth += 1) {
          if (cursor === input.issueId) {
            isDescendant = true;
            break;
          }
          const parent = await db
            .select({ id: issueRows.id, companyId: issueRows.companyId, parentId: issueRows.parentId })
            .from(issueRows)
            .where(eq(issueRows.id, cursor))
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
        .select({ sourceTrust: issueComments.sourceTrust })
        .from(issueComments)
        .where(and(eq(issueComments.id, input.artifactId), eq(issueComments.issueId, input.issueId)))
        .then((rows) => rows[0] ?? null);
      return row?.sourceTrust ?? null;
    }

    if (input.artifactKind === "document") {
      const row = await db
        .select({ sourceTrust: documents.sourceTrust })
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(and(eq(documents.id, input.artifactId), eq(issueDocuments.issueId, input.issueId)))
        .then((rows) => rows[0] ?? null);
      return row?.sourceTrust ?? null;
    }

    const row = await db
      .select({ sourceTrust: issueWorkProducts.sourceTrust })
      .from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.id, input.artifactId), eq(issueWorkProducts.issueId, input.issueId)))
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
    issue: { id: string; companyId: string };
    metadata: Record<string, unknown> | null | undefined;
  }) {
    const parsed = attachmentArtifactMetadataInputSchema.safeParse(input.metadata);
    if (!parsed.success) {
      throw unprocessable("Invalid attachment artifact metadata", {
        code: "invalid_attachment_artifact_metadata",
        details: parsed.error.issues,
      });
    }

    const attachment = await svc.getAttachmentById(parsed.data.attachmentId);
    if (!attachment || attachment.companyId !== input.issue.companyId || attachment.issueId !== input.issue.id) {
      throw unprocessable("Attachment artifact must reference an attachment on the same issue", {
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

  async function assertCanManageIssueApprovalLinks(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    return true;
  }

  function actorCanAccessCompany(req: Request, companyId: string) {
    if (req.actor.type !== "board") return false;
    if (req.actor.isInstanceAdmin) return true;
    return (req.actor.companyIds ?? []).includes(companyId);
  }

  async function assertIssueReadAllowed(
    req: Request,
    res: Response,
    issue: { companyId: string },
  ) {
    if (req.actor.type === "board" && actorCanAccessCompany(req, issue.companyId)) {
      return true;
    }
    res.status(403).json({ error: "Board access required" });
    return false;
  }

  async function filterIssuesForActor<T extends { companyId: string }>(
    req: Request,
    rows: T[],
  ) {
    if (req.actor.type !== "board") return [];
    return rows.filter((issue) => actorCanAccessCompany(req, issue.companyId));
  }

  async function actorCanReadCompanyScope(req: Request, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    return decision.allowed;
  }

  async function assertBoardIssueMutationAllowed(
    req: Request,
    res: Response,
    issue: { companyId: string },
  ) {
    if (req.actor.type === "board" && actorCanAccessCompany(req, issue.companyId)) {
      return true;
    }
    res.status(403).json({ error: "Board access required" });
    return false;
  }

  async function loadWorkProductRunAttribution(runId: string) {
    const identity = await resolveIssueExecutionRunIdentityById(db, runId);
    if (!identity) return null;
    const run = await readIssueExecutionRun(db, identity);
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

  function isExplicitResumeCapableStatus(status: string | null | undefined) {
    return status === "done" || status === "blocked" || status === "todo" || status === "in_progress";
  }

  async function assertExplicitResumeIntentAllowed(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; boardPresentationStatus: string },
  ) {
    if (issue.boardPresentationStatus === "cancelled") {
      res.status(409).json({
        error: "Cancelled issues must be restored through the dedicated restore flow",
        details: {
          issueId: issue.id,
          boardPresentationStatus: issue.boardPresentationStatus,
        },
      });
      return false;
    }

    if (!isExplicitResumeCapableStatus(issue.boardPresentationStatus)) {
      res.status(409).json({
        error: "Issue is not resumable through comment follow-up intent",
        details: {
          issueId: issue.id,
          boardPresentationStatus: issue.boardPresentationStatus,
        },
      });
      return false;
    }

    const activePauseHold = await treeControlSvc.getActivePauseHoldGate(issue.companyId, issue.id);
    if (activePauseHold) {
      res.status(409).json({
        error: "Issue follow-up blocked by active subtree pause hold",
        details: {
          issueId: issue.id,
          holdId: activePauseHold.holdId,
          rootIssueId: activePauseHold.rootIssueId,
          mode: activePauseHold.mode,
        },
      });
      return false;
    }

    if (issue.boardPresentationStatus === "blocked") {
      const readiness = await svc.getDependencyReadiness(issue.id);
      if (readiness.unresolvedBlockerCount > 0) {
        res.status(409).json({
          error: "Issue follow-up blocked by unresolved blockers",
          details: {
            issueId: issue.id,
            unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
          },
        });
        return false;
      }
    }

    return true;
  }

  async function resolveIssueRouteId(rawId: string): Promise<string> {
    const identifier = normalizeIssueReferenceIdentifier(rawId);
    if (identifier) {
      const issue = await svc.getByIdentifier(identifier);
      if (issue) {
        return issue.id;
      }
    }
    return rawId;
  }

  async function resolveIssueProjectAndGoal(issue: {
    companyId: string;
    projectId: string | null;
    goalId: string | null;
  }) {
    const projectPromise = issue.projectId ? projectsSvc.getById(issue.projectId) : Promise.resolve(null);
    const directGoalPromise = issue.goalId ? goalsSvc.getById(issue.goalId) : Promise.resolve(null);
    const [project, directGoal] = await Promise.all([projectPromise, directGoalPromise]);

    if (directGoal) {
      return { project, goal: directGoal };
    }

    const projectGoalId = project?.goalId ?? project?.goalIds[0] ?? null;
    if (projectGoalId) {
      const projectGoal = await goalsSvc.getById(projectGoalId);
      return { project, goal: projectGoal };
    }

    if (!issue.projectId) {
      const defaultGoal = await goalsSvc.getDefaultCompanyGoal(issue.companyId);
      return { project, goal: defaultGoal };
    }

    return { project, goal: null };
  }

  function compactIssueProjectWorkspace(workspace: ProjectWorkspace | null | undefined) {
    if (!workspace) return null;
    return {
      id: workspace.id,
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      name: workspace.name,
      sourceType: workspace.sourceType,
      cwd: workspace.cwd,
      repoUrl: workspace.repoUrl,
      repoRef: workspace.repoRef,
      defaultRef: workspace.defaultRef,
      visibility: workspace.visibility,
      setupCommand: workspace.setupCommand,
      cleanupCommand: workspace.cleanupCommand,
      remoteProvider: workspace.remoteProvider,
      remoteWorkspaceRef: workspace.remoteWorkspaceRef,
      sharedWorkspaceKey: workspace.sharedWorkspaceKey,
      runtimeConfig: workspace.runtimeConfig,
      isPrimary: workspace.isPrimary,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  }

  function compactIssueProject(project: Awaited<ReturnType<typeof resolveIssueProjectAndGoal>>["project"]) {
    if (!project) return null;
    return {
      id: project.id,
      companyId: project.companyId,
      urlKey: project.urlKey,
      goalId: project.goalId,
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
      executionWorkspacePolicy: project.executionWorkspacePolicy,
      codebase: project.codebase,
      workspaces: (project.workspaces ?? []).map(compactIssueProjectWorkspace),
      primaryWorkspace: compactIssueProjectWorkspace(project.primaryWorkspace),
      managedByPlugin: project.managedByPlugin ?? null,
      issueCount: project.issueCount,
      budget: project.budget,
      archivedAt: project.archivedAt,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  function compactIssueRuntimeService(service: WorkspaceRuntimeService) {
    return {
      id: service.id,
      companyId: service.companyId,
      projectId: service.projectId,
      projectWorkspaceId: service.projectWorkspaceId,
      executionWorkspaceId: service.executionWorkspaceId,
      issueId: service.issueId,
      scopeType: service.scopeType,
      scopeId: service.scopeId,
      serviceName: service.serviceName,
      status: service.status,
      lifecycle: service.lifecycle,
      reuseKey: service.reuseKey,
      command: service.command,
      cwd: service.cwd,
      port: service.port,
      url: service.url,
      provider: service.provider,
      providerRef: service.providerRef,
      ownerAgentId: service.ownerAgentId,
      startedByRunId: service.startedByRunId,
      lastUsedAt: service.lastUsedAt,
      startedAt: service.startedAt,
      stoppedAt: service.stoppedAt,
      healthStatus: service.healthStatus,
      configIndex: service.configIndex ?? null,
    };
  }

  function compactIssueExecutionWorkspace(workspace: ExecutionWorkspace | null) {
    if (!workspace) return null;
    return {
      id: workspace.id,
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      projectWorkspaceId: workspace.projectWorkspaceId,
      sourceIssueId: workspace.sourceIssueId,
      mode: workspace.mode,
      strategyType: workspace.strategyType,
      name: workspace.name,
      status: workspace.status,
      cwd: workspace.cwd,
      repoUrl: workspace.repoUrl,
      baseRef: workspace.baseRef,
      branchName: workspace.branchName,
      providerType: workspace.providerType,
      providerRef: workspace.providerRef,
      derivedFromExecutionWorkspaceId: workspace.derivedFromExecutionWorkspaceId,
      lastUsedAt: workspace.lastUsedAt,
      openedAt: workspace.openedAt,
      closedAt: workspace.closedAt,
      cleanupEligibleAt: workspace.cleanupEligibleAt,
      cleanupReason: workspace.cleanupReason,
      config: workspace.config
        ? {
            environmentId: workspace.config.environmentId,
            provisionCommand: workspace.config.provisionCommand,
            teardownCommand: workspace.config.teardownCommand,
            cleanupCommand: workspace.config.cleanupCommand,
            workspaceRuntime: workspace.config.workspaceRuntime,
            desiredState: workspace.config.desiredState,
            serviceStates: workspace.config.serviceStates,
          }
        : null,
      metadata: null,
      runtimeServices: (workspace.runtimeServices ?? [])
        .filter((service) => service.status === "starting" || service.status === "running")
        .map(compactIssueRuntimeService),
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  }

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for all /issues/:id routes
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await resolveIssueRouteId(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for company-scoped attachment routes.
  router.param("issueId", async (req, res, next, rawId) => {
    try {
      req.params.issueId = await resolveIssueRouteId(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
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
        error: parsedQuery.error.issues[0]?.message ?? "Invalid extract search query",
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
        error: parsedQuery.error.issues[0]?.message ?? "Invalid search query",
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

  router.get("/companies/:companyId/issues", async (req, res) => {
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
    const limit = parsedLimit === null ? ISSUE_LIST_DEFAULT_LIMIT : clampIssueListLimit(parsedLimit);
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
      res.status(400).json({ error: `limit must be a positive integer up to ${ISSUE_LIST_MAX_LIMIT}` });
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

    const listFilters: IssueFilters = {
      attention: attention === "blocked" ? "blocked" : undefined,
      status: req.query.status as string | string[] | undefined,
      ownerAgentId,
      participantAgentId: req.query.participantAgentId as string | undefined,
      ownerUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      projectId: req.query.projectId as string | undefined,
      workspaceId: req.query.workspaceId as string | undefined,
      executionWorkspaceId: req.query.executionWorkspaceId as string | undefined,
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
    const requestKey = issueListRequestKey({
      req,
      companyId,
      normalizedQuery: {
        ...listFilters,
        view: compactView ? "compact" : undefined,
      },
    });
    const coordinated = await coordinateIssueListGet({
      req,
      companyId,
      requestKey,
      allowTtlCache: compactView,
      diagnostics: opts.issueListDiagnostics,
      compute: async () => {
        const rawResult = await svc.list(companyId, listFilters);
        const result = await actorCanReadCompanyScope(req, companyId)
          ? rawResult
          : await filterIssuesForActor(req, rawResult);
        if (compactView) {
          const compactResult = result.map((issue) => toCompactIssue(issue));
          return {
            kind: "compact",
            body: compactResult,
            etag: compactIssueListEtag(compactResult),
            cacheControl: "private, must-revalidate",
          };
        }
        return {
          kind: "full",
          body: result,
        };
      },
    });

    res.setHeader("X-Paperclip-Request-Cache", coordinated.cacheStatus);
    if (!coordinated.response) {
      const body = {
        error: "Too many concurrent issue-list requests for this actor/client",
        retryAfterSeconds: coordinated.retryAfterSeconds ?? 1,
      };
      res.setHeader("Retry-After", String(body.retryAfterSeconds));
      logIssueListRequest({
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
      logIssueListRequest({
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

    logIssueListRequest({
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

  router.get("/companies/:companyId/issues/count", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const attention = req.query.attention as string | undefined;
    const hasPlanDocument = parseOptionalBooleanQuery(req.query.hasPlanDocument);
    if (attention !== "blocked") {
      res.status(400).json({ error: "issues/count currently requires attention=blocked" });
      return;
    }
    if (req.query.limit !== undefined || req.query.offset !== undefined) {
      res.status(400).json({ error: "issues/count does not accept limit or offset" });
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
      workspaceId: req.query.workspaceId as string | undefined,
      executionWorkspaceId: req.query.executionWorkspaceId as string | undefined,
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
          limit: ISSUE_LIST_MAX_LIMIT,
          offset,
        });
        visibleCount += (await filterIssuesForActor(req, rows)).length;
        if (rows.length < ISSUE_LIST_MAX_LIMIT) break;
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

  router.post("/companies/:companyId/labels", validate(createIssueLabelSchema), async (req, res) => {
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

  router.get("/issues/:id/diagnostics/blockers", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;

    const diagnostic = await svc.getBlockerDiagnostics(issue.id);
    const visibleBlockers = await filterIssuesForActor(req, diagnostic.blockers);
    const response = buildIssueBlockerDiagnosticsResponse({
      issue,
      blockers: diagnostic.blockers,
      visibleBlockers,
      readiness: diagnostic.readiness,
      truncated: diagnostic.truncated,
    });

    logger.info(
      {
        companyId: issue.companyId,
        issueId: issue.id,
        actorType: req.actor.type,
        visibleBlockerCount: response.blockers.length,
        omittedUnauthorizedBlockerCount: response.omittedUnauthorizedBlockerCount,
        truncated: response.truncated,
      },
      "issue blocker diagnostics read",
    );

    res.json(response);
  });

  router.get("/issues/:id/diagnostics/subtree", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;

    const diagnostic = await svc.getSubtreeDiagnostics(issue.id);
    const allBlockers = [...diagnostic.blockersByIssueId.values()].flat();
    const [visibleNodes, visibleBlockers] = await Promise.all([
      filterIssuesForActor(req, diagnostic.nodes),
      filterIssuesForActor(req, allBlockers),
    ]);
    const response = buildIssueSubtreeDiagnosticsResponse({
      issue,
      nodes: diagnostic.nodes,
      visibleNodes,
      blockersByIssueId: diagnostic.blockersByIssueId,
      visibleBlockers,
      readinessByIssueId: diagnostic.readinessByIssueId,
      truncatedNodes: diagnostic.truncatedNodes,
      truncatedDepth: diagnostic.truncatedDepth,
      truncatedBlockerIssueIds: diagnostic.truncatedBlockerIssueIds,
      caps: diagnostic.caps,
    });

    logger.info(
      {
        companyId: issue.companyId,
        issueId: issue.id,
        actorType: req.actor.type,
        nodeCount: response.nodeCount,
        omittedUnauthorizedNodeCount: response.omittedUnauthorizedNodeCount,
        edgeCount: response.edges.length,
        truncated: response.truncated,
      },
      "issue subtree diagnostics read",
    );

    res.json(response);
  });

  router.get("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const inboxArchiveFieldsPromise = req.actor.type === "board" && req.actor.userId
      ? svc.getActiveInboxArchiveFields(issue, req.actor.userId)
      : Promise.resolve({});
    const [
      { project, goal },
      ancestors,
      mentionedProjectIds,
      documentPayload,
      relations,
      blockerAttention,
      referenceSummary,
      linkedCases,
      inboxArchiveFields,
    ] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.findMentionedProjectIds(issue.id, { includeCommentBodies: false }),
      documentsSvc.getIssueDocumentPayload(issue),
      svc.getRelationSummaries(issue.id),
      svc.listBlockerAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
      issueReferencesSvc.listIssueReferenceSummary(issue.id),
      listIssueLinkedCases(db, issue.companyId, issue.id),
      inboxArchiveFieldsPromise,
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    const currentExecutionWorkspace = await executionWorkspacesSvc.getCurrentForIssue(
      issue.companyId,
      issue.id,
    );
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json({
      ...issue,
      ...inboxArchiveFields,
      goalId: goal?.id ?? issue.goalId,
      ancestors,
      ...(blockerAttention ? { blockerAttention } : {}),
      blockedBy: relations.blockedBy,
      blocks: relations.blocks,
      relatedWork: referenceSummary,
      referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
      ...documentPayload,
      project: compactIssueProject(project),
      goal: goal ?? null,
      mentionedProjects,
      currentExecutionWorkspace: compactIssueExecutionWorkspace(currentExecutionWorkspace),
      workProducts,
      linkedCases,
    });
  });

  router.get("/issues/:id/watchdog", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    res.json(await issueWatchdogsSvc.getActiveForIssue(issue.companyId, issue.id));
  });

  router.put("/issues/:id/watchdog", validate(upsertIssueWatchdogSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
    assertBoard(req);
    const { watchdog, created } = await issueWatchdogsSvc.upsertForIssue(
      issue.companyId,
      issue.id,
    );
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: created ? "issue.watchdog_created" : "issue.watchdog_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        watchdogId: watchdog.id,
      },
    });
    await queueIssueWatchdogEvaluation(issue);
    res.json(watchdog);
  });

  router.delete("/issues/:id/watchdog", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
    assertBoard(req);
    const disabled = await issueWatchdogsSvc.disableForIssue(issue.companyId, issue.id);
    if (disabled) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "issue.watchdog_removed",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          watchdogId: disabled.id,
        },
      });
    }
    await queueIssueWatchdogEvaluation(issue);
    res.json({ ok: true });
  });

  router.get("/issues/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json(workProducts);
  });

  router.get("/issues/:id/external-objects", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const objects = await externalObjectsSvc.listForIssue(issue.id);
    res.json(objects);
  });

  router.get("/issues/:id/external-object-summary", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const summary = await externalObjectsSvc.getIssueSummary(issue.id);
    res.json(summary);
  });

  router.post("/companies/:companyId/issues/external-object-summaries", validate(externalObjectSummariesSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const requestedIssueIds = [...new Set(req.body.issueIds as string[])];
    const candidateIssues = requestedIssueIds.length > 0
      ? await db
        .select({
          id: issueRows.id,
          companyId: issueRows.companyId,
          projectId: issueRows.projectId,
          parentId: issueRows.parentId,
          ownerAgentId: issueRows.ownerAgentId,
          ownerUserId: issueRows.ownerUserId,
        })
        .from(issueRows)
        .where(and(eq(issueRows.companyId, companyId), inArray(issueRows.id, requestedIssueIds)))
      : [];
    const readableIssueIds = (await filterIssuesForActor(req, candidateIssues)).map((issue) => issue.id);
    const summaries = await externalObjectsSvc.getIssueSummaries(companyId, readableIssueIds);
    res.json({ summaries: Object.fromEntries(summaries) });
  });

  router.post("/issues/:id/external-objects/refresh", validate(refreshExternalObjectsSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
    assertBoard(req);
    const results = await externalObjectsSvc.refreshIssueObjects(issue.id, {
      companyId: issue.companyId,
      objectIds: req.body.objectIds,
      actor: {
        actorType: "user",
        actorId: req.actor.userId,
      },
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "external_object.refresh_requested",
      entityType: "issue",
      entityId: issue.id,
      details: {
        issueId: issue.id,
        objectIds: results.map((result) => result.object.id),
      },
    });
    res.json({ refreshed: results });
  });

  router.get("/issues/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const docs = await documentsSvc.listIssueDocuments(issue.id, {
      includeSystem: req.query.includeSystem === "true",
    });
    res.json(docs);
  });

  router.get("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const doc = await documentsSvc.getIssueDocumentByKey(issue.id, keyParsed.data);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    if (!shouldIncludeDocumentAnnotations(req)) {
      res.json(doc);
      return;
    }
    const annotations = await documentAnnotationsSvc.listThreadsForIssueDocument(issue.id, keyParsed.data, {
      status: "open",
      includeComments: shouldIncludeDocumentAnnotationComments(req),
    });
    res.json({ ...doc, annotations });
  });

  router.get("/issues/:id/documents/:key/annotations", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const status = req.query.status === "resolved" || req.query.status === "all" ? req.query.status : "open";
    const threads = await documentAnnotationsSvc.listThreadsForIssueDocument(issue.id, keyParsed.data, {
      status,
      includeComments: parseBooleanQuery(req.query.includeComments),
    });
    res.json(threads);
  });

  router.post(
    "/issues/:id/documents/:key/annotations",
    validate(createDocumentAnnotationThreadSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }

      const { userId, annotationActor } = annotationActorInput(req);
      const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const thread = await documentAnnotationsSvc.createThread(issue.id, keyParsed.data, req.body, annotationActor);
      const firstComment = thread.comments[0];
      const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.document_annotation_thread_created",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: thread.documentKey,
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          commentId: firstComment?.id ?? null,
          revisionNumber: thread.currentRevisionNumber,
          quote: thread.selectedText.slice(0, 240),
          ...summarizeIssueReferenceActivityDetails({
            addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
            removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
            currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
          }),
        },
      });

      res.status(201).json(thread);
    },
  );

  router.get("/issues/:id/documents/:key/annotations/:threadId", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const thread = await documentAnnotationsSvc.getThreadForIssueDocument(
      issue.id,
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
    "/issues/:id/documents/:key/annotations/:threadId/comments",
    validate(createDocumentAnnotationCommentSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }

      const { userId, annotationActor } = annotationActorInput(req);
      const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const comment = await documentAnnotationsSvc.addComment(
        issue.id,
        keyParsed.data,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.document_annotation_comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: keyParsed.data,
          documentKey: keyParsed.data,
          threadId: comment.threadId,
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          ...summarizeIssueReferenceActivityDetails({
            addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
            removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
            currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
          }),
        },
      });

      res.status(201).json(comment);
    },
  );

  router.patch(
    "/issues/:id/documents/:key/annotations/:threadId",
    validate(updateDocumentAnnotationThreadSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }
      const { userId, annotationActor } = annotationActorInput(req);
      const thread = await documentAnnotationsSvc.updateThread(
        issue.id,
        keyParsed.data,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "user",
        actorId: userId,
        action: thread.status === "resolved"
          ? "issue.document_annotation_thread_resolved"
          : "issue.document_annotation_thread_reopened",
        entityType: "issue",
        entityId: issue.id,
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

  router.put("/issues/:id/documents/:key", validate(upsertIssueDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    assertBoard(req);
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const result = await documentsSvc.upsertIssueDocument({
      issueId: issue.id,
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
    await externalObjectsSvc.syncDocumentSafely(doc.id);
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
    const remappedAnnotations = result.created
      ? []
      : await documentAnnotationsSvc.remapOpenThreadsForDocument({
        issueId: issue.id,
        key: doc.key,
        documentId: doc.id,
        nextRevisionId: doc.latestRevisionId,
        nextRevisionNumber: doc.latestRevisionNumber,
        nextBody: doc.body,
      });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: result.created ? "issue.document_created" : "issue.document_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
        redirectedFromLockedDocument,
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    for (const remap of remappedAnnotations) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "issue.document_annotation_remapped",
        entityType: "issue",
        entityId: issue.id,
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

  router.post("/issues/:id/documents/:key/lock", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    assertBoard(req);
    const result = await documentsSvc.lockIssueDocument({
      issueId: issue.id,
      key: keyParsed.data,
      lockedByUserId: req.actor.userId,
    });

    if (result.changed) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "issue.document_locked",
        entityType: "issue",
        entityId: issue.id,
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

  router.post("/issues/:id/documents/:key/unlock", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    assertBoard(req);
    const result = await documentsSvc.unlockIssueDocument(issue.id, keyParsed.data);

    if (result.changed) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "issue.document_unlocked",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
        },
      });
    }

    res.json(result.document);
  });

  router.get("/issues/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const revisions = await documentsSvc.listIssueDocumentRevisions(issue.id, keyParsed.data);
    res.json(revisions);
  });

  router.post(
    "/issues/:id/documents/:key/revisions/:revisionId/restore",
    validate(restoreIssueDocumentRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const revisionId = req.params.revisionId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }

      assertBoard(req);
      const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const result = await documentsSvc.restoreIssueDocumentRevision({
        issueId: issue.id,
        key: keyParsed.data,
        revisionId,
        createdByUserId: req.actor.userId,
      });
      const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      await externalObjectsSvc.syncDocumentSafely(result.document.id);
      const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
      const remappedAnnotations = await documentAnnotationsSvc.remapOpenThreadsForDocument({
        issueId: issue.id,
        key: result.document.key,
        documentId: result.document.id,
        nextRevisionId: result.document.latestRevisionId,
        nextRevisionNumber: result.document.latestRevisionNumber,
        nextBody: result.document.body,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "issue.document_restored",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          format: result.document.format,
          revisionNumber: result.document.latestRevisionNumber,
          restoredFromRevisionId: result.restoredFromRevisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
          ...summarizeIssueReferenceActivityDetails({
            addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
            removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
            currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
          }),
        },
      });

      for (const remap of remappedAnnotations) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "user",
          actorId: req.actor.userId,
          action: "issue.document_annotation_remapped",
          entityType: "issue",
          entityId: issue.id,
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

  router.delete("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const removed = await documentsSvc.deleteIssueDocument(issue.id, keyParsed.data);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    if (removed) await externalObjectsSvc.syncDocumentSafely(removed.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
    assertBoard(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "issue.document_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });
    res.json({ ok: true });
  });

  router.post("/issues/:id/work-products", validate(createIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
    assertBoard(req);
    const createInput = {
      ...req.body,
      projectId: req.body.projectId ?? issue.projectId ?? null,
    };
    const createdByRunId = await resolveWorkProductCreatedByRunId(req, res, issue.companyId, req.body, "create");
    if (createdByRunId === undefined) return;
    createInput.createdByRunId = createdByRunId;
    if (requiresPaperclipAttachmentMetadata(createInput)) {
      createInput.metadata = await canonicalizePaperclipArtifactMetadata({
        issue,
        metadata: req.body.metadata ?? null,
      });
    }
    const product = await workProductsSvc.createForIssue(issue.id, issue.companyId, createInput);
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "issue.work_product_created",
      entityType: "issue",
      entityId: issue.id,
      details: { workProductId: product.id, type: product.type, provider: product.provider },
    });
    res.status(201).json(product);
  });

  router.post("/issues/:id/low-trust/promotions", validate(promoteLowTrustOutputSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
    assertBoard(req);
    const sourceTrust = await lookupLowTrustSourceArtifact({
      issueId: issue.id,
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
      sourceIssueId: issue.id,
      sourceArtifactKind: req.body.sourceArtifactKind,
      sourceArtifactId: req.body.sourceArtifactId,
      promotedByActorType: "user",
      promotedByActorId: req.actor.userId,
      promotedAt,
    });
    const product = await db.transaction(async (tx) => {
      const markPromoted = { sourceTrust: promotionTrust, updatedAt: promotedAt };
      const updatedSource = await (async () => {
        if (req.body.sourceArtifactKind === "issue") {
          return tx
            .update(issueRows)
            .set(markPromoted)
            .where(and(
              eq(issueRows.id, req.body.sourceArtifactId),
              eq(issueRows.sourceTrust, sourceTrust),
            ))
            .returning({ id: issueRows.id });
        }
        if (req.body.sourceArtifactKind === "comment") {
          return tx
            .select({ id: issueComments.id })
            .from(issueComments)
            .where(and(
              eq(issueComments.id, req.body.sourceArtifactId),
              eq(issueComments.issueId, issue.id),
              eq(issueComments.sourceTrust, sourceTrust),
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
          .update(issueWorkProducts)
          .set(markPromoted)
          .where(and(
            eq(issueWorkProducts.id, req.body.sourceArtifactId),
            eq(issueWorkProducts.issueId, issue.id),
            eq(issueWorkProducts.sourceTrust, sourceTrust),
          ))
          .returning({ id: issueWorkProducts.id });
      })();
      if (!updatedSource[0]) return null;

      return tx
        .insert(issueWorkProducts)
        .values({
          companyId: issue.companyId,
          issueId: issue.id,
          projectId: issue.projectId ?? null,
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
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "issue.low_trust_output_promoted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        sourceArtifacts: [{
          artifactKind: req.body.sourceArtifactKind,
          artifactId: req.body.sourceArtifactId,
        }],
        reviewerPrincipal: {
          actorType: "user",
          actorId: req.actor.userId,
        },
        targetIssueId: issue.id,
        promotedWorkProductId: product.id,
        decision: "promoted",
      },
    });

    res.status(201).json(product);
  });

  router.patch("/work-products/:id", validate(updateIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, workProductsSvc.getById(id), "Work product not found");
    if (!existing) return;
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
    assertBoard(req);
    const patch = { ...req.body };
    const createdByRunId = await resolveWorkProductCreatedByRunId(req, res, existing.companyId, req.body, "update");
    if (createdByRunId === undefined && Object.prototype.hasOwnProperty.call(req.body, "createdByRunId")) return;
    if (createdByRunId !== undefined) patch.createdByRunId = createdByRunId;
    if (requiresPaperclipAttachmentMetadata(patch, existing)) {
      if (patch.metadata !== undefined) {
        patch.metadata = await canonicalizePaperclipArtifactMetadata({
          issue,
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
      action: "issue.work_product_updated",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: product.id, changedKeys: Object.keys(req.body).sort() },
    });
    res.json(product);
  });

  router.delete("/work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, workProductsSvc.getById(id), "Work product not found");
    if (!existing) return;
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
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
      action: "issue.work_product_deleted",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: removed.id, type: removed.type },
    });
    res.json(removed);
  });

  router.post("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readState = await svc.markRead(issue.companyId, issue.id, req.actor.userId, new Date());
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "issue.read_marked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.delete("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.markUnread(issue.companyId, issue.id, req.actor.userId);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "issue.read_unmarked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json({ id: issue.id, removed });
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

  router.post("/issues/:id/inbox-archive", validate(inboxArchiveBodySchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    const target = resolveInboxArchiveTarget(req);
    const archiveState = await svc.archiveInbox(issue.companyId, issue.id, target.userId, new Date(), {
      archivedByActorType: "user",
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: target.userId,
      action: "issue.inbox_archived",
      entityType: "issue",
      entityId: issue.id,
      details: {
        userId: target.userId,
        archivedAt: archiveState.archivedAt,
        targetResolvedFrom: target.targetResolvedFrom,
      },
    });
    res.json(archiveState);
  });

  router.delete("/issues/:id/inbox-archive", validate(inboxArchiveBodySchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    const target = resolveInboxArchiveTarget(req);
    const removed = await svc.unarchiveInbox(issue.companyId, issue.id, target.userId);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: target.userId,
      action: "issue.inbox_unarchived",
      entityType: "issue",
      entityId: issue.id,
      details: {
        userId: target.userId,
        targetResolvedFrom: target.targetResolvedFrom,
      },
    });
    res.json(removed ?? { ok: true, userId: target.userId });
  });

  router.get("/issues/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.json(approvals);
  });

  router.post("/issues/:id/approvals", validate(linkIssueApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertCanManageIssueApprovalLinks(req, issue.companyId))) return;
    assertBoard(req);

    await issueApprovalsSvc.link(id, req.body.approvalId, {
      userId: req.actor.userId,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "issue.approval_linked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId: req.body.approvalId },
    });

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.status(201).json(approvals);
  });

  router.delete("/issues/:id/approvals/:approvalId", async (req, res) => {
    const id = req.params.id as string;
    const approvalId = req.params.approvalId as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertCanManageIssueApprovalLinks(req, issue.companyId))) return;

    await issueApprovalsSvc.unlink(id, approvalId);

    assertBoard(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "issue.approval_unlinked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  router.use(issueIngressRoutes({
    ordinaryIssues,
    getIssueById: (id) => svc.getById(id),
  }));

  router.put(
    "/issues/:id/execution-policy",
    validate(updateIssueExecutionPolicySchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Issue not found",
      );
      if (!existing) return;

      const previousPolicy = normalizeIssueExecutionPolicy(
        existing.executionPolicy,
      );
      const issue = await executionPolicyControl.configure({
        companyId: existing.companyId,
        issueId: existing.id,
        executionPolicy: req.body.executionPolicy,
        actorUserId,
      });
      const nextPolicy = normalizeIssueExecutionPolicy(issue.executionPolicy);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "issue.execution_policy_updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          executionPolicy: nextPolicy,
          executionState: issue.executionState,
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
          companyId: issue.companyId,
          actorType: "user",
          actorId: actorUserId,
          action:
            stageType === "review"
              ? "issue.reviewers_updated"
              : "issue.approvers_updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            participants: changes.participants,
            addedParticipants: changes.addedParticipants,
            removedParticipants: changes.removedParticipants,
          },
        });
      }

      const previousMonitor = summarizeIssueMonitor(
        existing,
        previousPolicy,
      );
      const nextMonitor = summarizeIssueMonitor(issue, nextPolicy);
      if (
        nextMonitor.nextCheckAt &&
        (previousMonitor.nextCheckAt !== nextMonitor.nextCheckAt ||
          previousMonitor.notes !== nextMonitor.notes)
      ) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "issue.monitor_scheduled",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
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
          companyId: issue.companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "issue.monitor_cleared",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            previousNextCheckAt: previousMonitor.nextCheckAt,
            reason: nextMonitor.clearReason ?? "manual",
            notes: previousMonitor.notes,
          },
        });
      }

      res.json(issue);
    },
  );

  router.post(
    "/issues/:id/execution-policy/decisions",
    validate(decideIssueExecutionStageSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Issue not found",
      );
      if (!existing) return;

      const result = await executionPolicyControl.decide({
        companyId: existing.companyId,
        issueId: existing.id,
        outcome: req.body.outcome,
        body: req.body.body,
        reviewRequest: req.body.reviewRequest,
        idempotencyKey: req.body.idempotencyKey,
        actor: { userId: actorUserId },
      });

      if (!result.retried) {
        await logActivity(db, {
          companyId: result.issue.companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "issue.execution_policy_decided",
          entityType: "issue",
          entityId: result.issue.id,
          details: {
            identifier: result.issue.identifier,
            decisionId: result.decision.id,
            stageId: result.decision.stageId,
            stageType: result.decision.stageType,
            outcome: result.decision.outcome,
            lifecycleStatus: result.issue.lifecycleStatus,
            boardStatus: result.issue.boardPresentationStatus,
          },
        });
      }

      res.status(result.retried ? 200 : 201).json(result);
    },
  );

  router.patch("/issues/:id", validate(updateIssueTitleSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req,
      res,
      svc.getById(id),
      "Issue not found",
    );
    if (!existing) return;

    const issue = await svc.updateTitle(id, req.body.title);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    await externalObjectsSvc.syncIssueSafely(issue.id);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "issue.title_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        title: issue.title,
        _previous: { title: existing.title },
      },
    });

    res.json(issue);
  });

  router.post("/issues/:id/reassign", validate(reassignIssueSchema), async (req, res) => {
    const actorUserId = requireNamedBoardUser(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req,
      res,
      svc.getById(id),
      "Issue not found",
    );
    if (!existing) return;

    try {
      const result = await ordinaryIssues.boardReassign({
        companyId: existing.companyId,
        issueId: existing.id,
        ownerAgentId: req.body.ownerAgentId,
        actorUserId,
        idempotencyKey: req.body.idempotencyKey,
      });
      res.status(result.retried ? 200 : 201).json(result);
    } catch (error) {
      canonicalIssueMutationError(error);
    }
  });

  router.post(
    "/issues/:id/creator-reassign",
    validate(reassignIssueSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Issue not found",
      );
      if (!existing) return;

      try {
        const result = await ordinaryIssues.reassign({
          companyId: existing.companyId,
          issueId: existing.id,
          ownerAgentId: req.body.ownerAgentId,
          idempotencyKey: req.body.idempotencyKey,
          creator: { kind: "user/board", userId: actorUserId },
        });
        res.status(result.retried ? 200 : 201).json(result);
      } catch (error) {
        canonicalIssueMutationError(error);
      }
    },
  );

  router.post(
    "/issues/:id/withdrawal-self-assignment",
    validate(selfAssignIssueWithdrawalSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Issue not found",
      );
      if (!existing) return;

      try {
        const result =
          await ordinaryIssues.userCreatorWithdrawalSelfAssign({
            companyId: existing.companyId,
            issueId: existing.id,
            actorUserId,
            idempotencyKey: req.body.idempotencyKey,
          });
        res.status(result.retried ? 200 : 201).json(result);
      } catch (error) {
        canonicalIssueMutationError(error);
      }
    },
  );

  router.post(
    "/issue-creator-form-updates",
    validate(commitIssueCreatorFormSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(req.body.issueId),
        "Issue not found",
      );
      if (!existing) return;

      try {
        const result = await ordinaryIssues.commitCreatorFormUpdate(
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
        await externalObjectsSvc.syncCommentSafely(result.comment.id);
        res.status(201).json(result);
      } catch (error) {
        canonicalIssueMutationError(error);
      }
    },
  );

  router.post(
    "/issue-owner-form-updates",
    validate(commitIssueOwnerFormSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(req.body.issueId),
        "Issue not found",
      );
      if (!existing) return;

      const ownerAuthority =
        existing.creatorKind === "system" &&
        existing.escalatedFromAffectedIssueId &&
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
        const result = await ordinaryIssues.commitOwnerFormUpdate(
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
        await externalObjectsSvc.syncCommentSafely(result.comment.id);
        res.status(201).json(result);
      } catch (error) {
        canonicalIssueMutationError(error);
      }
    },
  );

  router.post("/issues/:id/reopen", validate(reopenIssueSchema), async (req, res) => {
    const actorUserId = requireNamedBoardUser(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req,
      res,
      svc.getById(id),
      "Issue not found",
    );
    if (!existing) return;

    try {
      const result = await ordinaryIssues.boardReopen({
        companyId: existing.companyId,
        issueId: existing.id,
        actorUserId,
        reason: req.body.reason,
        idempotencyKey: req.body.idempotencyKey,
      });
      res.status(result.retried ? 200 : 201).json(result);
    } catch (error) {
      canonicalIssueMutationError(error);
    }
  });
  router.get("/issues/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const query = issueCommentRootPageQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid issue comment page query" });
      return;
    }
    const page = await svc.listBoardCommentGroups(issue.companyId, id, {
      cursor: query.data.cursor ?? null,
      limit: query.data.limit ?? null,
      entryLimit: query.data.entryLimit ?? null,
    });
    res.json(page);
  });

  router.get("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const comment = await svc.getBoardComment(issue.companyId, id, commentId);
    if (!comment) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.get("/issues/:id/comments/:rootCommentId/thread", async (req, res) => {
    const id = req.params.id as string;
    const rootCommentId = req.params.rootCommentId as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const query = issueCommentThreadPageQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid issue comment thread page query" });
      return;
    }
    const page = await svc.getBoardCommentThread(
      issue.companyId,
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

  router.get("/issues/:id/feedback-votes", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback votes" });
      return;
    }

    assertBoard(req);
    const votes = await feedback.listIssueVotesForUser(id, req.actor.userId);
    res.json(votes);
  });

  router.get("/issues/:id/feedback-traces", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }

    const targetTypeRaw = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const voteRaw = typeof req.query.vote === "string" ? req.query.vote : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const targetType = targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined;
    const vote = voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined;
    const status = statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId: issue.companyId,
      issueId: issue.id,
      targetType,
      vote,
      status,
      from: parseDateQuery(req.query.from, "from"),
      to: parseDateQuery(req.query.to, "to"),
      sharedOnly: parseBooleanQuery(req.query.sharedOnly),
      includePayload: parseBooleanQuery(req.query.includePayload),
    });
    res.json(traces);
  });

  router.get("/feedback-traces/:traceId", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }
    const includePayload = parseBooleanQuery(req.query.includePayload) || req.query.includePayload === undefined;
    const trace = await feedback.getFeedbackTraceById(traceId, includePayload);
    if (!trace || !actorCanAccessCompany(req, trace.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(trace);
  });

  router.get("/feedback-traces/:traceId/bundle", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback trace bundles" });
      return;
    }
    const bundle = await feedback.getFeedbackTraceBundle(traceId);
    if (!bundle || !actorCanAccessCompany(req, bundle.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(bundle);
  });

  router.post(
    "/issues/:id/comments",
    validate(createIssueUserCommentSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getById(id),
        "Issue not found",
      );
      if (!existing) return;

      try {
        if (req.body.replyToCommentId) {
          await authorizeHumanIssueSteering(db, req, existing.companyId);
        }
        const result = await ordinaryIssues.userComment({
          companyId: existing.companyId,
          issueId: existing.id,
          actorUserId,
          message: req.body.message,
          idempotencyKey: req.body.idempotencyKey,
          mention: req.body.mention ?? null,
          replyToCommentId: req.body.replyToCommentId ?? null,
        });
        await externalObjectsSvc.syncCommentSafely(result.comment.id);
        const comment = await svc.getBoardComment(
          existing.companyId,
          existing.id,
          result.comment.id,
        );
        if (!comment) {
          throw new OrdinaryIssueRuntimeRejected(
            "Board comment projection is missing after commit",
            "board_comment_projection_missing",
          );
        }
        await publishPluginDomainEvent({
          eventId: comment.id,
          eventType: "issue.comment.created",
          occurredAt: new Date().toISOString(),
          actorId: actorUserId,
          actorType: "user",
          entityId: comment.id,
          entityType: "issue_comment",
          companyId: existing.companyId,
          payload: {
            companyId: existing.companyId,
            issueId: existing.id,
            commentId: comment.id,
          },
        });
        res.status(result.retried ? 200 : 201).json({
          comment,
          retried: result.retried,
        });
      } catch (error) {
        canonicalIssueMutationError(error);
      }
    },
  );
  router.post("/issues/:id/feedback-votes", validate(upsertIssueFeedbackVoteSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can vote on AI feedback" });
      return;
    }

    assertBoard(req);
    const result = await feedback.saveIssueVote({
      issueId: id,
      targetType: req.body.targetType,
      targetId: req.body.targetId,
      vote: req.body.vote,
      reason: req.body.reason,
      authorUserId: req.actor.userId,
      allowSharing: req.body.allowSharing === true,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "issue.feedback_vote_saved",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        targetType: result.vote.targetType,
        targetId: result.vote.targetId,
        vote: result.vote.vote,
        hasReason: Boolean(result.vote.reason),
        sharingEnabled: result.sharingEnabled,
      },
    });

    if (result.consentEnabledNow) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "company.feedback_data_sharing_updated",
        entityType: "company",
        entityId: issue.companyId,
        details: {
          feedbackDataSharingEnabled: true,
          source: "issue_feedback_vote",
        },
      });
    }

    if (result.persistedSharingPreference) {
      const settings = await instanceSettings.get();
      const companyIds = await instanceSettings.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: "user",
            actorId: req.actor.userId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: settings.id,
            details: {
              general: settings.general,
              changedKeys: ["feedbackDataSharingPreference"],
              source: "issue_feedback_vote",
            },
          }),
        ),
      );
    }

    if (result.sharingEnabled && result.traceId && feedbackExportService) {
      try {
        await feedbackExportService.flushPendingFeedbackTraces({
          companyId: issue.companyId,
          traceId: result.traceId,
          limit: 1,
        });
      } catch (err) {
        logger.warn({ err, issueId: issue.id, traceId: result.traceId }, "failed to flush shared feedback trace immediately");
      }
    }

    res.status(201).json(result.vote);
  });

  router.get("/issues/:id/attachments", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(issueId), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const attachments = await svc.listAttachments(issueId);
    res.json(attachments.map(withContentPath));
  });

  router.post("/companies/:companyId/issues/:issueId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.companyId !== companyId) {
      res.status(422).json({ error: "Issue does not belong to company" });
      return;
    }
    if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;

    const company = await companiesSvc.getById(companyId);
    const attachmentMaxBytes = normalizeIssueAttachmentMaxBytes(company?.attachmentMaxBytes);

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

    const parsedMeta = createIssueAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    assertBoard(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      issueId,
      issueCommentId: parsedMeta.data.issueCommentId ?? null,
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
      action: "issue.attachment_added",
      entityType: "issue",
      entityId: issueId,
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
    const issue = await svc.getById(attachment.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertIssueReadAllowed(req, res, issue))) return;

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
    const issue = await svc.getById(attachment.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertBoardIssueMutationAllowed(req, res, issue))) return;

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
      action: "issue.attachment_removed",
      entityType: "issue",
      entityId: removed.issueId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });

  return router;
}
