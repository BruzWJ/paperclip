import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { createDeclarativeTestAdapter } from "./helpers/declarative-adapter.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
  resolveAdapterConfigForRuntime: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => ({ config }),
  ),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const acpxCatalog = vi.hoisted(() => ({
  adapter: null as ServerAdapterModule | null,
  refreshAcpxAdapters: vi.fn(async () => undefined),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentCompanySkillSelectionService: () => ({}),
    agentService: () => ({}),
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    budgetService: () => ({}),
    createRuntimeAgentConfigurationService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: vi.fn(),
    secretService: () => mockSecretService,
    workspaceOperationService: () => ({}),
  }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => ({
      getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
    }),
  }));
  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: (type: string) =>
      acpxCatalog.adapter?.type === type ? acpxCatalog.adapter : null,
    listAdapterModelProfiles: async () => [],
    refreshAcpxAdapters: acpxCatalog.refreshAcpxAdapters,
  }));
  // Company model policy reads the registry lazily. The fixture acts as ACPX's
  // current probe snapshot rather than a Paperclip-owned provider catalog.
  vi.doMock("../adapters/registry.js", () => ({
    listAdapterModels: async (type: string) =>
      acpxCatalog.adapter?.type === type
        ? [...acpxCatalog.adapter.definition.models]
        : [],
    resolveAvailableAdapterModel: async (modelId: string) => {
      const model = acpxCatalog.adapter?.definition.models.find(
        (candidate) => candidate.id === modelId,
      );
      if (!model) throw new Error("Model is unavailable from ACPX");
      return model;
    },
  }));
}

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/agents.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = testBoardSessionActor({
      userId: "board-user",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });
    next();
  });
  app.use("/api", agentRoutes({} as any, {
    ordinaryIssues: {
      notifyCreatorDelivery: async () => undefined,
    } as never,
  }));
  app.use(errorHandler);
  return app;
}

describe("ACPX adapter model catalog route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../adapters/registry.js");
    registerModuleMocks();
    vi.clearAllMocks();
    acpxCatalog.adapter = createDeclarativeTestAdapter({
      type: "fixture-agent-alpha",
      models: [{
        id: "fixture-model-alpha",
        label: "Fixture model alpha",
        value: "fixture-model-alpha",
        limits: null,
      }],
    });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
  });

  afterEach(() => vi.clearAllMocks());

  it("returns the latest ACPX-discovered model values without provider probe flags", async () => {
    const app = await createApp();
    const res = await request(app).get(
      "/api/companies/company-1/adapters/fixture-agent-alpha/models?refresh=1&environmentId=env-1",
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(acpxCatalog.adapter!.definition.models);
    expect(acpxCatalog.refreshAcpxAdapters).toHaveBeenCalledOnce();
    expect(mockEnvironmentService.getById).not.toHaveBeenCalled();
  }, 15_000);

  it("rejects a whitespace-normalized ACPX agent identity", async () => {
    const app = await createApp();
    const res = await request(app).get(
      "/api/companies/company-1/adapters/%20fixture-agent-alpha%20/models",
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe(
      "Adapter type must be an exact non-blank string",
    );
  }, 15_000);
});
