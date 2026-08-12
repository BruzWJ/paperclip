import { describe, expect, it, vi } from "vitest";
import {
  AcpxRuntimeReadinessCapabilityError,
  AcpxRuntimeReadinessCleanupError,
} from "@paperclipai/adapter-utils/acpx-runtime";
import type { AcpxLocalWorkspaceTarget } from "@paperclipai/adapter-utils/acpx-runtime";
import type { AgentAdapterAcpConfiguration } from "@paperclipai/shared";
import {
  createAdapterConfigurationPreflightService,
  type AdapterConfigurationPreflightRuntime,
  type AdapterRuntimeReadinessRepository,
} from "./adapter-configuration-preflight.js";
import { LocalExecutionTargetError } from "./local-execution-orchestrator.js";

type ProbeAcpxRuntimeReadiness =
  typeof import("@paperclipai/adapter-utils/acpx-runtime").probeAcpxRuntimeReadiness;
type AcpxRuntimeReadinessProbeInput = Parameters<ProbeAcpxRuntimeReadiness>[0];
type AcpxRuntimeReadinessProbeResult = Awaited<
  ReturnType<ProbeAcpxRuntimeReadiness>
>;

const acpxRuntimeMocks = vi.hoisted(() => ({
  probeAcpxRuntimeReadiness: vi.fn(),
}));

vi.mock(
  "@paperclipai/adapter-utils/acpx-runtime",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@paperclipai/adapter-utils/acpx-runtime")
    >()),
    probeAcpxRuntimeReadiness: acpxRuntimeMocks.probeAcpxRuntimeReadiness,
  }),
);

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const TASK_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const AGENT_ID = "00000000-0000-4000-8000-000000000004";
const REVISION_ID = "00000000-0000-4000-8000-000000000005";
const BINDING_ID = "00000000-0000-4000-8000-000000000007";
const WORKSPACE = "/workspace/exact";
const TARGET_WORKSPACE = "/target/workspace/exact";
const ACPX_AGENT_NAME = "fixture-agent";
const ACP_CONFIGURATION: AgentAdapterAcpConfiguration = {
  contractVersion: "acpx-runtime/v1",
  launchProfile: {
    registryName: ACPX_AGENT_NAME,
  },
  sessionConfigSelections: [
    { configId: "fast_mode", value: true },
    { configId: "model", value: "gpt-5" },
    { configId: "reasoning_effort", value: "high" },
  ],
  model: {
    value: "gpt-5",
    label: "GPT-5",
  },
};

const TARGET: AcpxLocalWorkspaceTarget = Object.freeze({
  kind: "local",
  leaseId: "readiness-lease",
});

function persistedBinding(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    companyId: COMPANY_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    runKind: "productive" as const,
    runStatus: "queued" as const,
    agentId: AGENT_ID,
    currentAdapterConfigRevisionId: REVISION_ID,
    adapterConfigRevisionId: REVISION_ID,
    executionWorkspaceBindingId: BINDING_ID,
    absoluteCwd: WORKSPACE,
    acpConfiguration: ACP_CONFIGURATION,
    ...overrides,
  });
}

interface HarnessOptions {
  readonly binding?: ReturnType<typeof persistedBinding>;
  readonly acquisitionError?: unknown;
  readonly probeError?: unknown;
  readonly releaseError?: unknown;
}

function createHarness(options: HarnessOptions = {}) {
  const binding = options.binding ?? persistedBinding();
  const acquisitionInputs: unknown[] = [];
  const probeInputs: AcpxRuntimeReadinessProbeInput[] = [];
  const releases: boolean[] = [];

  const repository: AdapterRuntimeReadinessRepository = {
    async loadExactBinding() {
      return binding;
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
  };
  acpxRuntimeMocks.probeAcpxRuntimeReadiness
    .mockReset()
    .mockImplementation(async (input: AcpxRuntimeReadinessProbeInput) => {
      probeInputs.push(input);
      if (options.probeError) throw options.probeError;
      return Object.freeze({
        capabilities: Object.freeze({ controls: ["session/status"] }),
        status: Object.freeze({ backendSessionId: "provider-session" }),
      }) as AcpxRuntimeReadinessProbeResult;
    });

  return {
    service: createAdapterConfigurationPreflightService({
      repository,
      runtime,
    }),
    acquisitionInputs,
    probeInputs,
    releases,
  };
}

const IDENTITY = Object.freeze({
  companyId: COMPANY_ID,
  taskId: TASK_ID,
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
      expect(harness.probeInputs).toEqual([]);
    },
  );

  it("binds the exact persisted scope and delegates generic settings to ACPX", async () => {
    const harness = createHarness();

    const result = await harness.service.inspect(IDENTITY);

    expect(result).toEqual({
      status: "ready",
      scope: {
        runId: RUN_ID,
        agentId: AGENT_ID,
        adapterConfigRevisionId: REVISION_ID,
      },
      runtimeControls: ["session/status"],
    });
    expect(harness.acquisitionInputs).toEqual([{
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      targetAgentId: AGENT_ID,
      adapterConfigRevisionId: REVISION_ID,
      executionWorkspaceBindingId: BINDING_ID,
      acpConfiguration: ACP_CONFIGURATION,
      hostCwd: WORKSPACE,
      localWorkspaceCwd: WORKSPACE,
      targetAdditionalDirectories: [],
    }]);
    expect(harness.probeInputs).toEqual([{
      cwd: TARGET_WORKSPACE,
      registryCwd: process.cwd(),
      agentName: ACPX_AGENT_NAME,
      configSelections: ACP_CONFIGURATION.sessionConfigSelections,
    }]);
    expect(harness.releases).toEqual([false]);
  });

  it.each([
    [
      "generic ACPX setup failure",
      { probeError: new Error("ACPX session rejected") },
      "acp_initialization_failed",
    ],
    [
      "missing ACPX control",
      {
        probeError: new AcpxRuntimeReadinessCapabilityError(
          "session/set_config_option unavailable",
        ),
      },
      "acp_capability_incompatible",
    ],
    [
      "disposable ACPX state cleanup failure",
      {
        probeError: new AcpxRuntimeReadinessCleanupError({
          cleanupErrors: [new Error("state cleanup failed")],
        }),
      },
      "target_cleanup_failed",
    ],
  ] as const)("fails closed for %s", async (_label, options, reason) => {
    const harness = createHarness(options);
    await expect(harness.service.inspect(IDENTITY)).resolves.toMatchObject({
      status: "incomplete",
      reason,
    });
    expect(harness.releases).toEqual([true]);
  });

  it.each([
    [
      new LocalExecutionTargetError("lease_acquire_failed", "missing"),
      "execution_target_unavailable",
    ],
    [
      new LocalExecutionTargetError(
        "workspace_binding_unavailable",
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
    expect(harness.probeInputs).toEqual([]);
  });

  it("lets target lease cleanup failure override a successful ACPX probe", async () => {
    const harness = createHarness({
      releaseError: new Error("release failed"),
    });

    await expect(harness.service.inspect(IDENTITY)).resolves.toMatchObject({
      status: "incomplete",
      reason: "target_cleanup_failed",
    });
    expect(harness.releases).toEqual([false]);
  });
});
