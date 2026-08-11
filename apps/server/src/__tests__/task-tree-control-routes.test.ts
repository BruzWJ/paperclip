import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mockTaskService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockTreeControlService = vi.hoisted(() => ({
  preview: vi.fn(),
  createHold: vi.fn(),
  restoreTaskStatusesForHold: vi.fn(),
  getHold: vi.fn(),
  releaseHold: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTaskExecutionCancellation = vi.hoisted(() => ({}));

vi.mock("../services/index.js", () => ({
  taskService: () => mockTaskService,
  taskTreeControlService: () => mockTreeControlService,
  logActivity: mockLogActivity,
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { taskTreeControlRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/task-tree-control.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", taskTreeControlRoutes(
    {} as any,
    mockTaskExecutionCancellation as never,
  ));
  app.use(errorHandler);
  return app;
}

function boardActor(companyIds: string[]) {
  return testBoardSessionActor({
    sessionId: "session-1",
    userId: "user-1",
    userName: "Board User",
    userEmail: "board@example.com",
    companyIds,
    memberships: companyIds.map((companyId) => ({
      companyId,
      membershipRole: "owner",
      status: "active",
    })),
    isInstanceAdmin: false,
  });
}

describe("task tree control routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-2",
    });
    mockTreeControlService.restoreTaskStatusesForHold.mockResolvedValue({
      updatedTaskIds: [],
      updatedTasks: [],
      releasedCancelHoldIds: [],
      restoreHold: null,
    });
  });

  it("rejects cross-company preview requests with a uniform 404 before calling the preview service", async () => {
    const app = await createApp(boardActor(["company-1"]));

    const res = await request(app)
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/tree-control/preview")
      .send({ mode: "pause" });

    expect(res.status).toBe(404);
    expect(mockTreeControlService.preview).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("requires board access for hold creation", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-2",
      runId: null,
      source: "internal",
    });

    const res = await request(app)
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "pause" });

    expect(res.status).toBe(403);
    expect(mockTaskService.getById).not.toHaveBeenCalled();
    expect(mockTreeControlService.createHold).not.toHaveBeenCalled();
  });

  it("rejects malformed tree hold IDs before querying the hold service", async () => {
    const app = await createApp(boardActor(["company-2"]));

    const getRes = await request(app)
      .get("/api/tasks/11111111-1111-4111-8111-111111111111/tree-holds/null");
    const releaseRes = await request(app)
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/tree-holds/null/release")
      .send({ reason: "bad hold id" });

    expect(getRes.status).toBe(400);
    expect(releaseRes.status).toBe(400);
    expect(mockTreeControlService.getHold).not.toHaveBeenCalled();
    expect(mockTreeControlService.releaseHold).not.toHaveBeenCalled();
  });

  it("reports task cancellation committed with the cancel hold", async () => {
    const app = await createApp(boardActor(["company-2"]));
    mockTreeControlService.createHold.mockResolvedValue({
      hold: {
        id: "33333333-3333-4333-8333-333333333333",
        mode: "cancel",
        reason: "cancel subtree",
      },
      preview: {
        mode: "cancel",
        totals: { affectedTasks: 2 },
        warnings: [],
        activeRuns: [],
      },
      cancelledTaskIds: [
        "11111111-1111-4111-8111-111111111111",
        "55555555-5555-4555-8555-555555555555",
      ],
    });

    const res = await request(app)
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "cancel", reason: "cancel subtree" });

    expect(res.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "task.tree_cancel_status_updated",
        details: expect.objectContaining({ cancelledTaskCount: 2 }),
      }),
    );
  });

  it("restores affected tasks without a direct dispatch path", async () => {
    const app = await createApp(boardActor(["company-2"]));
    mockTreeControlService.createHold.mockResolvedValue({
      hold: {
        id: "66666666-6666-4666-8666-666666666666",
        mode: "restore",
        reason: "restore subtree",
      },
      preview: {
        mode: "restore",
        totals: { affectedTasks: 1 },
        warnings: [],
        activeRuns: [],
      },
    });
    mockTreeControlService.restoreTaskStatusesForHold.mockResolvedValue({
      updatedTaskIds: ["55555555-5555-4555-8555-555555555555"],
      updatedTasks: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          status: "todo",
          ownerAgentId: "22222222-2222-4222-8222-222222222222",
        },
      ],
      releasedCancelHoldIds: ["33333333-3333-4333-8333-333333333333"],
      restoreHold: {
        id: "66666666-6666-4666-8666-666666666666",
        mode: "restore",
        status: "released",
      },
    });
    const res = await request(app)
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "restore", reason: "restore subtree" });

    expect(res.status).toBe(200);
    expect(mockTreeControlService.restoreTaskStatusesForHold).toHaveBeenCalledWith(
      "company-2",
      "11111111-1111-4111-8111-111111111111",
      "66666666-6666-4666-8666-666666666666",
      expect.objectContaining({ reason: "restore subtree" }),
    );
    expect(res.body.hold.status).toBe("released");
  });

  it("releases a restore hold if the restore application fails", async () => {
    const app = await createApp(boardActor(["company-2"]));
    mockTreeControlService.createHold.mockResolvedValue({
      hold: {
        id: "66666666-6666-4666-8666-666666666666",
        mode: "restore",
        reason: "restore subtree",
      },
      preview: {
        mode: "restore",
        totals: { affectedTasks: 1 },
        warnings: [],
        activeRuns: [],
      },
    });
    mockTreeControlService.restoreTaskStatusesForHold.mockRejectedValue(new Error("restore failed"));
    mockTreeControlService.releaseHold.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      mode: "restore",
      status: "released",
    });

    const res = await request(app)
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "restore", reason: "restore subtree" });

    expect(res.status).toBe(500);
    expect(mockTreeControlService.releaseHold).toHaveBeenCalledWith(
      "company-2",
      "11111111-1111-4111-8111-111111111111",
      "66666666-6666-4666-8666-666666666666",
      expect.objectContaining({
        reason: "Restore operation failed before subtree status updates completed",
        metadata: { cleanup: "restore_failed_before_apply" },
      }),
    );
  });

  it("returns resume operations as released holds and avoids cancellation side effects", async () => {
    const app = await createApp(boardActor(["company-2"]));
    mockTreeControlService.createHold.mockResolvedValue({
      hold: {
        id: "77777777-7777-4777-8777-777777777777",
        mode: "resume",
        status: "released",
        reason: "resume subtree",
      },
      preview: {
        mode: "resume",
        totals: {
          affectedTasks: 1,
        },
        warnings: [],
        activeRuns: [],
      },
      resumedPauseHoldIds: ["33333333-3333-4333-8333-333333333333"],
    });
    const res = await request(app)
      .post("/api/tasks/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "resume", reason: "resume subtree" });

    expect(res.status).toBe(200);
    expect(res.body.hold.mode).toBe("resume");
    expect(res.body.hold.status).toBe("released");
    expect(res.body.resumedPauseHoldIds).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(mockTreeControlService.restoreTaskStatusesForHold).not.toHaveBeenCalled();
  });
});
