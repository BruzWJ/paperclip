import { describe, expect, it } from "vitest";
import {
  assertNoAmbientAuthOriginEnvironment,
  resolveCanonicalPublicOrigin,
} from "../config.js";

const AMBIENT_KEYS = [
  ["BETTER", "AUTH", "URL"],
  ["BETTER", "AUTH", "BASE", "URL"],
  ["NEXT", "PUBLIC", "BETTER", "AUTH", "URL"],
  ["PUBLIC", "BETTER", "AUTH", "URL"],
  ["NUXT", "PUBLIC", "BETTER", "AUTH", "URL"],
  ["NUXT", "PUBLIC", "AUTH", "URL"],
  ["PAPERCLIP", "AUTH", "PUBLIC", "BASE", "URL"],
  ["NEXT", "PUBLIC", "URL"],
  ["BASE", "URL"],
  ["BETTER", "AUTH", "TRUSTED", "ORIGINS"],
].map((segments) => segments.join("_"));

describe("canonical auth origin environment", () => {
  it("rejects every ambient or retired auth-origin alias", () => {
    for (const key of AMBIENT_KEYS) {
      expect(() =>
        assertNoAmbientAuthOriginEnvironment({
          [key]: "https://ambient.example",
        }),
      ).toThrow(key);
    }
  });

  it("accepts Paperclip's canonical public URL", () => {
    expect(() =>
      assertNoAmbientAuthOriginEnvironment({
        PAPERCLIP_PUBLIC_URL: "https://paperclip.example",
      }),
    ).not.toThrow();
  });

  it("ignores empty ambient values because Better Auth cannot consume them", () => {
    expect(() =>
      assertNoAmbientAuthOriginEnvironment(
        Object.fromEntries(AMBIENT_KEYS.map((key) => [key, ""])),
      ),
    ).not.toThrow();
  });

  it("normalizes matching environment and persisted public origins", () => {
    expect(resolveCanonicalPublicOrigin({
      deploymentExposure: "public",
      environmentValue: "HTTPS://Paperclip.Example:443/",
      persistedValue: "https://paperclip.example",
    })).toBe("https://paperclip.example");
  });

  it("rejects malformed and conflicting public origins", () => {
    expect(() => resolveCanonicalPublicOrigin({
      deploymentExposure: "public",
      environmentValue: "http://paperclip.example",
    })).toThrow(/must use https:\/\//);

    expect(() => resolveCanonicalPublicOrigin({
      deploymentExposure: "public",
      environmentValue: "https://paperclip.example/path",
    })).toThrow(/must not contain a path/);

    expect(() => resolveCanonicalPublicOrigin({
      deploymentExposure: "public",
      environmentValue: "https://one.example",
      persistedValue: "https://two.example",
    })).toThrow(/must match/);
  });

  it("requires a public origin only for public exposure", () => {
    expect(() => resolveCanonicalPublicOrigin({
      deploymentExposure: "public",
    })).toThrow(/is required/);
    expect(() => resolveCanonicalPublicOrigin({
      deploymentExposure: "private",
      environmentValue: "https://paperclip.example",
    })).toThrow(/only valid/);
    expect(resolveCanonicalPublicOrigin({
      deploymentExposure: "private",
    })).toBeUndefined();
  });
});
