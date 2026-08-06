import { describe, expect, it, vi } from "vitest";
import type {
  AcpAgentRegistry,
  AcpRuntimeCapabilities,
  AcpRuntimeHandle,
  AcpSessionStore,
} from "acpx/runtime";
import {
  AcpxRuntimeReadinessCapabilityError,
  AcpxRuntimeReadinessCleanupError,
  probeAcpxRuntimeReadiness,
  type AcpxRuntimeReadinessRuntime,
} from "./acpx-runtime-readiness.js";

function registry(names: readonly string[] = ["fixture"]): AcpAgentRegistry {
  return {
    list: () => [...names],
    resolve: (name) => [process.execPath, name],
  };
}

function store(): AcpSessionStore {
  return { load: async () => undefined, save: async () => {} };
}

describe("ACPX runtime readiness probe", () => {
  it("uses a disposable ACPX session and applies generic model, reasoning, and boolean settings", async () => {
    const handle: AcpRuntimeHandle = {
      sessionKey: "readiness-session",
      backend: "acpx",
      runtimeSessionName: "readiness-session",
      backendSessionId: "provider-session",
    };
    const setConfigOption = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const capabilities: AcpRuntimeCapabilities = {
      controls: ["session/status", "session/set_config_option"],
      configOptionKeys: ["model", "reasoning_effort", "fast_mode"],
    };
    const runtime: AcpxRuntimeReadinessRuntime = {
      ensureSession: vi.fn(async () => handle),
      getCapabilities: vi.fn(async () => capabilities),
      getStatus: vi.fn(async () => ({
        backendSessionId: "provider-session",
        models: { availableModelIds: ["model-b"] },
      })),
      setConfigOption,
      close,
    };
    const createAcpRuntime = vi.fn(() => runtime);
    const removeTemporaryStateDir = vi.fn(async () => {});

    const result = await probeAcpxRuntimeReadiness({
      cwd: "/workspace",
      agentName: "fixture",
      configSelections: [
        { configId: "model", value: "model-b" },
        { configId: "reasoning_effort", value: "high" },
        { configId: "fast_mode", value: true },
      ],
      dependencies: {
        loadAgentRegistry: async () => registry(),
        createAcpRuntime,
        createRuntimeStore: () => store(),
        createTemporaryStateDir: async () => "/private/readiness-state",
        removeTemporaryStateDir,
        createSessionKey: () => "readiness-session",
      },
    });

    expect(result).toMatchObject({
      capabilities: {
        controls: ["session/status", "session/set_config_option"],
      },
    });
    expect(createAcpRuntime).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      agentRegistry: expect.any(Object),
      mcpServers: [],
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
    }));
    expect(runtime.ensureSession).toHaveBeenCalledWith({
      sessionKey: "readiness-session",
      agent: "fixture",
      mode: "persistent",
      cwd: "/workspace",
    });
    expect(setConfigOption).toHaveBeenCalledTimes(3);
    expect(setConfigOption).toHaveBeenNthCalledWith(1, {
      handle,
      key: "model",
      value: "model-b",
    });
    expect(setConfigOption).toHaveBeenNthCalledWith(2, {
      handle,
      key: "reasoning_effort",
      value: "high",
    });
    expect(setConfigOption).toHaveBeenNthCalledWith(3, {
      handle,
      key: "fast_mode",
      value: "true",
    });
    expect(close).toHaveBeenCalledWith({
      handle,
      reason: "temporary ACPX readiness session",
      discardPersistentState: true,
    });
    expect(removeTemporaryStateDir).toHaveBeenCalledWith(
      "/private/readiness-state",
    );
  });

  it("loads the ACPX registry from the service scope without moving the disposable session out of its workspace", async () => {
    const handle: AcpRuntimeHandle = {
      sessionKey: "readiness-session",
      backend: "acpx",
      runtimeSessionName: "readiness-session",
      backendSessionId: "provider-session",
    };
    const registryCwds: string[] = [];
    const runtimeCwds: string[] = [];
    const sessionCwds: string[] = [];

    await expect(
      probeAcpxRuntimeReadiness({
        cwd: "/execution/workspace",
        registryCwd: "/paperclip/acpx-config",
        agentName: "fixture",
        configSelections: [],
        dependencies: {
          loadAgentRegistry: async ({ cwd }) => {
            registryCwds.push(cwd);
            return registry();
          },
          createRuntimeStore: () => store(),
          createTemporaryStateDir: async () => "/private/readiness-state",
          removeTemporaryStateDir: async () => {},
          createAcpRuntime: (options) => {
            runtimeCwds.push(options.cwd);
            return {
              ensureSession: async (input) => {
                if (!input.cwd) throw new Error("session cwd was omitted");
                sessionCwds.push(input.cwd);
                return handle;
              },
              getCapabilities: async () => ({
                controls: ["session/status", "session/set_config_option"],
              }),
              getStatus: async () => ({ backendSessionId: "provider-session" }),
              close: async () => {},
            };
          },
        },
      }),
    ).resolves.toMatchObject({
      capabilities: { controls: ["session/status", "session/set_config_option"] },
    });

    expect(registryCwds).toEqual(["/paperclip/acpx-config"]);
    expect(runtimeCwds).toEqual(["/execution/workspace"]);
    expect(sessionCwds).toEqual(["/execution/workspace"]);
  });

  it("never reaches ACPX's unknown-agent raw-command fallback", async () => {
    const ensureSession = vi.fn();
    const removeTemporaryStateDir = vi.fn(async () => {});

    await expect(
      probeAcpxRuntimeReadiness({
        cwd: "/workspace",
        agentName: "unlisted-command --unsafe",
        configSelections: [],
        dependencies: {
          loadAgentRegistry: async () => registry(["fixture"]),
          createRuntimeStore: () => store(),
          createAcpRuntime: () => ({
            ensureSession,
            close: async () => {},
          }),
          createTemporaryStateDir: async () => "/private/readiness-state",
          removeTemporaryStateDir,
        },
      }),
    ).rejects.toThrow("ACPX agent is not registry-listed");
    expect(ensureSession).not.toHaveBeenCalled();
    expect(removeTemporaryStateDir).toHaveBeenCalledWith(
      "/private/readiness-state",
    );
  });

  it("rejects an uninstalled package-runner agent before ACPX creates a runtime", async () => {
    const createAcpRuntime = vi.fn();
    const removeTemporaryStateDir = vi.fn(async () => {});

    await expect(
      probeAcpxRuntimeReadiness({
        cwd: process.cwd(),
        agentName: "definitely-not-installed-agent",
        configSelections: [],
        dependencies: {
          loadAgentRegistry: async () => ({
            list: () => ["definitely-not-installed-agent"],
            resolve: () => [
              "npx",
              "-y",
              "definitely-not-installed-package",
            ],
          }),
          createAcpRuntime,
          createTemporaryStateDir: async () => "/private/readiness-state",
          removeTemporaryStateDir,
        },
      }),
    ).rejects.toThrow("ACPX agent is not locally available");

    expect(createAcpRuntime).not.toHaveBeenCalled();
    expect(removeTemporaryStateDir).toHaveBeenCalledWith(
      "/private/readiness-state",
    );
  });

  it("fails closed when ACPX cannot apply a persisted generic setting", async () => {
    const handle: AcpRuntimeHandle = {
      sessionKey: "readiness-session",
      backend: "acpx",
      runtimeSessionName: "readiness-session",
      backendSessionId: "provider-session",
    };
    const close = vi.fn(async () => {});

    await expect(
      probeAcpxRuntimeReadiness({
        cwd: "/workspace",
        agentName: "fixture",
        configSelections: [{ configId: "reasoning_effort", value: "high" }],
        dependencies: {
          loadAgentRegistry: async () => registry(),
          createRuntimeStore: () => store(),
          createTemporaryStateDir: async () => "/private/readiness-state",
          removeTemporaryStateDir: async () => {},
          createAcpRuntime: () => ({
            ensureSession: async () => handle,
            getCapabilities: async () => ({
              controls: ["session/status"],
              configOptionKeys: [],
            }),
            getStatus: async () => ({ backendSessionId: "provider-session" }),
            close,
          }),
        },
      }),
    ).rejects.toBeInstanceOf(AcpxRuntimeReadinessCapabilityError);
    expect(close).toHaveBeenCalledWith({
      handle,
      reason: "temporary ACPX readiness session",
      discardPersistentState: true,
    });
  });

  it("surfaces cleanup failure rather than claiming disposable-state cleanup", async () => {
    const handle: AcpRuntimeHandle = {
      sessionKey: "readiness-session",
      backend: "acpx",
      runtimeSessionName: "readiness-session",
      backendSessionId: "provider-session",
    };

    await expect(
      probeAcpxRuntimeReadiness({
        cwd: "/workspace",
        agentName: "fixture",
        configSelections: [],
        dependencies: {
          loadAgentRegistry: async () => registry(),
          createRuntimeStore: () => store(),
          createTemporaryStateDir: async () => "/private/readiness-state",
          removeTemporaryStateDir: async () => {
            throw new Error("remove failed");
          },
          createAcpRuntime: () => ({
            ensureSession: async () => handle,
            getCapabilities: async () => ({
              controls: ["session/status", "session/set_config_option"],
            }),
            getStatus: async () => ({ backendSessionId: "provider-session" }),
            close: async () => {},
          }),
        },
      }),
    ).rejects.toBeInstanceOf(AcpxRuntimeReadinessCleanupError);
  });

  it("accepts a non-discarding close when a frontend lacks backend session close", async () => {
    const handle: AcpRuntimeHandle = {
      sessionKey: "readiness-session",
      backend: "acpx",
      runtimeSessionName: "readiness-session",
      backendSessionId: "provider-session",
    };
    const close = vi.fn(async (input: { discardPersistentState?: boolean }) => {
      if (input.discardPersistentState) {
        throw new Error("backend close unsupported");
      }
    });

    await expect(
      probeAcpxRuntimeReadiness({
        cwd: "/workspace",
        agentName: "fixture",
        configSelections: [],
        dependencies: {
          loadAgentRegistry: async () => registry(),
          createRuntimeStore: () => store(),
          createTemporaryStateDir: async () => "/private/readiness-state",
          removeTemporaryStateDir: async () => {},
          createAcpRuntime: () => ({
            ensureSession: async () => handle,
            getCapabilities: async () => ({
              controls: ["session/status", "session/set_config_option"],
            }),
            getStatus: async () => ({ backendSessionId: "provider-session" }),
            close,
          }),
        },
      }),
    ).resolves.toMatchObject({
      capabilities: { controls: ["session/status", "session/set_config_option"] },
    });
    expect(close).toHaveBeenNthCalledWith(1, {
      handle,
      reason: "temporary ACPX readiness session",
      discardPersistentState: true,
    });
    expect(close).toHaveBeenNthCalledWith(2, {
      handle,
      reason: "temporary ACPX readiness session",
      discardPersistentState: false,
    });
  });

  it("fails a strictly disposable probe when ACPX cannot discard the backend session", async () => {
    const handle: AcpRuntimeHandle = {
      sessionKey: "readiness-session",
      backend: "acpx",
      runtimeSessionName: "readiness-session",
      backendSessionId: "provider-session",
    };
    const close = vi.fn(async (input: { discardPersistentState?: boolean }) => {
      if (input.discardPersistentState) {
        throw new Error("backend close unsupported");
      }
    });
    const removeTemporaryStateDir = vi.fn(async () => {});

    await expect(
      probeAcpxRuntimeReadiness({
        cwd: "/workspace",
        agentName: "fixture",
        configSelections: [],
        requireBackendSessionDiscard: true,
        dependencies: {
          loadAgentRegistry: async () => registry(),
          createRuntimeStore: () => store(),
          createTemporaryStateDir: async () => "/private/readiness-state",
          removeTemporaryStateDir,
          createAcpRuntime: () => ({
            ensureSession: async () => handle,
            getCapabilities: async () => ({
              controls: ["session/status", "session/set_config_option"],
            }),
            getStatus: async () => ({ backendSessionId: "provider-session" }),
            close,
          }),
        },
      }),
    ).rejects.toBeInstanceOf(AcpxRuntimeReadinessCleanupError);
    expect(close).toHaveBeenNthCalledWith(1, {
      handle,
      reason: "temporary ACPX readiness session",
      discardPersistentState: true,
    });
    expect(close).toHaveBeenNthCalledWith(2, {
      handle,
      reason: "temporary ACPX readiness session",
      discardPersistentState: false,
    });
    expect(removeTemporaryStateDir).toHaveBeenCalledWith(
      "/private/readiness-state",
    );
  });
});
