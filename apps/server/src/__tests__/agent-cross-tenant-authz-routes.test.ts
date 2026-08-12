import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testBoardSessionActor } from "./helpers/request-actor.js";

vi.unmock("http");
vi.unmock("node:http");

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  currentAdapterConfigRevisionId: null,
  budgetMonthlyAmount: "0",
  knownSpendAmount: "0",
  pauseReason: null,
  pausedAt: null,
  instruction: null,
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  updatedAt: new Date("2026-04-11T00:00:00.000Z"),
};

let currentAccessCanUser = false;

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  clearError: vi.fn(),
  terminate: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockTaskExecutionCancellation = vi.hoisted(() => ({
  requestAgentCancellationsInTransaction: vi.fn(),
  reconcileRequestedCancellations: vi.fn(),
}));

const mockTaskApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockTaskService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockResolveInvokableTaskOwnerCatalogFromDb = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/agent-invokability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/agent-invokability.js")>()),
  resolveInvokableTaskOwnerCatalogFromDb:
    mockResolveInvokableTaskOwnerCatalogFromDb,
}));

vi.mock("../routes/authz.js", async () => {
  const { forbidden, unauthorized } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
  function assertAuthenticated(req: Express.Request) {
    if (req.actor.type === "none") {
      throw unauthorized();
    }
  }

  function assertBoard(req: Express.Request) {
    if (req.actor.type !== "board") {
      throw forbidden("Board access required");
    }
  }

  function assertCompanyAccess(req: Express.Request, expectedCompanyId: string) {
    assertBoard(req);
    if (!req.actor.companyIds.includes(expectedCompanyId)) {
      throw forbidden("User does not have access to this company");
    }
  }

  async function getAccessibleResource<T extends { companyId: string }>(
    req: Express.Request,
    res: { status(code: number): { json(body: unknown): unknown } },
    resource: T | null | undefined | Promise<T | null | undefined>,
    notFoundMessage: string,
  ): Promise<T | null> {
    const resolved = await resource;
    if (
      !resolved
      || req.actor.type !== "board"
      || !(req.actor.companyIds ?? []).includes(resolved.companyId)
    ) {
      res.status(404).json({ error: notFoundMessage });
      return null;
    }
    assertCompanyAccess(req, resolved.companyId);
    return resolved;
  }

  function assertInstanceAdmin(req: Express.Request) {
    assertBoard(req);
    if (req.actor.isInstanceAdmin) return;
    throw forbidden("Instance admin access required");
  }

  return {
    assertAuthenticated,
    assertBoard,
    assertCompanyAccess,
    assertInstanceAdmin,
    getAccessibleResource,
  };
});

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  budgetService: () => mockBudgetService,
  createRuntimeAgentConfigurationService: () => ({}),
  taskApprovalService: () => mockTaskApprovalService,
  taskService: () => mockTaskService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

let routeModules:
  | Promise<[
    typeof import("../middleware/index.js"),
    typeof import("../routes/agents.js"),
  ]>
  | null = null;

async function loadRouteModules() {
  routeModules ??= Promise.all([
    import("../middleware/index.js"),
    import("../routes/agents.js"),
  ]);
  return routeModules;
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { agentRoutes }] = await loadRouteModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any, {
    ordinaryTasks: {} as never,
    taskExecutionCancellation: mockTaskExecutionCancellation as never,
  }));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

function resetMockDefaults() {
  vi.clearAllMocks();
  for (const mock of Object.values(mockAgentService)) mock.mockReset();
  for (const mock of Object.values(mockAccessService)) mock.mockReset();
  for (const mock of Object.values(mockApprovalService)) mock.mockReset();
  for (const mock of Object.values(mockBudgetService)) mock.mockReset();
  for (const mock of Object.values(mockTaskExecutionCancellation)) mock.mockReset();
  for (const mock of Object.values(mockTaskApprovalService)) mock.mockReset();
  for (const mock of Object.values(mockTaskService)) mock.mockReset();
  mockLogActivity.mockReset();
  mockGetTelemetryClient.mockReset();
  mockResolveInvokableTaskOwnerCatalogFromDb.mockReset();
  mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
  mockResolveInvokableTaskOwnerCatalogFromDb.mockResolvedValue(new Map());
  currentAccessCanUser = false;
  mockAgentService.getById.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.pause.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.resume.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.clearError.mockImplementation(async () => ({ ...baseAgent, status: "idle" }));
  mockAgentService.terminate.mockImplementation(async () => ({ ...baseAgent }));
  mockAccessService.canUser.mockImplementation(async () => currentAccessCanUser);
  mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
    const allowed = input.actor?.type === "board" && input.actor.source === "session"
      ? true
      : currentAccessCanUser;
    return {
      allowed,
      action: input.action,
      reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
      explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
    };
  });
  mockAccessService.hasPermission.mockImplementation(async () => false);
  mockAccessService.getMembership.mockImplementation(async () => null);
  mockAccessService.listPrincipalGrants.mockImplementation(async () => []);
  mockAccessService.ensureMembership.mockImplementation(async () => undefined);
  mockAccessService.setPrincipalPermission.mockImplementation(async () => undefined);
  mockTaskExecutionCancellation.requestAgentCancellationsInTransaction.mockImplementation(
    async (_transaction, input) => ({
      companyId: input.companyId,
      agentIds: input.agentIds,
      reason: input.reason,
      fence: { refIds: [], correlationIds: [] },
      requests: [],
    }),
  );
  mockTaskExecutionCancellation.reconcileRequestedCancellations.mockImplementation(async () => undefined);
  mockLogActivity.mockImplementation(async () => undefined);
}

describe.sequential("agent cross-tenant route authorization", () => {
  beforeEach(() => {
    resetMockDefaults();
  });

  it(
    "does not expose a second DELETE agent lifecycle command",
    async () => {
      const app = await createApp(testBoardSessionActor({
        userId: "board-user",
        companyIds: [companyId],
        isInstanceAdmin: true,
      }));

      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).delete(`/api/agents/${agentId}`),
      );

      expect(res.status).toBe(404);
      expect(mockAgentService.terminate).not.toHaveBeenCalled();
    },
    15_000,
  );

  it("returns only safe fields from the canonical invokable task-owner catalog", async () => {
    mockResolveInvokableTaskOwnerCatalogFromDb.mockResolvedValue(new Map([
      [agentId, {
        owner: {
          ...baseAgent,
          title: "Build lead",
          icon: "hammer",
          currentAdapterConfigRevisionId:
            "33333333-3333-4333-8333-333333333333",
        },
        revision: {
          id: "33333333-3333-4333-8333-333333333333",
          companyId,
          agentId,
        },
        revisionId: "33333333-3333-4333-8333-333333333333",
      }],
    ]));
    const app = await createApp(testBoardSessionActor({
      userId: "board-user",
      companyIds: [companyId],
      isInstanceAdmin: false,
    }));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/task-owner-catalog`),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{
      id: agentId,
      name: "Builder",
      title: "Build lead",
      icon: "hammer",
    }]);
    expect(mockResolveInvokableTaskOwnerCatalogFromDb).toHaveBeenCalledWith(
      expect.anything(),
      { companyId },
    );
  });

  it("does not resolve the task-owner catalog outside company authorization", async () => {
    const app = await createApp(testBoardSessionActor({
      userId: "outside-user",
      companyIds: [],
      isInstanceAdmin: false,
    }));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/task-owner-catalog`),
    );

    expect(res.status).toBe(403);
    expect(mockResolveInvokableTaskOwnerCatalogFromDb).not.toHaveBeenCalled();
  });

  it("enforces company boundaries before mutating agents", async () => {
    const crossTenantActor = testBoardSessionActor({
      userId: "mallory",
      companyIds: [],
      isInstanceAdmin: false,
    });
    const deniedCases = [
      {
        label: "pause",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).post(`/api/agents/${agentId}/pause`).send({})),
        untouched: [mockAgentService.pause],
      },
      {
        label: "clear error",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({})),
        untouched: [mockAgentService.clearError],
      },
    ];

    for (const deniedCase of deniedCases) {
      resetMockDefaults();
      const app = await createApp(crossTenantActor);
      const res = await deniedCase.request(app);

      expect(res.status, `${deniedCase.label}: ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body.error).toBe("Agent not found");
      expect(mockAgentService.getById).toHaveBeenCalledWith(agentId);
      for (const mock of deniedCase.untouched) {
        expect(mock).not.toHaveBeenCalled();
      }
    }

  }, 15_000);

  it("clears error agents and records a distinct audit action", async () => {
    const errorAgent = {
      ...baseAgent,
      status: "error",
      pauseReason: "system",
      pausedAt: new Date("2026-04-11T00:02:00.000Z"),
    };
    mockAgentService.getById.mockImplementation(async () => ({ ...errorAgent }));
    mockAgentService.clearError.mockImplementation(async () => ({
      ...errorAgent,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
      updatedAt: new Date("2026-04-11T00:03:00.000Z"),
    }));
    const app = await createApp(testBoardSessionActor({
      userId: "board-user",
      companyIds: [companyId],
      isInstanceAdmin: true,
    }));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: agentId,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
    });
    expect(mockAgentService.clearError).toHaveBeenCalledWith(agentId);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "agent.error_cleared",
      entityType: "agent",
      entityId: agentId,
    }));
  });

  it("returns 409 and does not mutate when the agent org chain is invalid", async () => {
    mockAgentService.getById.mockImplementation(async () => ({
      ...baseAgent,
      status: "error",
      orgChainHealth: {
        status: "invalid_org_chain",
        reason: "missing_manager",
        repairGuidance: "Repair the reporting chain first.",
      },
    }));
    const app = await createApp(testBoardSessionActor({
      userId: "board-user",
      companyIds: [companyId],
      isInstanceAdmin: true,
    }));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Repair the reporting chain first");
    expect(mockAgentService.clearError).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns a clear 409 for non-error agents", async () => {
    const { conflict } = await import("../errors.js");
    mockAgentService.getById.mockImplementation(async () => ({ ...baseAgent, status: "idle" }));
    mockAgentService.clearError.mockImplementation(async () => {
      throw conflict("Only agents in error status can have their error cleared");
    });
    const app = await createApp(testBoardSessionActor({
      userId: "board-user",
      companyIds: [companyId],
      isInstanceAdmin: true,
    }));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Only agents in error status can have their error cleared");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
