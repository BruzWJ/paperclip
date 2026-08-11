import { describe, expect, it } from "vitest";
import {
  createProjectSchema,
  updateProjectCodebaseSchema,
} from "./project.js";

describe("project codebase validators", () => {
  it("rejects the retired singular project goal field", () => {
    expect(createProjectSchema.safeParse({
      name: "Paperclip",
      goalId: "11111111-1111-4111-8111-111111111111",
    }).success).toBe(false);
  });

  it("accepts an HTTPS repo and absolute local folder on project creation", () => {
    const parsed = createProjectSchema.parse({
      name: "Paperclip",
      codebase: {
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        localFolder: "/srv/paperclip",
      },
    });

    expect(parsed.codebase).toEqual({
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      localFolder: "/srv/paperclip",
    });
  });

  it("returns validation failures for malformed or non-HTTPS repo URLs", () => {
    expect(() => createProjectSchema.safeParse({
      name: "Malformed",
      codebase: { repoUrl: "not a url" },
    })).not.toThrow();
    expect(createProjectSchema.safeParse({
      name: "Malformed",
      codebase: { repoUrl: "not a url" },
    }).success).toBe(false);
    expect(createProjectSchema.safeParse({
      name: "Insecure",
      codebase: { repoUrl: "http://github.com/acme/repo" },
    }).success).toBe(false);
  });

  it("rejects relative local folders and empty codebase patches", () => {
    expect(updateProjectCodebaseSchema.safeParse({
      localFolder: "relative/project",
    }).success).toBe(false);
    expect(updateProjectCodebaseSchema.safeParse({}).success).toBe(false);
    expect(updateProjectCodebaseSchema.safeParse({ localFolder: null }).success).toBe(true);
  });
});
