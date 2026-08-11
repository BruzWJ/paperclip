import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companies, tasks } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
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

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveResponsibleUserIdForActivity(db: Db, input: LogActivityInput) {
  if (input.actorType === "user") return readNonEmptyString(input.actorId);

  const taskIdCandidate = readNonEmptyString(input.taskId)
    ?? (input.entityType === "task" ? readNonEmptyString(input.entityId) : null);
  const taskId = isUuidLike(taskIdCandidate) ? taskIdCandidate : null;
  if (taskId) {
    const task = await db
      .select({
        responsibleUserId: tasks.responsibleUserId,
        creatorUserId: tasks.creatorUserId,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, taskId)))
      .then((rows) => rows[0] ?? null);
    const taskResponsibleUserId = readNonEmptyString(task?.responsibleUserId)
      ?? readNonEmptyString(task?.creatorUserId);
    if (taskResponsibleUserId) return taskResponsibleUserId;
  }

  const company = await db
    .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .then((rows) => rows[0] ?? null);
  return readNonEmptyString(company?.defaultResponsibleUserId);
}

export async function logActivity(db: Db, input: LogActivityInput) {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails
    ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
    : null;
  const responsibleUserId = await resolveResponsibleUserIdForActivity(db, input);
  await db.insert(activityLog).values({
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
  });

  publishLiveEvent({
    companyId: input.companyId,
    type: "activity.logged",
    payload: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      responsibleUserId,
      details: redactedDetails,
    },
  });
}
