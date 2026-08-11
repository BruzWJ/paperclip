import { createHash } from "node:crypto";
import {
  agentAdapterConfigRevisions,
  agents,
  companies,
  executionWorkspaces,
  taskCommentProjectionSources,
  taskComments,
  taskConsultExecutions,
  taskExecutionAuthorities,
  taskExecutionHistoryViewMessages,
  taskExecutionHistoryViews,
  taskExecutionRefs,
  taskExecutionRunRefs,
  taskExecutionWorkspaceBindings,
  tasks,
  taskSessionEvents,
  taskSessionContextEpochs,
  taskSessionEventSequences,
  taskSessionInputDispositions,
  taskSessionInputs,
  taskSessions,
  type Db,
} from "@paperclipai/db";
import * as TaskSession from "@paperclipai/shared/task-session";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { evaluateAgentInvokability } from "../agent-invokability.js";
import type { TaskSessionCommentProjectionInput } from "./projector.js";
import {
  decodeStoredTaskSessionEvent,
  reserveTaskSessionEventSequence,
  type TaskSessionDbTransaction,
} from "./event-store.js";
import { publishTaskSessionEventInTx } from "./publication.js";
import {
  canonicalTaskSessionJson,
  TaskSessionInvariantError,
  TaskSessionLifecycleConflict,
} from "./store.js";
import {
  lockActiveTaskExecutionRunsForRefInTransaction,
  readTaskExecutionRun,
  readOccupiedTaskExecutionRefIds,
} from "../task-execution-run-service.js";

export interface TaskSessionInputScope {
  companyId: string;
  taskId: string;
  sessionId: string;
  activeRefId: string;
  runId: string;
  ownershipEpoch: number;
  executionLineageId: string;
  adapterConfigRevisionId: string;
  historyViewId: string;
  contextGeneration: number;
}

export interface TaskSessionPreparedInputScope {
  companyId: string;
  taskId: string;
  sessionId: string;
  refId: string;
  ownershipEpoch: number;
  executionLineageId: string;
  adapterConfigRevisionId: string;
  historyViewId: string;
  contextGeneration: number;
}

export interface TaskSessionPendingState {
  steer: boolean;
  queue: boolean;
}

export type TaskSessionInputRecord = typeof taskSessionInputs.$inferSelect;

export interface TaskSessionInputService {
  /**
   * Promotes the held source of one freshly prepared ref before it can be
   * leased. Returns false when the locked ref needs no promotion.
   */
  promotePreparedInput(
    scope: TaskSessionPreparedInputScope,
  ): Promise<boolean>;
  /**
   * Captures the canonical event boundary for a completed provider turn.
   * Inputs admitted after this value must not be promoted at that boundary.
   */
  latestSequence(scope: TaskSessionInputScope): Promise<number>;
  hasPending(scope: TaskSessionInputScope): Promise<TaskSessionPendingState>;
  promoteSteers(
    scope: TaskSessionInputScope,
    cutoffSeq: number,
  ): Promise<TaskSessionInputRecord[]>;
  /**
   * Promotes one FIFO queue input only when no eligible steer is pending.
   * Returning null never licenses an empty provider turn.
   */
  promoteNextQueued(
    scope: TaskSessionInputScope,
  ): Promise<TaskSessionInputRecord | null>;
}

type RefRow = typeof taskExecutionRefs.$inferSelect;
type ViewRow = typeof taskExecutionHistoryViews.$inferSelect;
type DispositionRow = typeof taskSessionInputDispositions.$inferSelect;

interface ActiveExecution {
  ref: RefRow;
  view: ViewRow;
  runId: string | null;
}

interface PendingCandidate {
  inbox: TaskSessionInputRecord;
  disposition: DispositionRow;
  ref: RefRow;
  view: ViewRow;
}

interface ValidatedExecutionScope
  extends Omit<TaskSessionInputScope, "runId"> {
  runId: string | null;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalTaskSessionJson(value))
    .digest("hex");
}

function deterministicUuid(namespace: string, key: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${namespace}\0${key}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sameNullableValue(
  left: string | number | null,
  right: string | number | null,
): boolean {
  return left === right;
}

async function validateActiveExecution(
  transaction: TaskSessionDbTransaction,
  scope: ValidatedExecutionScope,
): Promise<ActiveExecution> {
  await transaction.execute(sql`
    SELECT id
    FROM companies
    WHERE id = ${scope.companyId}
    FOR UPDATE
  `);
  const refs = await transaction
    .select()
    .from(taskExecutionRefs)
    .where(eq(taskExecutionRefs.id, scope.activeRefId))
    .limit(1)
    .for("update");
  const ref = refs[0];
  if (
    !ref ||
    ref.companyId !== scope.companyId ||
    ref.taskId !== scope.taskId ||
    ref.sessionId !== scope.sessionId ||
    ref.ownershipEpoch !== scope.ownershipEpoch ||
    ref.executionLineageId !== scope.executionLineageId ||
    ref.adapterConfigRevisionId !== scope.adapterConfigRevisionId ||
    ref.historyViewId !== scope.historyViewId ||
    ref.contextEpoch !== scope.contextGeneration ||
    ref.disposition !== "active"
  ) {
    throw new TaskSessionLifecycleConflict(
      "Task Session input processing requires its exact eligible execution ref",
      { refId: scope.activeRefId, runId: scope.runId },
    );
  }

  const activeMembershipRows =
    await lockActiveTaskExecutionRunsForRefInTransaction(transaction, {
      companyId: scope.companyId,
      taskId: scope.taskId,
      sessionId: scope.sessionId,
      refId: scope.activeRefId,
    });
  const activeMembership = activeMembershipRows[0] ?? null;
  if (
    activeMembershipRows.length > 1 ||
    (scope.runId === null
      ? activeMembership !== null && ref.promotedSeq === null
      : !activeMembership ||
        activeMembership.runId !== scope.runId ||
        activeMembership.status !== "running" ||
        activeMembership.currentAttemptId === null ||
        activeMembership.currentLeaseId === null)
  ) {
    throw new TaskSessionLifecycleConflict(
      "Task Session input processing requires its exact canonical run membership",
      { refId: scope.activeRefId, runId: scope.runId },
    );
  }

  const [
    companyRows,
    taskRows,
    sessionRows,
    viewRows,
    runRows,
    contextRows,
    revisionRows,
    companyAgentRows,
    workspaceRows,
  ] = await Promise.all([
    transaction
      .select()
      .from(companies)
      .where(eq(companies.id, scope.companyId))
      .limit(1),
    transaction
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, scope.companyId),
          eq(tasks.id, scope.taskId),
        ),
      )
      .limit(1),
    transaction
      .select()
      .from(taskSessions)
      .where(
        and(
          eq(taskSessions.companyId, scope.companyId),
          eq(taskSessions.taskId, scope.taskId),
          eq(taskSessions.id, scope.sessionId),
        ),
      )
      .limit(1),
    transaction
      .select()
      .from(taskExecutionHistoryViews)
      .where(eq(taskExecutionHistoryViews.id, scope.historyViewId))
      .limit(1),
    scope.runId === null
      ? Promise.resolve([])
      : readTaskExecutionRun(transaction, {
          companyId: scope.companyId,
          taskId: scope.taskId,
          runId: scope.runId,
        }).then((run) => (run ? [run] : [])),
    transaction
      .select()
      .from(taskSessionContextEpochs)
      .where(eq(taskSessionContextEpochs.sessionId, scope.sessionId))
      .limit(1),
    transaction
      .select()
      .from(agentAdapterConfigRevisions)
      .where(
        and(
          eq(agentAdapterConfigRevisions.companyId, scope.companyId),
          eq(agentAdapterConfigRevisions.agentId, ref.targetAgentId),
          eq(
            agentAdapterConfigRevisions.id,
            scope.adapterConfigRevisionId,
          ),
        ),
      )
      .limit(1),
    transaction
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        reportsTo: agents.reportsTo,
        status: agents.status,
        currentAdapterConfigRevisionId:
          agents.currentAdapterConfigRevisionId,
      })
      .from(agents)
      .where(eq(agents.companyId, scope.companyId)),
    transaction
      .select({
        binding: taskExecutionWorkspaceBindings,
        workspace: executionWorkspaces,
      })
      .from(taskExecutionWorkspaceBindings)
      .innerJoin(
        executionWorkspaces,
        and(
          eq(
            executionWorkspaces.id,
            taskExecutionWorkspaceBindings.executionWorkspaceId,
          ),
          eq(
            executionWorkspaces.companyId,
            taskExecutionWorkspaceBindings.companyId,
          ),
        ),
      )
      .where(
        and(
          eq(taskExecutionWorkspaceBindings.companyId, scope.companyId),
          eq(taskExecutionWorkspaceBindings.taskId, scope.taskId),
          eq(taskExecutionWorkspaceBindings.sessionId, scope.sessionId),
          eq(
            taskExecutionWorkspaceBindings.ownershipEpoch,
            scope.ownershipEpoch,
          ),
        ),
      )
      .limit(1),
  ]);
  const company = companyRows[0];
  const task = taskRows[0];
  const session = sessionRows[0];
  const view = viewRows[0];
  const run = runRows[0];
  const context = contextRows[0];
  const revision = revisionRows[0];
  const target = companyAgentRows.find((agent) => agent.id === ref.targetAgentId);
  const invokability = evaluateAgentInvokability(target, companyAgentRows);
  const workspace = workspaceRows[0];
  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null ||
    !task ||
    task.hiddenAt !== null ||
    (task.lifecycleStatus !== "open" &&
      task.lifecycleStatus !== "blocked") ||
    task.ownershipEpoch !== scope.ownershipEpoch ||
    !session ||
    session.integrityState !== "ready" ||
    session.refAdmittableAt === null ||
    session.timeArchived !== null ||
    session.purgeFencedAt !== null ||
    !view ||
    view.companyId !== scope.companyId ||
    view.taskId !== scope.taskId ||
    view.sessionId !== scope.sessionId ||
    view.refId !== ref.id ||
    view.executionLineageId !== scope.executionLineageId ||
    view.contextEpoch !== scope.contextGeneration ||
    view.sourceHighWaterSeq !== ref.admissionHighWaterSeq ||
    !["empty", "current"].includes(view.state) ||
    (scope.runId !== null &&
      (!run ||
        run.companyId !== scope.companyId ||
        run.targetAgentId !== ref.targetAgentId ||
        run.kind !== "productive" ||
        run.status !== "running")) ||
    !context ||
    context.companyId !== scope.companyId ||
    context.taskId !== scope.taskId ||
    context.generation !== scope.contextGeneration ||
    !revision ||
    !invokability.invokable ||
    !workspace ||
    !workspace.binding.absoluteCwd.startsWith("/")
  ) {
    throw new TaskSessionLifecycleConflict(
      "Task Session input processing lost its live company, task, session, view, run, revision, workspace, or context scope",
      { refId: scope.activeRefId, runId: scope.runId },
    );
  }

  if (ref.mode === "owner") {
    if (
      ref.taskExecutionAuthorityId === null ||
      ref.consultExecutionId !== null ||
      task.ownerKind !== "agent" ||
      task.ownerAgentId !== ref.targetAgentId
    ) {
      throw new TaskSessionLifecycleConflict(
        "Task Session owner input scope no longer matches the current owner",
        { refId: ref.id },
      );
    }
    const authorities = await transaction
      .select({ id: taskExecutionAuthorities.id })
      .from(taskExecutionAuthorities)
      .where(
        and(
          eq(taskExecutionAuthorities.companyId, scope.companyId),
          eq(taskExecutionAuthorities.taskId, scope.taskId),
          eq(taskExecutionAuthorities.sessionId, scope.sessionId),
          eq(
            taskExecutionAuthorities.ownershipEpoch,
            scope.ownershipEpoch,
          ),
          eq(taskExecutionAuthorities.agentId, ref.targetAgentId),
          eq(
            taskExecutionAuthorities.id,
            ref.taskExecutionAuthorityId,
          ),
          eq(taskExecutionAuthorities.state, "current"),
        ),
      )
      .limit(1);
    if (!authorities[0]) {
      throw new TaskSessionLifecycleConflict(
        "Task Session input owner authority is revoked or stale",
        { refId: ref.id },
      );
    }
  } else if (ref.mode === "consult") {
    if (
      ref.taskExecutionAuthorityId !== null ||
      ref.consultExecutionId === null ||
      ref.consultCallerRefId === null ||
      ref.consultChainToken === null
    ) {
      throw new TaskSessionLifecycleConflict(
        "Task Session consult input scope is incomplete",
        { refId: ref.id },
      );
    }
    const consults = await transaction
      .select({ id: taskConsultExecutions.id })
      .from(taskConsultExecutions)
      .where(
        and(
          eq(taskConsultExecutions.companyId, scope.companyId),
          eq(taskConsultExecutions.taskId, scope.taskId),
          eq(taskConsultExecutions.sessionId, scope.sessionId),
          eq(taskConsultExecutions.id, ref.consultExecutionId),
          eq(
            taskConsultExecutions.ownershipEpoch,
            scope.ownershipEpoch,
          ),
          eq(taskConsultExecutions.targetAgentId, ref.targetAgentId),
          eq(
            taskConsultExecutions.adapterConfigRevisionId,
            scope.adapterConfigRevisionId,
          ),
          eq(
            taskConsultExecutions.sourceRefId,
            ref.consultCallerRefId,
          ),
          eq(taskConsultExecutions.chainToken, ref.consultChainToken),
          eq(taskConsultExecutions.state, "active"),
        ),
      )
      .limit(1);
    if (!consults[0]) {
      throw new TaskSessionLifecycleConflict(
        "Task Session consult input binding is closed or stale",
        { refId: ref.id },
      );
    }
  } else {
    throw new TaskSessionLifecycleConflict(
      "Task Session input execution mode is invalid",
      { refId: ref.id, mode: ref.mode },
    );
  }

  return { ref, view, runId: scope.runId };
}

function sameOwnerCarryLineage(
  active: ActiveExecution,
  candidate: PendingCandidate,
): boolean {
  const { ref: activeRef, view: activeView } = active;
  const { ref, view } = candidate;
  return (
    activeRef.mode === "owner" &&
    ref.mode === "owner" &&
    activeRef.taskExecutionAuthorityId !== null &&
    activeRef.taskExecutionAuthorityId === ref.taskExecutionAuthorityId &&
    activeRef.companyId === ref.companyId &&
    activeRef.taskId === ref.taskId &&
    activeRef.sessionId === ref.sessionId &&
    activeRef.ownershipEpoch === ref.ownershipEpoch &&
    activeRef.targetAgentId === ref.targetAgentId &&
    activeRef.adapterConfigRevisionId === ref.adapterConfigRevisionId &&
    activeRef.contextEpoch === ref.contextEpoch &&
    activeRef.executionLineageId === ref.executionLineageId &&
    sameNullableValue(
      activeRef.counterpartTaskId,
      ref.counterpartTaskId,
    ) &&
    sameNullableValue(
      activeRef.counterpartAuthorityId,
      ref.counterpartAuthorityId,
    ) &&
    sameNullableValue(
      activeRef.counterpartOwnershipEpoch,
      ref.counterpartOwnershipEpoch,
    ) &&
    activeView.effectiveDialSnapshot?.carry_context === true &&
    view.effectiveDialSnapshot?.carry_context === true &&
    activeView.effectiveDialDigest === view.effectiveDialDigest
  );
}

function candidateMatchesScope(
  active: ActiveExecution,
  candidate: PendingCandidate,
  candidateHasActiveRun: boolean,
): boolean {
  const { inbox, disposition, ref, view } = candidate;
  const sameRef = ref.id === active.ref.id;
  const leaseable = sameRef
    ? candidateHasActiveRun === (active.runId !== null)
    : !candidateHasActiveRun;
  return (
    disposition.state === "active" &&
    disposition.sourceRefId === ref.id &&
    inbox.companyId === active.ref.companyId &&
    inbox.taskId === active.ref.taskId &&
    inbox.sessionId === active.ref.sessionId &&
    inbox.promotedSeq === null &&
    ref.inputId === inbox.id &&
    ref.admittedSeq === inbox.admittedSeq &&
    ref.promotedSeq === null &&
    ref.disposition === "active" &&
    leaseable &&
    view.id === ref.historyViewId &&
    view.companyId === inbox.companyId &&
    view.taskId === inbox.taskId &&
    view.sessionId === inbox.sessionId &&
    view.refId === ref.id &&
    view.executionLineageId === ref.executionLineageId &&
    view.contextEpoch === ref.contextEpoch &&
    view.sourceHighWaterSeq === ref.admissionHighWaterSeq &&
    view.sourceMessageId === inbox.id &&
    view.sourceInputId === inbox.id &&
    view.sourceAdmittedSeq === inbox.admittedSeq &&
    view.sourcePromotedSeq === null &&
    ["empty", "current"].includes(view.state) &&
    (sameRef || sameOwnerCarryLineage(active, candidate))
  );
}

async function loadPendingCandidates(
  transaction: TaskSessionDbTransaction,
  active: ActiveExecution,
): Promise<PendingCandidate[]> {
  const rows = await transaction
    .select({
      inbox: taskSessionInputs,
      disposition: taskSessionInputDispositions,
      ref: taskExecutionRefs,
      view: taskExecutionHistoryViews,
    })
    .from(taskSessionInputs)
    .innerJoin(
      taskSessionInputDispositions,
      eq(taskSessionInputDispositions.inputId, taskSessionInputs.id),
    )
    .innerJoin(
      taskExecutionRefs,
      eq(taskExecutionRefs.id, taskSessionInputDispositions.sourceRefId),
    )
    .innerJoin(
      taskExecutionHistoryViews,
      eq(taskExecutionHistoryViews.id, taskExecutionRefs.historyViewId),
    )
    .where(
      and(
        eq(taskSessionInputs.companyId, active.ref.companyId),
        eq(taskSessionInputs.taskId, active.ref.taskId),
        eq(taskSessionInputs.sessionId, active.ref.sessionId),
        isNull(taskSessionInputs.promotedSeq),
        eq(taskSessionInputDispositions.state, "active"),
      ),
    )
    .orderBy(asc(taskSessionInputs.admittedSeq))
    .for("update");
  const candidateRefIds = [...new Set(rows.map((row) => row.ref.id))];
  const occupiedRefIds = new Set(
    await readOccupiedTaskExecutionRefIds(transaction, {
      companyId: active.ref.companyId,
      taskId: active.ref.taskId,
      sessionId: active.ref.sessionId,
      refIds: candidateRefIds,
    }),
  );
  return rows.filter((candidate) =>
    candidateMatchesScope(
      active,
      candidate,
      occupiedRefIds.has(candidate.ref.id),
    ),
  );
}

async function promoteCandidate(
  transaction: TaskSessionDbTransaction,
  candidate: PendingCandidate,
  now: Date,
): Promise<TaskSessionInputRecord> {
  const { inbox, ref, view } = candidate;
  const comments = await transaction
    .select({
      comment: taskComments,
      source: taskCommentProjectionSources,
    })
    .from(taskComments)
    .innerJoin(
      taskCommentProjectionSources,
      eq(taskCommentProjectionSources.commentId, taskComments.id),
    )
    .where(
      and(
        eq(taskComments.companyId, inbox.companyId),
        eq(taskComments.taskId, inbox.taskId),
        eq(taskComments.sessionId, inbox.sessionId),
        eq(taskComments.canonicalMessageId, inbox.id),
      ),
    )
    .limit(1);
  const comment = comments[0]?.comment;
  const commentSource = comments[0]?.source;
  if (
    !comment ||
    !commentSource ||
    commentSource.sourceKind !== comment.canonicalSourceKind ||
    commentSource.sourceId !== comment.canonicalSourceId ||
    commentSource.messageId !== inbox.id
  ) {
    throw new TaskSessionInvariantError(
      `Admitted input ${inbox.id} has no stable projected comment`,
    );
  }
  const admittedEvent = await transaction
    .select()
    .from(taskSessionEvents)
    .where(
      and(
        eq(taskSessionEvents.companyId, inbox.companyId),
        eq(taskSessionEvents.taskId, inbox.taskId),
        eq(taskSessionEvents.sessionId, inbox.sessionId),
        eq(taskSessionEvents.seq, inbox.admittedSeq),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const admitted =
    admittedEvent ? decodeStoredTaskSessionEvent(admittedEvent) : null;
  if (
    !admittedEvent ||
    admitted?.event.type !== TaskSession.Event.PromptAdmitted.type ||
    (admitted.event.data as { messageID?: unknown }).messageID !== inbox.id ||
    admittedEvent.sourceKind !== ref.sourceKind ||
    admittedEvent.sourceId !== ref.sourceId ||
    admittedEvent.runId !== comment.runId ||
    (comment.authorType === "agent" &&
      (admittedEvent.runId === null ||
        admittedEvent.agentId !== comment.authorAgentId ||
        admittedEvent.adapterConfigRevisionId === null)) ||
    (comment.authorType !== "agent" && admittedEvent.runId !== null)
  ) {
    throw new TaskSessionInvariantError(
      `Admitted input ${inbox.id} lost its immutable producer envelope`,
    );
  }

  const { seq } = await reserveTaskSessionEventSequence(transaction, {
    companyId: inbox.companyId,
    taskId: inbox.taskId,
    sessionId: inbox.sessionId,
  });
  const eventId = `evt_${digest({
    transition: "prompted",
    sessionId: inbox.sessionId,
    inputId: inbox.id,
  }).slice(0, 40)}`;
  await publishTaskSessionEventInTx(transaction, {
    event: {
      id: eventId,
      sessionId: inbox.sessionId,
      seq,
      type: TaskSession.Event.Prompted.type,
      data: {
        sessionID: inbox.sessionId,
        messageID: inbox.id,
        timestamp: inbox.timeCreated.getTime(),
        prompt: inbox.prompt,
        delivery: inbox.delivery,
      },
    },
    envelope: {
      companyId: inbox.companyId,
      taskId: inbox.taskId,
      runId: admittedEvent.runId,
      ownershipEpoch: ref.ownershipEpoch,
      agentId: admittedEvent.agentId,
      adapterConfigRevisionId:
        admittedEvent.adapterConfigRevisionId,
      sourceKind: "input_promotion",
      sourceId: ref.sourceId,
      immutableSourceKey: `${ref.id}:prompted`,
      sourceRecordId: ref.id,
      sourceIdentityDigest: digest({
        kind: "input_promotion",
        refId: ref.id,
        inputId: inbox.id,
        admittedSeq: inbox.admittedSeq,
      }),
      createdAt: now,
    },
    projection: {
      comment: {
        phase: "promoted",
        sourceKind:
          comment.canonicalSourceKind as TaskSessionCommentProjectionInput["sourceKind"],
        sourceId: comment.canonicalSourceId,
        messageId: inbox.id,
        ...(commentSource.refId === null
          ? {}
          : {
              steeringSegment: {
                steeringTargetRunId:
                  commentSource.steeringTargetRunId!,
                refId: commentSource.refId,
                refOrdinal: commentSource.refOrdinal!,
                segmentOrdinal: commentSource.segmentOrdinal!,
              },
            }),
        comment: {
          id: comment.id,
          body: comment.body,
          authorAgentId: comment.authorAgentId,
          authorUserId: comment.authorUserId,
          authorPluginInstallationId:
            comment.authorPluginInstallationId,
          authorPluginKey: comment.authorPluginKey,
          authorType: comment.authorType,
          replyToCommentId: comment.replyToCommentId,
          replyToProjectedEventSeq:
            comment.replyToProjectedEventSeq,
          threadRootCommentId: comment.threadRootCommentId,
          threadRootProjectedEventSeq:
            comment.threadRootProjectedEventSeq,
          presentation: comment.presentation,
          metadata: comment.metadata,
          sourceTrust: comment.sourceTrust,
        },
      },
    },
  });

  const [updatedRefs, updatedViews] = await Promise.all([
    transaction
      .update(taskExecutionRefs)
      .set({ promotedSeq: seq, updatedAt: now })
      .where(
        and(
          eq(taskExecutionRefs.id, ref.id),
          isNull(taskExecutionRefs.promotedSeq),
          eq(taskExecutionRefs.disposition, "active"),
        ),
      )
      .returning({ id: taskExecutionRefs.id }),
    transaction
      .update(taskExecutionHistoryViews)
      .set({ sourcePromotedSeq: seq, updatedAt: now })
      .where(
        and(
          eq(taskExecutionHistoryViews.id, view.id),
          isNull(taskExecutionHistoryViews.sourcePromotedSeq),
          inArray(taskExecutionHistoryViews.state, ["empty", "current"]),
        ),
      )
      .returning({ id: taskExecutionHistoryViews.id }),
  ]);
  if (!updatedRefs[0] || !updatedViews[0]) {
    throw new TaskSessionLifecycleConflict(
      "Task Session input promotion lost its ref or history-view lifecycle race",
      { inputId: inbox.id, refId: ref.id, historyViewId: view.id },
    );
  }

  const orderRows = Array.from(
    await transaction.execute(sql<{ lowerOrder: number | null }>`
      SELECT max(lower_order)::integer AS "lowerOrder"
      FROM task_execution_history_view_messages
      WHERE history_view_id = ${view.id}
    `),
  );
  const lowerOrder = Number(orderRows[0]?.lowerOrder ?? -1) + 1;
  await transaction
    .insert(taskExecutionHistoryViewMessages)
    .values({
      id: deterministicUuid(
        "history-view-message",
        `${view.id}\0${inbox.id}`,
      ),
      companyId: inbox.companyId,
      taskId: inbox.taskId,
      sessionId: inbox.sessionId,
      historyViewId: view.id,
      messageId: inbox.id,
      lowerOrder,
      membershipKind: "source",
    })
    .onConflictDoNothing();
  const memberships = await transaction
    .select()
    .from(taskExecutionHistoryViewMessages)
    .where(
      and(
        eq(taskExecutionHistoryViewMessages.historyViewId, view.id),
        eq(taskExecutionHistoryViewMessages.messageId, inbox.id),
      ),
    )
    .limit(1);
  const membership = memberships[0];
  if (
    !membership ||
    membership.companyId !== inbox.companyId ||
    membership.taskId !== inbox.taskId ||
    membership.sessionId !== inbox.sessionId ||
    membership.lowerOrder !== lowerOrder ||
    membership.membershipKind !== "source"
  ) {
    throw new TaskSessionLifecycleConflict(
      "Task Session source membership diverged during input promotion",
      { inputId: inbox.id, historyViewId: view.id },
    );
  }

  const promoted = await transaction
    .select()
    .from(taskSessionInputs)
    .where(eq(taskSessionInputs.id, inbox.id))
    .limit(1);
  if (!promoted[0] || promoted[0].promotedSeq !== seq) {
    throw new TaskSessionInvariantError(
      `Task Session projector did not promote input ${inbox.id}`,
    );
  }
  return promoted[0];
}

function exactTextOnlyPrompt(
  value: unknown,
): value is {
  readonly text: string;
  readonly files?: readonly never[];
  readonly agents?: readonly never[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prompt = value as Record<string, unknown>;
  return typeof prompt.text === "string" &&
    (prompt.files === undefined ||
      (Array.isArray(prompt.files) && prompt.files.length === 0)) &&
    (prompt.agents === undefined ||
      (Array.isArray(prompt.agents) && prompt.agents.length === 0));
}

/**
 * Materializes one admitted human active-run steer as its canonical User
 * message before the positive segment takes a source-message FK. Unlike the
 * ordinary ref promotion path, this input deliberately has no ref/view; the
 * run repository binds its projected comment to the new segment immediately
 * after this transition in the same transaction.
 */
export async function promoteActiveRunSteeringInputInTransaction(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly sessionId: string;
    readonly sourceCommentId: string;
    readonly sourceMessageId: string;
    readonly sourceInputId: string;
    readonly actorUserId: string;
    readonly exactMessage: string;
    readonly at: Date;
  },
): Promise<TaskSessionInputRecord> {
  if (
    input.sourceMessageId !== input.sourceInputId ||
    input.exactMessage.length === 0
  ) {
    throw new TaskSessionLifecycleConflict(
      "Human active-run steering requires one exact source message/input identity",
      { sourceMessageId: input.sourceMessageId },
    );
  }
  const sourceInput = await transaction
    .select()
    .from(taskSessionInputs)
    .where(
      and(
        eq(taskSessionInputs.companyId, input.companyId),
        eq(taskSessionInputs.taskId, input.taskId),
        eq(taskSessionInputs.sessionId, input.sessionId),
        eq(taskSessionInputs.id, input.sourceInputId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  const disposition = await transaction
    .select()
    .from(taskSessionInputDispositions)
    .where(
      and(
        eq(taskSessionInputDispositions.companyId, input.companyId),
        eq(taskSessionInputDispositions.taskId, input.taskId),
        eq(taskSessionInputDispositions.sessionId, input.sessionId),
        eq(taskSessionInputDispositions.inputId, input.sourceInputId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  const projected = await transaction
    .select({
      comment: taskComments,
      source: taskCommentProjectionSources,
    })
    .from(taskComments)
    .innerJoin(
      taskCommentProjectionSources,
      eq(taskCommentProjectionSources.commentId, taskComments.id),
    )
    .where(
      and(
        eq(taskComments.companyId, input.companyId),
        eq(taskComments.taskId, input.taskId),
        eq(taskComments.sessionId, input.sessionId),
        eq(taskComments.id, input.sourceCommentId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !sourceInput ||
    !disposition ||
    !projected ||
    sourceInput.delivery !== "steer" ||
    sourceInput.promotedSeq !== null ||
    !exactTextOnlyPrompt(sourceInput.prompt) ||
    sourceInput.prompt.text !== input.exactMessage ||
    disposition.sourceRefId !== null ||
    disposition.state !== "active" ||
    projected.comment.canonicalMessageId !== input.sourceMessageId ||
    projected.comment.canonicalSourceKind !== "human_comment" ||
    projected.comment.body !== input.exactMessage ||
    projected.comment.authorType !== "user" ||
    projected.comment.authorUserId !== input.actorUserId ||
    projected.comment.runId !== null ||
    projected.source.sourceKind !== "human_comment" ||
    projected.source.messageId !== input.sourceMessageId ||
    projected.source.admittedEventSeq !== sourceInput.admittedSeq ||
    projected.source.promotedEventSeq !== null ||
    projected.source.steeringTargetRunId !== null ||
    projected.source.refId !== null ||
    projected.source.refOrdinal !== null ||
    projected.source.segmentOrdinal !== null
  ) {
    throw new TaskSessionLifecycleConflict(
      "Human active-run steering lost its exact admitted input/comment identity",
      { sourceInputId: input.sourceInputId },
    );
  }
  const admittedRow = await transaction
    .select()
    .from(taskSessionEvents)
    .where(
      and(
        eq(taskSessionEvents.companyId, input.companyId),
        eq(taskSessionEvents.taskId, input.taskId),
        eq(taskSessionEvents.sessionId, input.sessionId),
        eq(taskSessionEvents.seq, sourceInput.admittedSeq),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  const admitted = admittedRow
    ? decodeStoredTaskSessionEvent(admittedRow)
    : null;
  if (
    !admittedRow ||
    admittedRow.sourceKind !== "human_comment" ||
    admittedRow.sourceId !== projected.source.sourceId ||
    admittedRow.runId !== null ||
    admittedRow.agentId !== null ||
    admittedRow.adapterConfigRevisionId !== null ||
    admitted?.event.type !== TaskSession.Event.PromptAdmitted.type ||
    (admitted.event.data as { messageID?: unknown }).messageID !==
      input.sourceMessageId ||
    (admitted.event.data as { delivery?: unknown }).delivery !== "steer" ||
    !exactTextOnlyPrompt(
      (admitted.event.data as { prompt?: unknown }).prompt,
    ) ||
    (admitted.event.data as { prompt: { text: string } }).prompt.text !==
      input.exactMessage
  ) {
    throw new TaskSessionInvariantError(
      `Admitted active-run steering input ${input.sourceInputId} lost its immutable event`,
    );
  }
  const { seq } = await reserveTaskSessionEventSequence(transaction, input);
  const eventId = `evt_${digest({
    transition: "prompted",
    sessionId: input.sessionId,
    inputId: input.sourceInputId,
  }).slice(0, 40)}`;
  await publishTaskSessionEventInTx(transaction, {
    event: {
      id: eventId,
      sessionId: input.sessionId,
      seq,
      type: TaskSession.Event.Prompted.type,
      data: {
        sessionID: input.sessionId,
        messageID: input.sourceMessageId,
        timestamp: sourceInput.timeCreated.getTime(),
        prompt: sourceInput.prompt,
        delivery: "steer",
      },
    },
    envelope: {
      companyId: input.companyId,
      taskId: input.taskId,
      runId: null,
      ownershipEpoch: null,
      agentId: null,
      adapterConfigRevisionId: null,
      sourceKind: "input_promotion",
      sourceId: admittedRow.sourceId,
      immutableSourceKey: `${admittedRow.immutableSourceKey}:prompted`,
      sourceRecordId: admittedRow.sourceRecordId,
      sourceIdentityDigest: digest({
        kind: "input_promotion",
        sourceKind: admittedRow.sourceKind,
        sourceId: admittedRow.sourceId,
        sourceInputId: input.sourceInputId,
        admittedSeq: sourceInput.admittedSeq,
      }),
      createdAt: input.at,
    },
    projection: {
      comment: {
        phase: "promoted",
        sourceKind: "human_comment",
        sourceId: projected.source.sourceId,
        messageId: input.sourceMessageId,
        comment: {
          id: projected.comment.id,
          body: projected.comment.body,
          authorAgentId: projected.comment.authorAgentId,
          authorUserId: projected.comment.authorUserId,
          authorPluginInstallationId:
            projected.comment.authorPluginInstallationId,
          authorPluginKey: projected.comment.authorPluginKey,
          authorType: projected.comment.authorType,
          replyToCommentId: projected.comment.replyToCommentId,
          replyToProjectedEventSeq:
            projected.comment.replyToProjectedEventSeq,
          threadRootCommentId: projected.comment.threadRootCommentId,
          threadRootProjectedEventSeq:
            projected.comment.threadRootProjectedEventSeq,
          presentation: projected.comment.presentation,
          metadata: projected.comment.metadata,
          sourceTrust: projected.comment.sourceTrust,
        },
      },
    },
  });
  const promoted = await transaction
    .select()
    .from(taskSessionInputs)
    .where(eq(taskSessionInputs.id, input.sourceInputId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!promoted || promoted.promotedSeq !== seq) {
    throw new TaskSessionInvariantError(
      `Task Session projector did not promote active-run steering input ${input.sourceInputId}`,
    );
  }
  return promoted;
}

export function createTaskSessionInputService(
  db: Db,
  options: { clock?: () => Date } = {},
): TaskSessionInputService {
  const clock = options.clock ?? (() => new Date());
  return {
    promotePreparedInput(scope) {
      return db.transaction(async (transaction) => {
        const active = await validateActiveExecution(transaction, {
          ...scope,
          activeRefId: scope.refId,
          runId: null,
        });
        if (active.ref.inputId === null || active.ref.promotedSeq !== null) {
          return false;
        }
        const rows = await transaction
          .select({
            inbox: taskSessionInputs,
            disposition: taskSessionInputDispositions,
            ref: taskExecutionRefs,
            view: taskExecutionHistoryViews,
          })
          .from(taskSessionInputs)
          .innerJoin(
            taskSessionInputDispositions,
            eq(
              taskSessionInputDispositions.inputId,
              taskSessionInputs.id,
            ),
          )
          .innerJoin(
            taskExecutionRefs,
            eq(
              taskExecutionRefs.id,
              taskSessionInputDispositions.sourceRefId,
            ),
          )
          .innerJoin(
            taskExecutionHistoryViews,
            eq(
              taskExecutionHistoryViews.id,
              taskExecutionRefs.historyViewId,
            ),
          )
          .where(
            and(
              eq(taskSessionInputs.id, active.ref.inputId),
              isNull(taskSessionInputs.promotedSeq),
            ),
          )
          .limit(1)
          .for("update");
        const candidate = rows[0];
        if (!candidate) {
          throw new TaskSessionInvariantError(
            `Prepared Task Session input ${active.ref.inputId} disappeared before promotion`,
          );
        }
        if (!candidateMatchesScope(active, candidate, false)) {
          throw new TaskSessionLifecycleConflict(
            "Prepared Task Session input no longer matches its exact ref and history view",
            { refId: scope.refId, inputId: active.ref.inputId },
          );
        }
        await promoteCandidate(transaction, candidate, clock());
        return true;
      });
    },

    latestSequence(scope) {
      return db.transaction(async (transaction) => {
        await validateActiveExecution(transaction, scope);
        const rows = await transaction
          .select({ seq: taskSessionEventSequences.seq })
          .from(taskSessionEventSequences)
          .where(
            and(
              eq(taskSessionEventSequences.companyId, scope.companyId),
              eq(taskSessionEventSequences.taskId, scope.taskId),
              eq(taskSessionEventSequences.sessionId, scope.sessionId),
            ),
          )
          .limit(1);
        const seq = rows[0]?.seq;
        if (seq === undefined) {
          throw new TaskSessionInvariantError(
            `Task Session ${scope.sessionId} has no event sequence`,
          );
        }
        return seq;
      });
    },

    hasPending(scope) {
      return db.transaction(async (transaction) => {
        const active = await validateActiveExecution(transaction, scope);
        const candidates = await loadPendingCandidates(transaction, active);
        return {
          steer: candidates.some(
            (candidate) => candidate.inbox.delivery === "steer",
          ),
          queue: candidates.some(
            (candidate) => candidate.inbox.delivery === "queue",
          ),
        };
      });
    },

    promoteSteers(scope, cutoffSeq) {
      if (!Number.isSafeInteger(cutoffSeq) || cutoffSeq < -1) {
        throw new TypeError(
          "Task Session steer cutoff must be a safe event sequence",
        );
      }
      return db.transaction(async (transaction) => {
        const active = await validateActiveExecution(transaction, scope);
        const sequenceRows = await transaction
          .select({ seq: taskSessionEventSequences.seq })
          .from(taskSessionEventSequences)
          .where(
            and(
              eq(taskSessionEventSequences.companyId, scope.companyId),
              eq(taskSessionEventSequences.taskId, scope.taskId),
              eq(taskSessionEventSequences.sessionId, scope.sessionId),
            ),
          )
          .limit(1);
        if (
          sequenceRows[0] === undefined ||
          cutoffSeq > sequenceRows[0].seq
        ) {
          throw new TaskSessionLifecycleConflict(
            "Task Session steer cutoff is ahead of its durable event sequence",
            { sessionId: scope.sessionId, cutoffSeq },
          );
        }
        const candidates = (
          await loadPendingCandidates(transaction, active)
        ).filter(
          (candidate) =>
            candidate.inbox.delivery === "steer" &&
            candidate.inbox.admittedSeq <= cutoffSeq,
        );
        const promoted: TaskSessionInputRecord[] = [];
        for (const candidate of candidates) {
          promoted.push(
            await promoteCandidate(transaction, candidate, clock()),
          );
        }
        return promoted;
      });
    },

    promoteNextQueued(scope) {
      return db.transaction(async (transaction) => {
        const active = await validateActiveExecution(transaction, scope);
        const candidates = await loadPendingCandidates(transaction, active);
        if (
          candidates.some(
            (candidate) => candidate.inbox.delivery === "steer",
          )
        ) {
          return null;
        }
        const queued = candidates.find(
          (candidate) => candidate.inbox.delivery === "queue",
        );
        return queued
          ? promoteCandidate(transaction, queued, clock())
          : null;
      });
    },
  };
}
