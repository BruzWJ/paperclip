import { and, asc, eq } from "drizzle-orm";
import {
  companies,
  companyMemberships,
  routineRuns,
  routineTriggers,
  tasks,
  type Db,
  type routines,
} from "@paperclipai/db";
import { type RoutineTriggerSecretMaterial, isCanonicalUuid } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { InvokableTaskOwnerRejected } from "./agent-invokability.js";
import { requireSecretMutationActor, type SecretMutationActor } from "./secrets.js";
import { WEEKDAY_INDEX, assertTimeZone, floorToMinute } from "./routine-schedule-time.js";

export { WEEKDAY_INDEX, assertTimeZone, floorToMinute };

export const MAX_CATCH_UP_RUNS = 25;

export const MAX_ROUTINE_REVISIONS = 100;

export const ACTIVITY_GATE_IGNORED_ACTIONS = [
  "task.read_marked",
  "task.read_unmarked",
  "task.inbox_archived",
  "task.inbox_unarchived",
];

export function routineOwnerConfigurationRejected(
  error: unknown,
  companyId: string,
  assigneeAgentId: string,
): never {
  if (error instanceof InvokableTaskOwnerRejected) {
    throw conflict("Routine assignee must be an invokable task owner", {
      code: "routine_assignee_not_invokable",
      reason: error.reason,
      companyId,
      assigneeAgentId,
      ...error.details,
    });
  }
  throw error;
}

export async function resolveCompanyDefaultResponsibleUserId(db: Db, companyId: string) {
  const company = await db
    .select({
      defaultResponsibleUserId: companies.defaultResponsibleUserId,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (company?.defaultResponsibleUserId) return company.defaultResponsibleUserId;

  const owner = await db
    .select({ userId: companyMemberships.principalUserId })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        eq(companyMemberships.membershipRole, "owner"),
      ),
    )
    .orderBy(asc(companyMemberships.createdAt), asc(companyMemberships.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return owner?.userId ?? null;
}

export async function resolveRoutineResponsibleUserId(
  db: Db,
  companyId: string,
  actorUserId: string | null | undefined,
  parentTaskId?: string | null,
) {
  if (actorUserId) return actorUserId;
  if (parentTaskId) {
    const parent = await db
      .select({
        responsibleUserId: tasks.responsibleUserId,
        creatorUserId: tasks.creatorUserId,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, parentTaskId)))
      .then((rows) => rows[0] ?? null);
    if (parent?.responsibleUserId) return parent.responsibleUserId;
    if (parent?.creatorUserId) return parent.creatorUserId;
  }
  return resolveCompanyDefaultResponsibleUserId(db, companyId);
}

export type RoutineMutationActor =
  | {
      type: "user";
      userId: string;
      agentId?: never;
      runId?: never;
    }
  | {
      type: "agent";
      agentId: string;
      userId?: never;
      runId?: string | null;
    }
  | {
      type: "system";
      agentId?: never;
      userId?: never;
      runId?: never;
    };

export type Actor = RoutineMutationActor;

export type RoutineRow = typeof routines.$inferSelect;

export type RoutineTriggerRow = typeof routineTriggers.$inferSelect;

export type RoutineRunSummaryRow = Omit<typeof routineRuns.$inferSelect, "responsibleUserId"> & {
  triggerKind: RoutineTriggerRow["kind"] | null;
  triggerLabel: RoutineTriggerRow["label"] | null;
  taskNumber: (typeof tasks.$inferSelect)["taskNumber"] | null;
  taskIdentifier: (typeof tasks.$inferSelect)["identifier"] | null;
  taskTitle: (typeof tasks.$inferSelect)["title"] | null;
  taskBoardPresentationStatus: (typeof tasks.$inferSelect)["boardPresentationStatus"] | null;
  taskPriority: (typeof tasks.$inferSelect)["priority"] | null;
  taskUpdatedAt: (typeof tasks.$inferSelect)["updatedAt"] | null;
};

export const routineRunSummarySelection = {
  id: routineRuns.id,
  companyId: routineRuns.companyId,
  routineId: routineRuns.routineId,
  triggerId: routineRuns.triggerId,
  source: routineRuns.source,
  status: routineRuns.status,
  triggeredAt: routineRuns.triggeredAt,
  idempotencyKey: routineRuns.idempotencyKey,
  triggerPayload: routineRuns.triggerPayload,
  dispatchFingerprint: routineRuns.dispatchFingerprint,
  routineRevisionId: routineRuns.routineRevisionId,
  linkedTaskId: routineRuns.linkedTaskId,
  coalescedIntoRunId: routineRuns.coalescedIntoRunId,
  failureReason: routineRuns.failureReason,
  completedAt: routineRuns.completedAt,
  createdAt: routineRuns.createdAt,
  updatedAt: routineRuns.updatedAt,
  triggerKind: routineTriggers.kind,
  triggerLabel: routineTriggers.label,
  taskNumber: tasks.taskNumber,
  taskIdentifier: tasks.identifier,
  taskTitle: tasks.title,
  taskBoardPresentationStatus: tasks.boardPresentationStatus,
  taskPriority: tasks.priority,
  taskUpdatedAt: tasks.updatedAt,
};

export function routineSecretMutationActor(actor: unknown): SecretMutationActor {
  if (typeof actor === "object" && actor !== null && !Array.isArray(actor)) {
    const prototype = Object.getPrototypeOf(actor);
    const keys = Reflect.ownKeys(actor);
    const descriptors = Object.getOwnPropertyDescriptors(actor);
    const typeDescriptor = descriptors.type;
    const type = typeDescriptor && "value" in typeDescriptor ? typeDescriptor.value : undefined;
    if (
      (prototype === Object.prototype || prototype === null) &&
      keys.every((key): key is string => typeof key === "string") &&
      type === "agent" &&
      (keys.length === 2 || keys.length === 3) &&
      keys.includes("type") &&
      keys.includes("agentId") &&
      (keys.length === 2 || keys.includes("runId"))
    ) {
      const agentIdDescriptor = descriptors.agentId;
      const runIdDescriptor = descriptors.runId;
      const agentId = agentIdDescriptor && "value" in agentIdDescriptor ? agentIdDescriptor.value : undefined;
      const runId = runIdDescriptor && "value" in runIdDescriptor ? runIdDescriptor.value : undefined;
      if (
        typeof agentId === "string" &&
        isCanonicalUuid(agentId) &&
        (!keys.includes("runId") || runId === null || (typeof runId === "string" && isCanonicalUuid(runId)))
      ) {
        const candidate = { type: "agent", agentId } as const;
        requireSecretMutationActor(candidate);
        return candidate;
      }
    }
  }
  requireSecretMutationActor(actor);
  return actor as SecretMutationActor;
}

export const ROUTINE_DESCRIPTION_DOCUMENT_KEY = "description" as const;

export interface RoutineTriggerSecretRestoreMaterial extends RoutineTriggerSecretMaterial {
  triggerId: string;
}

export function routineWebhookSecretConfigPath(triggerId: string) {
  return `webhookSecret:${triggerId}`;
}
