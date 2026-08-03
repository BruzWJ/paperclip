import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";
const agentId = "11111111-1111-4111-8111-111111111111";
const projectId = "44444444-4444-4444-8444-444444444444";
const slotId = "55555555-5555-4555-8555-555555555555";
const issueId = "66666666-6666-4666-8666-666666666666";

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  canUser: vi.fn(),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));
const mockSummarySlotService = vi.hoisted(() => ({
  getSlot: vi.fn(),
  listRevisions: vi.fn(),
  dispatchRefresh: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function slot(overrides: Record<string, unknown> = {}) {
  return {
    id: slotId,
    companyId,
    scopeKind: "project",
    scopeId: projectId,
    slotKey: "header",
    routineId: slotId,
    documentId: null,
    status: "idle",
    failureReason: null,
    generatingIssueId: null,
    lastGeneratedAt: null,
    lastGeneratedByAgentId: null,
    lastModel: null,
    createdAt: new Date("2026-07-14T00:00:00.000Z"),
    updatedAt: new Date("2026-07-14T00:00:00.000Z"),
    ...overrides,
  };
}

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/summary-slots.js", () => ({
    summarySlotService: () => mockSummarySlotService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ summarySlotRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/summary-slots.js")>("../routes/summary-slots.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", summarySlotRoutes({} as any, {
    ordinaryIssues: {} as never,
  }));
  app.use(errorHandler);
  return app;
}

const boardActor = testBoardSessionActor({
  userId: "board-user",
  companyIds: [companyId],
  isInstanceAdmin: false,
});
const agentActor = {
  type: "agent",
  agentId,
  companyId,
  source: "internal",
  runId: "run-123",
};
const slotPath = `/api/companies/${companyId}/summary-slots/project/header?scopeId=${projectId}`;

describe("summary slot routes", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true, explanation: "Allowed." });
    mockAccessService.canUser.mockResolvedValue(true);
    mockInstanceSettingsService.getExperimental.mockResolvedValue({
      enableSummaries: true,
    });
    mockSummarySlotService.getSlot.mockResolvedValue({
      slot: slot(),
      document: null,
      generatingIssue: null,
    });
    mockSummarySlotService.listRevisions.mockResolvedValue({
      slot: slot(),
      revisions: [],
    });
    mockSummarySlotService.dispatchRefresh.mockResolvedValue({
      slot: slot({ status: "generating", generatingIssueId: issueId }),
      generatingIssue: {
        id: issueId,
        identifier: "PAP-1000",
        title: "Refresh project summary",
        status: "todo",
        ownerAgentId: agentId,
      },
      alreadyGenerating: false,
    });
  });

  it("keeps slot state and revisions board-readable", async () => {
    const app = await createApp(boardActor);
    const [state, revisions] = await Promise.all([
      request(app).get(slotPath),
      request(app).get(
        `/api/companies/${companyId}/summary-slots/project/header/revisions?scopeId=${projectId}`,
      ),
    ]);
    expect(state.status).toBe(200);
    expect(revisions.status).toBe(200);
    expect(mockSummarySlotService.getSlot).toHaveBeenCalledWith({
      companyId,
      scopeKind: "project",
      slotKey: "header",
      scopeId: projectId,
    });
  });

  it("passes an explicit owner only to board-triggered routine configuration", async () => {
    const app = await createApp(boardActor);
    const response = await request(app)
      .post(`/api/companies/${companyId}/summary-slots/project/header/refresh`)
      .send({ scopeId: projectId, ownerAgentId: agentId });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(mockSummarySlotService.dispatchRefresh).toHaveBeenCalledWith(
      {
        companyId,
        scopeKind: "project",
        slotKey: "header",
        scopeId: projectId,
        ownerAgentId: agentId,
      },
      { type: "user", userId: "board-user" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "summary_slot.refresh_requested",
        entityType: "summary_slot",
        entityId: slotId,
      }),
    );
  });

  it("rejects refreshes from agents and boards outside the company", async () => {
    const [agentApp, foreignBoardApp] = await Promise.all([
      createApp(agentActor),
      createApp({ ...boardActor, companyIds: [otherCompanyId] }),
    ]);
    const [agentResponse, foreignResponse] = await Promise.all([
      request(agentApp)
        .post(`/api/companies/${companyId}/summary-slots/project/header/refresh`)
        .send({ ownerAgentId: agentId }),
      request(foreignBoardApp).get(slotPath),
    ]);
    expect(agentResponse.status).toBe(403);
    expect(foreignResponse.status).toBe(403);
  });

  it("has no agent-facing summary write route", async () => {
    const app = await createApp(agentActor);
    const response = await request(app)
      .put(slotPath)
      .send({ markdown: "# forbidden writer" });
    expect(response.status).toBe(404);
  });
});
