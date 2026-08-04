import { describe, expect, it } from "vitest";
import {
  adapterSupportsRemoteManagedEnvironments,
  getEnvironmentCapabilities,
  isSandboxProviderSupportedForAdapter,
  supportedEnvironmentDriversForAdapter,
} from "./environment-support.js";

describe("isSandboxProviderSupportedForAdapter", () => {
  const adapterDrivers = {
    claude: ["local", "ssh", "sandbox", "plugin"],
    "runtime-discovered-agent": ["local"],
  } as const;

  it("accepts additional sandbox providers only when ACPX advertises the sandbox transport", () => {
    expect(
      isSandboxProviderSupportedForAdapter(
        "claude",
        "fake-plugin",
        ["fake-plugin"],
        adapterDrivers,
      ),
    ).toBe(true);
    expect(
      isSandboxProviderSupportedForAdapter(
        "runtime-discovered-agent",
        "fake-plugin",
        ["fake-plugin"],
        adapterDrivers,
      ),
    ).toBe(false);
    expect(
      isSandboxProviderSupportedForAdapter(
        "sandbox-only-agent",
        "fake-plugin",
        ["fake-plugin"],
        { "sandbox-only-agent": ["sandbox"] },
      ),
    ).toBe(true);
  });

  it("fails closed until the ACPX catalog supplies drivers", () => {
    expect(adapterSupportsRemoteManagedEnvironments("codex")).toBe(false);
    expect(supportedEnvironmentDriversForAdapter("codex")).toEqual([]);
  });

  it("uses the exact driver membership supplied by the ACPX catalog", () => {
    const expectedDrivers = [
      "local",
      "ssh",
      "sandbox",
      "plugin",
    ] as const;
    const catalog = {
      codex: expectedDrivers,
      claude: expectedDrivers,
      "runtime-discovered-agent": ["local"],
    } as const;
    expect(adapterSupportsRemoteManagedEnvironments("codex", catalog)).toBe(true);
    expect(adapterSupportsRemoteManagedEnvironments("claude", catalog)).toBe(true);
    expect(adapterSupportsRemoteManagedEnvironments("runtime-discovered-agent", catalog)).toBe(false);
    expect(supportedEnvironmentDriversForAdapter("codex", catalog)).toEqual(expectedDrivers);
    expect(supportedEnvironmentDriversForAdapter("claude", catalog)).toEqual(expectedDrivers);
    expect(supportedEnvironmentDriversForAdapter("runtime-discovered-agent", catalog)).toEqual(["local"]);
  });

  it("reports only ACPX-admitted transport capabilities for each runtime agent", () => {
    const capabilities = getEnvironmentCapabilities(["codex", "runtime-discovered-agent"], {
      adapterDrivers: {
        codex: ["local", "ssh", "sandbox", "plugin"],
        "runtime-discovered-agent": ["local"],
      },
      sandboxProviders: {
        "fake-plugin": { displayName: "Fake Plugin" },
      },
    });

    expect(capabilities.adapters).toEqual([
      expect.objectContaining({
        adapterType: "codex",
        drivers: expect.objectContaining({
          local: "supported",
          plugin: "supported",
          sandbox: "supported",
          ssh: "supported",
        }),
        sandboxProviders: expect.objectContaining({
          "fake-plugin": "supported",
        }),
      }),
      expect.objectContaining({
        adapterType: "runtime-discovered-agent",
        drivers: expect.objectContaining({
          local: "supported",
          plugin: "unsupported",
          sandbox: "unsupported",
          ssh: "unsupported",
        }),
        sandboxProviders: expect.objectContaining({
          "fake-plugin": "unsupported",
        }),
      }),
    ]);
    expect(capabilities.drivers).toEqual({
      local: "supported",
      ssh: "supported",
      sandbox: "supported",
      plugin: "supported",
    });
  });
});
