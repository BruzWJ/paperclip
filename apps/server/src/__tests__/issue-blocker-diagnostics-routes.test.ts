import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";
import { issueRoutes } from "../routes/issues.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const issueMocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getBlockerDiagnostics: vi.fn(),
}));

vi.mock("../services/index.js", async () => ({
  ...await vi.importActual<typeof import("../services/index.js")>("../services/index.js"),
  issueService: () => issueMocks,
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const rootId = "00000000-0000-4000-8000-000000000010";
const blockerId = "00000000-0000-4000-8000-000000000011";

function issue(overrides: Record<string, unknown> = {}) {
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
  app.use("/api", issueRoutes(db, {} as never, { ordinaryIssues: {} as never }));
  app.use(errorHandler);
  return app;
}

describe("issue blocker diagnostics route", () => {
  beforeEach(() => {
    issueMocks.getById.mockReset();
    issueMocks.getBlockerDiagnostics.mockReset();
  });

  it("returns stale-blocker diagnosis and anomaly flags for a done blocker", async () => {
    const root = issue();
    const blocker = issue({
      id: blockerId,
      identifier: "PC-2",
      title: "Finished blocker",
      boardPresentationStatus: "done",
      ownerUserId: null,
    });
    issueMocks.getById.mockResolvedValue(root);
    issueMocks.getBlockerDiagnostics.mockResolvedValue({
      blockers: [blocker],
      readiness: {
        allBlockersDone: true,
        isDependencyReady: true,
        unresolvedBlockerIssueIds: [],
        pendingFinalizeBlockerIssueIds: [],
      },
      truncated: false,
    });
    const harness = createMockDb();

    const res = await request(createApp(harness.db))
      .get(`/api/issues/${rootId}/diagnostics/blockers`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      diagnosis: expect.stringContaining("stale blocker hold"),
      readiness: {
        allBlockersDone: true,
        isDependencyReady: true,
        unresolvedBlockerCount: 0,
        pendingFinalizeBlockerCount: 0,
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

  it("returns no diagnosis for an unblocked issue with no blockers", async () => {
    const root = issue({ boardPresentationStatus: "todo", title: "Ready work" });
    issueMocks.getById.mockResolvedValue(root);
    issueMocks.getBlockerDiagnostics.mockResolvedValue({
      blockers: [],
      readiness: {
        allBlockersDone: true,
        isDependencyReady: true,
        unresolvedBlockerIssueIds: [],
        pendingFinalizeBlockerIssueIds: [],
      },
      truncated: false,
    });

    const res = await request(createApp(createMockDb().db))
      .get(`/api/issues/${rootId}/diagnostics/blockers`);

    expect(res.status).toBe(200);
    expect(res.body.diagnosis).toBeNull();
    expect(res.body.blockers).toEqual([]);
    expect(res.body.readiness).toMatchObject({
      allBlockersDone: true,
      isDependencyReady: true,
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerCount: 0,
    });
  });

  it("caps blocker output and withholds readiness when diagnostics are truncated", async () => {
    const root = issue({ title: "Wide blocked issue" });
    const blockers = Array.from({ length: 100 }, (_, index) => issue({
      id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      identifier: `PC-${index + 2}`,
      title: `Blocker ${String(index).padStart(3, "0")}`,
      boardPresentationStatus: "done",
    }));
    issueMocks.getById.mockResolvedValue(root);
    issueMocks.getBlockerDiagnostics.mockResolvedValue({
      blockers,
      readiness: {
        allBlockersDone: true,
        isDependencyReady: true,
        unresolvedBlockerIssueIds: [],
        pendingFinalizeBlockerIssueIds: [],
      },
      truncated: true,
    });

    const res = await request(createApp(createMockDb().db))
      .get(`/api/issues/${rootId}/diagnostics/blockers`);

    expect(res.status).toBe(200);
    expect(res.body.blockers).toHaveLength(100);
    expect(res.body.truncated).toBe(true);
    expect(res.body.readiness).toBeNull();
    expect(res.body.omittedUnauthorizedBlockerCount).toBeNull();
    expect(res.body.diagnosis).toContain("truncated at 100 blockers");
    expect(res.body.caps).toEqual({ maxBlockers: 100 });
  });

  it("denies generic agent credentials before reading issue or blocker data", async () => {
    const harness = createMockDb();
    const actor = {
      type: "agent",
      agentId: "00000000-0000-4000-8000-000000000020",
      companyId,
      runId: "00000000-0000-4000-8000-000000000030",
      source: "internal",
    } as const;

    const res = await request(createApp(harness.db, actor))
      .get(`/api/issues/${rootId}/diagnostics/blockers`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Agent credentials cannot access the generic REST API; use the run-scoped compiled interface",
      code: "compiled_run_interface_required",
    });
    expect(issueMocks.getById).not.toHaveBeenCalled();
    expect(issueMocks.getBlockerDiagnostics).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });
});
