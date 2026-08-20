import {
  ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
  ACP_SESSION_CORRELATION_KIND,
} from "@paperclipai/adapter-utils/acpx-runtime";
import { localExecutionCorrelationFingerprint } from "../services/local-execution-correlation.js";
import type { ResolvedTaskExecutionPrompt } from "../services/task-execution-attempt-executor.js";
import type { AcpCorrelationScope, StoredAcpSessionCorrelation } from "../services/native-correlation.js";

export const launchProfile = Object.freeze({
  registryName: "fixture-agent",
});
export const digest = "a".repeat(64);
export const toolsDigest = "b".repeat(64);
export const targetFingerprint = localExecutionCorrelationFingerprint("revision-1");

export function correlationScope(input: {
  generation?: number;
  laneKind?: "owner" | "consult";
}): AcpCorrelationScope {
  return {
    companyId: "company-1",
    taskId: "task-1",
    ownershipEpoch: 1,
    targetAgentId: "agent-1",
    adapterConfigIdentity: "revision-1",
    workspaceIdentity: "workspace-1",
    targetFingerprint: localExecutionCorrelationFingerprint("revision-1"),
    correlationGeneration: input.generation ?? 2,
    laneKind: input.laneKind ?? "owner",
    authorizedContextExposureDigest: digest,
  };
}

export function storedCorrelation(input: {
  generation?: number;
  laneKind?: "owner" | "consult";
} = {}): StoredAcpSessionCorrelation {
  const scope = correlationScope({
    generation: input.generation ?? 1,
    laneKind: input.laneKind,
  });
  return {
    id: "correlation-1",
    state: "eligible",
    scope,
    envelopeVersion: ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
    codecKind: ACP_SESSION_CORRELATION_KIND,
    ciphertext: "pcnc.v1.nonce.tag.ciphertext",
    digest: "d".repeat(64),
  };
}

export function resolvedPrompt(input: {
  carryContext: boolean;
  readOnly?: boolean;
  turn?: ResolvedTaskExecutionPrompt["turn"];
  stored?: StoredAcpSessionCorrelation | null;
  sessionOperation?: ResolvedTaskExecutionPrompt["sessionOperation"];
  bootstrapPredecessor?: ResolvedTaskExecutionPrompt["bootstrapPredecessor"];
  activationGeneration?: number;
  laneKind?: "owner" | "consult";
  leaseRenewalIntervalMs?: number;
}): ResolvedTaskExecutionPrompt {
  const laneKind = input.laneKind ?? "owner";
  const stored = input.stored ?? null;
  const sessionOperation =
    input.sessionOperation ??
    (input.carryContext && stored ? "resume" : "new");
  return {
    identity: {
      companyId: "company-1",
      taskId: "task-1",
      sessionId: "paperclip-session-1",
      ownershipEpoch: 1,
      executionScopeId: "authority-1",
      runId: "run-1",
      runBatchDigest: digest,
      runKind: laneKind === "owner" ? "productive" : "consult",
      refId: "ref-1",
      refOrdinal: 0,
      attemptId: "attempt-1",
      attemptGeneration: 1,
      leaseId: "lease-1",
      leaseGeneration: 1,
      targetAgentId: "agent-1",
      laneKind,
      taskExecutionAuthorityId: laneKind === "owner" ? "authority-1" : null,
      consultExecutionId: laneKind === "consult" ? "consult-1" : null,
      adapterConfigRevisionId: "revision-1",
      executionWorkspaceBindingId: "workspace-1",
    },
    turn: input.turn ?? "work",
    readOnly: input.readOnly ?? false,
    sessionOperation,
    sourceMessageId: "source-message-1",
    sourceMessageSeq: 7,
    sourceText: "exact source message",
    contextAccess: {
      carry_context: input.carryContext,
      read_task_comments: true,
      read_task_agent_run: true,
      list_sub_tasks: true,
      read_sub_task_comments: true,
      read_sub_task_agent_run: true,
      list_company_tasks: true,
      read_company_task_comments: true,
      read_company_task_agent_run: true,
    },
    carryContext: input.carryContext,
    storedCorrelation: stored,
    bootstrapPredecessor: input.bootstrapPredecessor ?? null,
    activationCorrelationScope: correlationScope({
      generation: input.activationGeneration,
      laneKind,
    }),
    effectiveContextExposureDigest: digest,
    carrySourceExposureDigest: digest,
    effectiveToolsDigest: toolsDigest,
    acpConfiguration: {
      contractVersion: "acpx-runtime/v1",
      launchProfile,
      sessionConfigSelections: [{ configId: "model", value: "model-1" }],
      model: {
        value: "model-1",
        label: "Model 1",
      },
    },
    target: {
      companyId: "company-1",
      taskId: "task-1",
      runId: "run-1",
      targetAgentId: "agent-1",
      adapterConfigRevisionId: "revision-1",
      executionWorkspaceBindingId: "workspace-1",
      acpConfiguration: {
        contractVersion: "acpx-runtime/v1",
        launchProfile,
        sessionConfigSelections: [{ configId: "model", value: "model-1" }],
        model: {
          value: "model-1",
          label: "Model 1",
        },
      },
      hostCwd: "/workspace",
      localWorkspaceCwd: "/workspace",
      targetAdditionalDirectories: [],
    },
    leaseRenewalIntervalMs: input.leaseRenewalIntervalMs ?? 60_000,
  };
}
