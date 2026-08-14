import {
  canonicalUuidSchema,
  type CompanySearchExtractQuery,
  type CompanySearchExtractResponse,
  type CompanySearchQuery,
  type CompanySearchResponse,
  type TaskBlockerDiagnosticFlag,
  type TaskBlockerDiagnosticNode,
  type TaskBlockerDiagnosticTaskSummary,
  type TaskBlockerDiagnosticsReadiness,
  type TaskBlockerDiagnosticsResponse,
} from "@paperclipai/shared";
import { z } from "zod";
import { GENERIC_ATTACHMENT_CONTENT_TYPES, normalizeContentType } from "../attachment-types.js";
import { normalizeTaskExecutionPolicy } from "../services/task-execution-policy.js";
import { TASK_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS } from "../services/tasks.js";

export const MAX_TASK_COMMENT_LIMIT = 500;
export const taskCommentRootPageQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .refine((value) => value.trim() === value)
      .optional(),
    limit: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().max(MAX_TASK_COMMENT_LIMIT))
      .optional(),
    entryLimit: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().max(MAX_TASK_COMMENT_LIMIT))
      .optional(),
  })
  .strict();
export const taskCommentThreadPageQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .refine((value) => value.trim() === value)
      .optional(),
    limit: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().max(MAX_TASK_COMMENT_LIMIT))
      .optional(),
  })
  .strict();
export const inboxArchiveBodySchema = z.object({}).strict().default({});
export const promoteLowTrustOutputSchema = z.object({
  sourceArtifactKind: z.enum(["comment", "document", "work_product", "task"]),
  sourceArtifactId: canonicalUuidSchema,
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(8_000),
});

export type NormalizedExecutionPolicy = NonNullable<ReturnType<typeof normalizeTaskExecutionPolicy>>;
export type CompanySearchService = {
  extract(companyId: string, query: CompanySearchExtractQuery): Promise<CompanySearchExtractResponse>;
  search(companyId: string, query: CompanySearchQuery): Promise<CompanySearchResponse>;
};
export type ActivityTaskRelationSummary = {
  id: string;
  taskNumber: number;
  identifier: string;
  title: string | null;
};
export type ActivityExecutionParticipant = Pick<
  NormalizedExecutionPolicy["stages"][number]["participants"][number],
  "type" | "agentId" | "userId"
>;
export function buildAttachmentContentPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/content`;
}

export const GENERIC_RESPONSE_ATTACHMENT_CONTENT_TYPES = new Set(GENERIC_ATTACHMENT_CONTENT_TYPES);

export function inferVideoContentTypeFromFilename(filename: string | null | undefined): string | null {
  const lower = (filename ?? "").toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov") || lower.endsWith(".qt") || lower.endsWith(".quicktime"))
    return "video/quicktime";
  return null;
}

export function resolveAttachmentResponseContentType(input: {
  storedContentType: string | null | undefined;
  objectContentType?: string | null;
  originalFilename?: string | null;
}) {
  const storedContentType = normalizeContentType(input.storedContentType || input.objectContentType);
  if (!GENERIC_RESPONSE_ATTACHMENT_CONTENT_TYPES.has(storedContentType)) return storedContentType;
  return inferVideoContentTypeFromFilename(input.originalFilename) ?? storedContentType;
}

export function requiresPaperclipAttachmentMetadata(
  input: {
    type?: unknown;
    provider?: unknown;
  },
  fallback?: {
    type?: string | null;
    provider?: string | null;
  },
) {
  const type = typeof input.type === "string" ? input.type : (fallback?.type ?? null);
  const provider = typeof input.provider === "string" ? input.provider : (fallback?.provider ?? null);
  return type === "artifact" && provider === "paperclip";
}

export const attachmentArtifactMetadataInputSchema = z
  .object({
    attachmentId: canonicalUuidSchema,
  })
  .passthrough();

export type TaskBlockerDiagnosticReadableTask = {
  id: string;
  taskNumber: number;
  identifier: string;
  title: string | null;
  boardPresentationStatus: string;
  priority: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
};

export type TaskBlockerDiagnosticAuthzTask = TaskBlockerDiagnosticReadableTask & {
  companyId: string;
  projectId: string | null;
  parentId: string | null;
};

export function toTaskBlockerDiagnosticSummary(
  task: TaskBlockerDiagnosticReadableTask,
): TaskBlockerDiagnosticTaskSummary {
  return {
    id: task.id,
    taskNumber: task.taskNumber,
    identifier: task.identifier,
    title: task.title,
    boardPresentationStatus:
      task.boardPresentationStatus as TaskBlockerDiagnosticTaskSummary["boardPresentationStatus"],
    priority: task.priority as TaskBlockerDiagnosticTaskSummary["priority"],
    ownerAgentId: task.ownerAgentId,
    ownerUserId: task.ownerUserId,
  };
}

export function blockerDiagnosticLabel(task: TaskBlockerDiagnosticTaskSummary) {
  return task.title ?? task.identifier;
}

export function buildTaskBlockerDiagnosticsResponse(input: {
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
    if (task.boardPresentationStatus === "blocked" && blocker.boardPresentationStatus === "done")
      flags.push("done_but_blocking");
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
  const reportedOmittedUnauthorizedBlockerCount = input.truncated ? null : omittedUnauthorizedBlockerCount;

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

export function buildTaskBlockerDiagnosis(input: {
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

  const cancelled = input.blockers.find((blocker) => blocker.boardPresentationStatus === "cancelled");
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

  if (input.readiness?.isDependencyReady && input.task.boardPresentationStatus === "blocked") {
    return `All blockers for ${blockerDiagnosticLabel(
      input.task,
    )} are resolved, but the task is still blocked; this is likely a stale blocker hold.`;
  }
  if (input.readiness?.isDependencyReady) {
    return `All blockers for ${blockerDiagnosticLabel(input.task)} are resolved.`;
  }

  return null;
}

export function dateToIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
