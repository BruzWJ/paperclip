import { describe, expect, it } from "vitest";
import {
  isAbsoluteProjectFolder,
  isCanonicalProjectRepositoryUrl,
} from "./project-codebase.js";

describe("project codebase values", () => {
  it("accepts exact absolute host paths without rewriting them", () => {
    expect(isAbsoluteProjectFolder("/srv/acme/project")).toBe(true);
    expect(isAbsoluteProjectFolder("C:\\work\\project")).toBe(true);
    expect(isAbsoluteProjectFolder("relative/project")).toBe(false);
    expect(isAbsoluteProjectFolder("/srv/acme/project ")).toBe(false);
  });

  it("accepts only stable HTTPS repository URL serializations", () => {
    expect(
      isCanonicalProjectRepositoryUrl("https://github.com/acme/project.git"),
    ).toBe(true);
    expect(
      isCanonicalProjectRepositoryUrl(
        "https://git.example.test:8443/group/subgroup/project.git",
      ),
    ).toBe(true);
    expect(
      isCanonicalProjectRepositoryUrl("http://github.com/acme/project"),
    ).toBe(false);
    expect(isCanonicalProjectRepositoryUrl("https://github.com")).toBe(false);
    expect(
      isCanonicalProjectRepositoryUrl("https://GitHub.com/acme/project"),
    ).toBe(false);
    expect(
      isCanonicalProjectRepositoryUrl("https://github.com:443/acme/project"),
    ).toBe(false);
    expect(
      isCanonicalProjectRepositoryUrl(
        "https://github.com/acme/other/../project",
      ),
    ).toBe(false);
  });
});
