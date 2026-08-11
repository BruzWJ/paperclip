import type {
  AcpAgentRegistry,
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeHandle,
  AcpSessionStore,
} from "acpx/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpxRuntimeReadinessCapabilityError,
  AcpxRuntimeReadinessCleanupError,
  probeAcpxRuntimeReadiness,
} from "./acpx-runtime-readiness.js";

const runtimeMocks = vi.hoisted(() => ({
  create: vi.fn(),
  createStore: vi.fn(),
}));
const registryMocks = vi.hoisted(() => ({ load: vi.fn() }));
const stateMocks = vi.hoisted(() => ({
  createKey: vi.fn(),
  createDir: vi.fn(),
  removeDir: vi.fn(),
}));

vi.mock("acpx/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("acpx/runtime")>(),
  createAcpRuntime: runtimeMocks.create,
  createRuntimeStore: runtimeMocks.createStore,
}));
vi.mock("./agent-registry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./agent-registry.js")>(),
  loadAcpxAgentRegistry: registryMocks.load,
}));
vi.mock("./temporary-state.js", () => ({
  createTemporarySessionKey: stateMocks.createKey,
  createTemporaryStateDir: stateMocks.createDir,
  removeTemporaryStateDir: stateMocks.removeDir,
}));

type ProbeRuntime = Pick<AcpRuntime, "ensureSession" | "close"> & Partial<
  Pick<
    AcpRuntime,
    "doctor" | "getCapabilities" | "getStatus" | "setConfigOption"
  >
>;

const handle: AcpRuntimeHandle = {
  sessionKey: "probe-session",
  backend: "acpx",
  runtimeSessionName: "probe-session",
  backendSessionId: "provider-session",
};
const capabilities: AcpRuntimeCapabilities = {
  controls: ["session/status", "session/set_config_option"],
  configOptionKeys: ["model", "reasoning_effort", "fast_mode"],
};

function registry(names: readonly string[] = ["fixture"]): AcpAgentRegistry {
  return {
    list: () => [...names],
    resolve: () => process.execPath,
  };
}

function store(): AcpSessionStore {
  return { load: async () => undefined, save: async () => {} };
}

function runtime(overrides: Partial<ProbeRuntime> = {}): ProbeRuntime {
  return {
    doctor: vi.fn(async () => ({ ok: true, message: "available" })),
    ensureSession: vi.fn(async () => handle),
    getCapabilities: vi.fn(async () => capabilities),
    getStatus: vi.fn(async () => ({ backendSessionId: "provider-session" })),
    setConfigOption: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  runtimeMocks.create.mockReset();
  runtimeMocks.createStore.mockReset().mockReturnValue(store());
  registryMocks.load.mockReset().mockResolvedValue(registry());
  stateMocks.createKey.mockReset().mockReturnValue("probe-session");
  stateMocks.createDir.mockReset().mockResolvedValue("/private/probe-state");
  stateMocks.removeDir.mockReset().mockResolvedValue(undefined);
});

describe("canonical disposable ACPX probe", () => {
  it("owns the no-prompt lifecycle and applies exact generic settings", async () => {
    const probeRuntime = runtime();
    runtimeMocks.create.mockReturnValue(probeRuntime);

    const result = await probeAcpxRuntimeReadiness({
      cwd: "/execution/workspace",
      registryCwd: "/paperclip/acpx-config",
      agentName: "fixture",
      configSelections: [
        { configId: "model", value: "model-b" },
        { configId: "reasoning_effort", value: "high" },
        { configId: "fast_mode", value: true },
      ],
    });

    expect(result).toEqual({
      capabilities,
      status: { backendSessionId: "provider-session" },
    });
    expect(registryMocks.load).toHaveBeenCalledWith("/paperclip/acpx-config");
    expect(runtimeMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/execution/workspace",
      probeAgent: "fixture",
      mcpServers: [],
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
      timeoutMs: 15_000,
    }));
    expect(probeRuntime.doctor).toHaveBeenCalledOnce();
    expect(probeRuntime.ensureSession).toHaveBeenCalledWith({
      sessionKey: "probe-session",
      agent: "fixture",
      mode: "persistent",
      cwd: "/execution/workspace",
    });
    expect(probeRuntime.setConfigOption).toHaveBeenNthCalledWith(1, {
      handle,
      key: "model",
      value: "model-b",
    });
    expect(probeRuntime.setConfigOption).toHaveBeenNthCalledWith(2, {
      handle,
      key: "reasoning_effort",
      value: "high",
    });
    expect(probeRuntime.setConfigOption).toHaveBeenNthCalledWith(3, {
      handle,
      key: "fast_mode",
      value: "true",
    });
    expect(probeRuntime.close).toHaveBeenCalledWith({
      handle,
      reason: "temporary ACPX probe session",
      discardPersistentState: true,
    });
    expect(stateMocks.removeDir).toHaveBeenCalledWith("/private/probe-state");
  });

  it("rejects unknown agents before allocating disposable state", async () => {
    await expect(probeAcpxRuntimeReadiness({
      cwd: "/workspace",
      agentName: "unlisted-command --unsafe",
      configSelections: [],
    })).rejects.toThrow("ACP registry name is not listed by ACPX");
    expect(runtimeMocks.create).not.toHaveBeenCalled();
    expect(stateMocks.createDir).not.toHaveBeenCalled();
  });

  it("rejects unavailable package launches before creating a runtime", async () => {
    registryMocks.load.mockResolvedValue({
      list: () => ["definitely-not-installed-agent"],
      resolve: () => ["npx", "-y", "definitely-not-installed-package"],
    });

    await expect(probeAcpxRuntimeReadiness({
      cwd: process.cwd(),
      agentName: "definitely-not-installed-agent",
      configSelections: [],
    })).rejects.toThrow("ACPX agent is not locally available");
    expect(runtimeMocks.create).not.toHaveBeenCalled();
    expect(stateMocks.createDir).not.toHaveBeenCalled();
  });

  it("cleans state when ACPX's frontend probe fails before session creation", async () => {
    const ensureSession = vi.fn();
    const probeRuntime = runtime({
      doctor: vi.fn(async () => ({ ok: false, message: "unavailable" })),
      ensureSession,
    });
    runtimeMocks.create.mockReturnValue(probeRuntime);

    await expect(probeAcpxRuntimeReadiness({
      cwd: "/workspace",
      agentName: "fixture",
      configSelections: [],
    })).rejects.toThrow("ACPX frontend availability probe failed");
    expect(ensureSession).not.toHaveBeenCalled();
    expect(probeRuntime.close).not.toHaveBeenCalled();
    expect(stateMocks.removeDir).toHaveBeenCalledWith("/private/probe-state");
  });

  it("fails closed when persisted settings cannot be applied", async () => {
    const probeRuntime = runtime({
      getCapabilities: vi.fn(async (): Promise<AcpRuntimeCapabilities> => ({
        controls: ["session/status"],
      })),
    });
    runtimeMocks.create.mockReturnValue(probeRuntime);

    await expect(probeAcpxRuntimeReadiness({
      cwd: "/workspace",
      agentName: "fixture",
      configSelections: [{ configId: "reasoning_effort", value: "high" }],
    })).rejects.toBeInstanceOf(AcpxRuntimeReadinessCapabilityError);
    expect(probeRuntime.getStatus).not.toHaveBeenCalled();
    expect(probeRuntime.close).toHaveBeenCalledWith({
      handle,
      reason: "temporary ACPX probe session",
      discardPersistentState: true,
    });
    expect(stateMocks.removeDir).toHaveBeenCalledWith("/private/probe-state");
  });

  it("reports operation and all cleanup failures through one error", async () => {
    const operationError = new Error("status failed");
    const closeError = new Error("close failed");
    const stateError = new Error("remove failed");
    runtimeMocks.create.mockReturnValue(runtime({
      getStatus: vi.fn(async () => { throw operationError; }),
      close: vi.fn(async () => { throw closeError; }),
    }));
    stateMocks.removeDir.mockRejectedValue(stateError);

    let failure: unknown;
    try {
      await probeAcpxRuntimeReadiness({
        cwd: "/workspace",
        agentName: "fixture",
        configSelections: [],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AcpxRuntimeReadinessCleanupError);
    expect(failure).toMatchObject({
      operationError,
      cleanupErrors: [closeError, stateError],
    });
  });
});
