import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testBoardSessionActor } from "./helpers/request-actor.js";
import { testSecretsRuntimeConfig } from "./helpers/secrets-runtime.js";

const companyAId = "11111111-1111-4111-8111-111111111111";
const companyBId = "22222222-2222-4222-8222-222222222222";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
  stampRoleGrants: vi.fn(),
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

function registerCompanyRouteMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
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
  const routeModulePath = `../routes/companies.js?cross-company-authz-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?cross-company-authz-${appImportCounter}`;
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/companies.js")>,
    import(middlewareModulePath) as Promise<
      typeof import("../middleware/index.js")
    >,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api/companies",
    companyRoutes(
      {} as any,
      undefined,
      {} as never,
      testSecretsRuntimeConfig(),
    ),
  );
  app.use(errorHandler);
  return app;
}

function createCompany(id: string) {
  const now = new Date("2026-06-18T00:00:00.000Z");
  return {
    id,
    name: id === companyAId ? "Company A" : "Company B",
    description: null,
    status: "active",
    taskPrefix: id === companyAId ? "CPA" : "CPB",
    taskCounter: 1,
    budgetCurrency: "USD",
    budgetMonthlyAmount: "0",
    knownSpendAmount: "0",
    requireBoardApprovalForNewAgents: false,
    brandColor: "#123456",
    logoAssetId: null,
    logoUrl: null,
    attachmentMaxBytes: 25_000_000,
    createdAt: now,
    updatedAt: now,
  };
}

const exportRequest = {
  include: { company: true, agents: true, projects: true },
};

function exportResult() {
  return {
    rootPath: "paperclip",
    manifest: {
      agents: [],
      projects: [],
      tasks: [],
      envInputs: [],
      includes: {
        company: true,
        agents: true,
        projects: true,
        tasks: false,
      },
      company: null,
      schemaVersion: 5,
      generatedAt: "2026-06-18T00:00:00.000Z",
      source: null,
    },
    files: {},
    warnings: [],
  };
}

function exportPreviewResult() {
  return {
    ...exportResult(),
    fileInventory: [],
    counts: { files: 0, agents: 0, projects: 0, tasks: 0 },
    paperclipExtensionPath: ".paperclip.yaml",
  };
}

function importRequest(targetCompanyId = companyBId) {
  return {
    source: {
      type: "inline",
      files: { "COMPANY.md": "---\nname: Imported\n---\n" },
    },
    include: { company: true, agents: true, projects: false, tasks: false },
    target: { mode: "existing_company", companyId: targetCompanyId },
    collisionStrategy: "rename",
  };
}

function importResult(companyId = companyBId) {
  return {
    company: { id: companyId, action: "updated" },
    agents: [],
    warnings: [],
  };
}

function resetMockDefaults() {
  mockCompanyService.getById.mockImplementation(async (id: string) => {
    if (id === companyAId || id === companyBId) return createCompany(id);
    return null;
  });
  mockCompanyService.update.mockImplementation(
    async (id: string, body: Record<string, unknown>) => ({
      ...createCompany(id),
      ...body,
    }),
  );
  mockCompanyService.archive.mockImplementation(async (id: string) => ({
    ...createCompany(id),
    status: "archived",
  }));
  mockCompanyService.remove.mockImplementation(async (id: string) => ({
    companyId: id,
    lifecycleOperationId: "33333333-3333-4333-8333-333333333333",
    generation: 1,
    status: "completed",
    purged: true,
    alreadyAbsent: false,
  }));
  mockCompanyPortabilityService.exportBundle.mockResolvedValue(exportResult());
  mockCompanyPortabilityService.previewExport.mockResolvedValue(
    exportPreviewResult(),
  );
  mockCompanyPortabilityService.previewImport.mockResolvedValue({ ok: true });
  mockCompanyPortabilityService.importBundle.mockResolvedValue(importResult());
}

function assertNoTargetMutationSideEffects() {
  expect(mockCompanyService.update).not.toHaveBeenCalled();
  expect(mockCompanyService.archive).not.toHaveBeenCalled();
  expect(mockCompanyService.remove).not.toHaveBeenCalled();
  expect(mockCompanyPortabilityService.exportBundle).not.toHaveBeenCalled();
  expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
  expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  expect(mockLogActivity).not.toHaveBeenCalled();
}

function boardActor(input: {
  userId: string;
  companyIds?: string[];
  memberships?: Array<{
    companyId: string;
    membershipRole: string;
    status: string;
  }>;
  isInstanceAdmin?: boolean;
  source?: string;
}) {
  return testBoardSessionActor({
    userId: input.userId,
    companyIds: input.companyIds ?? [],
    memberships: input.memberships ?? [],
    isInstanceAdmin: input.isInstanceAdmin ?? false,
  });
}

describe.sequential("company route cross-company authorization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    resetMockDefaults();
  });

  it("covers non-member, active viewer, and instance-admin company boundaries", async () => {
    const nonMemberApp = await createApp(boardActor({ userId: "outsider" }));
    const nonMember = await request(nonMemberApp).get(
      `/api/companies/${companyBId}`,
    );
    expect(nonMember.status).toBe(403);
    expect(nonMember.body.error).toContain("access to this company");

    vi.clearAllMocks();
    resetMockDefaults();
    const viewerApp = await createApp(
      boardActor({
        userId: "viewer",
        companyIds: [companyBId],
        memberships: [
          { companyId: companyBId, membershipRole: "viewer", status: "active" },
        ],
      }),
    );
    await request(viewerApp).get(`/api/companies/${companyBId}`).expect(200);
    await request(viewerApp)
      .patch(`/api/companies/${companyBId}`)
      .send({ description: "Updated" })
      .expect(200);
    await request(viewerApp)
      .patch(`/api/companies/${companyBId}/branding`)
      .send({ brandColor: "#abcdef" })
      .expect(200);
    await request(viewerApp)
      .post(`/api/companies/${companyBId}/archive`)
      .send({})
      .expect(200);
    await request(viewerApp).delete(`/api/companies/${companyBId}`).expect(200);
    await request(viewerApp)
      .post(`/api/companies/${companyBId}/exports`)
      .send(exportRequest)
      .expect(200);
    await request(viewerApp)
      .post(`/api/companies/${companyBId}/exports/preview`)
      .send(exportRequest)
      .expect(200);
    await request(viewerApp)
      .post(`/api/companies/${companyBId}/imports/preview`)
      .send(importRequest())
      .expect(200);
    await request(viewerApp)
      .post(`/api/companies/${companyBId}/imports/apply`)
      .send(importRequest())
      .expect(200);

    vi.clearAllMocks();
    resetMockDefaults();
    const adminWithoutSnapshotApp = await createApp(
      boardActor({
        userId: "board-user",
        source: "session",
        isInstanceAdmin: true,
      }),
    );
    await request(adminWithoutSnapshotApp)
      .get(`/api/companies/${companyBId}`)
      .expect(403);
    await request(adminWithoutSnapshotApp)
      .patch(`/api/companies/${companyBId}`)
      .send({ description: "Denied" })
      .expect(403);

    vi.clearAllMocks();
    resetMockDefaults();
    const adminWithoutMembershipApp = await createApp(
      boardActor({
        userId: "instance-admin",
        isInstanceAdmin: true,
      }),
    );
    const adminRead = await request(adminWithoutMembershipApp).get(
      `/api/companies/${companyBId}`,
    );
    expect(adminRead.status).toBe(403);
    expect(adminRead.body.error).toContain("access to this company");
    const adminWrite = await request(adminWithoutMembershipApp)
      .patch(`/api/companies/${companyBId}`)
      .send({ description: "Admin" });
    expect(adminWrite.status).toBe(403);
    expect(adminWrite.body.error).toContain("access to this company");
    assertNoTargetMutationSideEffects();
  });
});
