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
  carryContext: boolean;
  generation?: number;
  currentSegmentOrdinal?: number;
  laneKind?: "owner" | "consult";
}): AcpCorrelationScope {
  const common = {
    companyId: "company-1",
    taskId: "task-1",
    ownershipEpoch: 1,
    targetAgentId: "agent-1",
    adapterConfigIdentity: "revision-1",
    workspaceIdentity: "workspace-1",
    targetFingerprint,
    correlationGeneration: input.generation ?? 2,
  } as const;
  return input.carryContext
    ? {
        ...common,
        purpose: "carry",
        laneKind: input.laneKind ?? "owner",
        authorizedContextExposureDigest: digest,
      }
    : {
        ...common,
        purpose: "active_run_steering",
        runId: "run-1",
        currentRefId: "ref-1",
        currentRefOrdinal: 0,
        currentSegmentOrdinal: input.currentSegmentOrdinal ?? 0,
      };
}

export function storedCorrelation(input: {
  purpose: "carry" | "active_run_steering";
  generation?: number;
  laneKind?: "owner" | "consult";
}): StoredAcpSessionCorrelation {
  const scope = correlationScope({
    carryContext: input.purpose === "carry",
    generation: input.generation ?? 1,
    laneKind: input.laneKind,
  });
  return {
    id: "correlation-1",
    state: input.purpose === "carry" ? "eligible" : "current",
    scope,
    envelopeVersion: ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
    codecKind: ACP_SESSION_CORRELATION_KIND,
    ciphertext: "pcnc.v1.nonce.tag.ciphertext",
    digest: "d".repeat(64),
  };
}

export function resolvedPrompt(input: {
  carryContext: boolean;
  turn?: ResolvedTaskExecutionPrompt["turn"];
  promptKind?: "base" | "steering";
  stored?: StoredAcpSessionCorrelation | null;
  sessionOperation?: ResolvedTaskExecutionPrompt["sessionOperation"];
  bootstrapPredecessor?: ResolvedTaskExecutionPrompt["bootstrapPredecessor"];
  laneKind?: "owner" | "consult";
  leaseRenewalIntervalMs?: number;
}): ResolvedTaskExecutionPrompt {
  const promptKind = input.promptKind ?? "base";
  const laneKind = input.laneKind ?? "owner";
  const stored = input.stored ?? null;
  const sessionOperation =
    input.sessionOperation ??
    (promptKind === "steering" && stored
      ? "steer_resume"
      : input.carryContext
        ? stored
          ? "resume"
          : "new"
        : "new");
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
      promptKind,
      refId: "ref-1",
      refOrdinal: 0,
      segmentOrdinal: promptKind === "base" ? 0 : 1,
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
      carryContext: input.carryContext,
      currentSegmentOrdinal: promptKind === "base" ? 0 : 1,
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
