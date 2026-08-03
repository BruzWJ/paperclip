import { describe, expect, it } from "vitest";
import { parseAdapterRegistryEnv } from "./adapter-registry-bootstrap.js";

const ENTRY = JSON.stringify([
  { adapterType: "codex", runtimeImage: "img", allowFqdns: [], probeCommand: ["codex-acp", "--version"] },
]);

describe("parseAdapterRegistryEnv", () => {
  it("returns null when neither env nor file is set", () => {
    expect(parseAdapterRegistryEnv({})).toBeNull();
  });

  it("parses inline PAPERCLIP_ADAPTERS JSON", () => {
    const r = parseAdapterRegistryEnv({ PAPERCLIP_ADAPTERS: ENTRY });
    expect(r).toHaveLength(1);
    expect(r?.[0].adapterType).toBe("codex");
    expect(r?.[0].enabled).toBe(true);
  });

  it("throws on malformed JSON (fail loud)", () => {
    expect(() => parseAdapterRegistryEnv({ PAPERCLIP_ADAPTERS: "{not json" })).toThrow(
      /PAPERCLIP_ADAPTERS/,
    );
  });

  it("throws on schema-invalid content (fail loud)", () => {
    expect(() =>
      parseAdapterRegistryEnv({ PAPERCLIP_ADAPTERS: JSON.stringify([{ enabled: true }]) }),
    ).toThrow(/PAPERCLIP_ADAPTERS/);
  });

  it("rejects provider env forwarding", () => {
    expect(() =>
      parseAdapterRegistryEnv({
        PAPERCLIP_ADAPTERS: JSON.stringify([
          {
            adapterType: "codex",
            runtimeImage: "img",
            envKeys: ["EXTERNAL_API_KEY"],
          },
        ]),
      }),
    ).toThrow(/PAPERCLIP_ADAPTERS/);
  });

  it("rejects a whitespace-normalized adapter identity", () => {
    expect(() =>
      parseAdapterRegistryEnv({
        PAPERCLIP_ADAPTERS: JSON.stringify([{ adapterType: " codex " }]),
      }),
    ).toThrow(/exact non-blank/);
  });
});
