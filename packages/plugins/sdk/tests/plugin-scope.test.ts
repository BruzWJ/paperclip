import { describe, expect, it } from "vitest";
import { normalizePluginScopeId } from "../src/plugin-scope.js";

describe("normalizePluginScopeId", () => {
  it("accepts only identifier-free instance scope", () => {
    expect(normalizePluginScopeId("instance", undefined)).toBeNull();
    expect(() => normalizePluginScopeId("instance", "instance")).toThrow(
      "must not include scopeId",
    );
  });

  it("requires canonical object scope identifiers", () => {
    expect(normalizePluginScopeId("issue", "issue-id")).toBe("issue-id");
    expect(() => normalizePluginScopeId("issue", undefined)).toThrow(
      "requires a canonical non-empty scopeId",
    );
    expect(() => normalizePluginScopeId("issue", " issue-id ")).toThrow(
      "requires a canonical non-empty scopeId",
    );
  });
});
