import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyCatalogSkillFile,
  getCatalogPackageMetadata,
  getCatalogSkillOrThrow,
  listCatalogSkills,
  readCatalogSkillFile,
  resolveCatalogSkillReference,
} from "../services/skills-catalog.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("skills catalog service", () => {
  it("loads a deterministic, sorted catalog with package provenance", () => {
    const skills = listCatalogSkills();
    const metadata = getCatalogPackageMetadata();

    expect(skills.length).toBeGreaterThan(0);
    expect(skills.map((skill) => skill.name)).toEqual(
      [...skills].sort((left, right) =>
        left.name.localeCompare(right.name) || left.key.localeCompare(right.key))
        .map((skill) => skill.name),
    );
    expect(metadata).toMatchObject({
      packageName: "@paperclipai/skills-catalog",
      packageVersion: expect.any(String),
    });
    expect(skills.every((skill) =>
      skill.packageName === metadata.packageName &&
      skill.packageVersion === metadata.packageVersion)).toBe(true);
  });

  it("filters by kind, category, and normalized search text", () => {
    const productSkills = listCatalogSkills({ kind: "bundled", category: "product" });
    expect(productSkills.length).toBeGreaterThan(0);
    expect(productSkills.every((skill) =>
      skill.kind === "bundled" && skill.category === "product")).toBe(true);

    const searched = listCatalogSkills({ q: "  GITHUB-PR  " });
    expect(searched).toEqual([
      expect.objectContaining({
        id: "paperclipai:bundled:software-development:github-pr-workflow",
      }),
    ]);
  });

  it("resolves canonical ids, keys, and unique slugs without aliases", () => {
    const byId = getCatalogSkillOrThrow(
      "paperclipai:bundled:software-development:github-pr-workflow",
    );

    expect(resolveCatalogSkillReference(byId.id)).toEqual({ skill: byId, ambiguous: false });
    expect(resolveCatalogSkillReference(byId.key)).toEqual({ skill: byId, ambiguous: false });
    expect(resolveCatalogSkillReference(byId.slug)).toEqual({ skill: byId, ambiguous: false });
    expect(resolveCatalogSkillReference("missing-skill")).toEqual({ skill: null, ambiguous: false });
    expect(() => getCatalogSkillOrThrow("missing-skill")).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });

  it("reads catalog markdown only after verifying the pinned content hash", async () => {
    const skill = getCatalogSkillOrThrow(
      "paperclipai:bundled:software-development:github-pr-workflow",
    );
    const file = await readCatalogSkillFile(skill.id, skill.entrypoint);
    const manifestEntry = skill.files.find((entry) => entry.path === skill.entrypoint);

    expect(file).toMatchObject({
      catalogSkillId: skill.id,
      path: skill.entrypoint,
      kind: "skill",
      language: "markdown",
      markdown: true,
    });
    expect(file.content).toContain("---");
    expect(createHash("sha256").update(file.content).digest("hex"))
      .toBe(manifestEntry?.sha256);
  });

  it("copies exact catalog bytes and rejects files outside the manifest", async () => {
    const skill = getCatalogSkillOrThrow(
      "paperclipai:bundled:software-development:github-pr-workflow",
    );
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-catalog-copy-"));
    cleanupDirectories.push(directory);
    const target = path.join(directory, "SKILL.md");

    await copyCatalogSkillFile(skill.id, skill.entrypoint, target);
    const copied = await readFile(target);
    const manifestEntry = skill.files.find((entry) => entry.path === skill.entrypoint);
    expect(createHash("sha256").update(copied).digest("hex")).toBe(manifestEntry?.sha256);

    await expect(readCatalogSkillFile(skill.id, "../outside.md"))
      .rejects.toMatchObject({ status: 404 });
  });
});
