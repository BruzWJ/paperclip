import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companies, tasks } from "@paperclipai/db";
import {
  isCanonicalUuid,
  type ActivityLoggedLiveEventPayload,
} from "@paperclipai/shared";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { instanceSettingsService } from "./instance-settings.js";

export interface LogActivityInput {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  details?: Record<string, unknown> | null;
}

export interface PersistActivityLogOptions {
  id?: string;
  createdAt?: Date;
}

export interface PersistedActivityLog {
  row: typeof activityLog.$inferSelect;
  taskId: string | null;
}

function readExactNonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readCanonicalUuid(value: unknown) {
  return typeof value === "string" && isCanonicalUuid(value) ? value : null;
}

function resolveCanonicalTaskId(input: LogActivityInput) {
  return (
    readCanonicalUuid(input.taskId) ??
    (input.entityType === "task" ? readCanonicalUuid(input.entityId) : null)
  );
}

function readActivityActorType(
  value: string,
): ActivityLoggedLiveEventPayload["actorType"] {
  if (
    value === "agent" ||
    value === "user" ||
    value === "system" ||
    value === "plugin"
  ) {
    return value;
  }
  throw new Error(`Persisted activity has unsupported actor type: ${value}`);
}

export async function resolveResponsibleUserIdForActivity(
  db: Db,
  input: LogActivityInput,
) {
  if (input.actorType === "user") {
    return readExactNonEmptyString(input.actorId);
  }

  const taskId = resolveCanonicalTaskId(input);
  if (taskId) {
    const task = await db
      .select({
        responsibleUserId: tasks.responsibleUserId,
        creatorUserId: tasks.creatorUserId,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, taskId)))
      .then((rows) => rows[0] ?? null);
    const taskResponsibleUserId =
      readExactNonEmptyString(task?.responsibleUserId) ??
      readExactNonEmptyString(task?.creatorUserId);
    if (taskResponsibleUserId) return taskResponsibleUserId;
  }

  const company = await db
    .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .then((rows) => rows[0] ?? null);
  return readExactNonEmptyString(company?.defaultResponsibleUserId);
}

export async function persistActivityLog(
  db: Db,
  input: LogActivityInput,
  options: PersistActivityLogOptions = {},
): Promise<PersistedActivityLog> {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral())
      .censorUsernameInLogs,
  };
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails
    ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
    : null;
  const responsibleUserId = await resolveResponsibleUserIdForActivity(
    db,
    input,
  );
  const taskId = resolveCanonicalTaskId(input);
  const row = await db
    .insert(activityLog)
    .values({
      ...(options.id ? { id: options.id } : {}),
      companyId: input.companyId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      responsibleUserId,
      details: redactedDetails,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning()
    .then((rows) => rows[0]);
  if (!row) throw new Error("Activity log insert did not return a row");
  return { row, taskId };
}

export function publishCommittedActivity(activity: PersistedActivityLog) {
  const { row, taskId } = activity;
  const payload: ActivityLoggedLiveEventPayload = {
    actorType: readActivityActorType(row.actorType),
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    agentId: row.agentId,
    runId: row.runId,
    taskId,
    responsibleUserId: row.responsibleUserId,
    details: row.details,
  };
  publishLiveEvent({
    companyId: row.companyId,
    type: "activity.logged",
    payload,
  });
}

export async function logActivity(db: Db, input: LogActivityInput) {
  if (!("$client" in db)) {
    throw new Error(
      "logActivity requires a root database; transaction owners must persist and publish after commit",
    );
  }
  const activity = await persistActivityLog(db, input);
  publishCommittedActivity(activity);
  return activity.row;
}
