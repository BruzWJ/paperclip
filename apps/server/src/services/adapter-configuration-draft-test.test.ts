import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpxRuntimeReadinessCapabilityError,
  AcpxRuntimeReadinessCleanupError,
} from "@paperclipai/adapter-utils/acpx-runtime";
import {
  createAdapterConfigurationDraftTestService,
} from "./adapter-configuration-draft-test.js";
import type {
  ResolvedRegisteredAdapterRuntimeConfiguration,
} from "./agent-adapter-config-revisions.js";

type AcpxRuntimeReadinessProbeInput = Parameters<
  typeof import("@paperclipai/adapter-utils/acpx-runtime").probeAcpxRuntimeReadiness
>[0];

const moduleMocks = vi.hoisted(() => ({
  createTemporarySessionCwd: vi.fn(),
  probeAcpxRuntimeReadiness: vi.fn(),
  removeTemporarySessionCwd: vi.fn(),
  resolveRegisteredAdapterRuntimeConfiguration: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdtemp: moduleMocks.createTemporarySessionCwd,
  rm: moduleMocks.removeTemporarySessionCwd,
}));

vi.mock(
  "@paperclipai/adapter-utils/acpx-runtime",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@paperclipai/adapter-utils/acpx-runtime")
    >()),
    probeAcpxRuntimeReadiness: moduleMocks.probeAcpxRuntimeReadiness,
  }),
);

vi.mock("./agent-adapter-config-revisions.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./agent-adapter-config-revisions.js")
  >()),
  resolveRegisteredAdapterRuntimeConfiguration:
    moduleMocks.resolveRegisteredAdapterRuntimeConfiguration,
}));

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
    acpConfiguration: ACP_CONFIGURATION,
  };
}

function createHarness(probeError?: unknown) {
  moduleMocks.resolveRegisteredAdapterRuntimeConfiguration.mockResolvedValue(
    resolvedConfiguration(),
  );
  moduleMocks.createTemporarySessionCwd.mockResolvedValue(
    "/private/draft-test-workspace",
  );
  moduleMocks.removeTemporarySessionCwd.mockResolvedValue(undefined);
  moduleMocks.probeAcpxRuntimeReadiness.mockImplementation(async (
    _input: AcpxRuntimeReadinessProbeInput,
  ) => {
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
    service: createAdapterConfigurationDraftTestService(),
  };
}

describe("unsaved adapter configuration test", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(TESTED_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

    expect(
      moduleMocks.resolveRegisteredAdapterRuntimeConfiguration,
    ).toHaveBeenCalledWith({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    });
    expect(moduleMocks.createTemporarySessionCwd).toHaveBeenCalledWith(
      join(tmpdir(), "paperclip-acpx-draft-test-"),
    );
    expect(moduleMocks.probeAcpxRuntimeReadiness).toHaveBeenCalledWith({
      cwd: "/private/draft-test-workspace",
      registryCwd: process.cwd(),
      agentName: ADAPTER_TYPE,
      configSelections: ACP_CONFIGURATION.sessionConfigSelections,
    });
    expect(moduleMocks.removeTemporarySessionCwd).toHaveBeenCalledWith(
      "/private/draft-test-workspace",
      { recursive: true, force: true },
    );
  });

  it.each([
    {
      error: new AcpxRuntimeReadinessCapabilityError(
        "secret provider detail",
      ),
      reason: "acp_capability_incompatible",
      message:
        "The local agent runtime does not expose the controls required by this configuration.",
    },
    {
      error: new AcpxRuntimeReadinessCleanupError({
        operationError: new Error("secret provider detail"),
        cleanupErrors: [new Error("secret cleanup detail")],
      }),
      reason: "acp_cleanup_failed",
      message:
        "Paperclip could not verify cleanup of the disposable test session.",
    },
    {
      error: new Error("secret provider detail"),
      reason: "acp_initialization_failed",
      message:
        "Paperclip could not initialize the local agent with this configuration.",
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
      expect(moduleMocks.removeTemporarySessionCwd).toHaveBeenCalledWith(
        "/private/draft-test-workspace",
        { recursive: true, force: true },
      );
    },
  );

  it("fails a ready observation when Paperclip cannot remove the isolated test workspace", async () => {
    const harness = createHarness();
    moduleMocks.removeTemporarySessionCwd.mockRejectedValue(
      new Error("secret filesystem detail"),
    );

    const result = await harness.service.test({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    });

    expect(result).toEqual({
      status: "failed",
      adapterType: ADAPTER_TYPE,
      reason: "acp_cleanup_failed",
      message:
        "Paperclip could not remove the isolated local agent test workspace.",
      testedAt: TESTED_AT.toISOString(),
    });
    expect(JSON.stringify(result)).not.toContain("secret filesystem detail");
  });

  it("reports a sanitized initialization failure when the isolated test workspace cannot be created", async () => {
    const harness = createHarness();
    moduleMocks.createTemporarySessionCwd.mockRejectedValue(
      new Error("secret filesystem detail"),
    );

    const result = await harness.service.test({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    });

    expect(result).toEqual({
      status: "failed",
      adapterType: ADAPTER_TYPE,
      reason: "acp_initialization_failed",
      message:
        "Paperclip could not prepare an execution workspace for the local agent test.",
      testedAt: TESTED_AT.toISOString(),
    });
    expect(JSON.stringify(result)).not.toContain("secret filesystem detail");
    expect(moduleMocks.probeAcpxRuntimeReadiness).not.toHaveBeenCalled();
    expect(moduleMocks.removeTemporarySessionCwd).not.toHaveBeenCalled();
  });

  it("does not disguise canonical catalog or structural validation failures as runtime observations", async () => {
    const validationError = new Error(
      "Adapter configuration is structurally invalid",
    );
    const harness = createHarness();
    moduleMocks.resolveRegisteredAdapterRuntimeConfiguration.mockRejectedValue(
      validationError,
    );

    await expect(harness.service.test({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    })).rejects.toBe(validationError);
    expect(moduleMocks.probeAcpxRuntimeReadiness).not.toHaveBeenCalled();
    expect(moduleMocks.createTemporarySessionCwd).not.toHaveBeenCalled();
  });
});
