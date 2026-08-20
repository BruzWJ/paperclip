import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testBoardSessionActor } from "./helpers/request-actor.js";

vi.unmock("http");
vi.unmock("node:http");

// Active company membership grants Board control. Inactive members remain
// denied on writes after the company boundary has been checked.

const companyId = "11111111-1111-4111-8111-111111111111";
const goalId = "22222222-2222-4222-8222-222222222222";

const baseGoal = {
  id: goalId,
  companyId,
  level: "company" as const,
  title: "Q3 goal",
  description: null,
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  updatedAt: new Date("2026-04-11T00:00:00.000Z"),
};

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackGoalCreated: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  goalService: () => mockGoalService,
  logActivity: mockLogActivity,
}));

let routeModules:
  | Promise<[
    typeof import("../middleware/index.js"),
    typeof import("../routes/goals.js"),
  ]>
  | null = null;

async function loadRouteModules() {
  routeModules ??= Promise.all([
    import("../middleware/index.js"),
    import("../routes/goals.js"),
  ]);
  return routeModules;
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { goalRoutes }] = await loadRouteModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", goalRoutes({} as any));
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

function resetMocks() {
  vi.clearAllMocks();
  for (const mock of Object.values(mockGoalService)) mock.mockReset();
  mockGoalService.list.mockImplementation(async () => []);
  mockGoalService.getById.mockImplementation(async () => ({ ...baseGoal }));
  mockGoalService.create.mockImplementation(async () => ({ ...baseGoal }));
  mockGoalService.update.mockImplementation(async () => ({ ...baseGoal }));
  mockGoalService.remove.mockImplementation(async () => ({ ...baseGoal }));
  mockLogActivity.mockImplementation(async () => undefined);
  mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
}

describe.sequential("write-path membership checks", () => {
  beforeAll(async () => {
    await loadRouteModules();
  });

  beforeEach(() => {
    resetMocks();
  });

  describe("active membership", () => {
    const viewerActor = testBoardSessionActor({
      userId: "viewer-user",
      companyIds: [companyId],
      isInstanceAdmin: false,
      memberships: [
        { companyId, status: "active", membershipRole: "viewer" },
      ],
    });

    it("allows every goal write method for an active viewer membership", async () => {
      const app = await createApp(viewerActor);
      const patch = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/goals/${goalId}`).send({ title: "New title" }),
      );
      const remove = await requestApp(app, (baseUrl) =>
        request(baseUrl).delete(`/api/goals/${goalId}`),
      );
      const create = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${companyId}/goals`)
          .send({ level: "company", title: "New goal" }),
      );

      expect([patch.status, remove.status, create.status]).toEqual([200, 200, 201]);
      expect(mockGoalService.update).toHaveBeenCalledOnce();
      expect(mockGoalService.remove).toHaveBeenCalledOnce();
      expect(mockGoalService.create).toHaveBeenCalledOnce();
    });
  });

  describe("inactive membership", () => {
    const inactiveActor = testBoardSessionActor({
      userId: "ex-employee",
      companyIds: [companyId],
      isInstanceAdmin: false,
      memberships: [
        { companyId, status: "removed", membershipRole: "editor" },
      ],
    });

    it("rejects PATCH on a goal with 403 'User does not have active company access'", async () => {
      const app = await createApp(inactiveActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/goals/${goalId}`).send({ title: "New title" }),
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("User does not have active company access");
      expect(mockGoalService.update).not.toHaveBeenCalled();
    });

    it("rejects DELETE on a goal with 403 'User does not have active company access'", async () => {
      const app = await createApp(inactiveActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).delete(`/api/goals/${goalId}`),
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("User does not have active company access");
      expect(mockGoalService.remove).not.toHaveBeenCalled();
    });

    it("rejects POST on a company's goals with 403 'User does not have active company access'", async () => {
      const app = await createApp(inactiveActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${companyId}/goals`)
          .send({ level: "company", title: "New goal" }),
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("User does not have active company access");
      expect(mockGoalService.create).not.toHaveBeenCalled();
    });
  });

});
