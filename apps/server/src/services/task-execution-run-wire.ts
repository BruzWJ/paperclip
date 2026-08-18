import type { TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { publishLiveEvent } from "./live-events.js";
import type { TaskExecutionRunEnvelope } from "./task-execution-run-service.js";

export function serializeTaskExecutionRunEnvelope(
  run: TaskExecutionRunEnvelope,
): TaskExecutionRunEnvelopeRecord {
  return {
    id: run.runId,
    companyId: run.companyId,
    taskId: run.taskId,
    sessionId: run.sessionId,
    executionScopeId: run.executionScopeId,
    kind: run.kind,
    status: run.status,
    ownershipEpoch: run.ownershipEpoch,
    targetAgentId: run.targetAgentId,
    adapterConfigRevisionId: run.adapterConfigRevisionId,
    executionMode: run.executionMode,
    taskExecutionAuthorityId: run.taskExecutionAuthorityId,
    consultExecutionId: run.consultExecutionId,
    parentRunId: run.parentRunId,
    retryOfRunId: run.retryOfRunId,
    currentAttemptId: run.currentAttemptId,
    currentLeaseId: run.currentLeaseId,
    cancellationIntentId: run.cancellationIntentId,
    terminalFinalizationId: run.terminalFinalizationId,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    terminalClassification: run.terminalClassification,
    terminalReasonCode: run.terminalReasonCode,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export function publishTaskExecutionRunState(run: TaskExecutionRunEnvelope) {
  return publishLiveEvent({
    companyId: run.companyId,
    type: "run.state",
    payload: { run: serializeTaskExecutionRunEnvelope(run) },
  });
}
