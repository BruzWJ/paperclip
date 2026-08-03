import { describe, expect, it } from "vitest";
import {
  adapterSupportsRemoteManagedEnvironments,
  getEnvironmentCapabilities,
  isSandboxProviderSupportedForAdapter,
  supportedEnvironmentDriversForAdapter,
} from "./environment-support.js";

describe("isSandboxProviderSupportedForAdapter", () => {
  it("accepts additional sandbox providers for the declarative codex adapter", () => {
    expect(
      isSandboxProviderSupportedForAdapter("codex", "fake-plugin", ["fake-plugin"]),
    ).toBe(true);
  });

  it("rejects providers for adapters without remote-managed environment support", () => {
    expect(
      isSandboxProviderSupportedForAdapter("unapproved-adapter", "fake-plugin", ["fake-plugin"]),
    ).toBe(false);
  });

  it("advertises every command-capable target for the admitted declarative adapter", () => {
    expect(adapterSupportsRemoteManagedEnvironments("codex")).toBe(true);
    expect(supportedEnvironmentDriversForAdapter("codex")).toEqual([
      "local",
      "ssh",
      "sandbox",
      "plugin",
    ]);
  });

  it("keeps an unapproved adapter local-only", () => {
    expect(
      adapterSupportsRemoteManagedEnvironments("unapproved-adapter"),
    ).toBe(false);
    expect(
      supportedEnvironmentDriversForAdapter("unapproved-adapter"),
    ).toEqual(["local"]);
    expect(
      isSandboxProviderSupportedForAdapter(
        "unapproved-adapter",
        "fake-plugin",
        ["fake-plugin"],
      ),
    ).toBe(false);
  });

  it("reports closed active transport capabilities", () => {
    const capabilities = getEnvironmentCapabilities(["codex", "unapproved-adapter"], {
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
        adapterType: "unapproved-adapter",
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
