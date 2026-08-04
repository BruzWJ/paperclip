import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAcpRuntime,
  createRuntimeStore,
  type AcpRuntimeCapabilities,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
} from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  listAcpxAgentNames,
  probeAcpxAgent,
  type AcpxDiscoveryRuntime,
} from "./acpx-discovery.js";

const fixtureEntrypoint = fileURLToPath(
  new URL("./fixtures/acp-agent-fixture.mjs", import.meta.url),
);

describe("dynamic ACPX discovery", () => {
  it("returns only names supplied by the ACPX registry", async () => {
    const createRegistry = vi.fn(() => ({
      list: () => ["runner-a", "runner-b", "runner-a", " malformed "],
      resolve: () => "not-used",
    }));

    await expect(
      listAcpxAgentNames({
        dependencies: { createAgentRegistry: createRegistry },
      }),
    ).resolves.toEqual(["runner-a", "runner-b"]);
    expect(createRegistry).toHaveBeenCalledOnce();
  });

  it("rejects a name that ACPX did not list before creating a runtime", async () => {
    const createRuntime = vi.fn();

    await expect(
      probeAcpxAgent({
        cwd: process.cwd(),
        agentName: "not-listed",
        dependencies: {
          createAgentRegistry: () => ({
            list: () => ["listed-agent"],
            resolve: () => "must-not-resolve",
          }),
          createAcpRuntime: createRuntime,
        },
      }),
    ).rejects.toThrow(/not registry-listed/);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("uses ACPX's live status for models and generic config options, then removes private state", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-acpx-discovery-test-"),
    );
    const createRuntime = vi.fn((options: AcpRuntimeOptions) =>
      createAcpRuntime(options),
    );
    const removeTemporaryStateDir = vi.fn(async (directory: string) => {
      await fs.rm(directory, { recursive: true, force: true });
    });
    const registry = {
      list: () => ["fixture"],
      resolve: () => [process.execPath, fixtureEntrypoint],
    };

    const result = await probeAcpxAgent({
      cwd: process.cwd(),
      agentName: "fixture",
      dependencies: {
        createAgentRegistry: () => registry,
        createAcpRuntime: createRuntime,
        createRuntimeStore,
        createTemporaryStateDir: async () => stateDir,
        removeTemporaryStateDir,
        createSessionKey: () => "fixture-discovery",
      },
    });

    expect(result).toEqual({
      agentName: "fixture",
      controls: [
        "session/set_mode",
        "session/set_config_option",
        "session/status",
      ],
      configOptionKeys: [
        "alpha-model",
        "zeta-enabled",
        "reasoning_effort",
        "omega-observer",
      ],
      models: ["model-a", "model-b"],
      currentModelId: "model-a",
      configOptions: [
        {
          id: "alpha-model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "model-a",
          options: [
            { kind: "value", value: "model-a", name: "Model A" },
            { kind: "value", value: "model-b", name: "Model B" },
          ],
        },
        {
          id: "zeta-enabled",
          name: "Enabled",
          type: "boolean",
          currentValue: false,
          options: [],
        },
        {
          id: "reasoning_effort",
          name: "Reasoning effort",
          type: "select",
          currentValue: "medium",
          options: [
            { kind: "value", value: "low", name: "Low" },
            { kind: "value", value: "medium", name: "Medium" },
            { kind: "value", value: "high", name: "High" },
          ],
        },
        {
          id: "omega-observer",
          name: "Observer",
          type: "boolean",
          currentValue: false,
          options: [],
        },
      ],
    });
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRegistry: registry,
        cwd: process.cwd(),
        probeAgent: "fixture",
        mcpServers: [],
        permissionMode: "deny-all",
        nonInteractivePermissions: "deny",
      }),
    );
    expect(removeTemporaryStateDir).toHaveBeenCalledWith(stateDir);
    await expect(fs.access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an agent compatible when it advertises no model selector", async () => {
    const handle: AcpRuntimeHandle = {
      sessionKey: "memory-probe",
      backend: "acpx",
      runtimeSessionName: "memory-probe",
    };
    const close = vi.fn(async (input: { discardPersistentState?: boolean }) => {
      if (input.discardPersistentState) {
        throw new Error("the fixture does not support session/close");
      }
    });
    const capabilities: AcpRuntimeCapabilities = {
      controls: ["session/status", "session/set_config_option"],
      configOptionKeys: ["enabled"],
    };
    const runtime: AcpxDiscoveryRuntime = {
      ensureSession: vi.fn(async () => handle),
      getCapabilities: vi.fn(async () => capabilities),
      getStatus: vi.fn(async () => ({
        details: {
          configOptions: [
            {
              id: "enabled",
              name: "Enabled",
              type: "boolean",
              currentValue: true,
            },
          ],
        },
      })),
      setConfigOption: vi.fn(async () => {}),
      close,
    };
    const removeTemporaryStateDir = vi.fn(async () => {});

    const result = await probeAcpxAgent({
      cwd: process.cwd(),
      agentName: "boolean-only",
      dependencies: {
        createAgentRegistry: () => ({
          list: () => ["boolean-only"],
          resolve: () => "not-used-by-the-fake-runtime",
        }),
        createRuntimeStore: () => ({
          load: async () => undefined,
          save: async () => {},
        }),
        createAcpRuntime: () => runtime,
        createTemporaryStateDir: async () => "/private/discovery-state",
        removeTemporaryStateDir,
        createSessionKey: () => "memory-probe",
      },
    });

    expect(result).toEqual({
      agentName: "boolean-only",
      controls: ["session/status", "session/set_config_option"],
      configOptionKeys: ["enabled"],
      models: [],
      configOptions: [
        {
          id: "enabled",
          name: "Enabled",
          type: "boolean",
          currentValue: true,
          options: [],
        },
      ],
    });
    expect(close).toHaveBeenNthCalledWith(1, {
      handle,
      reason: "temporary ACPX discovery session",
      discardPersistentState: true,
    });
    expect(close).toHaveBeenNthCalledWith(2, {
      handle,
      reason: "temporary ACPX discovery session",
      discardPersistentState: false,
    });
    expect(removeTemporaryStateDir).toHaveBeenCalledWith(
      "/private/discovery-state",
    );
    expect(runtime.setConfigOption).toHaveBeenCalledWith({
      handle,
      key: "enabled",
      value: "true",
    });
  });

  it("normalizes ACPX display metadata without changing ACPX configuration values", async () => {
    const handle: AcpRuntimeHandle = {
      sessionKey: "display-metadata-probe",
      backend: "acpx",
      runtimeSessionName: "display-metadata-probe",
    };
    const capabilities: AcpRuntimeCapabilities = {
      controls: ["session/status", "session/set_config_option"],
      configOptionKeys: ["model"],
    };
    const runtime: AcpxDiscoveryRuntime = {
      ensureSession: vi.fn(async () => handle),
      getCapabilities: vi.fn(async () => capabilities),
      getStatus: vi.fn(async () => ({
        models: {
          currentModelId: "model-a",
          availableModelIds: ["model-a", "model-b"],
        },
        details: {
          configOptions: [
            {
              id: "model",
              name: " Model ",
              type: "select",
              category: " model ",
              currentValue: "model-a",
              options: [
                { value: "model-a", name: " Model A " },
                { value: "model-b", name: "   " },
              ],
            },
          ],
        },
      })),
      setConfigOption: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };

    const result = await probeAcpxAgent({
      cwd: process.cwd(),
      agentName: "display-metadata-agent",
      dependencies: {
        createAgentRegistry: () => ({
          list: () => ["display-metadata-agent"],
          resolve: () => "not-used-by-the-fake-runtime",
        }),
        createRuntimeStore: () => ({
          load: async () => undefined,
          save: async () => {},
        }),
        createAcpRuntime: () => runtime,
        createTemporaryStateDir: async () => "/private/discovery-state",
        removeTemporaryStateDir: async () => {},
        createSessionKey: () => "display-metadata-probe",
      },
    });

    expect(result.configOptions).toEqual([
      {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: "model-a",
        options: [
          { kind: "value", value: "model-a", name: "Model A" },
          // A missing display label uses the exact ACPX choice value only as
          // presentation text; the configuration value is never normalized.
          { kind: "value", value: "model-b", name: "model-b" },
        ],
      },
    ]);
    expect(runtime.setConfigOption).toHaveBeenCalledWith({
      handle,
      key: "model",
      value: "model-a",
    });
  });

  it("uses ACPX's public no-prompt availability probe before opening a session", async () => {
    const ensureSession = vi.fn();
    const doctor = vi.fn(async () => ({ ok: false }));

    await expect(
      probeAcpxAgent({
        cwd: process.cwd(),
        agentName: "unavailable",
        dependencies: {
          createAgentRegistry: () => ({
            list: () => ["unavailable"],
            resolve: () => "not-used-by-the-fake-runtime",
          }),
          createRuntimeStore: () => ({
            load: async () => undefined,
            save: async () => {},
          }),
          createAcpRuntime: () => ({
            doctor,
            ensureSession,
            getStatus: async () => ({}),
            setConfigOption: async () => {},
            close: async () => {},
          }),
          createTemporaryStateDir: async () => "/private/discovery-state",
          removeTemporaryStateDir: async () => {},
        },
      }),
    ).rejects.toThrow("ACPX frontend availability probe failed");

    expect(doctor).toHaveBeenCalledOnce();
    expect(ensureSession).not.toHaveBeenCalled();
  });
});
