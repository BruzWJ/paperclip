import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";
import { taskRoutes } from "../routes/tasks.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const taskMocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getBlockerDiagnostics: vi.fn(),
}));

vi.mock("../services/index.js", async () => ({
  ...await vi.importActual<typeof import("../services/index.js")>("../services/index.js"),
  taskService: () => taskMocks,
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const rootId = "00000000-0000-4000-8000-000000000010";
const blockerId = "00000000-0000-4000-8000-000000000011";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: rootId,
    companyId,
    projectId: "00000000-0000-4000-8000-000000000100",
    parentId: null,
    identifier: "PC-1",
    title: "Ship root",
    boardPresentationStatus: "blocked",
    priority: "medium",
    ownerAgentId: null,
    ownerUserId: "board-user",
    ...overrides,
  };
}

function boardActor(): Express.Request["actor"] {
  return testBoardSessionActor({
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
  });
}

function createApp(db: Db, actor: Express.Request["actor"] = boardActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", denyGenericAgentRest("REST"));
  app.use("/api", taskRoutes(db, {} as never, { ordinaryTasks: {} as never }));
  app.use(errorHandler);
  return app;
}

describe("task blocker diagnostics route", () => {
  beforeEach(() => {
    taskMocks.getById.mockReset();
    taskMocks.getBlockerDiagnostics.mockReset();
  });

  it("returns stale-blocker diagnosis and anomaly flags for a done blocker", async () => {
    const root = task();
    const blocker = task({
      id: blockerId,
      identifier: "PC-2",
      title: "Finished blocker",
      boardPresentationStatus: "done",
      ownerUserId: null,
    });
    taskMocks.getById.mockResolvedValue(root);
    taskMocks.getBlockerDiagnostics.mockResolvedValue({
      blockers: [blocker],
      readiness: {
        allBlockersDone: true,
        isDependencyReady: true,
        unresolvedBlockerTaskIds: [],
      },
      truncated: false,
    });
    const harness = createMockDb();

    const res = await request(createApp(harness.db))
      .get(`/api/tasks/${rootId}/diagnostics/blockers`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      diagnosis: expect.stringContaining("stale blocker hold"),
      readiness: {
        allBlockersDone: true,
        isDependencyReady: true,
        unresolvedBlockerCount: 0,
      },
      omittedUnauthorizedBlockerCount: 0,
      truncated: false,
    });
    expect(res.body.blockers).toEqual([
      expect.objectContaining({
        id: blockerId,
        boardPresentationStatus: "done",
        isDependencyReady: true,
        flags: ["done_but_blocking"],
      }),
    ]);
    expect(harness.calls).toEqual([]);
  });

  it("returns no diagnosis for an unblocked task with no blockers", async () => {
    const root = task({ boardPresentationStatus: "todo", title: "Ready work" });
    taskMocks.getById.mockResolvedValue(root);
    taskMocks.getBlockerDiagnostics.mockResolvedValue({
      blockers: [],
      readiness: {
        allBlockersDone: true,
        isDependencyReady: true,
        unresolvedBlockerTaskIds: [],
      },
      truncated: false,
    });

    const res = await request(createApp(createMockDb().db))
      .get(`/api/tasks/${rootId}/diagnostics/blockers`);

    expect(res.status).toBe(200);
    expect(res.body.diagnosis).toBeNull();
    expect(res.body.blockers).toEqual([]);
    expect(res.body.readiness).toMatchObject({
      allBlockersDone: true,
      isDependencyReady: true,
      unresolvedBlockerCount: 0,
    });
  });

  it("caps blocker output and withholds readiness when diagnostics are truncated", async () => {
    const root = task({ title: "Wide blocked task" });
    const blockers = Array.from({ length: 100 }, (_, index) => task({
      id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      identifier: `PC-${index + 2}`,
      title: `Blocker ${String(index).padStart(3, "0")}`,
      boardPresentationStatus: "done",
    }));
    taskMocks.getById.mockResolvedValue(root);
    taskMocks.getBlockerDiagnostics.mockResolvedValue({
      blockers,
      readiness: {
        allBlockersDone: true,
        isDependencyReady: true,
        unresolvedBlockerTaskIds: [],
      },
      truncated: true,
    });

    const res = await request(createApp(createMockDb().db))
      .get(`/api/tasks/${rootId}/diagnostics/blockers`);

    expect(res.status).toBe(200);
    expect(res.body.blockers).toHaveLength(100);
    expect(res.body.truncated).toBe(true);
    expect(res.body.readiness).toBeNull();
    expect(res.body.omittedUnauthorizedBlockerCount).toBeNull();
    expect(res.body.diagnosis).toContain("truncated at 100 blockers");
    expect(res.body.caps).toEqual({ maxBlockers: 100 });
  });

  it("denies generic agent credentials before reading task or blocker data", async () => {
    const harness = createMockDb();
    const actor = {
      type: "agent",
      agentId: "00000000-0000-4000-8000-000000000020",
      companyId,
      runId: "00000000-0000-4000-8000-000000000030",
      source: "internal",
    } as const;

    const res = await request(createApp(harness.db, actor))
      .get(`/api/tasks/${rootId}/diagnostics/blockers`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Agent credentials cannot access the generic REST API; use the run-scoped compiled interface",
      code: "compiled_run_interface_required",
    });
    expect(taskMocks.getById).not.toHaveBeenCalled();
    expect(taskMocks.getBlockerDiagnostics).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });
});
