import { describe, it, expect } from "vitest";
import plugin from "../../src/plugin.js";

const adapters = [
  {
    adapterType: "fixture-acpx-agent",
    runtimeImage: "registry.example/provider-runtime:v1",
    allowFqdns: ["provider.example"],
    probeCommand: ["provider", "--version"],
  },
];

describe("plugin", () => {
  it("exports the kubernetes driver", () => {
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentValidateConfig).toBeTypeOf("function");
  });

  it("validateConfig accepts inCluster=true config", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, adapters },
    });
    expect(result.ok).toBe(true);
  });

  it("validateConfig rejects missing auth", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { adapters },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/requires one of `inCluster`/);
  });

  it("validateConfig normalizes defaults", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, adapters },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toEqual(
      expect.objectContaining({
        namespacePrefix: "paperclip-",
        egressMode: "standard",
        podActivityDeadlineSec: 3600,
        adapters: expect.any(Array),
      }),
    );
    expect(result.normalizedConfig).not.toHaveProperty("adapterType");
  });

  it("validateConfig rejects the removed backend selector", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: {
        inCluster: true,
        backend: "sandbox-cr",
        adapters,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/backend/);
  });

  it("onHealth returns ok", async () => {
    const result = await plugin.definition.onHealth!();
    expect(result.status).toBe("ok");
  });

  it("validateConfig warns about FQDN limitation in standard mode", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: {
        inCluster: true,
        adapterType: "fixture-acpx-agent",
        adapters,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(
      result.warnings?.some((warning) =>
        warning.includes("provider.example")
      ),
    ).toBe(true);
  });

  it("validateConfig does NOT warn when egressMode is cilium", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: {
        inCluster: true,
        adapterType: "fixture-acpx-agent",
        adapters,
        egressMode: "cilium",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});
