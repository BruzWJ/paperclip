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
vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyArtifactsService: () => mockCompanyArtifactsService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  logActivity: mockLogActivity,
}));

function createCompany() {
  const now = new Date("2026-03-19T02:00:00.000Z");
  return {
    id: "company-1",
    name: "Paperclip",
    description: null,
    status: "active",
    issuePrefix: "PAP",
    issueCounter: 568,
    budgetCurrency: "USD",
    budgetMonthlyAmount: "0",
    knownSpendAmount: "0",
    requireBoardApprovalForNewAgents: false,
    brandColor: "#123456",
    logoAssetId: "11111111-1111-4111-8111-111111111111",
    logoUrl: "/api/assets/11111111-1111-4111-8111-111111111111/content",
    createdAt: now,
    updatedAt: now,
  };
}

function companyOperatorActor() {
  return testBoardSessionActor({
    userId: "user-1",
    companyIds: ["company-1"],
    memberships: [
      {
        companyId: "company-1",
        membershipRole: "operator",
        status: "active",
      },
    ],
    isInstanceAdmin: false,
  });
}

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
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

describe("PATCH /api/companies/:companyId/branding", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
  });

  it("denies generic agent REST callers before validating branding fields", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "internal",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({ status: "archived" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("compiled_run_interface_required");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("allows board callers to update branding fields", async () => {
    const company = createCompany();
    mockCompanyService.update.mockResolvedValue({
      ...company,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
    });
    const app = await createApp(companyOperatorActor());

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({ brandColor: null, logoAssetId: null });

    expect(res.status).toBe(200);
    expect(res.body.brandColor ?? null).toBeNull();
    expect(res.body.logoAssetId ?? null).toBeNull();
  });

  it("rejects non-branding fields in the request body", async () => {
    const app = await createApp(companyOperatorActor());

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({
        logoAssetId: "11111111-1111-4111-8111-111111111111",
        status: "archived",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/companies/:companyId", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
  });

  it("denies generic agent REST callers before loading the company or validating settings", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "internal",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ status: "archived" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("compiled_run_interface_required");
    expect(mockCompanyService.getById).not.toHaveBeenCalled();
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("keeps full company settings updates board-only", async () => {
    const company = createCompany();
    mockCompanyService.getById.mockResolvedValue(company);
    mockCompanyService.update.mockResolvedValue({
      ...company,
      status: "paused",
    });
    const app = await createApp(companyOperatorActor());

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ status: "paused" });

    expect(res.status).toBe(200);
    expect(mockCompanyService.update).toHaveBeenCalledWith("company-1", { status: "paused" }, expect.objectContaining({
      actorType: "user",
      actorId: "user-1",
    }));
  });
});
