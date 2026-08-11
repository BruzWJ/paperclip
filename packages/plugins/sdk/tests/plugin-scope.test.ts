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
    expect(normalizePluginScopeId("task", "task-id")).toBe("task-id");
    expect(() => normalizePluginScopeId("task", undefined)).toThrow(
      "requires a canonical non-empty scopeId",
    );
    expect(() => normalizePluginScopeId("task", " task-id ")).toThrow(
      "requires a canonical non-empty scopeId",
    );
  });
});
