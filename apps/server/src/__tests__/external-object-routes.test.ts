import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";
const ownerRunId = "55555555-5555-4555-8555-555555555555";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockExternalObjectsService = vi.hoisted(() => ({
  getIssueSummary: vi.fn(),
  getIssueSummaries: vi.fn(),
  listForIssue: vi.fn(),
  refreshIssueObjects: vi.fn(),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));
let errorHandler!: typeof import("../middleware/index.js").errorHandler;
let issueRoutes!: typeof import("../routes/issues.js").issueRoutes;

function registerRouteMocks() {
  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => mockExternalObjectsService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companySkillService: () => ({}),
    companyService: () => ({
      getById: vi.fn(async () => null),
    }),
    companySearchService: () => ({}),
    documentAnnotationService: () => ({}),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    goalService: () => ({}),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    }),
    issueService: () => mockIssueService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({}),
    workProductService: () => ({}),
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    ownerAgentId,
    ownerUserId: null,
    identifier: "PAP-2265",
    title: "External object routes",
    executionWorkspaceId: null,
    ...overrides,
  };
}

async function createApp(actor: Express.Request["actor"]) {
  const routeDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [makeIssue()]),
      })),
    })),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", denyGenericAgentRest("REST"));
  app.use(
    "/api",
    issueRoutes(
      routeDb as any,
      { provider: "local_disk" } as any,
      { ordinaryIssues: {} as any },
    ),
  );
  app.use(errorHandler);
  return app;
}

function boardActor(): Express.Request["actor"] {
  return testBoardSessionActor({
    userId: "board-user",
    userName: null,
    userEmail: null,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "member" }],
    isInstanceAdmin: false,
  });
}

function ownerActor(): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: ownerAgentId,
    companyId,
    keyId: "key-1",
    runId: ownerRunId,
    source: "internal",
  };
}

function peerActor(): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: peerAgentId,
    companyId,
    keyId: "key-2",
    runId: "66666666-6666-4666-8666-666666666666",
    source: "internal",
  };
}

describe("external object routes", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/external-objects.js");
    registerRouteMocks();
    const [middlewareModule, issueRouteModule] = await Promise.all([
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
      vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    ]);
    errorHandler = middlewareModule.errorHandler;
    issueRoutes = issueRouteModule.issueRoutes;
  }, 30_000);

  beforeEach(() => {
    vi.resetAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) => ({
      allowed: action === "issue:read" || action === "issue:mutate",
      explanation: "Denied by test mock",
    }));
    mockAgentService.list.mockResolvedValue([
      { id: ownerAgentId, companyId, reportsTo: null, governance: {} },
      { id: peerAgentId, companyId, reportsTo: null, governance: {} },
    ]);
    mockExternalObjectsService.getIssueSummary.mockResolvedValue({ total: 1, objects: [] });
    mockExternalObjectsService.getIssueSummaries.mockImplementation(async (_companyId: string, issueIds: string[]) =>
      new Map(issueIds.map((id) => [id, { total: 1, objects: [] }])),
    );
    mockExternalObjectsService.listForIssue.mockResolvedValue([]);
    mockExternalObjectsService.refreshIssueObjects.mockResolvedValue([
      { object: { id: "77777777-7777-4777-8777-777777777777" }, refreshed: false, reason: "no_resolver" },
    ]);
    mockInstanceSettingsService.getExperimental.mockResolvedValue({
      enableExternalObjects: true,
    });
  });

  it("enforces company access on read routes", async () => {
    const app = await createApp({ ...boardActor(), companyIds: ["other-company"] });

    const res = await request(app).get(`/api/issues/${issueId}/external-object-summary`);

    // Uniform 404 so cross-tenant ids are indistinguishable from missing ones.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Issue not found");
    expect(mockExternalObjectsService.getIssueSummary).not.toHaveBeenCalled();
  });

  it("allows board users to read issue external object summaries", async () => {
    const app = await createApp(boardActor());

    const res = await request(app).get(`/api/issues/${issueId}/external-object-summary`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(mockExternalObjectsService.getIssueSummary).toHaveBeenCalledWith(issueId);
  });

  it("denies agent credentials before reading issue external objects", async () => {
    const app = await createApp(ownerActor());

    const summary = await request(app).get(`/api/issues/${issueId}/external-object-summary`);
    expect(summary.status).toBe(403);
    expect(summary.body.code).toBe("compiled_run_interface_required");
    expect(mockExternalObjectsService.getIssueSummary).not.toHaveBeenCalled();

    const list = await request(app).get(`/api/issues/${issueId}/external-objects`);
    expect(list.status).toBe(403);
    expect(list.body.code).toBe("compiled_run_interface_required");
    expect(mockExternalObjectsService.listForIssue).not.toHaveBeenCalled();
  });

  it("allows board users to fetch company-scoped external object summaries in bulk", async () => {
    const app = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/external-object-summaries`)
      .send({ issueIds: [issueId] });

    expect(res.status).toBe(200);
    expect(res.body.summaries[issueId].total).toBe(1);
    expect(mockExternalObjectsService.getIssueSummaries).toHaveBeenCalledWith(companyId, [issueId]);
  });

  it("denies agent credentials before reading bulk external object summaries", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/external-object-summaries`)
      .send({ issueIds: [issueId] });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("compiled_run_interface_required");
    expect(mockExternalObjectsService.getIssueSummaries).not.toHaveBeenCalled();
  });

  it("enforces company access on bulk external object summaries", async () => {
    const app = await createApp({ ...boardActor(), companyIds: ["other-company"] });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/external-object-summaries`)
      .send({ issueIds: [issueId] });

    expect(res.status).toBe(403);
    expect(mockExternalObjectsService.getIssueSummaries).not.toHaveBeenCalled();
  });

  it("rejects a non-owner agent manual refresh through generic REST", async () => {
    const app = await createApp(peerActor());

    const res = await request(app)
      .post(`/api/issues/${issueId}/external-objects/refresh`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("compiled_run_interface_required");
    expect(mockExternalObjectsService.refreshIssueObjects).not.toHaveBeenCalled();
  });

  it("rejects an owner agent manual refresh through generic REST", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app)
      .post(`/api/issues/${issueId}/external-objects/refresh`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("compiled_run_interface_required");
    expect(mockExternalObjectsService.refreshIssueObjects).not.toHaveBeenCalled();
  });
});
