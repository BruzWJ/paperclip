import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companySkillService } from "../services/company-skills.js";
import { createMockDb } from "./helpers/mock-db.js";

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  companyPins: vi.fn(),
  pruneEmptyBundledCategories: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => ({ list: mocks.listAgents })),
}));

vi.mock("../services/runtime-skill-selections.js", () => ({
  companySkillPinsForCompany: mocks.companyPins,
}));

vi.mock("../services/folders.js", () => ({
  folderService: vi.fn(() => ({
    pruneEmptyBundledCategories: mocks.pruneEmptyBundledCategories,
    ensureBundledCategory: vi.fn(),
    getFolder: vi.fn(),
  })),
}));

function skillRow(companyId: string, skillId: string, skillKey: string) {
  const now = new Date("2026-03-11T00:00:00.000Z");
  return {
    id: skillId,
    companyId,
    folderId: null,
    key: skillKey,
    slug: "reflection-coach",
    name: "Reflection Coach",
    description: null,
    markdown: "# Reflection Coach\n",
    sourceType: "catalog",
    sourceLocator: "paperclip://catalog/reflection-coach",
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
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
    installCount: 0,
    forkCount: 0,
    currentVersionId: null,
    metadata: { sourceKind: "catalog" },
    createdAt: now,
    updatedAt: now,
  };
}

function detailHarness() {
  const companyId = randomUUID();
  const skillId = randomUUID();
  const agentId = randomUUID();
  const skillKey = `company/${companyId}/reflection-coach`;
  const harness = createMockDb({
    select: [
      [{ id: companyId }],
      [],
      [],
      [skillRow(companyId, skillId, skillKey)],
      [],
    ],
  });
  mocks.listAgents.mockResolvedValue([
    {
      id: agentId,
      companyId,
      name: "Reviewer",
      urlKey: "reviewer",
      adapterType: "codex",
    },
  ]);
  mocks.companyPins.mockResolvedValue([
    { agentId, key: skillKey, versionId: randomUUID() },
  ]);
  return { ...harness, companyId, skillId };
}

describe("companySkillService.detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pruneEmptyBundledCategories.mockResolvedValue(undefined);
  });

  it("reports attached agents without probing adapter runtime skill state", async () => {
    const { db, companyId, skillId } = detailHarness();

    const detail = await companySkillService(db).detail(companyId, skillId);

    expect(detail?.usedByAgents).toEqual([
      expect.objectContaining({
        name: "Reviewer",
        desired: true,
        actualState: null,
      }),
    ]);
    expect(mocks.listAgents).toHaveBeenCalledWith(companyId);
    expect(mocks.companyPins).toHaveBeenCalledWith(db, companyId);
  });

  it("uses explicit company skill column selections when resolving detail usage", async () => {
    const { db, calls, companyId, skillId } = detailHarness();

    const detail = await companySkillService(db).detail(companyId, skillId);

    expect(detail?.usedByAgents).toEqual([
      expect.objectContaining({ name: "Reviewer", desired: true }),
    ]);
    const selectCalls = calls.filter((call) => call.method === "select");
    expect(selectCalls).not.toHaveLength(0);
    expect(selectCalls.every((call) => call.args.length === 1)).toBe(true);
  });
});
