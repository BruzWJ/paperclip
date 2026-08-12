import { describe, expect, it } from "vitest";
import { requireExactPluginScopeId } from "../src/plugin-scope.js";

describe("requireExactPluginScopeId", () => {
  const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("accepts only identifier-free instance scope", () => {
    expect(requireExactPluginScopeId("instance", undefined)).toBeNull();
    expect(() => requireExactPluginScopeId("instance", "instance")).toThrow(
      "must not include scopeId",
    );
  });

  it("requires canonical object scope identifiers", () => {
    expect(requireExactPluginScopeId("task", taskId)).toBe(taskId);
    expect(() => requireExactPluginScopeId("task", undefined)).toThrow(
      "requires an exact canonical UUID scopeId",
    );
    expect(() => requireExactPluginScopeId("task", ` ${taskId} `)).toThrow(
      "requires an exact canonical UUID scopeId",
    );
    expect(() => requireExactPluginScopeId("task", taskId.toUpperCase())).toThrow(
      "requires an exact canonical UUID scopeId",
    );
  });
});
