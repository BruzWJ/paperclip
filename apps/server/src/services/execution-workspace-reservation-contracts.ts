import { createHash } from "node:crypto";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { taskSessionContextEpochs, taskSessions, tasks } from "@paperclipai/db";
import * as TaskSession from "@paperclipai/shared/task-session";
import {
  reserveTaskSessionEventSequence,
  type TaskSessionDbTransaction,
} from "./task-session/event-store.js";
import { publishTaskSessionEventInTx } from "./task-session/publication.js";

export type WorkspaceReservationTask = Pick<
  typeof tasks.$inferSelect,
  | "id"
  | "companyId"
  | "parentId"
  | "projectId"
  | "projectWorkspaceId"
  | "title"
  | "identifier"
  | "ownershipEpoch"
  | "ownerAgentId"
>;

export interface ReserveTaskExecutionWorkspaceBindingInput {
  task: WorkspaceReservationTask;
  session: {
    id: string;
    parentSessionId?: string | null;
    now: Date;
  };
  provenance?: {
    agentId?: string | null;
    userId?: string | null;
  };
}

export class TaskExecutionWorkspaceReservationRejected extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "TaskExecutionWorkspaceReservationRejected";
  }
}

export function rejectWorkspaceReservation(message: string, reason: string): never {
  throw new TaskExecutionWorkspaceReservationRejected(message, reason);
}

export { deterministicUuid as deterministicWorkspaceUuid } from "./deterministic-uuid.js";

export function workspaceReservationDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function absoluteProjectWorkspaceCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  if (!path.isAbsolute(cwd)) {
    rejectWorkspaceReservation(
      "Selected project workspace cwd must be absolute",
      "project_workspace_cwd_invalid",
    );
  }
  return path.resolve(cwd);
}

export async function currentContextGeneration(
  tx: TaskSessionDbTransaction,
  input: { companyId: string; taskId: string; sessionId: string },
): Promise<number> {
  const row = await tx
    .select({ generation: taskSessionContextEpochs.generation })
    .from(taskSessionContextEpochs)
    .where(
      and(
        eq(taskSessionContextEpochs.companyId, input.companyId),
        eq(taskSessionContextEpochs.taskId, input.taskId),
        eq(taskSessionContextEpochs.sessionId, input.sessionId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) {
    rejectWorkspaceReservation("Task Session context epoch is missing", "session_context_epoch_missing");
  }
  return row.generation;
}

export async function resolveReservationParentSession(
  tx: TaskSessionDbTransaction,
  input: ReserveTaskExecutionWorkspaceBindingInput,
): Promise<string | null> {
  if (!input.task.parentId) {
    if (input.session.parentSessionId) {
      rejectWorkspaceReservation("Root task cannot have a parent Session", "parent_session_invalid");
    }
    return null;
  }
  const parent = await tx
    .select({ id: taskSessions.id })
    .from(taskSessions)
    .where(
      and(eq(taskSessions.companyId, input.task.companyId), eq(taskSessions.taskId, input.task.parentId)),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!parent) {
    rejectWorkspaceReservation("Parent task has no canonical Session", "parent_session_missing");
  }
  if (input.session.parentSessionId !== undefined && input.session.parentSessionId !== parent.id) {
    rejectWorkspaceReservation("Parent Session does not match the parent task", "parent_session_mismatch");
  }
  return parent.id;
}

export async function publishSessionMovedForWorkspaceInTx(
  tx: TaskSessionDbTransaction,
  input: ReserveTaskExecutionWorkspaceBindingInput,
  absoluteCwd: string,
): Promise<void> {
  const { seq } = await reserveTaskSessionEventSequence(tx, {
    companyId: input.task.companyId,
    taskId: input.task.id,
    sessionId: input.session.id,
  });
  const sourceKey = ["workspace-binding", input.task.id, input.task.ownershipEpoch, absoluteCwd].join(":");
  const eventId = `evt_${workspaceReservationDigest(sourceKey).slice(0, 40)}`;
  await publishTaskSessionEventInTx(tx, {
    event: {
      id: eventId,
      sessionId: input.session.id,
      seq,
      type: TaskSession.Event.Moved.type,
      data: {
        sessionID: input.session.id,
        timestamp: input.session.now.getTime(),
        location: { directory: absoluteCwd },
      },
    },
    envelope: {
      companyId: input.task.companyId,
      taskId: input.task.id,
      runId: null,
      ownershipEpoch: input.task.ownershipEpoch,
      agentId: input.task.ownerAgentId,
      adapterConfigRevisionId: null,
      sourceKind: "workspace_binding_moved",
      sourceId: eventId,
      immutableSourceKey: sourceKey,
      sourceRecordId: input.task.id,
      sourceIdentityDigest: workspaceReservationDigest(`${sourceKey}:${eventId}`),
      createdAt: input.session.now,
    },
  });
}
