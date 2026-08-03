import { describe, expect, it } from "vitest";
import { adapterRegistrySchema } from "./adapter-registry.js";

describe("adapterRegistrySchema", () => {
  it("parses a full entry", () => {
    const parsed = adapterRegistrySchema.parse([
      {
        adapterType: "codex",
        runtimeImage: "ghcr.io/example/codex-acp-runtime:v1",
        allowFqdns: [],
        probeCommand: ["codex-acp", "--version"],
      },
    ]);
    expect(parsed[0].adapterType).toBe("codex");
    expect(parsed[0].enabled).toBe(true); // defaulted
    expect(parsed[0].runtimeImage).toContain("codex-acp-runtime");
  });

  it("rejects implicit server-environment provider configuration", () => {
    expect(() =>
      adapterRegistrySchema.parse([
        {
          adapterType: "codex",
          envKeys: ["EXTERNAL_AGENT_API_KEY"],
        },
      ]),
    ).toThrow();
    expect(() =>
      adapterRegistrySchema.parse([
        {
          adapterType: "codex",
          defaultEnv: {
            EXTERNAL_AGENT_BASE_URL: "http://provider.invalid",
          },
        },
      ]),
    ).toThrow();
  });

  it("defaults enabled to true and optional collections to undefined", () => {
    const parsed = adapterRegistrySchema.parse([{ adapterType: "codex" }]);
    expect(parsed[0]).toMatchObject({ adapterType: "codex", enabled: true });
    expect(parsed[0].runtimeImage).toBeUndefined();
  });

  it("rejects blank and whitespace-normalized adapter identities", () => {
    for (const adapterType of ["", "   ", " codex", "codex "]) {
      expect(() =>
        adapterRegistrySchema.parse([{ adapterType }]),
      ).toThrow();
    }
  });

  it("rejects an entry with no adapterType", () => {
    expect(() => adapterRegistrySchema.parse([{ enabled: true }])).toThrow();
  });

  it("rejects a non-array", () => {
    expect(() => adapterRegistrySchema.parse({ adapterType: "x" })).toThrow();
  });
});
