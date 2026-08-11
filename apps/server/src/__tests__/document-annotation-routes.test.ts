import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";

const mockTaskService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockDocumentService = vi.hoisted(() => ({
  getTaskDocumentByKey: vi.fn(),
  upsertTaskDocument: vi.fn(),
}));
const mockAnnotationService = vi.hoisted(() => ({
  listThreadsForTaskDocument: vi.fn(),
  getThreadForTaskDocument: vi.fn(),
  createThread: vi.fn(),
  addComment: vi.fn(),
  updateThread: vi.fn(),
  remapOpenThreadsForDocument: vi.fn(),
}));
const mockTaskReferenceService = vi.hoisted(() => ({
  diffTaskReferenceSummary: vi.fn(() => ({
    addedReferencedTasks: [],
    removedReferencedTasks: [],
    currentReferencedTasks: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listTaskReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const documentPayload = {
  id: "document-1",
  companyId,
  taskId,
  key: "plan",
  title: "Plan",
  format: "markdown",
  body: "Alpha selected text omega",
  latestRevisionId: "44444444-4444-4444-8444-444444444444",
  latestRevisionNumber: 1,
  createdByAgentId: null,
  createdByUserId: "board-user",
  updatedByAgentId: null,
  updatedByUserId: "board-user",
  createdAt: new Date("2026-05-14T12:00:00.000Z"),
  updatedAt: new Date("2026-05-14T12:00:00.000Z"),
};

const annotationThread = {
  id: "55555555-5555-4555-8555-555555555555",
  companyId,
  taskId,
  documentId: "document-1",
  documentKey: "plan",
  status: "open",
  anchorState: "active",
  anchorConfidence: "exact",
  originalRevisionId: documentPayload.latestRevisionId,
  originalRevisionNumber: 1,
  currentRevisionId: documentPayload.latestRevisionId,
  currentRevisionNumber: 1,
  selectedText: "selected text",
  prefixText: "Alpha ",
  suffixText: " omega",
  normalizedStart: 6,
  normalizedEnd: 19,
  markdownStart: 6,
  markdownEnd: 19,
  anchorSelector: {
    quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
    position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
  },
  createdByAgentId: null,
  createdByUserId: "board-user",
  resolvedByAgentId: null,
  resolvedByUserId: null,
  resolvedAt: null,
  createdAt: new Date("2026-05-14T12:01:00.000Z"),
  updatedAt: new Date("2026-05-14T12:01:00.000Z"),
};

const annotationComment = {
  id: "66666666-6666-4666-8666-666666666666",
  companyId,
  threadId: annotationThread.id,
  taskId,
  documentId: "document-1",
  body: "Please review PAP-1",
  authorType: "user",
  authorAgentId: null,
  authorUserId: "board-user",
  createdByRunId: null,
  createdAt: new Date("2026-05-14T12:01:00.000Z"),
  updatedAt: new Date("2026-05-14T12:01:00.000Z"),
};

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      canUser: vi.fn(),
      decide: vi.fn(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_test",
        explanation: "Allowed by test mock.",
      })),
      hasPermission: vi.fn(async () => false),
    }),
    agentService: () => ({ getById: vi.fn(), list: vi.fn(async () => []) }),
    companySkillService: () => ({
      completeTestRunForTask: vi.fn(async () => null),
    }),
    companyService: () => ({ getById: vi.fn(async () => ({ id: companyId, attachmentMaxBytes: 10_000_000 })) }),
    createOrdinaryTaskRuntime: () => ({}),
    documentAnnotationService: () => mockAnnotationService,
    documentService: () => mockDocumentService,
    executionWorkspaceService: () => ({}),
    goalService: () => ({}),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({ id: "settings", general: {} })),
      getGeneral: vi.fn(async () => ({})),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    taskApprovalService: () => ({}),
    taskReferenceService: () => mockTaskReferenceService,
    taskService: () => mockTaskService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForTask: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

async function createApp(actor: "board" | "agent" = "board", actorCompanyId = companyId) {
  const [{ taskRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/tasks.js")>("../routes/tasks.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor === "agent"
      ? {
        type: "agent",
        agentId: "77777777-7777-4777-8777-777777777777",
        companyId: actorCompanyId,
        runId: "88888888-8888-4888-8888-888888888888",
      }
      : testBoardSessionActor({
        userId: "board-user",
        companyIds: [actorCompanyId],
        isInstanceAdmin: false,
      });
    next();
  });
  app.use("/api", denyGenericAgentRest("REST"));
  app.use(
    "/api",
    taskRoutes({} as any, {} as any, {
      ordinaryTasks: {} as never,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("document annotation routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/tasks.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockTaskService.getById.mockResolvedValue({
      id: taskId,
      companyId,
      title: "Annotation API",
      status: "in_progress",
      ownerAgentId: null,
    });
    mockDocumentService.getTaskDocumentByKey.mockResolvedValue(documentPayload);
    mockDocumentService.upsertTaskDocument.mockResolvedValue({
      created: false,
      document: {
        ...documentPayload,
        body: "Alpha updated selected text omega",
        latestRevisionId: "99999999-9999-4999-8999-999999999999",
        latestRevisionNumber: 2,
      },
    });
    mockAnnotationService.listThreadsForTaskDocument.mockImplementation(async (
      _taskId: string,
      _key: string,
      options?: { includeComments?: boolean },
    ) => (
      options?.includeComments
        ? [{ ...annotationThread, comments: [annotationComment] }]
        : [annotationThread]
    ));
    mockAnnotationService.getThreadForTaskDocument.mockResolvedValue({ ...annotationThread, comments: [annotationComment] });
    mockAnnotationService.createThread.mockResolvedValue({ ...annotationThread, comments: [annotationComment] });
    mockAnnotationService.addComment.mockResolvedValue(annotationComment);
    mockAnnotationService.updateThread.mockResolvedValue({ ...annotationThread, status: "resolved" });
    mockAnnotationService.remapOpenThreadsForDocument.mockResolvedValue([]);
  });

  it("includes compact open annotations without comment bodies when a board read explicitly requests them", async () => {
    const res = await request(await createApp())
      .get(`/api/tasks/${taskId}/documents/plan?includeAnnotations=true`)
      .expect(200);

    expect(res.body.annotations).toHaveLength(1);
    expect(res.body.annotations[0].comments).toBeUndefined();
    expect(mockAnnotationService.listThreadsForTaskDocument).toHaveBeenCalledWith(taskId, "plan", {
      status: "open",
      includeComments: false,
    });
  }, 15_000);

  it("includes annotation comment bodies on board document reads only when both expansions are requested", async () => {
    const res = await request(await createApp())
      .get(`/api/tasks/${taskId}/documents/plan?includeAnnotations=true&includeAnnotationComments=true`)
      .expect(200);

    expect(res.body.annotations[0].comments[0].body).toBe("Please review PAP-1");
    expect(mockAnnotationService.listThreadsForTaskDocument).toHaveBeenCalledWith(taskId, "plan", {
      status: "open",
      includeComments: true,
    });
  });

  it("updates task documents through the canonical document owner", async () => {
    mockTaskService.getById.mockResolvedValue({
      id: taskId,
      companyId,
      title: "Document API",
      status: "in_progress",
      ownerAgentId: "99999999-9999-4999-8999-999999999999",
    });

    const res = await request(await createApp())
      .put(`/api/tasks/${taskId}/documents/plan`)
      .send({
        title: "Plan",
        format: "markdown",
        body: "Alpha updated selected text omega",
        changeSummary: "Document feedback only",
        baseRevisionId: documentPayload.latestRevisionId,
      })
      .expect(200);

    expect(res.body.latestRevisionNumber).toBe(2);
    expect(mockDocumentService.upsertTaskDocument).toHaveBeenCalledWith({
      taskId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "Alpha updated selected text omega",
      changeSummary: "Document feedback only",
      baseRevisionId: documentPayload.latestRevisionId,
      createdByUserId: "board-user",
      lockedDocumentStrategy: "conflict",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "task.document_updated",
    }));
  });

  it("creates annotation threads through the canonical annotation owner and logs activity", async () => {
    mockTaskService.getById.mockResolvedValue({
      id: taskId,
      companyId,
      title: "Annotation API",
      status: "todo",
      ownerAgentId: "99999999-9999-4999-8999-999999999999",
    });

    const res = await request(await createApp())
      .post(`/api/tasks/${taskId}/documents/plan/annotations`)
      .send({
        baseRevisionId: documentPayload.latestRevisionId,
        baseRevisionNumber: 1,
        selector: annotationThread.anchorSelector,
        body: "Please review PAP-1",
      })
      .expect(201);

    expect(res.body.id).toBe(annotationThread.id);
    expect(mockAnnotationService.createThread).toHaveBeenCalledWith(
      taskId,
      "plan",
      expect.objectContaining({ body: "Please review PAP-1" }),
      expect.objectContaining({
        actorType: "user",
        actorId: "board-user",
        userId: "board-user",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "task.document_annotation_thread_created",
      details: expect.objectContaining({
        key: "plan",
        documentKey: "plan",
      }),
    }));
  });

  it("rejects agent annotation reads through the generic task API", async () => {
    const response = await request(await createApp("agent", otherCompanyId))
      .get(`/api/tasks/${taskId}/documents/plan/annotations`)
      .expect(403);
    expect(response.body).toEqual({
      error: "Agent credentials cannot access the generic REST API; use the run-scoped compiled interface",
      code: "compiled_run_interface_required",
    });
  });

  it("adds annotation comments through the canonical annotation owner and resolves threads", async () => {
    mockTaskService.getById.mockResolvedValue({
      id: taskId,
      companyId,
      title: "Annotation API",
      status: "todo",
      ownerAgentId: "99999999-9999-4999-8999-999999999999",
    });

    await request(await createApp())
      .post(`/api/tasks/${taskId}/documents/plan/annotations/${annotationThread.id}/comments`)
      .send({ body: "Reply with PAP-2" })
      .expect(201);
    expect(mockAnnotationService.addComment).toHaveBeenCalledWith(
      taskId,
      "plan",
      annotationThread.id,
      { body: "Reply with PAP-2" },
      expect.objectContaining({
        actorType: "user",
        actorId: "board-user",
        userId: "board-user",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "task.document_annotation_comment_added",
      details: expect.objectContaining({
        key: "plan",
        documentKey: "plan",
      }),
    }));

    const resolved = await request(await createApp())
      .patch(`/api/tasks/${taskId}/documents/plan/annotations/${annotationThread.id}`)
      .send({ status: "resolved" })
      .expect(200);
    expect(resolved.body.status).toBe("resolved");
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "task.document_annotation_thread_resolved",
      details: expect.objectContaining({
        key: "plan",
        documentKey: "plan",
      }),
    }));
  });
});
