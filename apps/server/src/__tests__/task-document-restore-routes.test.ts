import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const mockTaskService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  listTaskDocuments: vi.fn(),
  listTaskDocumentRevisions: vi.fn(),
  restoreTaskDocumentRevision: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  listCompanyIds: vi.fn(async () => [companyId]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForTask: vi.fn(async () => undefined),
}));

const planDocument = {
  id: "document-1",
  companyId,
  taskId,
  key: "plan",
  title: "Plan",
  format: "markdown",
  body: "# Plan",
  latestRevisionId: "revision-2",
  latestRevisionNumber: 2,
  createdByAgentId: null,
  createdByUserId: "board-user",
  updatedByAgentId: null,
  updatedByUserId: "board-user",
  createdAt: new Date("2026-03-26T12:00:00.000Z"),
  updatedAt: new Date("2026-03-26T12:10:00.000Z"),
};

const systemDocument = {
  ...planDocument,
  id: "document-2",
  key: "system-plan",
  title: "System plan",
};

function registerModuleMocks() {
  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/documents.js", () => ({
    documentAnnotationService: () => ({
      remapOpenThreadsForDocument: async () => [],
    }),
    documentService: () => mockDocumentsService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/tasks.js", () => ({
    taskService: () => mockTaskService,
  }));

  vi.doMock("../services/routines.js", () => ({
    routineService: () => mockRoutineService,
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({
        id: "company-1",
        attachmentMaxBytes: 10 * 1024 * 1024,
      })),
    }),
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    documentAnnotationService: () => ({
      remapOpenThreadsForDocument: async () => [],
    }),
    documentService: () => mockDocumentsService,
    executionWorkspaceService: () => ({}),
    goalService: () => ({}),
    instanceSettingsService: () => mockInstanceSettingsService,
    taskApprovalService: () => ({}),
    taskReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffTaskReferenceSummary: () => ({
        addedReferencedTasks: [],
        removedReferencedTasks: [],
        currentReferencedTasks: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listTaskReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncTask: async () => undefined,
    }),
    taskService: () => mockTaskService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => mockRoutineService,
    workProductService: () => ({}),
  }));
}

let taskRoutes: typeof import("../routes/tasks.js").taskRoutes;
let errorHandler: typeof import("../middleware/index.js").errorHandler;

function createApp(
  actor: Express.Request["actor"] = testBoardSessionActor({
    userId: "board-user",
    companyIds: [companyId],
    isInstanceAdmin: false,
  }),
  db: unknown = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    taskRoutes(db as any, {} as any, { ordinaryTasks: {} as never }),
  );
  app.use(errorHandler);
  return app;
}

describe("task document revision routes", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/tasks.js");
    vi.doUnmock("../routes/tasks.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    [taskRoutes, errorHandler] = await Promise.all([
      vi
        .importActual<typeof import("../routes/tasks.js")>("../routes/tasks.js")
        .then((module) => module.taskRoutes),
      vi
        .importActual<typeof import("../middleware/index.js")>(
          "../middleware/index.js",
        )
        .then((module) => module.errorHandler),
    ]);
  }, 15_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "task:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockTaskService.getById.mockResolvedValue({
      id: taskId,
      companyId,
      identifier: "PAP-881",
      title: "Document revisions",
      status: "in_progress",
    });
    mockDocumentsService.listTaskDocuments.mockImplementation(
      async (_taskId, options: { includeSystem?: boolean } | undefined) =>
        options?.includeSystem
          ? [planDocument, systemDocument]
          : [planDocument],
    );
    mockDocumentsService.listTaskDocumentRevisions.mockResolvedValue([
      {
        id: "revision-2",
        companyId,
        documentId: "document-1",
        taskId,
        key: "plan",
        revisionNumber: 2,
        title: "Plan v2",
        format: "markdown",
        body: "# Two",
        changeSummary: null,
        createdByAgentId: null,
        createdByUserId: "board-user",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);
    mockDocumentsService.restoreTaskDocumentRevision.mockResolvedValue({
      restoredFromRevisionId: "revision-1",
      restoredFromRevisionNumber: 1,
      document: {
        id: "document-1",
        companyId,
        taskId,
        key: "plan",
        title: "Plan v1",
        format: "markdown",
        body: "# One",
        latestRevisionId: "revision-3",
        latestRevisionNumber: 3,
        createdByAgentId: null,
        createdByUserId: "board-user",
        updatedByAgentId: null,
        updatedByUserId: "board-user",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:10:00.000Z"),
      },
    });
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue([companyId]);
    mockRoutineService.syncRunStatusForTask.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns revision snapshots including title and format", async () => {
    const res = await request(createApp()).get(
      `/api/tasks/${taskId}/documents/plan/revisions`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        revisionNumber: 2,
        title: "Plan v2",
        format: "markdown",
        body: "# Two",
      }),
    ]);
  });

  it("filters system documents by default on the document list route", async () => {
    const res = await request(createApp()).get(
      `/api/tasks/${taskId}/documents`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ key: "plan" })]);
  });

  it("passes includeSystem=true through for debug document listing", async () => {
    const res = await request(createApp()).get(
      `/api/tasks/${taskId}/documents?includeSystem=true`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ key: "plan" }),
      expect.objectContaining({ key: "system-plan" }),
    ]);
  });

  it("rejects noncanonical document-list query values", async () => {
    await request(createApp())
      .get(`/api/tasks/${taskId}/documents?includeSystem=TRUE`)
      .expect(422);
  });

  it("restores a revision through the append-only route and logs the action", async () => {
    const res = await request(createApp())
      .post(`/api/tasks/${taskId}/documents/plan/revisions/revision-1/restore`)
      .send({});

    expect(res.status).toBe(200);
    expect(
      mockDocumentsService.restoreTaskDocumentRevision,
    ).toHaveBeenCalledWith({
      taskId,
      key: "plan",
      revisionId: "revision-1",
      createdByUserId: "board-user",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "task.document_restored",
        details: expect.objectContaining({
          key: "plan",
          restoredFromRevisionId: "revision-1",
          restoredFromRevisionNumber: 1,
          revisionNumber: 3,
        }),
      }),
    );
    expect(res.body).toEqual(
      expect.objectContaining({
        key: "plan",
        title: "Plan v1",
        latestRevisionNumber: 3,
      }),
    );
  });

  it.each(["PLAN", "%20plan", "INVALID%20KEY"])(
    "rejects noncanonical document key %s before attempting restore",
    async (documentKey) => {
      const res = await request(createApp())
        .post(
          `/api/tasks/${taskId}/documents/${documentKey}/revisions/revision-1/restore`,
        )
        .send({});

      expect(res.status).toBe(400);
      expect(
        mockDocumentsService.restoreTaskDocumentRevision,
      ).not.toHaveBeenCalled();
    },
  );
});
