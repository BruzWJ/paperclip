import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testBoardSessionActor } from "./helpers/request-actor.js";
import { teamsCatalogService } from "../services/teams-catalog.js";

const mocks = vi.hoisted(() => ({
  previewImport: vi.fn(),
  importBundle: vi.fn(),
  installFromCatalog: vi.fn(),
  importFromSource: vi.fn(),
  listAgents: vi.fn(),
  getAgentById: vi.fn(),
  logActivity: vi.fn(),
  validateAdapterConfiguration: vi.fn(),
}));

vi.mock("../services/company-portability.js", () => ({
  companyPortabilityService: vi.fn(() => ({
    previewImport: mocks.previewImport,
    importBundle: mocks.importBundle,
  })),
}));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: vi.fn(() => ({
    installFromCatalog: mocks.installFromCatalog,
    importFromSource: mocks.importFromSource,
  })),
}));

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => ({
    list: mocks.listAgents,
    getById: mocks.getAgentById,
  })),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));

vi.mock("../services/agent-adapter-config-revisions.js", () => ({
  validateRegisteredAdapterRuntimeConfiguration:
    mocks.validateAdapterConfiguration,
}));

const ordinaryIssues = {} as never;
const db = {} as never;

describe.sequential("teams catalog explicit adapter contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.previewImport.mockResolvedValue({ warnings: [], errors: [] });
    mocks.importBundle.mockResolvedValue({
      agents: [],
      projects: [],
      issues: [],
      skills: [],
      warnings: [],
    });
    mocks.installFromCatalog.mockResolvedValue({ warnings: [] });
    mocks.importFromSource.mockResolvedValue({ warnings: [] });
    mocks.listAgents.mockResolvedValue([]);
    mocks.getAgentById.mockResolvedValue(null);
    mocks.logActivity.mockResolvedValue(undefined);
    mocks.validateAdapterConfiguration.mockResolvedValue(undefined);
  });

  it("rejects a catalog install with no explicit adapter configuration", async () => {
    const service = teamsCatalogService(db, ordinaryIssues);

    await expect(
      service.installCatalogTeam(randomUUID(), "core-exec-team", {
        targetManagerAgentId: null,
        collisionStrategy: "rename",
        include: { projects: false, issues: false },
        actor: {
          actorType: "system",
          actorId: "teams-catalog-test",
        },
      }),
    ).rejects.toMatchObject({ status: 422 });

    expect(mocks.previewImport).not.toHaveBeenCalled();
    expect(mocks.importBundle).not.toHaveBeenCalled();
  });

  it("rejects a partial adapter selection instead of filling the missing agent", async () => {
    const service = teamsCatalogService(db, ordinaryIssues);

    await expect(
      service.installCatalogTeam(randomUUID(), "product-engineering", {
        targetManagerAgentId: null,
        collisionStrategy: "rename",
        include: { projects: false, issues: false },
        actor: {
          actorType: "system",
          actorId: "teams-catalog-test",
        },
        adapterOverrides: {
          "engineering-lead": {
            adapterType: "codex",
            adapterConfig: { model: "gpt-5.6" },
          },
        },
      }),
    ).rejects.toMatchObject({ status: 422 });

    expect(mocks.validateAdapterConfiguration).toHaveBeenCalledOnce();
    expect(mocks.previewImport).not.toHaveBeenCalled();
    expect(mocks.importBundle).not.toHaveBeenCalled();
  });

  it("imports the ordinary core team with exactly the operator's adapter choices", async () => {
    const companyId = randomUUID();
    const adapterOverrides = {
      "company-lead": {
        adapterType: "codex",
        adapterConfig: { model: "gpt-5.6" },
      },
      "engineering-lead": {
        adapterType: "codex",
        adapterConfig: { model: "gpt-5.6" },
      },
      qa: {
        adapterType: "codex",
        adapterConfig: { model: "gpt-5.6" },
      },
    };
    mocks.importBundle.mockResolvedValue({
      agents: [
        { name: "Company Lead" },
        { name: "Engineering Lead" },
        { name: "QA" },
      ],
      projects: [],
      issues: [],
      skills: [],
      warnings: [],
    });
    const service = teamsCatalogService(db, ordinaryIssues);

    await service.installCatalogTeam(companyId, "core-exec-team", {
      targetManagerAgentId: null,
      collisionStrategy: "rename",
      include: { projects: false, issues: false },
      actor: {
        actorType: "user",
        actorId: "board-user",
        userId: "board-user",
      },
      authorizationActor: testBoardSessionActor({
        userId: "board-user",
        companyIds: [companyId],
      }),
      adapterOverrides,
    });

    expect(mocks.validateAdapterConfiguration).toHaveBeenCalledTimes(3);
    expect(mocks.previewImport).toHaveBeenCalledOnce();
    expect(mocks.importBundle).toHaveBeenCalledOnce();
    expect(mocks.previewImport.mock.calls[0]?.[0]).toMatchObject({
      target: { mode: "existing_company", companyId },
      adapterOverrides,
    });
    expect(mocks.importBundle.mock.calls[0]?.[0]).toMatchObject({
      target: { mode: "existing_company", companyId },
      adapterOverrides,
    });
    expect(mocks.importBundle.mock.calls[0]?.[0].adapterOverrides).toEqual(
      adapterOverrides,
    );
  });
});
