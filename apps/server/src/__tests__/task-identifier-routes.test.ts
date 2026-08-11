import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const routeMocks = vi.hoisted(() => ({
  tasks: {
    getByIdentifier: vi.fn(),
    getById: vi.fn(),
    getActiveInboxArchiveFields: vi.fn(async () => ({})),
    getAncestors: vi.fn(async () => []),
    findMentionedProjectIds: vi.fn(async () => []),
    getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
    listBlockerAttention: vi.fn(async () => new Map()),
    updateTitle: vi.fn(),
  },
  documents: {
    getTaskDocumentPayload: vi.fn(async () => ({
      planDocument: null,
      documentSummaries: [],
    })),
  },
  taskReferences: {
    listTaskReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  },
  workProducts: {
    listForTask: vi.fn(async () => []),
  },
  goals: {
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  },
  executionWorkspaces: {
    getCurrentForTask: vi.fn(async () => null),
  },
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>(
    "../services/index.js",
  );
  return {
    ...actual,
    taskService: () => routeMocks.tasks,
    documentService: () => routeMocks.documents,
    taskReferenceService: () => routeMocks.taskReferences,
    workProductService: () => routeMocks.workProducts,
    goalService: () => routeMocks.goals,
    logActivity: routeMocks.logActivity,
  };
});

vi.mock("../services/execution-workspaces.js", async () => {
  const actual = await vi.importActual<typeof import("../services/execution-workspaces.js")>(
    "../services/execution-workspaces.js",
  );
  return {
    ...actual,
    executionWorkspaceService: () => routeMocks.executionWorkspaces,
  };
});

import { errorHandler } from "../middleware/index.js";
import { taskRoutes } from "../routes/tasks.js";

describe("task identifier routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.tasks.getActiveInboxArchiveFields.mockResolvedValue({});
    routeMocks.tasks.getAncestors.mockResolvedValue([]);
    routeMocks.tasks.findMentionedProjectIds.mockResolvedValue([]);
    routeMocks.tasks.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    routeMocks.tasks.listBlockerAttention.mockResolvedValue(new Map());
    routeMocks.documents.getTaskDocumentPayload.mockResolvedValue({
      planDocument: null,
      documentSummaries: [],
    });
    routeMocks.taskReferences.listTaskReferenceSummary.mockResolvedValue({
      outbound: [],
      inbound: [],
    });
    routeMocks.workProducts.listForTask.mockResolvedValue([]);
    routeMocks.executionWorkspaces.getCurrentForTask.mockResolvedValue(null);
  });

  it("resolves alphanumeric session task identifiers for detail reads and title updates", async () => {
    const companyId = randomUUID();
    const taskId = randomUUID();
    const task = {
      id: taskId,
      companyId,
      identifier: "PC1A2-7",
      title: "Tenant identifier route",
      projectId: null,
      goalId: null,
      boardPresentationStatus: "todo",
    };
    const updatedTask = {
      ...task,
      title: "Updated tenant identifier route",
    };
    routeMocks.tasks.getByIdentifier.mockResolvedValue(task);
    routeMocks.tasks.getById.mockResolvedValue(task);
    routeMocks.tasks.updateTitle.mockResolvedValue(updatedTask);

    const harness = createMockDb();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = testBoardSessionActor({
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: false,
      });
      next();
    });
    app.use(
      "/api",
      taskRoutes(harness.db, {} as never, {
        ordinaryTasks: {} as never,
      }),
    );
    let routeError: unknown = null;
    app.use((error: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => {
      routeError = error;
      next(error);
    });
    app.use(errorHandler);

    const read = await request(app).get("/api/tasks/pc1a2-7");
    expect(read.status, routeError instanceof Error ? routeError.stack : JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({
      id: taskId,
      companyId,
      identifier: "PC1A2-7",
    });

    const updated = await request(app)
      .patch("/api/tasks/PC1A2-7")
      .send({ title: "Updated tenant identifier route" });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject(updatedTask);

    expect(routeMocks.tasks.getByIdentifier).toHaveBeenNthCalledWith(1, "PC1A2-7");
    expect(routeMocks.tasks.getByIdentifier).toHaveBeenNthCalledWith(2, "PC1A2-7");
    expect(routeMocks.tasks.getById).toHaveBeenNthCalledWith(1, taskId);
    expect(routeMocks.tasks.getById).toHaveBeenNthCalledWith(2, taskId);
    expect(routeMocks.tasks.updateTitle).toHaveBeenCalledWith(
      taskId,
      "Updated tenant identifier route",
    );
    expect(routeMocks.logActivity).toHaveBeenCalledWith(harness.db, expect.objectContaining({
      companyId,
      actorId: "cloud-user-1",
      action: "task.title_updated",
      entityId: taskId,
    }));
    expect(harness.remaining("select")).toBe(0);
  });
});
