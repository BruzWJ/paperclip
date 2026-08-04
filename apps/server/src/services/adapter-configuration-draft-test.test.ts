import { describe, expect, it, vi } from "vitest";
import {
  AcpxRuntimeReadinessCapabilityError,
  AcpxRuntimeReadinessCleanupError,
  type AcpxRuntimeReadinessProbeInput,
  type AcpxRuntimeReadinessProbeResult,
} from "@paperclipai/adapter-utils/acp-subprocess";
import {
  createAdapterConfigurationDraftTestService,
} from "./adapter-configuration-draft-test.js";
import type {
  ResolvedRegisteredAdapterRuntimeConfiguration,
} from "./agent-adapter-config-revisions.js";

const TESTED_AT = new Date("2026-08-04T18:00:00.000Z");
const ADAPTER_TYPE = "fixture-agent";
const ADAPTER_CONFIG = {
  model: "fixture-model",
  reasoning_effort: "high",
};
const ACP_CONFIGURATION = {
  contractVersion: "acpx-runtime/v1" as const,
  launchProfile: { registryName: ADAPTER_TYPE },
  sessionConfigSelections: [
    { configId: "model", value: "fixture-model" },
    { configId: "reasoning_effort", value: "high" },
  ],
  model: null,
};

function resolvedConfiguration(): ResolvedRegisteredAdapterRuntimeConfiguration {
  return {
    canonicalAdapterConfig: ADAPTER_CONFIG,
    runtimeMetadata: {} as never,
    acpConfiguration: ACP_CONFIGURATION,
  };
}

function createHarness(probeError?: unknown) {
  const resolveConfiguration = vi.fn(async () =>
    resolvedConfiguration());
  const probeInputs: AcpxRuntimeReadinessProbeInput[] = [];
  const removeTemporarySessionCwd = vi.fn(async () => {});
  const probe = vi.fn(async (
    input: AcpxRuntimeReadinessProbeInput,
  ): Promise<AcpxRuntimeReadinessProbeResult> => {
    probeInputs.push(input);
    if (probeError) throw probeError;
    return {
      capabilities: {
        controls: ["session/status", "session/set_config_option"],
        configOptionKeys: ["model", "reasoning_effort"],
      },
      status: { backendSessionId: "disposable-backend-session" },
    };
  });
  return {
    service: createAdapterConfigurationDraftTestService({
      resolveRegisteredAdapterRuntimeConfiguration:
        resolveConfiguration,
      probeAcpxRuntimeReadiness: probe,
      createTemporarySessionCwd: async () => "/private/draft-test-workspace",
      removeTemporarySessionCwd,
      serviceCwd: "/paperclip/service",
      now: () => TESTED_AT,
    }),
    resolveConfiguration,
    probe,
    probeInputs,
    removeTemporarySessionCwd,
  };
}

describe("unsaved adapter configuration test", () => {
  it("reuses canonical dynamic resolution and delegates exact generic selections to a no-prompt ACPX probe", async () => {
    const harness = createHarness();

    await expect(harness.service.test({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    })).resolves.toEqual({
      status: "ready",
      adapterType: ADAPTER_TYPE,
      runtimeControls: [
        "session/status",
        "session/set_config_option",
      ],
      testedAt: TESTED_AT.toISOString(),
    });

    expect(harness.resolveConfiguration).toHaveBeenCalledWith({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    });
    expect(harness.probeInputs).toEqual([{
      cwd: "/private/draft-test-workspace",
      registryCwd: "/paperclip/service",
      agentName: ADAPTER_TYPE,
      configSelections: ACP_CONFIGURATION.sessionConfigSelections,
      requireBackendSessionDiscard: true,
    }]);
    expect(harness.removeTemporarySessionCwd).toHaveBeenCalledWith(
      "/private/draft-test-workspace",
    );
  });

  it.each([
    {
      error: new AcpxRuntimeReadinessCapabilityError(
        "secret provider detail",
      ),
      reason: "acp_capability_incompatible",
      message:
        "The ACPX agent does not expose the runtime controls required by this configuration.",
    },
    {
      error: new AcpxRuntimeReadinessCleanupError({
        operationError: new Error("secret provider detail"),
        cleanupErrors: [new Error("secret cleanup detail")],
      }),
      reason: "acp_cleanup_failed",
      message:
        "ACPX could not prove cleanup of the disposable test session.",
    },
    {
      error: new Error("secret provider detail"),
      reason: "acp_initialization_failed",
      message:
        "ACPX could not initialize the agent with this configuration.",
    },
  ] as const)(
    "maps a runtime failure to $reason without returning raw provider output",
    async ({ error, reason, message }) => {
      const harness = createHarness(error);
      const result = await harness.service.test({
        adapterType: ADAPTER_TYPE,
        adapterConfig: ADAPTER_CONFIG,
      });

      expect(result).toEqual({
        status: "failed",
        adapterType: ADAPTER_TYPE,
        reason,
        message,
        testedAt: TESTED_AT.toISOString(),
      });
      expect(JSON.stringify(result)).not.toContain("secret provider detail");
      expect(harness.removeTemporarySessionCwd).toHaveBeenCalledWith(
        "/private/draft-test-workspace",
      );
    },
  );

  it("fails a ready observation when Paperclip cannot remove the isolated test workspace", async () => {
    const removeTemporarySessionCwd = vi.fn(async () => {
      throw new Error("secret filesystem detail");
    });
    const service = createAdapterConfigurationDraftTestService({
      resolveRegisteredAdapterRuntimeConfiguration: async () =>
        resolvedConfiguration(),
      probeAcpxRuntimeReadiness: async () => ({
        capabilities: {
          controls: ["session/status", "session/set_config_option"],
        },
        status: { backendSessionId: "disposable-backend-session" },
      }),
      createTemporarySessionCwd: async () =>
        "/private/draft-test-workspace",
      removeTemporarySessionCwd,
      serviceCwd: "/paperclip/service",
      now: () => TESTED_AT,
    });

    const result = await service.test({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    });

    expect(result).toEqual({
      status: "failed",
      adapterType: ADAPTER_TYPE,
      reason: "acp_cleanup_failed",
      message:
        "Paperclip could not remove the isolated ACPX agent test workspace.",
      testedAt: TESTED_AT.toISOString(),
    });
    expect(JSON.stringify(result)).not.toContain("secret filesystem detail");
  });

  it("reports a sanitized initialization failure when the isolated test workspace cannot be created", async () => {
    const probe = vi.fn();
    const service = createAdapterConfigurationDraftTestService({
      resolveRegisteredAdapterRuntimeConfiguration: async () =>
        resolvedConfiguration(),
      probeAcpxRuntimeReadiness: probe,
      createTemporarySessionCwd: async () => {
        throw new Error("secret filesystem detail");
      },
      now: () => TESTED_AT,
    });

    const result = await service.test({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    });

    expect(result).toEqual({
      status: "failed",
      adapterType: ADAPTER_TYPE,
      reason: "acp_initialization_failed",
      message:
        "Paperclip could not prepare an isolated workspace for the ACPX agent test.",
      testedAt: TESTED_AT.toISOString(),
    });
    expect(JSON.stringify(result)).not.toContain("secret filesystem detail");
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not disguise canonical catalog or structural validation failures as runtime observations", async () => {
    const validationError = new Error(
      "Adapter configuration is structurally invalid",
    );
    const probe = vi.fn();
    const createTemporarySessionCwd = vi.fn();
    const service = createAdapterConfigurationDraftTestService({
      resolveRegisteredAdapterRuntimeConfiguration: async () => {
        throw validationError;
      },
      probeAcpxRuntimeReadiness: probe,
      createTemporarySessionCwd,
    });

    await expect(service.test({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    })).rejects.toBe(validationError);
    expect(probe).not.toHaveBeenCalled();
    expect(createTemporarySessionCwd).not.toHaveBeenCalled();
  });
});
