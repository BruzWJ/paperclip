import {
  agentContextGrants,
  agents,
  taskExecutionSessions,
  taskExecutionWorkspaceBindings,
  tasks,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { contextDialDigest } from "./context-dial-resolver.js";
import type {
  DispatchingExecutionSourceInput,
  TaskSessionAdmissionResult,
  TaskSessionAdmissionService,
} from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import { localExecutionCorrelationFingerprint } from "./local-execution-correlation.js";
import { resolveRuntimeContextDial } from "./runtime-interface-compiler-db.js";

const ROLE_BOOTSTRAP_SUFFIX =
  "\n\nThis is your role bootstrap turn, not task work. Do not inspect the filesystem, workspace, repository, home directory, environment, global configuration, or provider configuration, and do not use provider-local tools. If you need organizational or company context, use only the Paperclip-managed tools available in this turn. Briefly acknowledge the role and end the turn; the task request will arrive as a separate queued turn.";

/** @internal Preserves the board-owned instruction bytes before the fixed suffix. */
export function renderAgentInstructionBootstrap(
  instruction: string | null | undefined,
): string | null {
  return instruction && instruction.trim().length > 0
    ? `${instruction}${ROLE_BOOTSTRAP_SUFFIX}`
    : null;
}

/**
 * Sole target admission path. Exact carry resumes with one work ref; a target
 * without carry receives one atomic instruction/work pair, or the explicitly
 * authorized work singleton when its instruction is blank.
 */
export async function admitTaskExecutionInTransaction(input: {
  readonly sessionAdmission: TaskSessionAdmissionService;
  readonly transaction: TaskSessionDbTransaction;
  readonly work: DispatchingExecutionSourceInput;
}): Promise<TaskSessionAdmissionResult> {
  const work = input.work;
  const [agentRows, taskRows, bindingRows, contextRows] = await Promise.all([
    input.transaction.select({ instruction: agents.instruction }).from(agents)
      .where(and(eq(agents.companyId, work.companyId), eq(agents.id, work.targetAgentId)))
      .limit(2).for("share"),
    input.transaction.select({
      companyId: tasks.companyId, ownerKind: tasks.ownerKind,
      ownerAgentId: tasks.ownerAgentId, ownershipEpoch: tasks.ownershipEpoch,
      executionPolicy: tasks.executionPolicy,
    }).from(tasks).where(and(
      eq(tasks.companyId, work.companyId), eq(tasks.id, work.taskId),
      eq(tasks.ownershipEpoch, work.ownershipEpoch),
    )).limit(2).for("share"),
    input.transaction.select({ id: taskExecutionWorkspaceBindings.id })
      .from(taskExecutionWorkspaceBindings).where(and(
        eq(taskExecutionWorkspaceBindings.companyId, work.companyId),
        eq(taskExecutionWorkspaceBindings.taskId, work.taskId),
        eq(taskExecutionWorkspaceBindings.sessionId, work.sessionId),
        eq(taskExecutionWorkspaceBindings.ownershipEpoch, work.ownershipEpoch),
      )).limit(2).for("share"),
    input.transaction.select({ key: agentContextGrants.key })
      .from(agentContextGrants).where(and(
        eq(agentContextGrants.companyId, work.companyId),
        eq(agentContextGrants.agentId, work.targetAgentId),
      )).for("share"),
  ]);
  if (agentRows.length !== 1 || taskRows.length !== 1 || bindingRows.length !== 1) {
    throw new Error("Task execution target lost its canonical admission scope");
  }
  const contextDial = resolveRuntimeContextDial({
    capability: { targetAgentId: work.targetAgentId, executionMode: work.mode },
    task: taskRows[0]!,
    contextGrantKeys: contextRows.map((row) => row.key),
  });
  const carry = contextDial.carry_context
    ? await input.transaction.select({ id: taskExecutionSessions.id })
      .from(taskExecutionSessions).where(and(
        eq(taskExecutionSessions.companyId, work.companyId),
        eq(taskExecutionSessions.taskId, work.taskId),
        eq(taskExecutionSessions.ownershipEpoch, work.ownershipEpoch),
        eq(taskExecutionSessions.targetAgentId, work.targetAgentId),
        eq(taskExecutionSessions.adapterConfigIdentity, work.adapterConfigRevisionId),
        eq(taskExecutionSessions.workspaceIdentity, bindingRows[0]!.id),
        eq(taskExecutionSessions.targetFingerprint,
          localExecutionCorrelationFingerprint(work.adapterConfigRevisionId)),
        eq(taskExecutionSessions.purpose, "carry"),
        eq(taskExecutionSessions.state, "eligible"),
        eq(taskExecutionSessions.laneKind, work.mode),
        eq(taskExecutionSessions.authorizedContextExposureDigest,
          contextDialDigest(contextDial)),
      )).limit(2).for("update")
    : [];
  if (carry.length > 1) throw new Error("Task execution target carry is ambiguous");
  const bootstrapText = carry.length === 0
    ? renderAgentInstructionBootstrap(agentRows[0]!.instruction)
    : null;
  if (carry.length === 1 || bootstrapText === null) {
    return input.sessionAdmission.admitExecutionSource(work, input.transaction);
  }

  const { previousOwnershipEpoch: _previousOwnershipEpoch, ...bootstrapScope } = work;
  const bootstrapKey = `${work.immutableSourceKey}:bootstrap`;
  const admitted = await input.sessionAdmission.admitExecutionSourceBatch({
    batchKey: work.immutableSourceKey,
    sources: [{
      ...bootstrapScope,
      sourceKind: "task_request",
      actor: { kind: "system", sourceKind: "task_request", sourceId: work.taskId },
      immutableSourceKey: bootstrapKey,
      exactText: bootstrapText,
      comment: null,
      idempotencyKey: bootstrapKey,
    }, work],
  }, input.transaction);
  if (!admitted[1]) throw new Error("Task execution pair lost its work member");
  return admitted[1];
}
