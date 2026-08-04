import { describe, expect, it } from "vitest";
import type { AdapterRegistryEntry } from "../../src/adapter-registry.js";
import {
  requireAdapterRuntime,
  resolveRunAdapterType,
} from "../../src/adapter-runtime.js";

const registry: AdapterRegistryEntry[] = [
  {
    adapterType: "fixture-acpx-agent",
    enabled: true,
    runtimeImage: "registry.example/provider-runtime:v1",
    allowFqdns: ["provider.example"],
    probeCommand: ["provider", "--version"],
  },
  {
    adapterType: "external-provider",
    enabled: true,
    runtimeImage: "registry.example/external-runtime:v2",
  },
];

describe("requireAdapterRuntime", () => {
  it("resolves the exact operator-declared ACPX runtime mapping", () => {
    expect(requireAdapterRuntime("fixture-acpx-agent", registry)).toEqual({
      runtimeImage: "registry.example/provider-runtime:v1",
      allowFqdns: ["provider.example"],
      probeCommand: ["provider", "--version"],
    });
  });

  it("supports exact external adapter runtimes without a built-in allowlist", () => {
    expect(
      requireAdapterRuntime("external-provider", registry),
    ).toEqual({
      runtimeImage: "registry.example/external-runtime:v2",
      allowFqdns: [],
      probeCommand: [],
    });
  });

  it("rejects missing, absent, and disabled registry entries", () => {
    expect(() =>
      requireAdapterRuntime("fixture-acpx-agent", undefined)
    ).toThrow(/requires an explicit adapter runtime registry/);
    expect(() =>
      requireAdapterRuntime("missing", registry)
    ).toThrow(/not an enabled entry/);
    expect(() =>
      requireAdapterRuntime("fixture-acpx-agent", [
        {
          ...registry[0]!,
          enabled: false,
        },
      ])
    ).toThrow(/not an enabled entry/);
  });

  it("rejects a registry entry without an exact runtime image", () => {
    expect(() =>
      requireAdapterRuntime("fixture-acpx-agent", [
        {
          adapterType: "fixture-acpx-agent",
          enabled: true,
          runtimeImage: " ",
        },
      ])
    ).toThrow(/missing an exact runtimeImage/);
  });
});

describe("resolveRunAdapterType", () => {
  it("uses an exact per-run external type when supplied", () => {
    expect(
      resolveRunAdapterType(
        "external-provider",
        "fixture-acpx-agent",
      ),
    ).toBe("external-provider");
  });

  it("uses the explicit environment default for an absent run type", () => {
    expect(resolveRunAdapterType(undefined, "fixture-acpx-agent")).toBe(
      "fixture-acpx-agent",
    );
    expect(resolveRunAdapterType(null, "fixture-acpx-agent")).toBe(
      "fixture-acpx-agent",
    );
  });

  it("rejects blank or whitespace-normalized identifiers instead of rewriting them", () => {
    expect(() => resolveRunAdapterType(undefined, undefined)).toThrow(
      /ACPX-selected agent type/,
    );
    expect(() =>
      resolveRunAdapterType(" external-provider ", "fixture-acpx-agent")
    ).toThrow(/exact per-run adapter type/);
    expect(() =>
      resolveRunAdapterType("", "fixture-acpx-agent")
    ).toThrow(/exact per-run adapter type/);
  });
});
