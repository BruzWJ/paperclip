import { describe, expect, it } from "vitest";
import { formatProjectRepositoryUrl } from "./project-codebase";

describe("project codebase helpers", () => {
  it("formats a canonical repository URL for display", () => {
    const repoUrl = "https://github.com/acme/project.git";
    expect(formatProjectRepositoryUrl(repoUrl)).toBe("github.com/acme/project");
  });
});
