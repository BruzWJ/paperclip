import { describe, expect, it } from "vitest";
import type { AdapterRegistryEntry } from "../../src/adapter-registry.js";
import {
  requireAdapterRuntime,
  resolveRunAdapterType,
} from "../../src/adapter-runtime.js";

const registry: AdapterRegistryEntry[] = [
  {
    adapterType: "codex",
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
  it("resolves the exact operator-declared Codex runtime", () => {
    expect(requireAdapterRuntime("codex", registry)).toEqual({
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
      requireAdapterRuntime("codex", undefined)
    ).toThrow(/requires an explicit adapter runtime registry/);
    expect(() =>
      requireAdapterRuntime("missing", registry)
    ).toThrow(/not an enabled entry/);
    expect(() =>
      requireAdapterRuntime("codex", [
        {
          ...registry[0]!,
          enabled: false,
        },
      ])
    ).toThrow(/not an enabled entry/);
  });

  it("rejects a registry entry without an exact runtime image", () => {
    expect(() =>
      requireAdapterRuntime("codex", [
        {
          adapterType: "codex",
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
        "codex",
      ),
    ).toBe("external-provider");
  });

  it("uses the explicit environment default for an absent run type", () => {
    expect(resolveRunAdapterType(undefined, "codex")).toBe(
      "codex",
    );
    expect(resolveRunAdapterType(null, "codex")).toBe(
      "codex",
    );
  });

  it("rejects blank or whitespace-normalized identifiers instead of rewriting them", () => {
    expect(() => resolveRunAdapterType(undefined, " ")).toThrow(
      /exact default adapter type/,
    );
    expect(() =>
      resolveRunAdapterType(" external-provider ", "codex")
    ).toThrow(/exact per-run adapter type/);
    expect(() =>
      resolveRunAdapterType("", "codex")
    ).toThrow(/exact per-run adapter type/);
  });
});
