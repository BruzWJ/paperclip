import { describe, expect, it } from "vitest";
import {
  AcpInitializationCapabilityError,
  resolveApprovedAcpLaunch,
  type AcpSubprocess,
  type AcpSubprocessLaunch,
  type PreparedAcpExecutionTargetSubprocess,
} from "@paperclipai/adapter-utils/acp-subprocess";
import {
  resolveAdapterExecutionTargetNativeIdentityEnvironment,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import type {
  SelectedCompanySkillLaunchChannel,
} from "@paperclipai/adapter-utils/selected-company-skills";
import type { AgentAdapterAcpConfiguration } from "@paperclipai/shared";
import {
  createAdapterConfigurationPreflightService,
  type AdapterConfigurationPreflightRuntime,
  type AdapterRuntimeReadinessRepository,
} from "./adapter-configuration-preflight.js";
import {
  CompanySkillMaterializationLifecycleRejected,
} from "./company-skill-materialization-lifecycle.js";
import { EnvironmentRunError } from "./environment-run-orchestrator.js";

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const ISSUE_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const AGENT_ID = "00000000-0000-4000-8000-000000000004";
const REVISION_ID = "00000000-0000-4000-8000-000000000005";
const ENVIRONMENT_ID = "00000000-0000-4000-8000-000000000006";
const BINDING_ID = "00000000-0000-4000-8000-000000000007";
const WORKSPACE = "/workspace/exact";
const TARGET_WORKSPACE = "/target/workspace/exact";
const TARGET_NATIVE_EXECUTABLE = "/target/bin/codex";
const SECRET_OUTPUT = "provider-secret-must-not-escape";

const APPROVED_LAUNCH = resolveApprovedAcpLaunch("codex");
const ACP_CONFIGURATION: AgentAdapterAcpConfiguration = {
  contractVersion: "acp-subprocess/v1",
  launchProfile: {
    ...APPROVED_LAUNCH,
    args: [...APPROVED_LAUNCH.args],
  },
  sessionConfigSelections: [
    { configId: "model", value: "gpt-5" },
  ],
  model: {
    id: "gpt-5",
    label: "GPT-5",
    value: "gpt-5",
    limits: {
      contextTokenLimit: 200_000,
      outputTokenLimit: 16_000,
    },
  },
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

const TARGET: AdapterExecutionTarget = Object.freeze({
  kind: "local",
  environmentId: ENVIRONMENT_ID,
  leaseId: "readiness-lease",
});

const PROCESS_SUCCESS: RunProcessResult = Object.freeze({
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: SECRET_OUTPUT,
  stderr: SECRET_OUTPUT,
  pid: 42,
  startedAt: new Date(0).toISOString(),
});

const OPERATOR_NATIVE: SelectedCompanySkillLaunchChannel = Object.freeze({
  channel: "operator_native",
});

function persistedBinding(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    runId: RUN_ID,
    runKind: "productive" as const,
    runStatus: "queued" as const,
    agentId: AGENT_ID,
    currentAdapterConfigRevisionId: REVISION_ID,
    adapterConfigRevisionId: REVISION_ID,
    environmentId: ENVIRONMENT_ID,
    executionWorkspaceBindingId: BINDING_ID,
    absoluteCwd: WORKSPACE,
    acpConfiguration: ACP_CONFIGURATION,
    ...overrides,
  });
}

interface HarnessOptions {
  readonly binding?: ReturnType<typeof persistedBinding>;
  readonly companySkills?: SelectedCompanySkillLaunchChannel;
  readonly companySkillsError?: unknown;
  readonly acquisitionError?: unknown;
  readonly preparationError?: unknown;
  readonly processResult?: RunProcessResult;
  readonly processError?: unknown;
  readonly initializeResult?: {
    readonly protocolVersion: number;
    readonly agentCapabilities?: {
      readonly sessionCapabilities?: { readonly resume?: unknown };
    };
  };
  readonly initializeError?: unknown;
  readonly closeAndReapError?: unknown;
  readonly releaseError?: unknown;
  readonly selectedMaterialization?:
    PreparedAcpExecutionTargetSubprocess["selectedCompanySkillMaterialization"];
}

function createHarness(options: HarnessOptions = {}) {
  const binding = options.binding ?? persistedBinding();
  const acquisitionInputs: unknown[] = [];
  const preparationInputs: unknown[] = [];
  const authenticationCalls: Parameters<
    AdapterConfigurationPreflightRuntime["runTargetProcess"]
  >[] = [];
  const subprocessLaunches: AcpSubprocessLaunch[] = [];
  const initializeClients: unknown[] = [];
  const releases: boolean[] = [];
  const collections: unknown[] = [];
  let clientCloseCount = 0;
  let closeAndReapCount = 0;
  let terminateAndReapCount = 0;
  let disposeBeforeStartCount = 0;

  const subprocess = {
    child: {},
    stream: {},
    stderr: () => "",
    exited: Promise.resolve({ exitCode: 0, signal: null }),
    cancel() {},
    async closeAndReap() {
      closeAndReapCount += 1;
      if (options.closeAndReapError) throw options.closeAndReapError;
      return { exitCode: 0, signal: null };
    },
    async terminateAndReap() {
      terminateAndReapCount += 1;
      return { exitCode: 0, signal: null };
    },
    closeInput() {},
  } as unknown as AcpSubprocess;

  const prepared: PreparedAcpExecutionTargetSubprocess = Object.freeze({
    targetCwd: TARGET_WORKSPACE,
    targetAdditionalDirectories: Object.freeze([]),
    invocationFilePaths: Object.freeze({}),
    targetNodeExecutable: "/target/bin/node",
    targetNativeExecutable: TARGET_NATIVE_EXECUTABLE,
    targetFrontendEntrypoint: "/target/pinned/codex-acp.mjs",
    selectedCompanySkillMaterialization:
      options.selectedMaterialization ?? null,
    async startSubprocess(launch: AcpSubprocessLaunch) {
      subprocessLaunches.push(launch);
      return subprocess;
    },
    async disposeBeforeStart() {
      disposeBeforeStartCount += 1;
    },
  });

  const repository: AdapterRuntimeReadinessRepository = {
    async loadExactBinding() {
      return binding;
    },
    async resolveCompanySkills() {
      if (options.companySkillsError) throw options.companySkillsError;
      return options.companySkills ?? OPERATOR_NATIVE;
    },
    async collectMaterialization(candidate) {
      collections.push(candidate);
    },
  };

  const runtime: AdapterConfigurationPreflightRuntime = {
    targetAcquirer: {
      async acquire(input) {
        acquisitionInputs.push(input);
        if (options.acquisitionError) throw options.acquisitionError;
        return {
          adapterConfigRevisionId: input.adapterConfigRevisionId,
          acpConfiguration: input.acpConfiguration,
          executionTarget: TARGET,
          hostCwd: WORKSPACE,
          targetCwd: TARGET_WORKSPACE,
          targetAdditionalDirectories: Object.freeze([]),
          redactor: { redactText: (value: string) => value },
          async release(failed = false) {
            releases.push(failed);
            if (options.releaseError) throw options.releaseError;
          },
        };
      },
    },
    async prepareTarget(input) {
      preparationInputs.push(input);
      if (options.preparationError) throw options.preparationError;
      return prepared;
    },
    async runTargetProcess(...args) {
      authenticationCalls.push(args);
      if (options.processError) throw options.processError;
      await args[4].onLog("stdout", SECRET_OUTPUT);
      await args[4].onLog("stderr", SECRET_OUTPUT);
      return options.processResult ?? PROCESS_SUCCESS;
    },
    createInitializeOnlyClient() {
      const client = Object.freeze({
        async initialize() {
          if (options.initializeError) throw options.initializeError;
          return options.initializeResult ?? {
            protocolVersion: 1,
            agentCapabilities: {
              sessionCapabilities: { resume: true },
            },
          };
        },
        close() {
          clientCloseCount += 1;
        },
      });
      initializeClients.push(client);
      return client;
    },
  };

  return {
    service: createAdapterConfigurationPreflightService({
      repository,
      runtime,
    }),
    acquisitionInputs,
    preparationInputs,
    authenticationCalls,
    subprocessLaunches,
    initializeClients,
    releases,
    collections,
    counts: () => ({
      clientCloseCount,
      closeAndReapCount,
      terminateAndReapCount,
      disposeBeforeStartCount,
    }),
  };
}

const IDENTITY = Object.freeze({
  companyId: COMPANY_ID,
  issueId: ISSUE_ID,
  runId: RUN_ID,
});

describe("adapter runtime readiness", () => {
  it.each([
    [
      persistedBinding({ runKind: "unsupported" as never }),
      "run_not_preflightable",
    ],
    [persistedBinding({ runStatus: "succeeded" }), "run_not_preflightable"],
    [persistedBinding({ absoluteCwd: null }), "workspace_unavailable"],
  ] as const)(
    "rejects a non-runnable persisted scope before target acquisition",
    async (binding, reason) => {
      const harness = createHarness({ binding });
      await expect(harness.service.inspect(IDENTITY)).resolves.toMatchObject({
        status: "incomplete",
        reason,
      });
      expect(harness.acquisitionInputs).toEqual([]);
    },
  );

  it("binds the exact persisted scope, checks native auth, and initializes only the prepared frontend", async () => {
    const isolatedConfiguration: AgentAdapterAcpConfiguration = {
      ...ACP_CONFIGURATION,
      skillChannel: "isolated_skills_home",
    };
    const isolatedSkills: SelectedCompanySkillLaunchChannel = Object.freeze({
      channel: "isolated_skills_home",
      identity: Object.freeze({
        companyId: COMPANY_ID,
        agentId: AGENT_ID,
        executionTargetIdentity: "a".repeat(64),
        adapterConfigRevisionId: REVISION_ID,
      }),
      entries: Object.freeze([]),
    });
    const collectExact = async () => ({
      materializationKey: "materialization-key",
      outcome: "collected" as const,
    });
    const harness = createHarness({
      binding: persistedBinding({
        acpConfiguration: isolatedConfiguration,
      }),
      companySkills: isolatedSkills,
      selectedMaterialization: Object.freeze({
        materializationKey: "materialization-key",
        collectExact,
      }),
    });

    const result = await harness.service.inspect(IDENTITY);

    expect(result).toEqual({
      status: "ready",
      scope: {
        runId: RUN_ID,
        agentId: AGENT_ID,
        adapterConfigRevisionId: REVISION_ID,
        environmentId: ENVIRONMENT_ID,
        executionWorkspaceBindingId: BINDING_ID,
      },
      protocolVersion: 1,
      sessionResume: true,
    });
    expect(harness.acquisitionInputs).toEqual([{
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      runId: RUN_ID,
      targetAgentId: AGENT_ID,
      adapterConfigRevisionId: REVISION_ID,
      executionWorkspaceBindingId: BINDING_ID,
      acpConfiguration: isolatedConfiguration,
      hostCwd: WORKSPACE,
      localWorkspaceCwd: WORKSPACE,
      targetAdditionalDirectories: [],
    }]);
    expect(harness.preparationInputs).toEqual([expect.objectContaining({
      runId: RUN_ID,
      target: TARGET,
      sourceLaunch: APPROVED_LAUNCH,
      hostCwd: WORKSPACE,
      targetCwd: TARGET_WORKSPACE,
      companySkills: isolatedSkills,
    })]);
    expect(harness.authenticationCalls).toHaveLength(1);
    const auth = harness.authenticationCalls[0]!;
    expect(auth[1]).toBe(TARGET);
    expect(auth[2]).toBe(TARGET_NATIVE_EXECUTABLE);
    expect(auth[3]).toEqual(["login", "status"]);
    expect(auth[4]).toMatchObject({
      cwd: TARGET_WORKSPACE,
      env: resolveAdapterExecutionTargetNativeIdentityEnvironment(TARGET),
      timeoutSec: 15,
      graceSec: 2,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_OUTPUT);
    expect(harness.subprocessLaunches).toEqual([expect.objectContaining({
      launch: APPROVED_LAUNCH,
      cwd: TARGET_WORKSPACE,
      environment: {},
      mcpServers: [],
      configOptions: isolatedConfiguration.sessionConfigSelections,
    })]);
    expect(harness.initializeClients).toHaveLength(1);
    expect(Object.keys(harness.initializeClients[0] as object).sort()).toEqual([
      "close",
      "initialize",
    ]);
    expect(harness.releases).toEqual([false]);
    expect(harness.counts()).toEqual({
      clientCloseCount: 1,
      closeAndReapCount: 1,
      terminateAndReapCount: 0,
      disposeBeforeStartCount: 0,
    });
    expect(harness.collections).toEqual([{
      identity: isolatedSkills.identity,
      materializationKey: "materialization-key",
      collectExact,
    }]);
  });

  it("maps a rejected skill revision to typed configuration-incomplete after establishing scope", async () => {
    const harness = createHarness({
      companySkillsError: new CompanySkillMaterializationLifecycleRejected(
        "immutable company skill revision pin cannot be resolved",
      ),
    });

    await expect(harness.service.inspect(IDENTITY)).resolves.toEqual({
      status: "incomplete",
      scope: {
        runId: RUN_ID,
        agentId: AGENT_ID,
        adapterConfigRevisionId: REVISION_ID,
        environmentId: ENVIRONMENT_ID,
        executionWorkspaceBindingId: BINDING_ID,
      },
      reason: "adapter_revision_invalid",
      remediationCommand: null,
    });
    expect(harness.acquisitionInputs).toEqual([]);
  });

  it("does not disguise an unexpected skill repository failure as invalid configuration", async () => {
    const failure = new Error("database disconnected");
    const harness = createHarness({ companySkillsError: failure });
    await expect(harness.service.inspect(IDENTITY)).rejects.toBe(failure);
  });

  it("returns non-secret login guidance when native authentication is absent", async () => {
    const harness = createHarness({
      processResult: { ...PROCESS_SUCCESS, exitCode: 1 },
    });

    const result = await harness.service.inspect(IDENTITY);

    expect(result).toMatchObject({
      status: "incomplete",
      reason: "native_authentication_required",
      remediationCommand: "codex login",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_OUTPUT);
    expect(harness.subprocessLaunches).toEqual([]);
    expect(harness.releases).toEqual([true]);
    expect(harness.counts().disposeBeforeStartCount).toBe(1);
  });

  it.each([
    [
      "initialization failure",
      { initializeError: new Error("initialize rejected") },
      "acp_initialization_failed",
    ],
    [
      "typed initialize capability rejection",
      {
        initializeError: new AcpInitializationCapabilityError(
          "session_resume_unavailable",
          "resume is unavailable",
        ),
      },
      "acp_capability_incompatible",
    ],
    [
      "protocol mismatch",
      { initializeResult: { protocolVersion: 2 } },
      "acp_capability_incompatible",
    ],
    [
      "missing resume capability",
      {
        initializeResult: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: {} },
        },
      },
      "acp_capability_incompatible",
    ],
  ] as const)("fails closed for %s", async (_label, options, reason) => {
    const harness = createHarness(options);
    await expect(harness.service.inspect(IDENTITY)).resolves.toMatchObject({
      status: "incomplete",
      reason,
      remediationCommand: null,
    });
    expect(harness.releases).toEqual([true]);
    expect(harness.counts().closeAndReapCount).toBe(1);
  });

  it.each([
    [
      new EnvironmentRunError("environment_inactive", "inactive"),
      "environment_unavailable",
    ],
    [
      new EnvironmentRunError(
        "workspace_realization_failed",
        "workspace unavailable",
      ),
      "workspace_unavailable",
    ],
  ] as const)("types target acquisition failures", async (error, reason) => {
    const harness = createHarness({ acquisitionError: error });
    await expect(harness.service.inspect(IDENTITY)).resolves.toMatchObject({
      status: "incomplete",
      reason,
    });
    expect(harness.preparationInputs).toEqual([]);
  });

  it.each([
    [
      new Error("required executable is unavailable"),
      "target_native_executable_unavailable",
    ],
    [new Error("approved frontend artifact is missing"), "acp_frontend_unavailable"],
    [new Error("target preparation failed"), "execution_target_unavailable"],
  ] as const)("types preparation failures", async (error, reason) => {
    const harness = createHarness({ preparationError: error });
    await expect(harness.service.inspect(IDENTITY)).resolves.toMatchObject({
      status: "incomplete",
      reason,
    });
    expect(harness.authenticationCalls).toEqual([]);
    expect(harness.releases).toEqual([true]);
  });

  it("lets deterministic cleanup failure override a successful initialize", async () => {
    const harness = createHarness({
      closeAndReapError: new Error("reap failed"),
    });

    await expect(harness.service.inspect(IDENTITY)).resolves.toMatchObject({
      status: "incomplete",
      reason: "target_cleanup_failed",
    });
    expect(harness.counts()).toMatchObject({
      closeAndReapCount: 1,
      terminateAndReapCount: 1,
    });
    expect(harness.releases).toEqual([true]);
  });
});
