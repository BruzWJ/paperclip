import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";

const projectListMock = vi.hoisted(() => vi.fn());
const folderMocks = vi.hoisted(() => ({
  ensureBundledCategory: vi.fn(),
  ensureProjectFolder: vi.fn(),
  getFolder: vi.fn(),
  pruneEmptyBundledCategories: vi.fn(async () => undefined),
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => ({ list: projectListMock }),
}));

vi.mock("../services/folders.js", () => ({
  folderService: () => folderMocks,
}));

import { companySkillService } from "../services/company-skills.js";

describe("company skill local import boundary", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all([...cleanupDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("allows configured workspace imports and rejects out-of-tree and symlink escapes", async () => {
    const companyId = randomUUID();
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-approved-workspace-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-outside-skill-"));
    cleanupDirs.add(workspace);
    cleanupDirs.add(outside);
    await fs.writeFile(
      path.join(outside, "SKILL.md"),
      "---\nname: escaped\ndescription: escaped\n---\n# Escaped\n",
      "utf8",
    );
    const allowedSkill = path.join(workspace, ".agents", "skills", "allowed");
    await fs.mkdir(allowedSkill, { recursive: true });
    await fs.writeFile(
      path.join(allowedSkill, "SKILL.md"),
      "---\nname: allowed\ndescription: allowed\n---\n# Allowed\n",
      "utf8",
    );
    const symlink = path.join(workspace, "escaped-link");
    await fs.symlink(outside, symlink);

    projectListMock.mockResolvedValue([{
      id: randomUUID(),
      companyId,
      workspaces: [{ cwd: workspace }],
    }]);

    const persistedSkill = {
      id: randomUUID(),
      companyId,
      folderId: null,
      key: `${companyId}/allowed`,
      slug: "allowed",
      name: "allowed",
      description: "allowed",
      markdown: "---\nname: allowed\ndescription: allowed\n---\n# Allowed\n",
      sourceType: "local_path",
      sourceLocator: allowedSkill,
      sourceRef: null,
      trustLevel: "trusted",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "markdown" }],
      iconUrl: null,
      color: null,
      tagline: null,
      authorName: null,
      homepageUrl: null,
      categories: [],
      sharingScope: "company",
      publicShareToken: null,
      forkedFromSkillId: null,
      forkedFromCompanyId: null,
      starCount: 0,
      installCount: 1,
      forkCount: 0,
      currentVersionId: null,
      metadata: { sourceKind: "local_path" },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const companyExists = [{ id: companyId }];
    const harness = createMockDb({
      select: [
        companyExists, [], [], [],
        companyExists, [], [],
        companyExists, [], [],
        companyExists, [], [],
        companyExists, [], [],
      ],
      insert: [[persistedSkill]],
    });
    const service = companySkillService(harness.db);

    await expect(service.importFromSource(companyId, allowedSkill)).resolves.toMatchObject({
      imported: [expect.objectContaining({ slug: "allowed" })],
    });
    await expect(service.importFromSource(companyId, outside)).rejects.toMatchObject({
      status: 403,
      details: { code: "skill_workspace_boundary_denied" },
    });
    await expect(service.importFromSource(companyId, symlink)).rejects.toMatchObject({
      status: 403,
      details: { code: "skill_workspace_boundary_denied" },
    });
    await expect(service.importFromSource(companyId, "ftp://example.com/skill")).rejects.toMatchObject({
      status: 422,
      details: { code: "skill_source_validation_failed" },
    });
    await expect(service.importFromSource(companyId, "http://example.com/skill")).rejects.toMatchObject({
      status: 422,
      details: { code: "skill_source_validation_failed" },
    });

    expect(projectListMock).toHaveBeenCalledTimes(3);
    expect(folderMocks.pruneEmptyBundledCategories).toHaveBeenCalledTimes(5);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });
});
