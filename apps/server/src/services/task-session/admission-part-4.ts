import {
  companies,
  executionWorkspaces,
  taskComments,
  taskExecutionAuthorities,
  taskExecutionHistoryViews,
  taskExecutionRefs,
  taskExecutionWorkspaceBindings,
  taskSessionEvents,
  taskSessionInputs,
  taskSessions,
  tasks,
} from "@paperclipai/db";
import { encodeTaskSessionEvent, type TaskSessionEventType } from "@paperclipai/shared/task-session";
import { and, eq, sql } from "drizzle-orm";
import type * as admissionCore from "./admission-part-1.js";
import { decodeStoredTaskSessionEvent, type TaskSessionDbTransaction } from "./event-store.js";
import {
  TaskSessionInvariantError,
  TaskSessionLifecycleConflict,
  type TaskSessionSourceClaim,
} from "./store.js";
export function messageIdFromEvent(event: admissionCore.EventRow): string | null {
  const decoded = decodeStoredTaskSessionEvent(event).event;
  const wire = encodeTaskSessionEvent(decoded);
  const messageId = (wire.data as { messageID?: unknown }).messageID;
  return typeof messageId === "string" ? messageId : null;
}

export function sourceClaim(
  event: admissionCore.EventRow,
  ref: admissionCore.RefRow | null,
  inbox: admissionCore.InputRow | null,
  view: admissionCore.ViewRow | null,
  comment: admissionCore.CommentRow | null,
): TaskSessionSourceClaim {
  if (!event.sourceKind || !event.sourceId || !event.immutableSourceKey || !event.sourceIdentityDigest) {
    throw new TaskSessionInvariantError(`Event ${event.id} is missing its canonical source envelope`);
  }
  const messageId = messageIdFromEvent(event);
  if (!messageId) {
    throw new TaskSessionInvariantError(`Event ${event.id} is missing its Task Session message identity`);
  }
  return {
    key: `${event.sessionId}\0${event.sourceKind}\0${event.immutableSourceKey}`,
    companyId: event.companyId,
    taskId: event.taskId,
    sessionId: event.sessionId,
    sourceKind: event.sourceKind,
    immutableSourceKey: event.immutableSourceKey,
    identityDigest: event.sourceIdentityDigest,
    sourceId: event.sourceId,
    eventId: event.id,
    messageId,
    inputId: inbox?.id ?? null,
    refId: ref?.id ?? null,
    historyViewId: view?.id ?? null,
    commentId: comment?.id ?? null,
  };
}
export async function loadResult(
  transaction: TaskSessionDbTransaction,
  event: admissionCore.EventRow,
  retried: boolean,
): Promise<admissionCore.TaskSessionAdmissionResult> {
  const messageId = messageIdFromEvent(event);
  const [refs, inputs, comments] = await Promise.all([
    event.sourceId
      ? transaction
          .select()
          .from(taskExecutionRefs)
          .where(
            and(
              eq(taskExecutionRefs.sessionId, event.sessionId),
              eq(taskExecutionRefs.sourceId, event.sourceId),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
    messageId
      ? transaction
          .select()
          .from(taskSessionInputs)
          .where(and(eq(taskSessionInputs.sessionId, event.sessionId), eq(taskSessionInputs.id, messageId)))
          .limit(1)
      : Promise.resolve([]),
    event.sourceId
      ? transaction
          .select()
          .from(taskComments)
          .where(
            and(
              eq(taskComments.sessionId, event.sessionId),
              eq(taskComments.canonicalSourceId, event.sourceId),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);
  const ref = refs[0] ?? null;
  const views = ref
    ? await transaction
        .select()
        .from(taskExecutionHistoryViews)
        .where(eq(taskExecutionHistoryViews.id, ref.historyViewId))
        .limit(1)
    : [];
  const view = views[0] ?? null;
  const inbox = inputs[0] ?? null;
  const comment = comments[0] ?? null;
  return {
    source: sourceClaim(event, ref, inbox, view, comment),
    ref,
    input: inbox,
    view,
    comment,
    event,
    eventSeq: event.seq,
    retried,
  };
}

export async function findRetry(
  transaction: TaskSessionDbTransaction,
  input: {
    sessionId: string;
    sourceKind: string;
    immutableSourceKey: string;
    sourceRecordId: string;
  },
  identityDigest: string,
  expectedType: TaskSessionEventType,
): Promise<admissionCore.TaskSessionAdmissionResult | null> {
  const rows = await transaction
    .select()
    .from(taskSessionEvents)
    .where(
      and(
        eq(taskSessionEvents.sessionId, input.sessionId),
        eq(taskSessionEvents.sourceKind, input.sourceKind),
        eq(taskSessionEvents.immutableSourceKey, input.immutableSourceKey),
      ),
    )
    .limit(1);
  const event = rows[0];
  if (!event) return null;
  if (
    event.sourceIdentityDigest !== identityDigest ||
    event.sourceRecordId !== input.sourceRecordId ||
    decodeStoredTaskSessionEvent(event).event.type !== expectedType
  ) {
    throw new TaskSessionLifecycleConflict(
      "Canonical Session source identity was retried with different immutable bytes",
      {
        sessionId: input.sessionId,
        sourceKind: input.sourceKind,
        immutableSourceKey: input.immutableSourceKey,
      },
    );
  }
  return loadResult(transaction, event, true);
}

export async function lockCanonicalScope(
  transaction: TaskSessionDbTransaction,
  input: {
    companyId: string;
    taskId: string;
    sessionId: string;
  },
): Promise<void> {
  await lockCompanyLifecycle(transaction, input.companyId);
  await transaction.execute(sql`
    SELECT id
    FROM tasks
    WHERE company_id = ${input.companyId}
      AND id = ${input.taskId}
    FOR UPDATE
  `);
  await transaction.execute(sql`
    SELECT id
    FROM task_sessions
    WHERE company_id = ${input.companyId}
      AND task_id = ${input.taskId}
      AND id = ${input.sessionId}
    FOR UPDATE
  `);
}

export async function lockCompanyLifecycle(
  transaction: TaskSessionDbTransaction,
  companyId: string,
): Promise<void> {
  const rows = await transaction
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
    .for("update");
  if (!rows[0]) {
    throw new TaskSessionLifecycleConflict("Task Session company scope does not exist", { companyId });
  }
}

export async function assertCanonicalScope(
  transaction: TaskSessionDbTransaction,
  input: {
    companyId: string;
    taskId: string;
    sessionId: string;
  },
  options: {
    allowTerminal: boolean;
    dispatching: boolean;
  },
): Promise<{
  task: typeof tasks.$inferSelect;
  session: typeof taskSessions.$inferSelect;
}> {
  await lockCanonicalScope(transaction, input);
  const [companyRows, taskRows, sessionRows] = await Promise.all([
    transaction.select().from(companies).where(eq(companies.id, input.companyId)).limit(1),
    transaction
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, input.taskId)))
      .limit(1),
    transaction
      .select()
      .from(taskSessions)
      .where(
        and(
          eq(taskSessions.companyId, input.companyId),
          eq(taskSessions.taskId, input.taskId),
          eq(taskSessions.id, input.sessionId),
        ),
      )
      .limit(1),
  ]);
  const company = companyRows[0];
  const task = taskRows[0];
  const session = sessionRows[0];
  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null
  ) {
    throw new TaskSessionLifecycleConflict("Company is not ready for canonical Session admission", {
      companyId: input.companyId,
    });
  }
  if (!task || task.hiddenAt !== null) {
    throw new TaskSessionLifecycleConflict("Task Session scope is invalid", {
      ...input,
    });
  }
  const terminal = task.lifecycleStatus === "done" || task.lifecycleStatus === "cancelled";
  if (
    task.lifecycleStatus === null ||
    (!options.allowTerminal && !inArrayValue(task.lifecycleStatus, ["open", "blocked"])) ||
    (options.dispatching && terminal)
  ) {
    throw new TaskSessionLifecycleConflict("Task lifecycle does not accept this Session source", {
      taskId: input.taskId,
      lifecycleStatus: task.lifecycleStatus,
    });
  }
  if (
    !session ||
    session.integrityState !== "ready" ||
    session.refAdmittableAt === null ||
    session.timeArchived !== null ||
    session.purgeFencedAt !== null
  ) {
    throw new TaskSessionLifecycleConflict("Canonical Session is missing, not ready, or lifecycle-fenced", {
      ...input,
    });
  }
  return { task, session };
}

export function inArrayValue<T>(value: T, values: readonly T[]): boolean {
  return values.includes(value);
}

export async function assertWorkspaceBinding(
  transaction: TaskSessionDbTransaction,
  input: admissionCore.DispatchExecutionScope,
): Promise<void> {
  const rows = await transaction
    .select({
      binding: taskExecutionWorkspaceBindings,
      workspace: executionWorkspaces,
    })
    .from(taskExecutionWorkspaceBindings)
    .innerJoin(
      executionWorkspaces,
      and(
        eq(executionWorkspaces.id, taskExecutionWorkspaceBindings.executionWorkspaceId),
        eq(executionWorkspaces.companyId, taskExecutionWorkspaceBindings.companyId),
      ),
    )
    .where(
      and(
        eq(taskExecutionWorkspaceBindings.companyId, input.companyId),
        eq(taskExecutionWorkspaceBindings.taskId, input.taskId),
        eq(taskExecutionWorkspaceBindings.sessionId, input.sessionId),
        eq(taskExecutionWorkspaceBindings.ownershipEpoch, input.ownershipEpoch),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.binding.absoluteCwd.startsWith("/")) {
    throw new TaskSessionLifecycleConflict("Task execution has no current immutable workspace binding", {
      taskId: input.taskId,
      ownershipEpoch: input.ownershipEpoch,
    });
  }
}

export async function assertCounterpart(
  transaction: TaskSessionDbTransaction,
  input: Pick<
    admissionCore.DispatchExecutionScope,
    "companyId" | "taskId" | "counterpartTaskId" | "counterpartAuthorityId" | "counterpartOwnershipEpoch"
  >,
): Promise<void> {
  const counterpart = [
    input.counterpartTaskId ?? null,
    input.counterpartAuthorityId ?? null,
    input.counterpartOwnershipEpoch ?? null,
  ];
  const present = counterpart.filter((value) => value !== null).length;
  if (present !== 0 && present !== 3) {
    throw new TaskSessionLifecycleConflict(
      "Counterpart authority identity must be all present or all absent",
      { taskId: input.taskId },
    );
  }
  if (present === 0) return;
  const rows = await transaction
    .select()
    .from(taskExecutionAuthorities)
    .where(
      and(
        eq(taskExecutionAuthorities.companyId, input.companyId),
        eq(taskExecutionAuthorities.taskId, input.counterpartTaskId!),
        eq(taskExecutionAuthorities.ownershipEpoch, input.counterpartOwnershipEpoch!),
        eq(taskExecutionAuthorities.id, input.counterpartAuthorityId!),
        eq(taskExecutionAuthorities.state, "current"),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new TaskSessionLifecycleConflict("Counterpart authority is missing, revoked, or superseded", {
      counterpartAuthorityId: input.counterpartAuthorityId,
    });
  }
}
