import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverProjectWorkspaceSkillDirectories,
  findMissingLocalSkillIds,
  isGitRepoSkillImportSource,
  normalizeGitHubSkillDirectory,
  parseSkillImportSourceInput,
  readLocalSkillImportFromDirectory,
} from "../services/company-skills.js";

const tempDirectories: string[] = [];

async function tempDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("company skill source parsing", () => {
  it("normalizes skills.sh keys and CLI commands into canonical GitHub sources", () => {
    expect(parseSkillImportSourceInput("acme/agents/reviewer")).toEqual({
      resolvedSource: "https://github.com/acme/agents",
      requestedSkillSlug: "reviewer",
      originalSkillsShUrl: "https://skills.sh/acme/agents/reviewer",
      warnings: [],
    });

    expect(parseSkillImportSourceInput("npx skills add acme/agents --skill reviewer")).toEqual({
      resolvedSource: "https://github.com/acme/agents",
      requestedSkillSlug: "reviewer",
      originalSkillsShUrl: null,
      warnings: [],
    });
  });

  it("normalizes remote repository identity and rejects unsafe URL forms", () => {
    expect(parseSkillImportSourceInput("https://WWW.GitHub.com/Acme/Agents.git")).toMatchObject({
      resolvedSource: "https://github.com/acme/agents",
      requestedSkillSlug: null,
    });
    expect(() => parseSkillImportSourceInput("http://github.com/acme/agents"))
      .toThrow(/HTTPS/);
    expect(() => parseSkillImportSourceInput("https://token@github.com/acme/agents"))
      .toThrow(/credentials/);
    expect(() => parseSkillImportSourceInput("https://github.com/acme/agents?ref=main"))
      .toThrow(/query parameters/);
  });

  it("distinguishes repository sources from raw markdown and non-HTTPS URLs", () => {
    expect(isGitRepoSkillImportSource("https://github.com/acme/agents")).toBe(true);
    expect(isGitRepoSkillImportSource("https://github.com/acme/agents/blob/main/SKILL.md")).toBe(false);
    expect(isGitRepoSkillImportSource("https://raw.githubusercontent.com/acme/agents/main/SKILL.md")).toBe(false);
    expect(isGitRepoSkillImportSource("ssh://git@github.com/acme/agents")).toBe(false);
  });

  it("uses the containing directory when a GitHub path points at SKILL.md", () => {
    expect(normalizeGitHubSkillDirectory("skills/reviewer/SKILL.md", "fallback"))
      .toBe("skills/reviewer");
    expect(normalizeGitHubSkillDirectory("", "skills/fallback/SKILL.md"))
      .toBe("skills/fallback/SKILL.md");
  });
});

describe("company skill local inventory", () => {
  it("builds a deterministic local package snapshot and classifies executable content", async () => {
    const skillDir = await tempDirectory("paperclip-company-skill-");
    await mkdir(path.join(skillDir, "references"));
    await mkdir(path.join(skillDir, "scripts"));
    await writeFile(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: Review Assistant",
      "description: Reviews a proposed change.",
      "key: acme/review/assistant",
      "---",
      "Use the supplied context.",
    ].join("\n"));
    await writeFile(path.join(skillDir, "references", "rubric.md"), "# Rubric\n");
    await writeFile(path.join(skillDir, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n");

    const imported = await readLocalSkillImportFromDirectory("company-1", skillDir);

    expect(imported).toMatchObject({
      key: "acme/review/assistant",
      slug: "review-assistant",
      name: "Review Assistant",
      description: "Reviews a proposed change.",
      sourceType: "local_path",
      sourceLocator: path.resolve(skillDir),
      trustLevel: "scripts_executables",
      compatibility: "compatible",
    });
    expect(imported.fileInventory.map((entry) => [entry.path, entry.kind]))
      .toEqual([
        ["references/rubric.md", "reference"],
        ["scripts/check.sh", "script"],
        ["SKILL.md", "skill"],
      ]);
  });

  it("discovers only canonical skill directories inside a project workspace", async () => {
    const workspace = await tempDirectory("paperclip-project-skills-");
    await writeFile(path.join(workspace, "SKILL.md"), "# Root skill\n");
    await mkdir(path.join(workspace, ".agents", "skills", "reviewer"), { recursive: true });
    await writeFile(path.join(workspace, ".agents", "skills", "reviewer", "SKILL.md"), "# Reviewer\n");
    await mkdir(path.join(workspace, ".agents", "skills", "not-a-skill"), { recursive: true });
    await writeFile(path.join(workspace, ".agents", "skills", "not-a-skill", "README.md"), "ignored\n");

    const discovered = await discoverProjectWorkspaceSkillDirectories({
      projectId: "project-1",
      projectName: "Project",
      workspaceId: "workspace-1",
      workspaceName: "Primary",
      workspaceCwd: workspace,
    });

    expect(discovered.map((entry) => ({
      relativePath: entry.relativePath,
      inventoryMode: entry.inventoryMode,
    }))).toEqual([
      { relativePath: ".", inventoryMode: "project_root" },
      { relativePath: ".agents/skills/reviewer", inventoryMode: "full" },
    ]);
  });

  it("reports missing local sources while ignoring remote skills", async () => {
    const present = await tempDirectory("paperclip-present-skill-");
    await writeFile(path.join(present, "SKILL.md"), "# Present\n");

    await expect(findMissingLocalSkillIds([
      { id: "present", sourceType: "local_path", sourceLocator: present },
      { id: "missing", sourceType: "local_path", sourceLocator: path.join(present, "gone") },
      { id: "unset", sourceType: "local_path", sourceLocator: null },
      { id: "remote", sourceType: "github", sourceLocator: "https://github.com/acme/skill" },
    ])).resolves.toEqual(["missing", "unset"]);
  });
});
