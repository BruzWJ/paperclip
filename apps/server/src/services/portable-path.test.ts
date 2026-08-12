import { describe, expect, it } from "vitest";
import {
  joinPortablePaths,
  requirePortablePath,
  resolvePortablePath,
} from "./portable-path.js";

describe("portable path service boundary", () => {
  it("returns canonical paths without rewriting their identity", () => {
    expect(requirePortablePath("agents/lead/AGENTS.md")).toBe(
      "agents/lead/AGENTS.md",
    );
    expect(resolvePortablePath("COMPANY.md", "agents/lead/AGENTS.md")).toBe(
      "agents/lead/AGENTS.md",
    );
    expect(
      resolvePortablePath("package/COMPANY.md", "agents/lead/AGENTS.md"),
    ).toBe("package/agents/lead/AGENTS.md");
    expect(joinPortablePaths("package", "agents/lead/AGENTS.md")).toBe(
      "package/agents/lead/AGENTS.md",
    );
  });

  it("rejects paths instead of normalizing aliases or traversal", () => {
    for (const pathValue of [
      "./COMPANY.md",
      "/COMPANY.md",
      "agents\\lead\\AGENTS.md",
      "agents/../lead/AGENTS.md",
      "agents//lead/AGENTS.md",
      " COMPANY.md",
    ]) {
      expect(() => requirePortablePath(pathValue)).toThrow(
        "not an exact portable relative path",
      );
    }

    expect(() =>
      resolvePortablePath("COMPANY.md", "../outside/AGENTS.md"),
    ).toThrow("not an exact portable relative path");
    expect(() => joinPortablePaths("package", "/COMPANY.md")).toThrow(
      "not an exact portable relative path",
    );
  });
});
