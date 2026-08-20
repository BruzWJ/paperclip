import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_LIST_SERVER_CACHE_MAX_ENTRIES, taskRoutes } from "../routes/tasks.js";
import { taskListResponseCache } from "../routes/task-route-list-cache.js";
import { errorHandler } from "../middleware/index.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";
import type { StorageService } from "../storage/types.js";

const services = vi.hoisted(() => ({
  tasks: { list: vi.fn() },
  access: { decide: vi.fn() },
}));

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
  return {
    ...actual,
    taskService: () => services.tasks,
    accessService: () => services.access,
  };
});

const companyId = "11111111-1111-4111-8111-111111111111";
const ownerAgentId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-08-01T12:00:00.000Z");

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: taskId,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Compact task",
    request: "Keep the canonical route contract.",
    boardPresentationStatus: "todo",
    lifecycleStatus: "open",
    disposition: null,
    workMode: "execute",
    priority: "medium",
    ownerKind: "agent",
    ownerAgentId,
    ownerUserId: null,
    ownershipEpoch: 1,
    creatorKind: "user/board",
    creatorAuthorityId: null,
    creatorAdapterConfigRevisionId: null,
    creatorUserId: "cloud-user-1",
    creatorPluginInstallationId: null,
    creatorPluginKey: null,
    creatorCallbackKey: null,
    creatorCallbackVersion: null,
    creatorRoutineId: null,
    creatorRoutineDispatchId: null,
    creatorSystemSourceKind: null,
    creatorSystemSourceId: null,
    taskNumber: 1,
    identifier: "PAP-1",
    originKind: "board",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function storage(): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(),
    getObject: vi.fn(),
    headObject: vi.fn(async () => ({ exists: false })),
    deleteObject: vi.fn(),
  } as unknown as StorageService;
}

function createApp(options: Omit<Parameters<typeof taskRoutes>[2], "ordinaryTasks"> = {}) {
  const harness = createMockDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.header("x-test-user-id") ?? "cloud-user-1";
    req.actor = testBoardSessionActor({
      userId,
      companyIds: [companyId],
      memberships: [
        {
          companyId,
          membershipRole: "owner",
          status: "active",
          principalId: userId,
        },
      ],
      isInstanceAdmin: false,
    });
    next();
  });
  app.use(
    "/api",
    taskRoutes(harness.db, storage(), {
      ordinaryTasks: {} as never,
      ...options,
    }),
  );
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  taskListResponseCache.clear();
  services.tasks.list.mockResolvedValue([task()]);
  services.access.decide.mockResolvedValue({ allowed: true });
});

afterEach(() => {
  taskListResponseCache.clear();
});

describe("task list owner filters", () => {
  it("passes canonical UUID owner filters to the task service", async () => {
    const app = createApp();
    const uuidResponse = await request(app)
      .get(`/api/companies/${companyId}/tasks`)
      .query({ status: "todo", ownerAgentId, limit: "20" });
    expect(uuidResponse.status).toBe(200);
    expect(services.tasks.list).toHaveBeenLastCalledWith(
      companyId,
      expect.objectContaining({ ownerAgentId, status: ["todo"], limit: 20 }),
    );
  });

  it("rejects malformed owner filters before calling the service", async () => {
    const response = await request(createApp())
      .get(`/api/companies/${companyId}/tasks`)
      .query({ ownerAgentId: "bad" });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "ownerAgentId must be an exact canonical UUID",
    });
    expect(services.tasks.list).not.toHaveBeenCalled();
  });

  it.each(["null", " NULL ", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"])(
    "rejects the owner-filter alias %j",
    async (ownerAgentIdAlias) => {
      const response = await request(createApp())
        .get(`/api/companies/${companyId}/tasks`)
        .query({ ownerAgentId: ownerAgentIdAlias });

      expect(response.status).toBe(422);
      expect(services.tasks.list).not.toHaveBeenCalled();
    },
  );

  it("accepts repeated statuses and rejects comma-separated status aliases", async () => {
    const app = createApp();
    const canonicalResponse = await request(app).get(
      `/api/companies/${companyId}/tasks?status=todo&status=in_progress`,
    );
    expect(canonicalResponse.status).toBe(200);
    expect(services.tasks.list).toHaveBeenLastCalledWith(
      companyId,
      expect.objectContaining({ status: ["todo", "in_progress"] }),
    );

    services.tasks.list.mockClear();
    const aliasResponse = await request(app).get(`/api/companies/${companyId}/tasks?status=todo,in_progress`);
    expect(aliasResponse.status).toBe(422);
    expect(services.tasks.list).not.toHaveBeenCalled();
  });

  it("rejects numeric boolean query aliases", async () => {
    const response = await request(createApp())
      .get(`/api/companies/${companyId}/tasks`)
      .query({ includeBlockedBy: "1" });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "includeBlockedBy must be true or false",
    });
    expect(services.tasks.list).not.toHaveBeenCalled();
  });

  it.each([
    ["limit", "01"],
    ["offset", "00"],
    ["touchedByUserId", " user-1"],
    ["participantAgentId", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
    ["projectId", ` ${companyId}`],
    ["parentId", "not-a-uuid"],
    ["descendantOf", ""],
    ["labelId", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa "],
    ["originKind", " plugin"],
    ["originId", ""],
  ])("rejects the non-exact %s query value %j", async (field, value) => {
    const response = await request(createApp())
      .get(`/api/companies/${companyId}/tasks`)
      .query({ [field]: value });

    expect(response.status).toBe(["limit", "offset"].includes(field) ? 400 : 422);
    expect(services.tasks.list).not.toHaveBeenCalled();
  });

  it("rejects removed and unknown task-list selectors", async () => {
    const response = await request(createApp())
      .get(`/api/companies/${companyId}/tasks`)
      .query({ includePluginOperations: "true", mystery: "value" });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "Unsupported task-list query parameters: includePluginOperations, mystery",
    });
    expect(services.tasks.list).not.toHaveBeenCalled();
  });

  it("forwards the opt-in live descendant summary and returns its projection", async () => {
    services.tasks.list.mockResolvedValue([
      task({
        boardPresentationStatus: "blocked",
        liveDescendantCount: 2,
      }),
    ]);
    const response = await request(createApp()).get(`/api/companies/${companyId}/tasks`).query({
      status: "blocked",
      includeLiveDescendantSummary: "true",
      view: "compact",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({ id: taskId, liveDescendantCount: 2 })]);
    expect(services.tasks.list).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ includeLiveDescendantSummary: true }),
    );
  });
});

describe("compact task-list response coordination", () => {
  it("returns 304 for an unchanged ETag", async () => {
    const app = createApp();
    const first = await request(app)
      .get(`/api/companies/${companyId}/tasks`)
      .query({ view: "compact", limit: "20" });
    const second = await request(app)
      .get(`/api/companies/${companyId}/tasks`)
      .query({ view: "compact", limit: "20" })
      .set("If-None-Match", first.headers.etag);

    expect(first.status).toBe(200);
    expect(first.headers.etag).toBeTruthy();
    expect(second.status).toBe(304);
    expect(second.text).toBe("");
    expect(services.tasks.list).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous identical requests into one computation", async () => {
    let computeCount = 0;
    const app = createApp({
      taskListDiagnostics: {
        async onComputeStart() {
          computeCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 25));
        },
      },
    });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app).get(`/api/companies/${companyId}/tasks`).query({ view: "compact", limit: "20" }),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(computeCount).toBe(1);
    expect(services.tasks.list).toHaveBeenCalledTimes(1);
    expect(responses.some((response) => response.headers["x-paperclip-request-cache"] === "coalesced")).toBe(
      true,
    );
  });

  it("separates cache keys by authenticated board user", async () => {
    const app = createApp();
    const first = await request(app)
      .get(`/api/companies/${companyId}/tasks`)
      .set("X-Test-User-Id", "cloud-user-1")
      .query({ view: "compact", limit: "20" });
    const second = await request(app)
      .get(`/api/companies/${companyId}/tasks`)
      .set("X-Test-User-Id", "cloud-user-2")
      .query({ view: "compact", limit: "20" });

    expect(first.headers["x-paperclip-request-cache"]).toBe("miss");
    expect(second.headers["x-paperclip-request-cache"]).toBe("miss");
    expect(services.tasks.list).toHaveBeenCalledTimes(2);
  });

  it("bounds the short-lived server cache", async () => {
    const app = createApp();
    for (let index = 0; index < TASK_LIST_SERVER_CACHE_MAX_ENTRIES + 5; index += 1) {
      const response = await request(app)
        .get(`/api/companies/${companyId}/tasks`)
        .query({ view: "compact", q: `cache-key-${index}` });
      expect(response.status).toBe(200);
    }

    expect(taskListResponseCache.size).toBe(TASK_LIST_SERVER_CACHE_MAX_ENTRIES);
  });

  it("reports request storms without logging query values", async () => {
    const stormEvents: unknown[] = [];
    const app = createApp({
      taskListDiagnostics: {
        async onComputeStart() {
          await new Promise((resolve) => setTimeout(resolve, 25));
        },
        onStormDetected(event) {
          stormEvents.push(event);
        },
      },
    });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .get(`/api/companies/${companyId}/tasks`)
          .set("Referer", "http://localhost:3100/tasks?q=do-not-log-this")
          .set("X-Paperclip-Tab-Visible", "visible")
          .query({ view: "compact", limit: "20", q: "do-not-log-this" }),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(stormEvents).toHaveLength(1);
    expect(stormEvents[0]).toMatchObject({
      event: "request_storm_detected",
      route: "GET /api/companies/:companyId/tasks",
      companyId,
      visibilityHint: "visible",
      referer: "/tasks",
      queryKeys: expect.arrayContaining(["limit", "q", "view"]),
    });
    expect(JSON.stringify(stormEvents[0])).not.toContain("do-not-log-this");
  });
});
