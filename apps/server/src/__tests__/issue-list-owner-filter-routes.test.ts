import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearIssueListResponseCacheForTests,
  __getIssueListResponseCacheSizeForTests,
  ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES,
  issueRoutes,
} from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";
import type { StorageService } from "../storage/types.js";

const services = vi.hoisted(() => ({
  issues: { list: vi.fn() },
  access: { decide: vi.fn() },
}));

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>(
    "../services/index.js",
  );
  return {
    ...actual,
    issueService: () => services.issues,
    accessService: () => services.access,
  };
});

const companyId = "11111111-1111-4111-8111-111111111111";
const ownerAgentId = "22222222-2222-4222-8222-222222222222";
const issueId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-08-01T12:00:00.000Z");

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Compact issue",
    request: "Keep the canonical route contract.",
    boardPresentationStatus: "todo",
    lifecycleStatus: "open",
    disposition: null,
    workMode: "execute",
    priority: "medium",
    ownerKind: "agent",
    ownerAgentId,
    ownerUserId: null,
    ownerAssignmentSource: "explicit",
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
    issueNumber: 1,
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

function createApp(
  options: Omit<Parameters<typeof issueRoutes>[2], "ordinaryIssues"> = {},
) {
  const harness = createMockDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.header("x-test-user-id") ?? "cloud-user-1";
    req.actor = testBoardSessionActor({
      userId,
      companyIds: [companyId],
      memberships: [{
        companyId,
        membershipRole: "owner",
        status: "active",
        principalId: userId,
      }],
      isInstanceAdmin: false,
    });
    next();
  });
  app.use("/api", issueRoutes(harness.db, storage(), {
    ordinaryIssues: {} as never,
    ...options,
  }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearIssueListResponseCacheForTests();
  services.issues.list.mockResolvedValue([issue()]);
  services.access.decide.mockResolvedValue({ allowed: true });
});

afterEach(() => {
  __clearIssueListResponseCacheForTests();
});

describe("issue list owner filters", () => {
  it("passes canonical null and UUID owner filters to the issue service", async () => {
    const app = createApp();
    const nullResponse = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", ownerAgentId: "null", limit: "20" });
    expect(nullResponse.status).toBe(200);
    expect(services.issues.list).toHaveBeenLastCalledWith(
      companyId,
      expect.objectContaining({ ownerAgentId: null, status: "todo", limit: 20 }),
    );

    const uuidResponse = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", ownerAgentId, limit: "20" });
    expect(uuidResponse.status).toBe(200);
    expect(services.issues.list).toHaveBeenLastCalledWith(
      companyId,
      expect.objectContaining({ ownerAgentId, status: "todo", limit: 20 }),
    );
  });

  it("rejects malformed owner filters before calling the service", async () => {
    const response = await request(createApp())
      .get(`/api/companies/${companyId}/issues`)
      .query({ ownerAgentId: "bad" });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "ownerAgentId must be a UUID or 'null'",
    });
    expect(services.issues.list).not.toHaveBeenCalled();
  });

  it("forwards the opt-in live descendant summary and returns its projection", async () => {
    services.issues.list.mockResolvedValue([
      issue({
        boardPresentationStatus: "blocked",
        liveDescendantCount: 2,
      }),
    ]);
    const response = await request(createApp())
      .get(`/api/companies/${companyId}/issues`)
      .query({
        status: "blocked",
        includeLiveDescendantSummary: "true",
        view: "compact",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({ id: issueId, liveDescendantCount: 2 }),
    ]);
    expect(services.issues.list).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ includeLiveDescendantSummary: true }),
    );
  });
});

describe("compact issue-list response coordination", () => {
  it("returns 304 for an unchanged ETag", async () => {
    const app = createApp();
    const first = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" });
    const second = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", limit: "20" })
      .set("If-None-Match", first.headers.etag);

    expect(first.status).toBe(200);
    expect(first.headers.etag).toBeTruthy();
    expect(second.status).toBe(304);
    expect(second.text).toBe("");
    expect(services.issues.list).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous identical requests into one computation", async () => {
    let computeCount = 0;
    const app = createApp({
      issueListDiagnostics: {
        async onComputeStart() {
          computeCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 25));
        },
      },
    });
    const responses = await Promise.all(Array.from({ length: 10 }, () =>
      request(app)
        .get(`/api/companies/${companyId}/issues`)
        .query({ view: "compact", limit: "20" }),
    ));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(computeCount).toBe(1);
    expect(services.issues.list).toHaveBeenCalledTimes(1);
    expect(responses.some(
      (response) => response.headers["x-paperclip-request-cache"] === "coalesced",
    )).toBe(true);
  });

  it("separates cache keys by authenticated board user", async () => {
    const app = createApp();
    const first = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .set("X-Test-User-Id", "cloud-user-1")
      .query({ view: "compact", limit: "20" });
    const second = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .set("X-Test-User-Id", "cloud-user-2")
      .query({ view: "compact", limit: "20" });

    expect(first.headers["x-paperclip-request-cache"]).toBe("miss");
    expect(second.headers["x-paperclip-request-cache"]).toBe("miss");
    expect(services.issues.list).toHaveBeenCalledTimes(2);
  });

  it("bounds the short-lived server cache", async () => {
    const app = createApp();
    for (let index = 0; index < ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES + 5; index += 1) {
      const response = await request(app)
        .get(`/api/companies/${companyId}/issues`)
        .query({ view: "compact", q: `cache-key-${index}` });
      expect(response.status).toBe(200);
    }

    expect(__getIssueListResponseCacheSizeForTests()).toBe(
      ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES,
    );
  });

  it("reports request storms without logging query values", async () => {
    const stormEvents: unknown[] = [];
    const app = createApp({
      issueListDiagnostics: {
        async onComputeStart() {
          await new Promise((resolve) => setTimeout(resolve, 25));
        },
        onStormDetected(event) {
          stormEvents.push(event);
        },
      },
    });
    const responses = await Promise.all(Array.from({ length: 5 }, () =>
      request(app)
        .get(`/api/companies/${companyId}/issues`)
        .set("Referer", "http://localhost:3100/issues?q=do-not-log-this")
        .set("X-Paperclip-Tab-Visible", "visible")
        .query({ view: "compact", limit: "20", q: "do-not-log-this" }),
    ));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(stormEvents).toHaveLength(1);
    expect(stormEvents[0]).toMatchObject({
      event: "request_storm_detected",
      route: "GET /api/companies/:companyId/issues",
      companyId,
      visibilityHint: "visible",
      referer: "/issues",
      queryKeys: expect.arrayContaining(["limit", "q", "view"]),
    });
    expect(JSON.stringify(stormEvents[0])).not.toContain("do-not-log-this");
  });
});
