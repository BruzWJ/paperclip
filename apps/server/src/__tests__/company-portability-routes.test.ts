import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockCompanyArtifactsService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/budgets.js", () => ({
  budgetService: () => mockBudgetService,
}));

vi.mock("../services/companies.js", () => ({
  companyService: () => mockCompanyService,
}));

vi.mock("../services/company-portability.js", () => ({
  companyPortabilityService: () => mockCompanyPortabilityService,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyArtifactsService: () => mockCompanyArtifactsService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  logActivity: mockLogActivity,
}));

function registerCompanyRouteMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    budgetService: () => mockBudgetService,
    companyArtifactsService: () => mockCompanyArtifactsService,
    companyPortabilityService: () => mockCompanyPortabilityService,
    companyService: () => mockCompanyService,
    logActivity: mockLogActivity,
  }));
}

let appImportCounter = 0;

async function createApp(actor: Record<string, unknown>) {
  registerCompanyRouteMocks();
  appImportCounter += 1;
  const routeModulePath = `../routes/companies.js?company-portability-routes-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?company-portability-routes-${appImportCounter}`;
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/companies.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", denyGenericAgentRest("REST"));
  app.use(
    "/api/companies",
    companyRoutes({} as any, undefined, {} as never),
  );
  app.use(errorHandler);
  return app;
}

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const agentId = "agent-1";

const exportRequest = {
  include: { company: true, agents: true, projects: true },
};

function createExportResult() {
  return {
    rootPath: "paperclip",
    manifest: {
      agents: [],
      skills: [],
      projects: [],
      issues: [],
      envInputs: [],
      includes: { company: true, agents: true, projects: true, issues: false, skills: false },
      company: null,
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      source: null,
    },
    files: {},
    warnings: [],
  };
}

const importRequest = {
  source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
  include: { company: true, agents: true, projects: false, issues: false },
  target: { mode: "existing_company", companyId },
  collisionStrategy: "rename",
};

function sessionActor() {
  return testBoardSessionActor({
    userId: "user-1",
    userName: "Paperclip User",
    userEmail: "user@example.com",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: true,
  });
}

function createImportResult(action = "updated") {
  return {
    company: { id: companyId, action },
    agents: [{ id: "agent-1" }],
    warnings: [],
  };
}

describe.sequential("company portability routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockImplementation(async (id: string) => ({
      id,
      companyId,
    }));
    mockCompanyPortabilityService.exportBundle.mockResolvedValue(createExportResult());
    mockCompanyPortabilityService.previewExport.mockResolvedValue({
      rootPath: "paperclip",
      manifest: { agents: [], skills: [], projects: [], issues: [], envInputs: [], includes: { company: true, agents: true, projects: true, issues: false, skills: false }, company: null, schemaVersion: 1, generatedAt: new Date().toISOString(), source: null },
      files: {},
      fileInventory: [],
      counts: { files: 0, agents: 0, skills: 0, projects: 0, issues: 0 },
      warnings: [],
      paperclipExtensionPath: ".paperclip.yaml",
    });
    mockCompanyPortabilityService.previewImport.mockResolvedValue({ ok: true });
    mockCompanyPortabilityService.importBundle.mockResolvedValue({
      company: { id: companyId, action: "created" },
      agents: [],
      warnings: [],
    });
  });

  it.sequential.each([
    ["post", `/api/companies/${companyId}/exports/preview`, exportRequest],
    ["post", `/api/companies/${companyId}/export`, exportRequest],
    ["post", `/api/companies/${companyId}/exports`, exportRequest],
    ["post", `/api/companies/${companyId}/imports/preview`, importRequest],
    ["post", `/api/companies/${companyId}/imports/apply`, importRequest],
    ["post", "/api/companies/import/preview", importRequest],
    ["post", "/api/companies/import", importRequest],
  ] as const)("denies generic agent REST access to %s %s before service dispatch", async (method, path, body) => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "internal",
      runId: "run-1",
    });

    const res = await request(app)[method](path).send(body);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("compiled_run_interface_required");
    expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.exportBundle).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it.sequential("allows board users to export through legacy and safe bundle routes", async () => {
    mockCompanyPortabilityService.exportBundle.mockResolvedValue(createExportResult());
    const app = await createApp(testBoardSessionActor({
      userId: "user-1",
      companyIds: [companyId],
      isInstanceAdmin: false,
    }));

    for (const path of [`/api/companies/${companyId}/export`, `/api/companies/${companyId}/exports`]) {
      const res = await request(app).post(path).send(exportRequest);

      expect(res.status).toBe(200);
      expect(res.body.rootPath).toBe("paperclip");
    }
    expect(mockCompanyPortabilityService.exportBundle).toHaveBeenCalledTimes(2);
  });

  it.sequential("rejects replace collision strategy on safe import routes", async () => {
    const app = await createApp(testBoardSessionActor({
      userId: "user-1",
      companyIds: [companyId],
      isInstanceAdmin: false,
    }));

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/imports/preview")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "replace",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("does not allow replace");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it.sequential("rejects board users from previewing or applying imports against an inaccessible route company", async () => {
    const app = await createApp(testBoardSessionActor({
      userId: "user-1",
      companyIds: [companyId],
      isInstanceAdmin: false,
    }));

    for (const path of [
      `/api/companies/${otherCompanyId}/imports/preview`,
      `/api/companies/${otherCompanyId}/imports/apply`,
    ]) {
      const res = await request(app).post(path).send({
        ...importRequest,
        target: { mode: "existing_company", companyId: otherCompanyId },
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("does not have access");
    }
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it.sequential("rejects safe import bodies that target a different company than the route", async () => {
    const app = await createApp(testBoardSessionActor({
      userId: "user-1",
      companyIds: [companyId],
      isInstanceAdmin: false,
    }));

    for (const path of [
      `/api/companies/${companyId}/imports/preview`,
      `/api/companies/${companyId}/imports/apply`,
    ]) {
      const res = await request(app).post(path).send({
        ...importRequest,
        target: { mode: "existing_company", companyId: otherCompanyId },
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("only target the route company");
    }
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it.sequential("keeps global import preview routes board-only", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "internal",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/import/preview")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("compiled_run_interface_required");
  });

  it.sequential("keeps global import preview board-only before validating request shape", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "internal",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/import/preview")
      .send({ target: { mode: "existing_company", companyId: "not-a-uuid" } });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("compiled_run_interface_required");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it.sequential("requires instance admin for new-company import preview", async () => {
    const app = await createApp(testBoardSessionActor({
      userId: "user-1",
      companyIds: ["11111111-1111-4111-8111-111111111111"],
      isInstanceAdmin: false,
    }));

    const res = await request(app)
      .post("/api/companies/import/preview")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "new_company", newCompanyName: "Imported Test" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it.sequential("rejects replace collision strategy on safe import apply routes", async () => {
    const app = await createApp(testBoardSessionActor({
      userId: "user-1",
      companyIds: [companyId],
      isInstanceAdmin: false,
    }));

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/imports/apply")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_company", companyId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "replace",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("does not allow replace");
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it.sequential("requires instance admin for new-company import apply", async () => {
    const app = await createApp(testBoardSessionActor({
      userId: "user-1",
      companyIds: ["11111111-1111-4111-8111-111111111111"],
      isInstanceAdmin: false,
    }));

    const res = await request(app)
      .post("/api/companies/import")
      .send({
        source: { type: "inline", files: { "COMPANY.md": "---\nname: Test\n---\n" } },
        include: { company: true, agents: true, projects: false, issues: false },
        target: { mode: "new_company", newCompanyName: "Imported Test" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it.sequential("imports synchronously for an authenticated Better Auth user", async () => {
    mockCompanyPortabilityService.importBundle.mockResolvedValueOnce(createImportResult("created"));
    const app = await createApp(sessionActor());

    const res = await request(app)
      .post("/api/companies/import")
      .send(importRequest);

    expect(res.status).toBe(200);
    expect(res.body.company.id).toBe(companyId);
    expect(res.body.company.action).toBe("created");
    expect(res.body.job).toBeUndefined();
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledWith(
      importRequest,
      "user-1",
      expect.objectContaining({ authorizationActor: expect.objectContaining({ type: "board" }) }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.imported",
      companyId,
    }));
  });
});
