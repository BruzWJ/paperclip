import { Readable as ReadableImport } from "node:stream";
import type { IncomingMessage } from "node:http";
import expressModule from "express";
import requestModule from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageService } from "../storage/types.js";
import { testBoardSessionActor as testBoardSessionActorImport } from "./helpers/request-actor.js";

const Readable = ReadableImport;
const express = expressModule;
export const request = requestModule;
const testBoardSessionActor = testBoardSessionActorImport;
export const mockTaskService = {
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  createAttachment: vi.fn(),
  getAttachmentById: vi.fn(),
};
export const mockCompanyService = {
  getById: vi.fn(),
};
export const mockWorkProductService = {
  createForTask: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
};
export const mockAccessService = {
  decide: vi.fn(async () => ({
    allowed: true,
    explanation: "Allowed by test mock",
  })),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
};

const mockLogActivity = vi.fn(async () => undefined);

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/tasks.js", () => ({
    taskService: () => mockTaskService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(),
    }),
    companyService: () => mockCompanyService,
    documentAnnotationService: () => ({
      remapOpenThreadsForDocument: async () => [],
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    goalService: () => ({}),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
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
    routineService: () => ({
      syncRunStatusForTask: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

type TestStorageService = StorageService & {
  __calls: {
    putFile?: {
      companyId: string;
      namespace: string;
      originalFilename?: string;
      contentType: string;
      body: Buffer;
    };
  };
};

export function taskFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    identifier: "PAP-1",
    ...overrides,
  };
}

export function createStorageService(body = Buffer.from("test")): TestStorageService {
  const calls: TestStorageService["__calls"] = {};
  return {
    provider: "local_disk",
    __calls: calls,
    putFile: async (input) => {
      calls.putFile = input;
      return {
        provider: "local_disk",
        objectKey: `${input.namespace}/${input.originalFilename ?? "upload"}`,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: "sha256-sample",
        originalFilename: input.originalFilename,
      };
    },
    getObject: vi.fn(async (_companyId, _objectKey, options) => {
      const range = options?.range;
      const streamBody = range ? body.subarray(range.start, range.end + 1) : body;
      return {
        stream: Readable.from(streamBody),
        contentLength: streamBody.length,
      };
    }),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

export async function createApp(
  storage: StorageService,
  options?: { companyIds?: string[]; source?: string },
) {
  const [{ errorHandler }, { taskRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/tasks.js")>("../routes/tasks.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = testBoardSessionActor({
      userId: "board-user",
      companyIds: options?.companyIds ?? ["company-1"],
      isInstanceAdmin: false,
    });
    next();
  });
  app.use("/api", taskRoutes({} as any, storage, { ordinaryTasks: {} as any }));
  app.use(errorHandler);
  return app;
}

export function makeAttachment(contentType: string, originalFilename: string) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "attachment-1",
    companyId: "company-1",
    taskId: "11111111-1111-4111-8111-111111111111",
    taskCommentId: null,
    assetId: "asset-1",
    provider: "local_disk",
    objectKey: `tasks/task-1/${originalFilename}`,
    contentType,
    byteSize: 4,
    sha256: "sha256-sample",
    originalFilename,
    createdByAgentId: null,
    createdByUserId: "board-user",
    createdAt: now,
    updatedAt: now,
  };
}

export function parseBinaryResponse(
  res: IncomingMessage,
  callback: (error: Error | null, body?: Buffer) => void,
) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
  res.on("error", callback);
}

export function registerSuiteSetup() {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/tasks.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../routes/tasks.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      explanation: "Allowed by test mock",
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockTaskService.getById.mockResolvedValue(
      taskFixture({
        projectId: null,
        parentId: null,
        status: "todo",
        ownerAgentId: null,
        ownerUserId: null,
      }),
    );
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      attachmentMaxBytes: 1024 * 1024 * 1024,
    });
    mockWorkProductService.createForTask.mockReset();
    mockWorkProductService.getById.mockReset();
    mockWorkProductService.update.mockReset();
  });
}

export { describe, expect, it, vi };
