import { randomUUID } from "node:crypto";
import type { AcpCorrelationScope } from "./native-correlation.js";
import type { TaskExecutionPromptIdentity } from "./task-execution-attempt-executor.js";
import {
  type PostgresTaskExecutionPromptCycleOptions,
  DEFAULT_CAPABILITY_TTL_MS,
  DEFAULT_LEASE_TTL_MS,
  nextCorrelationGeneration,
  reject,
} from "./task-execution-prompt-cycle-postgres-shared.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export function resolveTaskExecutionPromptCycleSettings(options: PostgresTaskExecutionPromptCycleOptions) {
  const idFactory = options.idFactory ?? randomUUID;
  const capabilityTtlMs = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  if (!Number.isSafeInteger(capabilityTtlMs) || capabilityTtlMs < 1) {
    reject("prompt capability TTL must be a positive integer");
  }
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1_000) {
    reject("attempt lease TTL must be at least one second");
  }
  const leaseRenewalIntervalMs = Math.max(1, Math.floor(Math.min(leaseTtlMs, capabilityTtlMs) / 3));
  const endpoint = new URL(options.capabilityEndpoint);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    reject("prompt capability endpoint must use HTTP transport");
  }
  return {
    idFactory,
    capabilityTtlMs,
    leaseTtlMs,
    leaseRenewalIntervalMs,
    endpoint,
  };
}

export async function createTaskExecutionPromptActivationScope(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly identity: TaskExecutionPromptIdentity;
    readonly carryContext: boolean;
    readonly effectiveContextExposureDigest: string;
    readonly targetFingerprint: string;
  },
): Promise<AcpCorrelationScope> {
  const { identity, carryContext, effectiveContextExposureDigest, targetFingerprint } = input;
  const correlationGeneration = await nextCorrelationGeneration(transaction, {
    identity,
    carryContext,
  });
  if (carryContext) {
    return {
      purpose: "carry",
      companyId: identity.companyId,
      taskId: identity.taskId,
      ownershipEpoch: identity.ownershipEpoch,
      targetAgentId: identity.targetAgentId,
      adapterConfigIdentity: identity.adapterConfigRevisionId,
      workspaceIdentity: identity.executionWorkspaceBindingId,
      targetFingerprint,
      correlationGeneration,
      laneKind: identity.laneKind,
      authorizedContextExposureDigest: effectiveContextExposureDigest,
    };
  }
  return {
    purpose: "active_run_steering",
    companyId: identity.companyId,
    taskId: identity.taskId,
    ownershipEpoch: identity.ownershipEpoch,
    targetAgentId: identity.targetAgentId,
    adapterConfigIdentity: identity.adapterConfigRevisionId,
    workspaceIdentity: identity.executionWorkspaceBindingId,
    targetFingerprint,
    correlationGeneration,
    runId: identity.runId,
    currentRefId: identity.refId,
    currentRefOrdinal: identity.refOrdinal,
    currentSegmentOrdinal: identity.segmentOrdinal,
  };
}
