import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginRoutes } from "../routes/plugins.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const pluginId = "11111111-1111-4111-8111-111111111111";

const registry = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

function emptyDeliveriesDb() {
  const query = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue([]),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  return { select: vi.fn(() => query) };
}

describe("plugin dashboard health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.health-test",
      status: "ready",
      lastError: null,
      manifestJson: {
        id: "paperclip.health-test",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Health test",
        description: "Health test",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "dist/worker.js" },
      },
    });
  });

  it("calls worker health exactly once through the sole dashboard surface", async () => {
    const call = vi.fn().mockResolvedValue({
      status: "degraded",
      message: "Upstream is slow",
    });
    const workerManager = {
      getWorker: vi.fn(() => ({
        diagnostics: () => ({
          status: "running",
          pid: 123,
          uptime: 5_000,
          consecutiveCrashes: 0,
          totalCrashes: 0,
          pendingRequests: 0,
          lastCrashAt: null,
          nextRestartAt: null,
        }),
      })),
      call,
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = testBoardSessionActor({
        userId: "admin-1",
        userName: "Admin",
        userEmail: "admin@paperclip.test",
        sessionId: "session-admin-1",
        isInstanceAdmin: true,
        companyIds: [],
      });
      next();
    });
    app.use("/api", pluginRoutes(
      emptyDeliveriesDb() as never,
      {} as never,
      {
        workerManager,
        jobStore: {
          listRunsByPlugin: vi.fn().mockResolvedValue([]),
          listJobs: vi.fn().mockResolvedValue([]),
        },
      } as never,
    ));

    const dashboard = await request(app).get(`/api/plugins/${pluginId}/dashboard`);

    expect(dashboard.status).toBe(200);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(pluginId, "health", {});
    expect(dashboard.body.health.healthy).toBe(false);
    expect(dashboard.body.health.checks).toContainEqual({
      name: "plugin",
      passed: false,
      message: "Upstream is slow",
    });

    const removedHealthRoute = await request(app).get(`/api/plugins/${pluginId}/health`);
    expect(removedHealthRoute.status).toBe(404);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
