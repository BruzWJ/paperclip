import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mockTaskService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockTrackAgentTaskCompleted = vi.hoisted(() => vi.fn());
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{ companyId: "company-1" }]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
}));

function registerModuleMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: mockTrackAgentTaskCompleted,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(),
      decide: vi.fn(async () => ({
        allowed: true,
        action: "task:mutate",
        reason: "allow_test",
        explanation: "Allowed by test mock.",
      })),
      hasPermission: vi.fn(),
    }),
    agentService: () => mockAgentService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    goalService: () => ({}),
    instanceSettingsService: () => ({}),
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
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForTask: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

function makeTask(status: "todo" | "done") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    ownerKind: "agent",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    ownershipEpoch: 1,
    creatorKind: "user/board",
    creatorUserId: "board-user",
    identifier: "PAP-1018",
    title: "Telemetry test",
  };
}

let taskRoutes: typeof import("../routes/tasks.js").taskRoutes;
let errorHandler: typeof import("../middleware/index.js").errorHandler;

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", taskRoutes(mockDb as any, {} as any, { ordinaryTasks: {} as never }));
  app.use(errorHandler);
  return app;
}

describe("task telemetry routes", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/tasks.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    [taskRoutes, errorHandler] = await Promise.all([
      vi.importActual<typeof import("../routes/tasks.js")>("../routes/tasks.js")
        .then((module) => module.taskRoutes),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js")
        .then((module) => module.errorHandler),
    ]);
  }, 15_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskService.getById.mockResolvedValue(makeTask("todo"));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{ companyId: "company-1" }]).then(onFulfilled, onRejected),
    }));
  });

  it("rejects the retired board status patch without emitting agent completion telemetry", async () => {
    const app = createApp(testBoardSessionActor({
      userId: "board-user",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    }));
    const res = await request(app)
      .patch("/api/tasks/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(400);
    expect(mockTrackAgentTaskCompleted).not.toHaveBeenCalled();
    expect(mockAgentService.getById).not.toHaveBeenCalled();
  });
});
