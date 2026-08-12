import { describe, expect, it } from "vitest";
import { createProjectSchema, updateProjectCodebaseSchema } from "./project.js";

describe("project codebase validators", () => {
  it("accepts only exact lowercase project colors", () => {
    expect(
      createProjectSchema.safeParse({ name: "Canonical", color: "#336699" })
        .success,
    ).toBe(true);
    expect(
      createProjectSchema.safeParse({ name: "Short", color: "#369" }).success,
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({ name: "Upper", color: "#ABCDEF" })
        .success,
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({ name: "Padded", color: " #336699 " })
        .success,
    ).toBe(false);
  });

  it("rejects the retired singular project goal field", () => {
    expect(
      createProjectSchema.safeParse({
        name: "Paperclip",
        goalId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
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
    expect(() =>
      createProjectSchema.safeParse({
        name: "Malformed",
        codebase: { repoUrl: "not a url" },
      }),
    ).not.toThrow();
    expect(
      createProjectSchema.safeParse({
        name: "Malformed",
        codebase: { repoUrl: "not a url" },
      }).success,
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({
        name: "Insecure",
        codebase: { repoUrl: "http://github.com/acme/repo" },
      }).success,
    ).toBe(false);
  });

  it("rejects relative local folders and empty codebase patches", () => {
    expect(
      updateProjectCodebaseSchema.safeParse({
        localFolder: "relative/project",
      }).success,
    ).toBe(false);
    expect(updateProjectCodebaseSchema.safeParse({}).success).toBe(false);
    expect(
      updateProjectCodebaseSchema.safeParse({ localFolder: null }).success,
    ).toBe(true);
  });

  it("rejects padded codebase identities instead of normalizing them", () => {
    expect(
      updateProjectCodebaseSchema.safeParse({ localFolder: " /srv/paperclip" })
        .success,
    ).toBe(false);
    expect(
      updateProjectCodebaseSchema.safeParse({
        repoUrl: "https://github.com/paperclipai/paperclip.git ",
      }).success,
    ).toBe(false);
  });

  it.each([
    "https://GitHub.com/paperclipai/paperclip.git",
    "https://github.com:443/paperclipai/paperclip.git",
    "https://github.com/paperclipai/other/../paperclip.git",
  ])("rejects the noncanonical repository URL %s", (repoUrl) => {
    expect(
      createProjectSchema.safeParse({
        name: "Noncanonical",
        codebase: { repoUrl },
      }).success,
    ).toBe(false);
  });
});
