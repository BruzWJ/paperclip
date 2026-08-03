import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  resolveApprovedAcpLaunch,
  type AcpPromptClosureOutcome,
  type AcpPromptExecutionInput,
  type AcpPromptExecutionResult,
  type AcpPromptSettlement,
  type PreparedAcpExecutionTargetSubprocess,
} from "@paperclipai/adapter-utils/acp-subprocess";
import type {
  AdapterImplementationIdentity,
  AgentAdapterAcpConfiguration,
} from "@paperclipai/shared";
import { createDeclarativeTestAdapter } from "../__tests__/helpers/declarative-adapter.js";
import {
  SessionCompactionConflict,
  SessionCompactionProviderFailure,
} from "./issue-session-compaction-postgres.js";
import { createPostgresSessionCompactionProvider } from "./issue-session-compaction-provider.js";
import type {
  IssueExecutionTargetAcquirer,
} from "./issue-execution-provider-configuration.js";

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const ISSUE_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000003";
const RUN_ID = "00000000-0000-4000-8000-000000000004";
const REVISION_ID = "00000000-0000-4000-8000-000000000005";
const BINDING_ID = "00000000-0000-4000-8000-000000000006";
const ENVIRONMENT_ID = "00000000-0000-4000-8000-000000000007";
const SESSION_ID = "ses_compaction";
const TARGET_SESSION_ID = "native_compaction";

const PRODUCTIVE_MODEL: AdapterModel = Object.freeze({
  id: "productive-model",
  label: "Productive model",
  value: "productive-target-value",
  limits: Object.freeze({
    contextTokenLimit: 128_000,
    inputTokenLimit: 96_000,
    outputTokenLimit: 32_000,
  }),
});

const SUMMARY_MODEL: AdapterModel = Object.freeze({
  id: "summary-model",
  label: "Summary model",
  value: "summary-target-value",
  limits: Object.freeze({
    contextTokenLimit: 200_000,
    inputTokenLimit: 180_000,
    outputTokenLimit: 40_000,
  }),
});

const IMPLEMENTATION_IDENTITY: AdapterImplementationIdentity = Object.freeze({
  adapterType: "codex",
  definitionVersion: "acp-subprocess/v1",
  protocolVersion: 1,
  origin: "builtin",
  packageName: "@paperclipai/adapter-codex",
  packageVersion: "1.0.0",
  buildIdentity: "test-build",
  artifactDigest: "b".repeat(64),
});

const ADAPTER = createDeclarativeTestAdapter({
  type: "codex",
  models: [PRODUCTIVE_MODEL, SUMMARY_MODEL],
});
const APPROVED_LAUNCH = resolveApprovedAcpLaunch("codex");

const ACP_CONFIGURATION: AgentAdapterAcpConfiguration = {
  contractVersion: "acp-subprocess/v1",
  launchProfile: {
    ...APPROVED_LAUNCH,
    args: [...APPROVED_LAUNCH.args],
  },
  sessionConfigSelections: [
    {
      configId: ADAPTER.definition.modelConfigOptionId,
      value: PRODUCTIVE_MODEL.value,
    },
  ],
  model: PRODUCTIVE_MODEL,
  executionTargetSelector: {
    defaultEnvironmentId: ENVIRONMENT_ID,
    executionTargetDriver: "local",
    executionTargetDigest: "a".repeat(64),
  },
  workspaceSelector: {
    kind: "issue_execution_workspace",
  },
  companySkillPins: [],
  skillChannel: "operator_native",
};

const REVISION = Object.freeze({
  id: REVISION_ID,
  companyId: COMPANY_ID,
  agentId: AGENT_ID,
  revisionNumber: 1,
  adapterType: "codex",
  implementationIdentity: IMPLEMENTATION_IDENTITY,
  adapterConfigSchemaVersion: "acp-subprocess/v1",
  defaultEnvironmentId: ENVIRONMENT_ID,
  executionTargetDriver: "local",
  executionTargetDigest: "a".repeat(64),
  normalizedConfig: {},
  runtimeConfig: {},
  acpConfiguration: ACP_CONFIGURATION,
  digest: "c".repeat(64),
  parentRevisionId: null,
  createdByAgentId: null,
  createdByUserId: null,
  createdAt: new Date(0),
});

const BINDING = Object.freeze({
  id: BINDING_ID,
  companyId: COMPANY_ID,
  issueId: ISSUE_ID,
  sessionId: SESSION_ID,
  ownershipEpoch: 1,
  executionWorkspaceId: "00000000-0000-4000-8000-000000000008",
  bindingMode: "issue",
  absoluteCwd: "/workspace",
  repositoryLocator: null,
  repositoryRef: null,
  pullRequestSelector: null,
  environmentSelector: null,
  boundByAgentId: null,
  boundByUserId: null,
  createdAt: new Date(0),
});

const TRIGGER_MODEL = Object.freeze({
  modelRef: PRODUCTIVE_MODEL.id,
  targetModelId: PRODUCTIVE_MODEL.id,
  targetModelValue: PRODUCTIVE_MODEL.value,
  contextTokenLimit: PRODUCTIVE_MODEL.limits.contextTokenLimit,
  inputTokenLimit: PRODUCTIVE_MODEL.limits.inputTokenLimit,
  outputTokenLimit: PRODUCTIVE_MODEL.limits.outputTokenLimit,
});

const SUMMARY_SELECTION = Object.freeze({
  modelRef: SUMMARY_MODEL.id,
  targetModelId: SUMMARY_MODEL.id,
  targetModelValue: SUMMARY_MODEL.value,
  contextTokenLimit: SUMMARY_MODEL.limits.contextTokenLimit,
  inputTokenLimit: SUMMARY_MODEL.limits.inputTokenLimit,
  outputTokenLimit: SUMMARY_MODEL.limits.outputTokenLimit,
});

function queryReturning(rows: readonly unknown[]) {
  const query = {
    from: () => query,
    where: () => query,
    limit: () => Promise.resolve(rows),
  };
  return query;
}

function database(loads = 1): Db {
  const select = vi.fn();
  for (let index = 0; index < loads; index += 1) {
    select.mockReturnValueOnce(queryReturning([REVISION]));
    select.mockReturnValueOnce(queryReturning([BINDING]));
  }
  return { select } as unknown as Db;
}

function targetAcquirer(input: {
  secret?: string;
  release?: (failed?: boolean) => Promise<void>;
} = {}): IssueExecutionTargetAcquirer {
  const release =
    input.release ?? vi.fn(async (_failed?: boolean) => undefined);
  return {
    acquire: vi.fn(async () => ({
      adapterConfigRevisionId: REVISION_ID,
      acpConfiguration: ACP_CONFIGURATION,
      executionTarget: {
        kind: "local" as const,
        environmentId: ENVIRONMENT_ID,
        leaseId: "lease-compaction",
      },
      hostCwd: "/workspace",
      targetCwd: "/target/workspace",
      targetAdditionalDirectories: Object.freeze([]),
      redactor: {
        redactText(value: string) {
          return input.secret
            ? value.split(input.secret).join("***REDACTED***")
            : value;
        },
      },
      release: async (failed?: boolean) => release(failed),
    })),
  };
}

function preparedTarget(): PreparedAcpExecutionTargetSubprocess {
  return Object.freeze({
    targetCwd: "/target/workspace",
    targetAdditionalDirectories: Object.freeze([]),
    invocationFilePaths: Object.freeze({}),
    targetNodeExecutable: "/usr/bin/node",
    targetNativeExecutable: "/usr/bin/codex",
    targetFrontendEntrypoint: "/target/frontend.mjs",
    selectedCompanySkillMaterialization: null,
    startSubprocess: vi.fn() as never,
    disposeBeforeStart: vi.fn(async () => undefined),
  });
}

function settlement(
  contextSize = SUMMARY_MODEL.limits.contextTokenLimit,
): AcpPromptSettlement {
  return Object.freeze({
    kind: "protocol_settled",
    stopReason: "end_turn",
    occupancy: Object.freeze({
      used: 1_024,
      size: contextSize,
      cost: null,
    }),
  });
}

function settledExecution(input: {
  assistantText?: string;
  event?: AcpPromptExecutionInput["onSessionEvent"] extends (
    event: infer Event,
  ) => unknown
    ? Event
    : never;
  contextSize?: number;
} = {}) {
  return vi.fn(async (
    request: AcpPromptExecutionInput,
  ): Promise<AcpPromptExecutionResult> => {
    expect(request.request.start).toEqual({ kind: "new" });
    await request.activatePrompt({ sessionId: TARGET_SESSION_ID });
    await request.beginPromptTransmission({ sessionId: TARGET_SESSION_ID });
    await request.onSessionEvent({
      kind: "user_message_echo",
      content: { type: "text", text: request.request.message },
    });
    if (input.event) {
      await request.onSessionEvent(input.event);
    } else {
      await request.onSessionEvent({
        kind: "message_chunk",
        channel: "assistant",
        content: {
          type: "text",
          text: input.assistantText ?? "Canonical summary",
        },
      });
    }
    await request.validatePromptEvents?.();
    const promptSettlement = settlement(input.contextSize);
    const closure: AcpPromptClosureOutcome = {
      kind: "settled",
      sessionId: TARGET_SESSION_ID,
      settlement: promptSettlement,
      cancellationNotificationError: null,
    };
    await request.closePrompt(closure);
    return {
      ...closure,
      closureError: null,
      teardown: {
        kind: "reaped",
        processExit: { exitCode: 0, signal: null },
      },
      stderr: "",
    };
  });
}

function summarizerInput(model = SUMMARY_SELECTION) {
  return {
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    agentId: AGENT_ID,
    ownershipEpoch: 1,
    adapterConfigRevisionId: REVISION_ID,
    executionWorkspaceBindingId: BINDING_ID,
    prompt: "Summarize the authorized recovery view.",
    model,
    lifecycle: {},
  };
}

describe("canonical ACP session compaction provider", () => {
  it("maps a company-catalog model to the closed ACP selection snapshot", async () => {
    const resolve = vi.fn(async () => SUMMARY_MODEL);
    const provider = createPostgresSessionCompactionProvider(database(), {
      companyModelCatalog: {
        async listModels() {
          return [PRODUCTIVE_MODEL, SUMMARY_MODEL];
        },
        resolve,
      },
    });

    await expect(
      provider.modelResolver.resolve({
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        agentId: AGENT_ID,
        ownershipEpoch: 1,
        adapterConfigRevisionId: REVISION_ID,
        executionWorkspaceBindingId: BINDING_ID,
        requestedModelRef: SUMMARY_MODEL.id,
        triggerModel: TRIGGER_MODEL,
      }),
    ).resolves.toEqual(SUMMARY_SELECTION);
    expect(resolve).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      modelId: SUMMARY_MODEL.id,
    });
  });

  it("sends one exact prompt to a fresh tool-free ACP session and returns protocol settlement accounting", async () => {
    const executePrompt = settledExecution();
    const prepareTarget = vi.fn(async () => preparedTarget());
    const release = vi.fn(async (_failed?: boolean) => undefined);
    const acquire = targetAcquirer({ release });
    const controller = new AbortController();
    const provider = createPostgresSessionCompactionProvider(database(), {
      adapterRegistry: { require: vi.fn(async () => ADAPTER) },
      targetAcquirer: acquire,
      executePrompt,
      prepareTarget,
    });

    await expect(
      provider.summarizer.summarize({
        ...summarizerInput(),
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      text: "Canonical summary",
      settlement: {
        kind: "protocol_settled",
        stopReason: "end_turn",
        occupancy: {
          used: 1_024,
          size: SUMMARY_MODEL.limits.contextTokenLimit,
          cost: null,
        },
      },
    });

    const execution = executePrompt.mock.calls[0]![0];
    expect(execution.signal).toBe(controller.signal);
    expect(execution.request).toEqual({
      start: { kind: "new" },
      message: "Summarize the authorized recovery view.",
    });
    expect(execution.launch.mcpServers).toEqual([]);
    expect(execution.launch.configOptions).toEqual([
      {
        configId: ADAPTER.definition.modelConfigOptionId,
        value: SUMMARY_MODEL.value,
      },
    ]);
    expect(execution.launch.cwd).toBe("/target/workspace");
    expect(prepareTarget).toHaveBeenCalledWith(expect.objectContaining({
      runId: RUN_ID,
      hostCwd: "/workspace",
      targetCwd: "/target/workspace",
      sourceLaunch: resolveApprovedAcpLaunch("codex"),
    }));
    expect(acquire.acquire).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      runId: RUN_ID,
      adapterConfigRevisionId: REVISION_ID,
      executionWorkspaceBindingId: BINDING_ID,
      acpConfiguration: expect.objectContaining({
        model: SUMMARY_MODEL,
      }),
    }));
    expect(release).toHaveBeenCalledWith(false);
  });

  it("fails closed when a tool call appears in the tool-free compaction session", async () => {
    const release = vi.fn(async (_failed?: boolean) => undefined);
    const provider = createPostgresSessionCompactionProvider(database(), {
      adapterRegistry: { require: vi.fn(async () => ADAPTER) },
      targetAcquirer: targetAcquirer({ release }),
      prepareTarget: vi.fn(async () => preparedTarget()),
      executePrompt: settledExecution({
        event: {
          kind: "tool_call",
          toolCallId: "unexpected",
          title: "Unexpected tool",
        },
      }),
    });

    await expect(
      provider.summarizer.summarize(summarizerInput()),
    ).rejects.toMatchObject({
      errorKind: "acp_compaction_failure",
      retryable: false,
    });
    expect(release).toHaveBeenCalledWith(true);
  });

  it("rejects occupancy that differs from the immutable target model limit", async () => {
    const provider = createPostgresSessionCompactionProvider(database(), {
      adapterRegistry: { require: vi.fn(async () => ADAPTER) },
      targetAcquirer: targetAcquirer(),
      prepareTarget: vi.fn(async () => preparedTarget()),
      executePrompt: settledExecution({ contextSize: 128_000 }),
    });

    await expect(
      provider.summarizer.summarize(summarizerInput()),
    ).rejects.toMatchObject({
      errorKind: "acp_occupancy_invalid",
      retryable: false,
    });
  });

  it("returns the stable native-login failure without exposing stderr or partial secrets", async () => {
    const secret = "native-cli-secret";
    const executePrompt = vi.fn(async (
      input: AcpPromptExecutionInput,
    ): Promise<AcpPromptExecutionResult> => {
      const closure: AcpPromptClosureOutcome = {
        kind: "error",
        failure: "authentication_required",
        phase: "session_setup",
        promptTransmitted: false,
        cause: new Error(secret),
      };
      await input.closePrompt(closure);
      return {
        ...closure,
        closureError: null,
        teardown: {
          kind: "reaped",
          processExit: { exitCode: 0, signal: null },
        },
        stderr: secret,
      };
    });
    const provider = createPostgresSessionCompactionProvider(database(), {
      adapterRegistry: { require: vi.fn(async () => ADAPTER) },
      targetAcquirer: targetAcquirer({ secret }),
      prepareTarget: vi.fn(async () => preparedTarget()),
      executePrompt,
    });

    let failure: SessionCompactionProviderFailure | null = null;
    try {
      await provider.summarizer.summarize(summarizerInput());
    } catch (error) {
      expect(error).toBeInstanceOf(SessionCompactionProviderFailure);
      failure = error as SessionCompactionProviderFailure;
    }
    expect(failure).toMatchObject({
      errorKind: "authentication_required",
      retryable: false,
      partialText: "",
    });
    expect(failure?.message).toContain("native login");
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("rejects a model that is not the exact immutable entry in the selected adapter", async () => {
    const acquire = targetAcquirer();
    const provider = createPostgresSessionCompactionProvider(database(), {
      adapterRegistry: { require: vi.fn(async () => ADAPTER) },
      targetAcquirer: acquire,
      prepareTarget: vi.fn(async () => preparedTarget()),
      executePrompt: settledExecution(),
    });

    await expect(
      provider.summarizer.summarize(
        summarizerInput({
          ...SUMMARY_SELECTION,
          targetModelValue: "invented-target-value",
        }),
      ),
    ).rejects.toBeInstanceOf(SessionCompactionConflict);
    expect(acquire.acquire).not.toHaveBeenCalled();
  });

  it("has no implicit local execution path when no target acquirer is configured", async () => {
    const provider = createPostgresSessionCompactionProvider(database(), {
      adapterRegistry: { require: vi.fn(async () => ADAPTER) },
      prepareTarget: vi.fn(async () => preparedTarget()),
      executePrompt: settledExecution(),
    });

    await expect(
      provider.summarizer.summarize(summarizerInput()),
    ).rejects.toMatchObject({
      errorKind: "execution_target_unavailable",
      retryable: false,
    });
  });

  it("does not launch a subprocess after cancellation during target acquisition", async () => {
    let releaseAcquisition!: () => void;
    const acquisitionGate = new Promise<void>((resolve) => {
      releaseAcquisition = resolve;
    });
    const release = vi.fn(async (_failed?: boolean) => undefined);
    const baseAcquirer = targetAcquirer({ release });
    const acquire: IssueExecutionTargetAcquirer = {
      acquire: vi.fn(async (input) => {
        await acquisitionGate;
        return baseAcquirer.acquire(input);
      }),
    };
    const prepareTarget = vi.fn(async () => preparedTarget());
    const executePrompt = settledExecution();
    const provider = createPostgresSessionCompactionProvider(database(), {
      adapterRegistry: { require: vi.fn(async () => ADAPTER) },
      targetAcquirer: acquire,
      prepareTarget,
      executePrompt,
    });
    const controller = new AbortController();
    const summary = provider.summarizer.summarize({
      ...summarizerInput(),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(acquire.acquire).toHaveBeenCalledOnce());
    controller.abort("lease_lost");
    releaseAcquisition();

    await expect(summary).rejects.toMatchObject({
      errorKind: "acp_compaction_cancelled",
      promptTransmitted: false,
    });
    expect(prepareTarget).not.toHaveBeenCalled();
    expect(executePrompt).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(true);
  });
});
