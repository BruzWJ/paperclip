import { describe, expect, it, vi } from "vitest";
import {
  AcpxRuntimeReadinessCapabilityError,
  AcpxRuntimeReadinessCleanupError,
  type AcpxRuntimeReadinessProbeInput,
  type AcpxRuntimeReadinessProbeResult,
} from "@paperclipai/adapter-utils/acp-subprocess";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
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
  readonly acquiredTarget?: AdapterExecutionTarget;
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
    async resolveCompanySkills() {
      if (options.companySkillsError) throw options.companySkillsError;
      return options.companySkills ?? OPERATOR_NATIVE;
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
          executionTarget: options.acquiredTarget ?? TARGET,
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
    async probeAcpxRuntimeReadiness(input) {
      probeInputs.push(input);
      if (options.probeError) throw options.probeError;
      return Object.freeze({
        capabilities: Object.freeze({ controls: ["session/status"] }),
        status: Object.freeze({ backendSessionId: "provider-session" }),
      }) as AcpxRuntimeReadinessProbeResult;
    },
  };

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
        environmentId: ENVIRONMENT_ID,
        executionWorkspaceBindingId: BINDING_ID,
      },
      runtimeControls: ["session/status"],
    });
    expect(harness.acquisitionInputs).toEqual([{
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
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

  it("maps a rejected skill revision to typed configuration-incomplete before the ACPX probe", async () => {
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
    expect(harness.probeInputs).toEqual([]);
  });

  it("does not disguise an unexpected skill repository failure as invalid configuration", async () => {
    const failure = new Error("database disconnected");
    const harness = createHarness({ companySkillsError: failure });
    await expect(harness.service.inspect(IDENTITY)).rejects.toBe(failure);
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
      remediationCommand: null,
    });
    expect(harness.releases).toEqual([true]);
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
    expect(harness.probeInputs).toEqual([]);
  });

  it("rejects a non-local acquired target without attempting an ACPX process", async () => {
    const harness = createHarness({
      acquiredTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/remote/workspace",
        spec: {
          host: "example.test",
          port: 22,
          username: "agent",
          remoteWorkspacePath: "/remote/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
          remoteCwd: "/remote/workspace",
        },
      },
    });

    await expect(harness.service.inspect(IDENTITY)).resolves.toMatchObject({
      status: "incomplete",
      reason: "execution_target_unavailable",
    });
    expect(harness.probeInputs).toEqual([]);
    expect(harness.releases).toEqual([true]);
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
