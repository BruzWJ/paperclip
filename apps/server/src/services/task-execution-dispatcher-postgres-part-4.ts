import {
  taskConsultExecutions,
  taskExecutionAttempts,
  taskExecutionLanes,
  taskExecutionLeases,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionWorkspaceBindings,
} from "@paperclipai/db";
import type { TaskExecutionSessionOperation } from "@paperclipai/shared";
import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { type PostgresPromptCapabilityCompiler } from "./runtime-interface-compiler-db.js";
import * as dispatcherCore from "./task-execution-dispatcher-postgres-part-1.js";
import {
  assertRefDispatchable,
  selectSessionOperation,
} from "./task-execution-dispatcher-postgres-part-3.js";
import { lockLane, lockLaneParents } from "./task-execution-dispatcher-postgres-part-2.js";
import type { LeasedTaskExecutionRef, TaskExecutionTargetLaneIdentity } from "./task-execution-dispatcher.js";
import { isTaskExecutionRefDeliveryEligible } from "./task-execution-ref-delivery.js";
import {
  lockActiveProductiveRunForLaneInTransaction,
  readOccupiedTaskExecutionRefIds,
} from "./task-execution-run-service-part-3-section-1.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export async function createRunningLease(
  transaction: TaskSessionDbTransaction,
  options: {
    readonly runService: dispatcherCore.PostgresTaskExecutionDispatcherRepositoryOptions["runService"];
    readonly compiler: Pick<PostgresPromptCapabilityCompiler, "resolve">;
    readonly idFactory: () => string;
    readonly leaseTtlMs: number;
  },
  input: {
    readonly run: dispatcherCore.RunRow;
    readonly refs: readonly dispatcherCore.RefRow[];
    readonly workerId: string;
    readonly at: Date;
    readonly laneClaim: dispatcherCore.LockedLaneLeaseClaim;
    readonly pendingAttempt?: dispatcherCore.AttemptRow;
  },
): Promise<LeasedTaskExecutionRef> {
  const first = dispatcherCore.exactlyOne(input.refs.slice(0, 1), "run has no current ref");
  const control = dispatcherCore.exactlyOne(
    await transaction
      .select()
      .from(taskExecutionRunControls)
      .where(eq(taskExecutionRunControls.runId, input.run.runId))
      .limit(2)
      .for("update"),
    "productive run lost its current-prompt control",
  );
  if (
    control.currentRefId !== first.id ||
    control.currentOrdinal === null
  ) {
    dispatcherCore.reject("run control does not select the leased prompt");
  }
  const currentMember = dispatcherCore.exactlyOne(
    await transaction
      .select({ admissionOrder: taskExecutionRunRefs.admissionOrder })
      .from(taskExecutionRunRefs)
      .where(
        and(
          eq(taskExecutionRunRefs.runId, input.run.runId),
          eq(taskExecutionRunRefs.refId, first.id),
          eq(taskExecutionRunRefs.refOrdinal, control.currentOrdinal),
        ),
      )
      .limit(2)
      .for("update"),
    "attempt lost its run-ref membership",
  );
  if (currentMember.admissionOrder !== first.laneOrdinal) {
    dispatcherCore.reject("run member drifted from its immutable lane ordinal");
  }
  if (input.laneClaim.kind === "retry" && input.laneClaim.ordinal !== currentMember.admissionOrder) {
    dispatcherCore.reject("retry crossed its exact current lane ordinal");
  }
  const operation =
    input.pendingAttempt?.sessionOperation ??
    (await selectSessionOperation(transaction, options.compiler, {
      run: input.run,
      ref: first,
    }));
  const generationRows = await transaction
    .select({ generation: taskExecutionAttempts.attemptGeneration })
    .from(taskExecutionAttempts)
    .where(
      and(
        eq(taskExecutionAttempts.runId, input.run.runId),
        eq(taskExecutionAttempts.refId, first.id),
        eq(taskExecutionAttempts.refOrdinal, control.currentOrdinal),
      ),
    )
    .orderBy(desc(taskExecutionAttempts.attemptGeneration))
    .limit(1)
    .for("update");
  const attempt = input.pendingAttempt
    ? dispatcherCore.exactlyOne(
        await transaction
          .update(taskExecutionAttempts)
          .set({ state: "running", startedAt: input.at })
          .where(
            and(
              eq(taskExecutionAttempts.id, input.pendingAttempt.id),
              eq(taskExecutionAttempts.state, "pending"),
            ),
          )
          .returning(),
        "pending retry attempt could not start",
      )
    : dispatcherCore.exactlyOne(
        await transaction
          .insert(taskExecutionAttempts)
          .values({
            id: options.idFactory(),
            companyId: input.run.companyId,
            taskId: input.run.taskId,
            sessionId: input.run.sessionId,
            runId: input.run.runId,
            runKind: input.run.kind,
            sessionOperation: operation,
            refId: first.id,
            refOrdinal: control.currentOrdinal,
            attemptGeneration: (generationRows[0]?.generation ?? 0) + 1,
            state: "running",
            startedAt: input.at,
            finishedAt: null,
            createdAt: input.at,
          })
          .returning(),
        "attempt creation did not return one row",
      );
  if (
    attempt.sessionOperation !== operation ||
    attempt.refId !== first.id ||
    attempt.refOrdinal !== control.currentOrdinal
  ) {
    dispatcherCore.reject("attempt crossed its frozen prompt identity");
  }
  const leaseGeneration = input.laneClaim.kind === "retry" ? input.laneClaim.leaseGeneration + 1 : 1;
  const leaseId = options.idFactory();
  dispatcherCore.exactlyOne(
    await transaction
      .insert(taskExecutionLeases)
      .values({
        id: leaseId,
        companyId: input.run.companyId,
        taskId: input.run.taskId,
        runId: input.run.runId,
        attemptId: attempt.id,
        leaseGeneration,
        workerId: input.workerId,
        state: "active",
        acquiredAt: input.at,
        renewedAt: null,
        expiresAt: new Date(input.at.getTime() + options.leaseTtlMs),
        releasedAt: null,
        createdAt: input.at,
      })
      .returning({ id: taskExecutionLeases.id }),
    "attempt lease creation did not return one row",
  );
  await options.runService.attachAttempt(transaction, {
    companyId: input.run.companyId,
    taskId: input.run.taskId,
    runId: input.run.runId,
    attemptId: attempt.id,
    leaseId,
    at: input.at,
  });
  dispatcherCore.exactlyOne(
    await transaction
      .update(taskExecutionLanes)
      .set({
        activeOrdinal: currentMember.admissionOrder,
        activeLeaseGeneration: leaseGeneration,
        activeLeaseId: leaseId,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(taskExecutionLanes.companyId, first.companyId),
          eq(taskExecutionLanes.taskId, first.taskId),
          eq(taskExecutionLanes.ownershipEpoch, first.ownershipEpoch),
          eq(taskExecutionLanes.targetAgentId, first.targetAgentId),
          input.laneClaim.kind === "idle"
            ? isNull(taskExecutionLanes.activeOrdinal)
            : eq(taskExecutionLanes.activeOrdinal, input.laneClaim.ordinal),
          input.laneClaim.kind === "idle"
            ? isNull(taskExecutionLanes.activeLeaseGeneration)
            : eq(taskExecutionLanes.activeLeaseGeneration, input.laneClaim.leaseGeneration),
          input.laneClaim.kind === "idle"
            ? isNull(taskExecutionLanes.activeLeaseId)
            : eq(taskExecutionLanes.activeLeaseId, input.laneClaim.leaseId),
        ),
      )
      .returning({ companyId: taskExecutionLanes.companyId }),
    "attempt could not bind its lane",
  );
  return dispatcherCore.leaseProjection(input.refs, input.run.runId, attempt, leaseId, leaseGeneration);
}

export async function currentRunRefs(
  transaction: TaskSessionDbTransaction,
  runId: string,
): Promise<dispatcherCore.RefRow[]> {
  return transaction
    .select({ ref: taskExecutionRefs })
    .from(taskExecutionRunRefs)
    .innerJoin(taskExecutionRefs, eq(taskExecutionRefs.id, taskExecutionRunRefs.refId))
    .where(eq(taskExecutionRunRefs.runId, runId))
    .orderBy(asc(taskExecutionRunRefs.refOrdinal))
    .then((rows) => rows.map((row) => row.ref));
}

export async function findExistingRunForLane(
  transaction: TaskSessionDbTransaction,
  lane: TaskExecutionTargetLaneIdentity,
): Promise<dispatcherCore.RunRow | null> {
  await lockLaneParents(transaction, lane);
  await lockLane(transaction, lane);
  return lockActiveProductiveRunForLaneInTransaction(transaction, lane);
}

export async function createRunForRef(
  transaction: TaskSessionDbTransaction,
  options: dispatcherCore.PostgresTaskExecutionDispatcherRepositoryOptions,
  ref: dispatcherCore.RefRow,
  at: Date,
  exactRetry?: {
    readonly retryOfRunId: string;
    readonly orderedRefs: readonly dispatcherCore.RefRow[];
    readonly sessionOperation: TaskExecutionSessionOperation;
  },
): Promise<{ readonly run: dispatcherCore.RunRow; readonly refs: readonly dispatcherCore.RefRow[] }> {
  let refs: readonly dispatcherCore.RefRow[];
  if (exactRetry) {
    if (
      exactRetry.orderedRefs.length === 0 ||
      exactRetry.orderedRefs[0]?.id !== ref.id ||
      new Set(exactRetry.orderedRefs.map((candidate) => candidate.id)).size !== exactRetry.orderedRefs.length
    ) {
      dispatcherCore.reject("released-run retry lost its exact ordered ref frontier");
    }
    refs = Object.freeze([...exactRetry.orderedRefs]);
  } else {
    const occupiedRefIds = await readOccupiedTaskExecutionRefIds(transaction, {
      companyId: ref.companyId,
      taskId: ref.taskId,
      sessionId: ref.sessionId,
    });
    const candidates =
      ref.sourceKind === "task_update"
        ? await transaction
            .select()
            .from(taskExecutionRefs)
            .where(
              and(
                eq(taskExecutionRefs.companyId, ref.companyId),
                eq(taskExecutionRefs.taskId, ref.taskId),
                eq(taskExecutionRefs.ownershipEpoch, ref.ownershipEpoch),
                eq(taskExecutionRefs.targetAgentId, ref.targetAgentId),
                eq(taskExecutionRefs.disposition, "active"),
                gte(taskExecutionRefs.laneOrdinal, ref.laneOrdinal),
              ),
            )
            .orderBy(asc(taskExecutionRefs.laneOrdinal))
            .limit(dispatcherCore.MAX_CREATOR_UPDATE_BATCH + 1)
            .for("update")
        : [ref];
    const firstIndex = candidates.findIndex((candidate) => candidate.id === ref.id);
    const ordered: dispatcherCore.RefRow[] = [];
    if (firstIndex >= 0) {
      const occupied = new Set(occupiedRefIds);
      for (const candidate of candidates.slice(firstIndex)) {
        if (
          ordered.length >= dispatcherCore.MAX_CREATOR_UPDATE_BATCH ||
          occupied.has(candidate.id) ||
          !isTaskExecutionRefDeliveryEligible(candidate, "dispatch") ||
          !dispatcherCore.sameBatchScope(ref, candidate)
        )
          break;
        ordered.push(candidate);
      }
    }
    refs = ordered.length > 0 ? ordered : [ref];
  }
  for (const candidate of refs) await assertRefDispatchable(transaction, candidate);
  const workspace = dispatcherCore.exactlyOne(
    await transaction
      .select({ id: taskExecutionWorkspaceBindings.id })
      .from(taskExecutionWorkspaceBindings)
      .where(
        and(
          eq(taskExecutionWorkspaceBindings.companyId, ref.companyId),
          eq(taskExecutionWorkspaceBindings.taskId, ref.taskId),
          eq(taskExecutionWorkspaceBindings.sessionId, ref.sessionId),
          eq(taskExecutionWorkspaceBindings.ownershipEpoch, ref.ownershipEpoch),
        ),
      )
      .limit(2)
      .for("share"),
    "execution ref lost its exact workspace binding",
  );
  const baseRunInput = {
    companyId: ref.companyId,
    taskId: ref.taskId,
    sessionId: ref.sessionId,
    executionScopeId: ref.executionScopeId,
    ownershipEpoch: ref.ownershipEpoch,
    targetAgentId: ref.targetAgentId,
    adapterConfigRevisionId: ref.adapterConfigRevisionId,
    executionWorkspaceBindingId: workspace.id,
    orderedRefIds: refs.map((candidate) => candidate.id),
    retryOfRunId: exactRetry?.retryOfRunId ?? null,
    at,
  };
  const created =
    ref.mode === "owner"
      ? await options.runService.createRun(transaction, {
          kind: "productive",
          ...baseRunInput,
          taskExecutionAuthorityId: ref.taskExecutionAuthorityId!,
        })
      : await (async () => {
          const { sourceRunId } = dispatcherCore.exactlyOne(
            await transaction
              .select({
                sourceRunId: taskConsultExecutions.sourceRunId,
              })
              .from(taskConsultExecutions)
              .where(eq(taskConsultExecutions.id, ref.consultExecutionId!))
              .limit(2)
              .for("share"),
            "consult ref lost its parent run",
          );
          return options.runService.createRun(transaction, {
            kind: "consult",
            ...baseRunInput,
            consultExecutionId: ref.consultExecutionId!,
            parentRunId: sourceRunId,
          });
        })();
  dispatcherCore.exactlyOne(
    await transaction
      .update(taskExecutionRunControls)
      .set({
        currentRefId: refs[0]!.id,
        currentOrdinal: 0,
      })
      .where(
        and(
          eq(taskExecutionRunControls.runId, created.run.runId),
          isNull(taskExecutionRunControls.currentRefId),
          isNull(taskExecutionRunControls.currentOrdinal),
        ),
      )
      .returning({ runId: taskExecutionRunControls.runId }),
    "new run could not bind its first prompt",
  );
  if (exactRetry) {
    dispatcherCore.exactlyOne(
      await transaction
        .insert(taskExecutionAttempts)
        .values({
          id: options.idFactory?.() ?? randomUUID(),
          companyId: created.run.companyId,
          taskId: created.run.taskId,
          sessionId: created.run.sessionId,
          runId: created.run.runId,
          runKind: created.run.kind,
          sessionOperation: exactRetry.sessionOperation,
          refId: ref.id,
          refOrdinal: 0,
          attemptGeneration: 1,
          state: "pending",
          startedAt: null,
          finishedAt: null,
          createdAt: at,
        })
        .returning({ id: taskExecutionAttempts.id }),
      "released-run retry could not freeze its pending successor attempt",
    );
  }
  const admission = createTaskSessionAdmissionService(options.database);
  await admission.appendNonDispatchSyntheticComment(
    {
      companyId: ref.companyId,
      taskId: ref.taskId,
      sessionId: ref.sessionId,
      sourceKind: "task_execution_run_progress",
      immutableSourceKey: `run-progress:${created.run.runId}`,
      sourceRecordId: created.run.runId,
      exactText: "",
      projectionKind: "run_progress",
      ownershipEpoch: ref.ownershipEpoch,
      agentId: ref.targetAgentId,
      adapterConfigRevisionId: ref.adapterConfigRevisionId,
      runId: created.run.runId,
      comment: {
        author: { kind: "agent", agentId: ref.targetAgentId },
        producingRun: {
          runId: created.run.runId,
          adapterConfigRevisionId: ref.adapterConfigRevisionId,
        },
        replyToCommentId: null,
        body: "",
      },
    },
    transaction,
  );
  const run = await options.runService.lockRun(transaction, {
    companyId: created.run.companyId,
    taskId: created.run.taskId,
    runId: created.run.runId,
  });
  return { run, refs };
}
