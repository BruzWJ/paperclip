import { and, asc, eq } from "drizzle-orm";
import { type Db, routineRevisions, routineTriggers } from "@paperclipai/db";
import {
  type RoutineDescriptionDocument,
  type RoutineRevision,
  type RoutineRevisionSnapshotV1,
  type RoutineRunSummary,
  pluginManagedRoutineOriginIdSchema,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import {
  ROUTINE_DESCRIPTION_DOCUMENT_KEY,
  RoutineRow,
  RoutineRunSummaryRow,
  RoutineTriggerRow,
} from "./routine-ownership-and-secrets.js";
import { isPlainRecord } from "./routine-scheduling-and-variables.js";

export function readManagedRoutineTaskTemplate(defaultsJson: Record<string, unknown> | null | undefined) {
  const value = defaultsJson?.taskTemplate;
  if (!isPlainRecord(value)) return null;
  const originId =
    value.originId == null ? null : pluginManagedRoutineOriginIdSchema.safeParse(value.originId);
  if (originId !== null && !originId.success) {
    throw conflict("Managed routine task template originId is not canonical");
  }
  return {
    surfaceVisibility: typeof value.surfaceVisibility === "string" ? value.surfaceVisibility : null,
    originId: originId?.data ?? null,
    billingCode:
      typeof value.billingCode === "string" && value.billingCode.trim() ? value.billingCode.trim() : null,
  };
}

export function routineRevisionSnapshotRoutine(routine: RoutineRow): RoutineRevisionSnapshotV1["routine"] {
  return {
    id: routine.id,
    companyId: routine.companyId,
    projectId: routine.projectId,
    goalId: routine.goalId,
    parentTaskId: routine.parentTaskId,
    title: routine.title,
    description: routine.description,
    assigneeAgentId: routine.assigneeAgentId,
    priority: routine.priority as RoutineRevisionSnapshotV1["routine"]["priority"],
    status: routine.status as RoutineRevisionSnapshotV1["routine"]["status"],
    concurrencyPolicy: routine.concurrencyPolicy as RoutineRevisionSnapshotV1["routine"]["concurrencyPolicy"],
    catchUpPolicy: routine.catchUpPolicy as RoutineRevisionSnapshotV1["routine"]["catchUpPolicy"],
    variables: routine.variables ?? [],
    env: routine.env ?? null,
    responsibleUserId: routine.responsibleUserId ?? null,
  };
}

export function routineRevisionSnapshotTrigger(
  trigger: RoutineTriggerRow,
): RoutineRevisionSnapshotV1["triggers"][number] {
  return {
    id: trigger.id,
    kind: trigger.kind as RoutineRevisionSnapshotV1["triggers"][number]["kind"],
    label: trigger.label,
    enabled: trigger.enabled,
    cronExpression: trigger.cronExpression,
    timezone: trigger.timezone,
    publicId: trigger.publicId,
    signingMode: trigger.signingMode as RoutineRevisionSnapshotV1["triggers"][number]["signingMode"],
    replayWindowSec: trigger.replayWindowSec,
  };
}

export async function buildRoutineRevisionSnapshot(
  executor: Db,
  routine: RoutineRow,
): Promise<RoutineRevisionSnapshotV1> {
  const triggers = await executor
    .select()
    .from(routineTriggers)
    .where(and(eq(routineTriggers.companyId, routine.companyId), eq(routineTriggers.routineId, routine.id)))
    .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id));

  return {
    version: 1,
    routine: routineRevisionSnapshotRoutine(routine),
    triggers: triggers.map(routineRevisionSnapshotTrigger),
  };
}

export function canonicalSnapshot(value: RoutineRevisionSnapshotV1) {
  return JSON.stringify(value);
}

export function snapshotsMatch(left: RoutineRevisionSnapshotV1, right: RoutineRevisionSnapshotV1) {
  return canonicalSnapshot(left) === canonicalSnapshot(right);
}

export function routineCurrentFieldsMatch(left: RoutineRow, right: RoutineRow) {
  return snapshotsMatch(
    { version: 1, routine: routineRevisionSnapshotRoutine(left), triggers: [] },
    {
      version: 1,
      routine: routineRevisionSnapshotRoutine(right),
      triggers: [],
    },
  );
}

export function mapRoutineRevision(row: typeof routineRevisions.$inferSelect): RoutineRevision {
  return {
    ...row,
    snapshot: row.snapshot as RoutineRevisionSnapshotV1,
  };
}

export function mapRoutineDescriptionDocument(row: {
  id: string;
  companyId: string;
  routineId: string;
  key: string;
  title: string | null;
  format: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): RoutineDescriptionDocument {
  return {
    id: row.id,
    companyId: row.companyId,
    routineId: row.routineId,
    key: ROUTINE_DESCRIPTION_DOCUMENT_KEY,
    title: row.title,
    format: "markdown",
    body: row.latestBody,
    latestRevisionId: row.latestRevisionId,
    latestRevisionNumber: row.latestRevisionNumber,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapRoutineRunSummary(row: RoutineRunSummaryRow): RoutineRunSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    routineId: row.routineId,
    triggerId: row.triggerId,
    source: row.source,
    status: row.status,
    triggeredAt: row.triggeredAt,
    idempotencyKey: row.idempotencyKey,
    triggerPayload: row.triggerPayload,
    dispatchFingerprint: row.dispatchFingerprint,
    routineRevisionId: row.routineRevisionId,
    linkedTaskId: row.linkedTaskId,
    coalescedIntoRunId: row.coalescedIntoRunId,
    failureReason: row.failureReason,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    linkedTask:
      row.linkedTaskId && row.taskNumber && row.taskIdentifier
        ? {
            id: row.linkedTaskId,
            taskNumber: row.taskNumber,
            identifier: row.taskIdentifier,
            title: row.taskTitle ?? "Routine execution",
            boardPresentationStatus: row.taskBoardPresentationStatus ?? "todo",
            priority: row.taskPriority ?? "medium",
            updatedAt: row.taskUpdatedAt ?? row.updatedAt,
          }
        : null,
    trigger: row.triggerId
      ? {
          id: row.triggerId,
          kind: row.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
          label: row.triggerLabel,
        }
      : null,
  };
}

export function routineWebhookUrl(runtimeEnv: Record<string, string | undefined>, publicId: string): string {
  const baseUrl = (
    runtimeEnv.PAPERCLIP_PUBLIC_URL?.trim() ||
    runtimeEnv.PAPERCLIP_RUNTIME_API_URL?.trim() ||
    ""
  ).replace(/\/+$/, "");
  if (!baseUrl) {
    throw unprocessable("Routine webhook URLs require PAPERCLIP_PUBLIC_URL or PAPERCLIP_RUNTIME_API_URL");
  }
  return `${baseUrl}/api/routine-triggers/public/${publicId}/fire`;
}
