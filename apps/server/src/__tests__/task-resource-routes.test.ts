import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const routeMocks = vi.hoisted(() => ({
  tasks: {
    getById: vi.fn(),
    getByCompanyTaskNumber: vi.fn(),
    getActiveInboxArchiveFields: vi.fn(async () => ({})),
    getAncestors: vi.fn(async () => []),
    findMentionedProjectIds: vi.fn(async () => []),
    getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
    listBlockerAttention: vi.fn(async () => new Map()),
    list: vi.fn(async () => []),
    count: vi.fn(async () => 3),
    updateTitle: vi.fn(),
  },
  access: {
    decide: vi.fn(async () => ({
      allowed: true,
      reason: "test_allow",
      explanation: "Allowed by route test.",
    })),
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
    accessService: () => routeMocks.access,
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

describe("canonical task resource routes", () => {
  const companyId = randomUUID();
  const taskId = randomUUID();
  const task = {
    id: taskId,
    companyId,
    taskNumber: 7,
    identifier: "PC1A2-7",
    title: "UUID task route",
    projectId: null,
    goalId: null,
    boardPresentationStatus: "todo",
  };

  function createApp() {
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
      taskRoutes(harness.db, {} as never, { ordinaryTasks: {} as never }),
    );
    app.use(errorHandler);
    return { app, harness };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.tasks.getById.mockImplementation(async (id) =>
      id === task.id ? task : null,
    );
    routeMocks.tasks.getByCompanyTaskNumber.mockImplementation(
      async (requestedCompanyId, taskNumber) =>
        requestedCompanyId === companyId && taskNumber === task.taskNumber
          ? task
          : null,
    );
    routeMocks.tasks.updateTitle.mockImplementation(async (_id, title) => ({
      ...task,
      title,
    }));
    routeMocks.tasks.getActiveInboxArchiveFields.mockResolvedValue({});
    routeMocks.tasks.getAncestors.mockResolvedValue([]);
    routeMocks.tasks.findMentionedProjectIds.mockResolvedValue([]);
    routeMocks.tasks.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    routeMocks.tasks.listBlockerAttention.mockResolvedValue(new Map());
    routeMocks.tasks.list.mockResolvedValue([]);
    routeMocks.tasks.count.mockResolvedValue(3);
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

  it("does not accept task identifiers on UUID entity routes", async () => {
    const { app } = createApp();

    const read = await request(app).get(`/api/tasks/${task.identifier}`);
    const update = await request(app)
      .patch(`/api/tasks/${task.identifier}`)
      .send({ title: "Legacy alias" });

    expect(read.status).toBe(404);
    expect(update.status).toBe(404);
    expect(routeMocks.tasks.updateTitle).not.toHaveBeenCalled();
    expect(routeMocks.tasks.getById).toHaveBeenCalledWith(task.identifier);
  });

  it("loads task detail from the exact company-scoped task number route", async () => {
    const { app } = createApp();

    const response = await request(app).get(
      `/api/companies/${companyId}/tasks/${task.taskNumber}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: taskId,
      companyId,
      taskNumber: task.taskNumber,
    });
    expect(routeMocks.tasks.getByCompanyTaskNumber).toHaveBeenCalledWith(
      companyId,
      task.taskNumber,
    );
    expect(routeMocks.tasks.getById).not.toHaveBeenCalled();
  });

  it.each(["0", "01", "+1", " 1 ", "2147483648", task.identifier, task.id])(
    "rejects noncanonical task-number route token %s",
    async (taskNumber) => {
      const { app } = createApp();

      const response = await request(app).get(
        `/api/companies/${companyId}/tasks/${encodeURIComponent(taskNumber)}`,
      );

      expect(response.status).toBe(400);
      expect(routeMocks.tasks.getByCompanyTaskNumber).not.toHaveBeenCalled();
    },
  );

  it.each(["not-a-company-id", companyId.toUpperCase()])(
    "rejects noncanonical company route token %s",
    async (requestedCompanyId) => {
      const { app } = createApp();

      const response = await request(app).get(
        `/api/companies/${requestedCompanyId}/tasks/${task.taskNumber}`,
      );

      expect(response.status).toBe(400);
      expect(routeMocks.tasks.getByCompanyTaskNumber).not.toHaveBeenCalled();
    },
  );

  it("reads and updates through the UUID entity route", async () => {
    const { app, harness } = createApp();

    const read = await request(app).get(`/api/tasks/${taskId}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: taskId, identifier: task.identifier });

    const updated = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .send({ title: "Updated UUID task route" });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe("Updated UUID task route");
    expect(routeMocks.tasks.updateTitle).toHaveBeenCalledWith(
      taskId,
      "Updated UUID task route",
    );
    expect(routeMocks.logActivity).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({
        companyId,
        actorId: "cloud-user-1",
        action: "task.title_updated",
        entityId: taskId,
      }),
    );
  });
});
