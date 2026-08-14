import "./runtime-tool-gateway.test-suite-02-rejects-a-host-invalid-label.js";
import * as t from "./runtime-tool-gateway.test-support.js";
const { capability, createRuntimePluginToolPort, describe, expect, it, mintPluginRunContext, setup, vi } = t;

describe("runtime plugin tool port", () => {
  it("dispatches the compiler-bound bare name directly to the exact installation worker", async () => {
    const call = vi.fn(async () => ({
      ok: true,
      content: "found",
    }));
    const mint = vi.fn(async () => "pc_plugin_ctx_v1_direct");
    const port = createRuntimePluginToolPort({
      getWorker: vi.fn(() => ({
        status: "running",
        manifestIdentity: "manifest-1",
        call,
      })),
    } as never);

    await expect(
      port.execute({
        capability,
        toolName: "lookup",
        pluginInstallationId: "plugin-installation",
        pluginManifestIdentity: "manifest-1",
        arguments: { query: "x" },
        mintPluginRunContext: mint,
      }),
    ).resolves.toEqual({ ok: true, content: "found" });

    expect(call).toHaveBeenCalledWith(
      "executeTool",
      {
        toolName: "lookup",
        parameters: { query: "x" },
        runContextHandle: "pc_plugin_ctx_v1_direct",
      },
      undefined,
      {
        companyId: "company",
        pluginRunContextHandle: "pc_plugin_ctx_v1_direct",
      },
    );
  });

  it("does not mint a run context when the exact installation worker is unavailable", async () => {
    const call = vi.fn();
    const mint = vi.fn(async () => "pc_plugin_ctx_v1_unused");
    const port = createRuntimePluginToolPort({
      getWorker: vi.fn(() => undefined),
    } as never);

    await expect(
      port.execute({
        capability,
        toolName: "lookup",
        pluginInstallationId: "plugin-installation",
        pluginManifestIdentity: "manifest-1",
        arguments: {},
        mintPluginRunContext: mint,
      }),
    ).rejects.toThrow(/exact compiled plugin runtime is not running/);
    expect(mint).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a replacement worker with a different manifest identity", async () => {
    const call = vi.fn();
    const mint = vi.fn(async () => "pc_plugin_ctx_v1_unused");
    const port = createRuntimePluginToolPort({
      getWorker: vi.fn(() => ({
        status: "running",
        manifestIdentity: "manifest-2",
        call,
      })),
    } as never);

    await expect(
      port.execute({
        capability,
        toolName: "lookup",
        pluginInstallationId: "plugin-installation",
        pluginManifestIdentity: "manifest-1",
        arguments: {},
        mintPluginRunContext: mint,
      }),
    ).rejects.toThrow(/exact compiled plugin runtime is not running/);
    expect(mint).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("preserves a declared plugin tool failure as a ToolResult", async () => {
    const call = vi.fn(async () => ({
      ok: false,
      error: "query is required",
    }));
    const port = createRuntimePluginToolPort({
      getWorker: vi.fn(() => ({
        status: "running",
        manifestIdentity: "manifest-1",
        call,
      })),
    } as never);

    await expect(
      port.execute({
        capability,
        toolName: "lookup",
        pluginInstallationId: "plugin-installation",
        pluginManifestIdentity: "manifest-1",
        arguments: {},
        mintPluginRunContext: vi.fn(async () => "pc_plugin_ctx_v1_direct"),
      }),
    ).resolves.toEqual({ ok: false, error: "query is required" });
  });

  it("rejects a worker response outside the plugin ToolResult contract", async () => {
    const call = vi.fn(async () => ({ legacyResult: true }));
    const port = createRuntimePluginToolPort({
      getWorker: vi.fn(() => ({
        status: "running",
        manifestIdentity: "manifest-1",
        call,
      })),
    } as never);

    await expect(
      port.execute({
        capability,
        toolName: "lookup",
        pluginInstallationId: "plugin-installation",
        pluginManifestIdentity: "manifest-1",
        arguments: {},
        mintPluginRunContext: vi.fn(async () => "pc_plugin_ctx_v1_direct"),
      }),
    ).rejects.toThrow("Invalid plugin ToolResult");
  });

  it("never rebinds a compiled call to a replacement worker during context mint", async () => {
    const oldCall = vi.fn(async () => ({
      ok: true,
      content: "old",
    }));
    const newCall = vi.fn(async () => ({
      ok: true,
      content: "new",
    }));
    let currentWorker = {
      status: "running",
      manifestIdentity: "manifest-1",
      call: oldCall,
    };
    const port = createRuntimePluginToolPort({
      getWorker: vi.fn(() => currentWorker),
    } as never);

    await expect(
      port.execute({
        capability,
        toolName: "lookup",
        pluginInstallationId: "plugin-installation",
        pluginManifestIdentity: "manifest-1",
        arguments: {},
        mintPluginRunContext: vi.fn(async () => {
          currentWorker = {
            status: "running",
            manifestIdentity: "manifest-2",
            call: newCall,
          };
          return "pc_plugin_ctx_v1_direct";
        }),
      }),
    ).resolves.toEqual({ ok: true, content: "old" });

    expect(oldCall).toHaveBeenCalledOnce();
    expect(newCall).not.toHaveBeenCalled();
  });

  it("decodes completed plugin-tool replays through the same ToolResult contract", async () => {
    const descriptor = {
      name: "paperclip.example__lookup",
      title: "Lookup",
      description: "",
      inputSchema: {},
      source: "plugin" as const,
      pluginInstallationId: "plugin-installation",
      pluginManifestIdentity: "manifest-1",
      pluginToolName: "lookup",
    };
    const valid = setup({
      replayedPluginResult: {
        value: { ok: true, content: "replayed", data: { record: 1 } },
      },
    });
    await expect(
      valid.executor.execute({
        capability,
        descriptor,
        arguments: {},
        callIdentity: { source: "provider", id: "replayed-valid" },
        ingressOrdinal: 0,
        mintPluginRunContext,
      }),
    ).resolves.toEqual({
      source: "plugin",
      value: { ok: true, content: "replayed", data: { record: 1 } },
    });
    expect(valid.executePlugin).not.toHaveBeenCalled();

    const invalid = setup({
      replayedPluginResult: { value: { content: "legacy replay" } },
    });
    await expect(
      invalid.executor.execute({
        capability,
        descriptor,
        arguments: {},
        callIdentity: { source: "provider", id: "replayed-invalid" },
        ingressOrdinal: 0,
        mintPluginRunContext,
      }),
    ).rejects.toThrow("Invalid plugin ToolResult");
    expect(invalid.executePlugin).not.toHaveBeenCalled();
  });
});
