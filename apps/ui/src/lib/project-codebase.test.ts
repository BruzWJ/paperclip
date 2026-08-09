import { describe, expect, it } from "vitest";
import {
  formatProjectRepositoryUrl,
  isAbsoluteProjectFolder,
  isSafeProjectRepositoryUrl,
  isValidProjectRepositoryUrl,
} from "./project-codebase";

describe("project codebase helpers", () => {
  it("recognizes absolute local folders without accepting relative input", () => {
    expect(isAbsoluteProjectFolder("/srv/acme/project")).toBe(true);
    expect(isAbsoluteProjectFolder("C:\\work\\project")).toBe(true);
    expect(isAbsoluteProjectFolder("relative/project")).toBe(false);
  });

  it("accepts safe HTTPS repository URLs and formats their display", () => {
    const repoUrl = "https://github.com/acme/project.git";
    expect(isValidProjectRepositoryUrl(repoUrl)).toBe(true);
    expect(isSafeProjectRepositoryUrl(repoUrl)).toBe(true);
    expect(formatProjectRepositoryUrl(repoUrl)).toBe("github.com/acme/project");
  });

  it("rejects malformed, insecure, and host-only repository URLs", () => {
    expect(isValidProjectRepositoryUrl("not a url")).toBe(false);
    expect(isValidProjectRepositoryUrl("http://github.com/acme/project")).toBe(false);
    expect(isValidProjectRepositoryUrl("https://github.com")).toBe(false);
  });
});
