import {
  companies,
  companySessionLifecycleOperations,
  taskConsultExecutions,
  taskExecutionHistoryViews,
  taskExecutionPromptSegments,
  taskExecutionSessions,
  taskSessions,
  tasks,
} from "@paperclipai/db";
import type { TaskExecutionSessionOperation } from "@paperclipai/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { type PostgresPromptCapabilityCompiler } from "./runtime-interface-compiler-db.js";
import { TaskConsultChainInvalid, lockAndValidateTaskConsultChain } from "./task-consult-chain-postgres.js";
import { type RefRow, type RunRow, exactlyOne, reject } from "./task-execution-dispatcher-postgres-part-1.js";
import { compileCarryContext } from "./task-execution-dispatcher-postgres-part-2.js";
import { resolveInitialPromptCycleInTransaction } from "./task-execution-prompt-cycle-postgres.js";
import { isTaskExecutionRefDeliveryEligible } from "./task-execution-ref-delivery.js";
import { lockTaskExecutionRunIfPresentInTransaction } from "./task-execution-run-service-part-3-section-1.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

/** @internal Freezes the sole ACPX session operation for one exact prompt. */
export async function selectSessionOperation(
  transaction: TaskSessionDbTransaction,
  compiler: Pick<PostgresPromptCapabilityCompiler, "resolve">,
  input: {
    readonly run: RunRow;
    readonly promptKind: "base" | "steering";
    readonly ref: RefRow;
    readonly refOrdinal: number;
    readonly segmentOrdinal: number;
  },
): Promise<TaskExecutionSessionOperation> {
  const run = input.run;
  const { carryContext, exposureDigest, carrySourceExposureDigest } = await compileCarryContext(
    compiler,
    run,
  );
  const common = and(
    eq(taskExecutionSessions.companyId, run.companyId),
    eq(taskExecutionSessions.taskId, run.taskId),
    eq(taskExecutionSessions.ownershipEpoch, run.ownershipEpoch),
    eq(taskExecutionSessions.targetAgentId, run.targetAgentId),
    eq(taskExecutionSessions.adapterConfigIdentity, run.adapterConfigRevisionId),
    eq(taskExecutionSessions.workspaceIdentity, run.executionWorkspaceBindingId),
  );
  if (input.promptKind === "steering") {
    const segment = exactlyOne(
      await transaction
        .select({
          resumeSourceCorrelationId: taskExecutionPromptSegments.resumeSourceCorrelationId,
        })
        .from(taskExecutionPromptSegments)
        .where(
          and(
            eq(taskExecutionPromptSegments.companyId, run.companyId),
            eq(taskExecutionPromptSegments.taskId, run.taskId),
            eq(taskExecutionPromptSegments.runId, run.runId),
            eq(taskExecutionPromptSegments.refId, input.ref.id),
            eq(taskExecutionPromptSegments.refOrdinal, input.refOrdinal),
            eq(taskExecutionPromptSegments.segmentOrdinal, input.segmentOrdinal),
            eq(taskExecutionPromptSegments.steeringState, "resumed"),
            isNull(taskExecutionPromptSegments.protocolSettlementState),
          ),
        )
        .limit(2)
        .for("update"),
      "steering attempt lost its immutable resume source",
    );
    const sources = await transaction
      .select()
      .from(taskExecutionSessions)
      .where(and(common, eq(taskExecutionSessions.id, segment.resumeSourceCorrelationId)))
      .limit(2)
      .for("update");
    if (sources.length > 1) reject("steering resume source is ambiguous");
    const source = sources[0] ?? null;
    const exactCarrySource =
      source !== null &&
      source.purpose === "carry" &&
      source.state === "eligible" &&
      source.laneKind === run.executionMode &&
      source.runId === null &&
      source.currentRefId === null &&
      source.currentRefOrdinal === null &&
      source.currentSegmentOrdinal === null &&
      source.authorizedContextExposureDigest === carrySourceExposureDigest;
    const exactActiveRunSource =
      source !== null &&
      source.purpose === "active_run_steering" &&
      source.state === "current" &&
      source.laneKind === null &&
      source.runId === run.runId &&
      source.currentRefId === input.ref.id &&
      source.currentRefOrdinal === input.refOrdinal &&
      source.currentSegmentOrdinal === input.segmentOrdinal - 1 &&
      source.authorizedContextExposureDigest === null;
    if (exactCarrySource || exactActiveRunSource) return "steer_resume";
    reject("steering attempt lost its exact native resume source");
  }
  const initialCycle = await resolveInitialPromptCycleInTransaction(transaction, {
    currentRef: input.ref,
    executionWorkspaceBindingId: run.executionWorkspaceBindingId,
  });
  if (initialCycle.kind === "invalid") {
    reject("bootstrap predecessor lost its exact settled native correlation");
  }
  if (initialCycle.kind === "new") return "new";
  if (initialCycle.kind === "bootstrap_resume") return "resume";
  if (initialCycle.kind === "bootstrap_unavailable") {
    reject("ordered session-start work lost its exact bootstrap correlation");
  }
  const eligible = carryContext
    ? await transaction
        .select({ id: taskExecutionSessions.id })
        .from(taskExecutionSessions)
        .where(
          and(
            common,
            eq(taskExecutionSessions.purpose, "carry"),
            eq(taskExecutionSessions.state, "eligible"),
            eq(taskExecutionSessions.laneKind, run.executionMode),
            eq(taskExecutionSessions.authorizedContextExposureDigest, exposureDigest),
          ),
        )
        .limit(2)
        .for("update")
    : [];
  if (eligible.length > 1) reject("carry target session is ambiguous");
  if (eligible.length === 1) {
    return "resume";
  }
  if (initialCycle.kind === "singleton" && initialCycle.instructionless) {
    return "new";
  }
  reject("instructed work lost its exact carry or ordered session start");
}

export async function assertRefDispatchable(
  transaction: TaskSessionDbTransaction,
  ref: RefRow,
): Promise<void> {
  const [companyRows, taskRows, sessionRows, viewRows, lifecycleRows] = await Promise.all([
    transaction
      .select({
        status: companies.status,
        integrity: companies.sessionIntegrityState,
      })
      .from(companies)
      .where(eq(companies.id, ref.companyId))
      .limit(2)
      .for("share"),
    transaction
      .select({
        lifecycleStatus: tasks.lifecycleStatus,
        ownerKind: tasks.ownerKind,
        ownerAgentId: tasks.ownerAgentId,
        ownershipEpoch: tasks.ownershipEpoch,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, ref.companyId), eq(tasks.id, ref.taskId)))
      .limit(2)
      .for("update"),
    transaction
      .select()
      .from(taskSessions)
      .where(
        and(
          eq(taskSessions.companyId, ref.companyId),
          eq(taskSessions.taskId, ref.taskId),
          eq(taskSessions.id, ref.sessionId),
        ),
      )
      .limit(2)
      .for("update"),
    transaction
      .select({
        state: taskExecutionHistoryViews.state,
        refId: taskExecutionHistoryViews.refId,
      })
      .from(taskExecutionHistoryViews)
      .where(eq(taskExecutionHistoryViews.id, ref.historyViewId))
      .limit(2)
      .for("update"),
    transaction
      .select({ id: companySessionLifecycleOperations.id })
      .from(companySessionLifecycleOperations)
      .where(
        and(
          eq(companySessionLifecycleOperations.companyId, ref.companyId),
          inArray(companySessionLifecycleOperations.status, ["fenced", "cancelling", "purge_ready"]),
        ),
      )
      .limit(1)
      .for("update"),
  ]);
  const company = exactlyOne(companyRows, "execution ref lost its company");
  const task = exactlyOne(taskRows, "execution ref lost its task");
  const session = exactlyOne(sessionRows, "execution ref lost its Session");
  const view = exactlyOne(viewRows, "execution ref lost its history view");
  const ownerValid =
    ref.mode === "owner"
      ? task.ownerKind === "agent" &&
        task.ownerAgentId === ref.targetAgentId &&
        ref.taskExecutionAuthorityId !== null
      : ref.consultExecutionId !== null;
  if (
    company.status !== "active" ||
    company.integrity !== "ready" ||
    lifecycleRows.length !== 0 ||
    !["open", "blocked"].includes(task.lifecycleStatus) ||
    task.ownershipEpoch !== ref.ownershipEpoch ||
    !ownerValid ||
    session.integrityState !== "ready" ||
    session.refAdmittableAt === null ||
    session.timeArchived !== null ||
    session.purgeFencedAt !== null ||
    !["empty", "current"].includes(view.state) ||
    view.refId !== ref.id ||
    ref.disposition !== "active" ||
    !isTaskExecutionRefDeliveryEligible(ref, "dispatch")
  ) {
    reject("execution ref is no longer current and dispatchable");
  }
  if (ref.mode === "consult") {
    if (!(await consultSourceRunIsFinalized(transaction, ref))) {
      reject("consult source run is not finalized");
    }
    try {
      await lockAndValidateTaskConsultChain(transaction, {
        ref,
        requireLiveAncestors: false,
        leafState: "active",
      });
    } catch (error) {
      if (error instanceof TaskConsultChainInvalid) {
        reject(error.message);
      }
      throw error;
    }
  }
}

export async function consultSourceRunIsFinalized(
  transaction: TaskSessionDbTransaction,
  ref: Pick<RefRow, "companyId" | "taskId" | "mode" | "consultExecutionId">,
): Promise<boolean> {
  if (ref.mode === "owner") return true;
  if (ref.consultExecutionId === null) return false;
  const rows = await transaction
    .select({ sourceRunId: taskConsultExecutions.sourceRunId })
    .from(taskConsultExecutions)
    .where(
      and(
        eq(taskConsultExecutions.id, ref.consultExecutionId),
        eq(taskConsultExecutions.companyId, ref.companyId),
        eq(taskConsultExecutions.taskId, ref.taskId),
      ),
    )
    .limit(2)
    .for("share");
  const consult = rows.length === 1 ? rows[0]! : null;
  if (!consult) return false;
  const sourceRun = await lockTaskExecutionRunIfPresentInTransaction(transaction, {
    companyId: ref.companyId,
    taskId: ref.taskId,
    runId: consult.sourceRunId,
  });
  return sourceRun?.terminalFinalizationId !== null;
}
