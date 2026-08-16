import { taskSessions, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  type NonDispatchControlNotice,
  type NonDispatchUserComment,
  type TaskSessionProjectedCommentAttribution,
  createTaskSessionAdmissionService,
  type TaskSessionAdmissionResult,
} from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import { TaskSessionInvariantError } from "./task-session/store.js";

type SessionReadDb = Pick<Db, "select">;

async function canonicalSessionId(db: SessionReadDb, companyId: string, taskId: string): Promise<string> {
  const rows = await db
    .select({ id: taskSessions.id })
    .from(taskSessions)
    .where(and(eq(taskSessions.companyId, companyId), eq(taskSessions.taskId, taskId)))
    .limit(2);
  if (rows.length !== 1) {
    throw new TaskSessionInvariantError(`Task ${taskId} must resolve to exactly one canonical Session`);
  }
  return rows[0]!.id;
}

export interface CanonicalControlNoticeInput {
  companyId: string;
  taskId: string;
  sourceKind: string;
  immutableSourceKey: string;
  sourceRecordId: string;
  exactText: string;
  comment?: TaskSessionProjectedCommentAttribution;
  allowTerminal?: boolean;
  occurredAt?: Date | string | null;
}

export interface CanonicalUserCommentInput {
  companyId: string;
  taskId: string;
  sourceKind: string;
  immutableSourceKey: string;
  sourceRecordId: string;
  exactText: string;
  userId: string;
  occurredAt?: Date | string | null;
}

function canonicalClock(value: Date | string | null | undefined) {
  if (value == null) return undefined;
  const occurredAt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new TaskSessionInvariantError("Canonical task Session source timestamp is invalid");
  }
  return () => occurredAt;
}

/**
 * Canonical producer for non-dispatch server notices. The caller supplies
 * the immutable causal identity; this function only resolves the one Session
 * owned by the task and delegates the event/projection transaction.
 */
export async function appendCanonicalControlNotice(
  db: Db,
  input: CanonicalControlNoticeInput,
  transaction?: TaskSessionDbTransaction,
): Promise<TaskSessionAdmissionResult> {
  const readDb = transaction ?? db;
  const sessionId = await canonicalSessionId(readDb, input.companyId, input.taskId);
  const notice: NonDispatchControlNotice = {
    companyId: input.companyId,
    taskId: input.taskId,
    sessionId,
    sourceKind: input.sourceKind,
    immutableSourceKey: input.immutableSourceKey,
    sourceRecordId: input.sourceRecordId,
    exactText: input.exactText,
    comment: input.comment ? { ...input.comment, body: input.exactText } : null,
    allowTerminal: input.allowTerminal,
  };
  return createTaskSessionAdmissionService(db, {
    clock: canonicalClock(input.occurredAt),
  }).appendNonDispatchControlNotice(notice, transaction);
}

/**
 * Canonical non-dispatch human/board comment path. Agent/provider output is
 * deliberately not accepted here: it belongs to the run translator, while a
 * human @mention that invokes the current owner belongs to dispatching-user
 * admission.
 */
export async function appendCanonicalUserComment(
  db: Db,
  input: CanonicalUserCommentInput,
  transaction?: TaskSessionDbTransaction,
): Promise<TaskSessionAdmissionResult> {
  const readDb = transaction ?? db;
  const sessionId = await canonicalSessionId(readDb, input.companyId, input.taskId);
  const comment: NonDispatchUserComment = {
    companyId: input.companyId,
    taskId: input.taskId,
    sessionId,
    sourceKind: input.sourceKind,
    immutableSourceKey: input.immutableSourceKey,
    sourceRecordId: input.sourceRecordId,
    exactText: input.exactText,
    comment: {
      author: { kind: "user", userId: input.userId },
      producingRun: null,
      body: input.exactText,
    },
  };
  return createTaskSessionAdmissionService(db, {
    clock: canonicalClock(input.occurredAt),
  }).appendNonDispatchUserComment(comment, transaction);
}
