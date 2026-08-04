import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { activityRoutes } from "../routes/activity.js";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  forIssue: vi.fn(),
  create: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
  normalizeActivityLimit: (limit: number | undefined) => {
    if (!Number.isFinite(limit)) return 100;
    return Math.max(1, Math.min(500, Math.floor(limit ?? 100)));
  },
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  issueService: () => mockIssueService,
}));

function createApp(
  actor: Record<string, unknown> = testBoardSessionActor({
    userId: "user-1",
    companyIds: ["company-1"],
    isInstanceAdmin: false,
  }),
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds)
        ? [...actor.companyIds]
        : actor.companyIds,
    };
    next();
  });
  app.use("/api", denyGenericAgentRest("REST"));
  app.use("/api", activityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
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
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

describe.sequential("activity routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockActivityService)) mock.mockReset();
    for (const mock of Object.values(mockIssueService)) mock.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
  });

  it("limits company activity lists by default", async () => {
    mockActivityService.list.mockResolvedValue([]);
    const app = createApp();
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/activity"),
    );

    expect(response.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      entityType: undefined,
      entityId: undefined,
      limit: 100,
    });
  });

  it("caps requested company activity list limits", async () => {
    mockActivityService.list.mockResolvedValue([]);
    const app = createApp();
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(
        "/api/companies/company-1/activity?limit=5000&entityType=issue",
      ),
    );

    expect(response.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      entityType: "issue",
      entityId: undefined,
      limit: 500,
    });
  });

  it("denies generic agent REST access before activity lookup", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "internal",
      runId: "run-1",
    });
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/activity"),
    );

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("compiled_run_interface_required");
    expect(mockActivityService.list).not.toHaveBeenCalled();
  });

  it("requires company access before creating activity events", async () => {
    const app = createApp();
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-2/activity")
        .send({
          actorId: "user-1",
          action: "test.event",
          entityType: "issue",
          entityId: "issue-1",
        }),
    );

    expect(response.status).toBe(403);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });
});
