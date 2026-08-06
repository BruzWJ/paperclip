import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginManagedSkillService } from "../services/plugin-managed-skills.js";
import { createMockDb } from "./helpers/mock-db.js";

const skills = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  importPackageFiles: vi.fn(),
  readFile: vi.fn(),
}));
const logActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: vi.fn(() => skills),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity }));

const companyId = "11111111-1111-4111-8111-111111111111";
const pluginId = "22222222-2222-4222-8222-222222222222";
const skillId = "33333333-3333-4333-8333-333333333333";
const pluginKey = "paperclip.managed-skills-test";
const canonicalKey = "plugin/paperclip-managed-skills-test/documentation-maintainer";
const referenceContent = "# Documentation style\n\nKeep pages cited and terse.\n";
const defaultMarkdown = [
  "---",
  'name: "Documentation Maintainer Skill"',
  'description: "Use documentation tools to maintain company knowledge."',
  `key: "${canonicalKey}"`,
  "---",
  "",
  "# Documentation Maintainer Skill",
  "",
  "Use documentation tools to maintain company knowledge.",
  "",
].join("\n");

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: pluginKey,
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Skills Test",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["skills.managed"],
    entrypoints: { worker: "./dist/worker.js" },
    skills: [{
      skillKey: "documentation-maintainer",
      displayName: "Documentation Maintainer Skill",
      description: "Use documentation tools to maintain company knowledge.",
      files: [{
        path: "references/documentation-style.md",
        content: referenceContent,
      }],
    }],
  };
}

function skill(overrides: Record<string, unknown> = {}) {
  return {
    id: skillId,
    companyId,
    key: canonicalKey,
    name: "Documentation Maintainer Skill",
    description: "Use documentation tools to maintain company knowledge.",
    sourceType: "catalog",
    markdown: defaultMarkdown,
    fileInventory: [
      { path: "SKILL.md", kind: "skill" },
      { path: "references/documentation-style.md", kind: "reference" },
    ],
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    ...overrides,
  };
}

function defaultsJson() {
  return {
    skillKey: "documentation-maintainer",
    displayName: "Documentation Maintainer Skill",
    slug: "documentation-maintainer",
    description: "Use documentation tools to maintain company knowledge.",
    canonicalKey,
    files: ["SKILL.md", "references/documentation-style.md"],
  };
}

function binding(resourceId = skillId) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    companyId,
    pluginId,
    pluginKey,
    resourceKind: "skill",
    resourceKey: "documentation-maintainer",
    resourceId,
    defaultsJson: defaultsJson(),
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
  };
}

function service(
  db: ReturnType<typeof createMockDb>["db"],
  pluginManifest = manifest(),
) {
  return pluginManagedSkillService(db, {
    pluginId,
    manifest: pluginManifest,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  skills.getById.mockResolvedValue(skill());
  skills.getByKey.mockResolvedValue(null);
  skills.importPackageFiles.mockResolvedValue([
    { skill: skill(), originalSlug: "documentation-maintainer" },
  ]);
  skills.readFile.mockImplementation(
    async (_companyId: string, _skillId: string, filePath: string) =>
      filePath === "references/documentation-style.md"
        ? { content: referenceContent }
        : null,
  );
});

describe("plugin-managed skills", () => {
  it("imports and binds a declared skill by its canonical key", async () => {
    const harness = createMockDb({
      select: [[], []],
      insert: [[binding()]],
    });

    await expect(
      service(harness.db).reconcile("documentation-maintainer", companyId),
    ).resolves.toMatchObject({
      status: "created",
      skillId,
      defaultDrift: null,
      skill: {
        key: canonicalKey,
        fileInventory: expect.arrayContaining([
          expect.objectContaining({ path: "SKILL.md", kind: "skill" }),
          expect.objectContaining({
            path: "references/documentation-style.md",
            kind: "reference",
          }),
        ]),
      },
    });

    expect(skills.importPackageFiles).toHaveBeenCalledWith(
      companyId,
      {
        "documentation-maintainer/SKILL.md": defaultMarkdown,
        "documentation-maintainer/references/documentation-style.md": referenceContent,
      },
      { onConflict: "replace" },
    );
    const bindingValues = harness.calls.find(
      (call) => call.operation === "insert" && call.method === "values",
    )?.args[0];
    expect(bindingValues).toMatchObject({
      companyId,
      pluginId,
      pluginKey,
      resourceKind: "skill",
      resourceKey: "documentation-maintainer",
      resourceId: skillId,
      defaultsJson: defaultsJson(),
    });
    expect(logActivity).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({ action: "plugin.managed_skill.reconciled" }),
    );
  });

  it("resolves a bound skill without rewriting an unchanged binding", async () => {
    const harness = createMockDb({
      select: [[binding()], [binding()]],
    });

    await expect(
      service(harness.db).reconcile("documentation-maintainer", companyId),
    ).resolves.toMatchObject({
      status: "resolved",
      skillId,
      defaultDrift: null,
    });

    expect(skills.getById).toHaveBeenCalledWith(companyId, skillId);
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("preserves operator edits and reports their drift during reconcile", async () => {
    const edited = skill({
      name: "Custom Documentation Skill",
      markdown: "# Custom instructions\n",
    });
    skills.getById.mockResolvedValue(edited);
    const harness = createMockDb({ select: [[binding()], [binding()]] });

    await expect(
      service(harness.db).reconcile("documentation-maintainer", companyId),
    ).resolves.toMatchObject({
      status: "resolved",
      skill: {
        name: "Custom Documentation Skill",
        markdown: "# Custom instructions\n",
      },
      defaultDrift: { changedFiles: ["SKILL.md"] },
    });

    expect(skills.importPackageFiles).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("resets through the manifest package while retaining the stable binding", async () => {
    const harness = createMockDb({ select: [[binding()]] });

    await expect(
      service(harness.db).reset("documentation-maintainer", companyId),
    ).resolves.toMatchObject({
      status: "reset",
      skillId,
      skill: { markdown: defaultMarkdown },
      defaultDrift: null,
    });

    expect(skills.getByKey).not.toHaveBeenCalled();
    expect(skills.importPackageFiles).toHaveBeenCalledOnce();
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
    expect(logActivity).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({ action: "plugin.managed_skill.reset" }),
    );
  });

  it("injects the canonical managed key into manifest-provided markdown", async () => {
    const pluginManifest = manifest();
    pluginManifest.skills = [{
      skillKey: "markdown-skill",
      displayName: "Markdown Skill",
      markdown: [
        "---",
        "name: markdown-skill",
        "description: Markdown source without a key.",
        "---",
        "",
        "# Markdown Skill",
      ].join("\n"),
    }];
    const markdownSkill = skill({
      key: "plugin/paperclip-managed-skills-test/markdown-skill",
      name: "markdown-skill",
      markdown: "ignored by this import-boundary assertion",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });
    skills.importPackageFiles.mockResolvedValue([
      { skill: markdownSkill, originalSlug: "markdown-skill" },
    ]);
    skills.readFile.mockResolvedValue(null);
    const harness = createMockDb({ select: [[], []], insert: [[binding(skillId)]] });

    await service(harness.db, pluginManifest).reconcile("markdown-skill", companyId);

    const files = skills.importPackageFiles.mock.calls[0]?.[1] as Record<string, string>;
    expect(files["markdown-skill/SKILL.md"]).toContain(
      'key: "plugin/paperclip-managed-skills-test/markdown-skill"',
    );
  });
});
