import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";
import { taskRoutes } from "../routes/tasks.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const taskMocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getSubtreeDiagnostics: vi.fn(),
}));

vi.mock("../services/index.js", async () => ({
  ...await vi.importActual<typeof import("../services/index.js")>("../services/index.js"),
  taskService: () => taskMocks,
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const rootId = "00000000-0000-4000-8000-000000000010";
const childId = "00000000-0000-4000-8000-000000000011";
const timestamp = new Date("2026-01-02T03:04:05.000Z");
const caps = { maxDepth: 8, maxNodes: 100, maxBlockersPerNode: 20 };

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: rootId,
    companyId,
    projectId: "00000000-0000-4000-8000-000000000100",
    parentId: null,
    identifier: "PC-1",
    title: "Blocked root",
    boardPresentationStatus: "blocked",
    priority: "medium",
    ownerAgentId: null,
    ownerUserId: "board-user",
    depth: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function ready() {
  return {
    allBlockersDone: true,
    isDependencyReady: true,
    unresolvedBlockerTaskIds: [],
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
  app.use("/api", taskRoutes(db, {} as never, { ordinaryTasks: {} as never }));
  app.use(errorHandler);
  return app;
}

describe("task subtree diagnostics route", () => {
  beforeEach(() => {
    taskMocks.getById.mockReset();
    taskMocks.getSubtreeDiagnostics.mockReset();
  });

  it("returns subtree nodes, blocker edges, and a deterministic stall diagnosis", async () => {
    const root = task();
    const child = task({
      id: childId,
      parentId: rootId,
      identifier: "PC-2",
      title: "Unfinished child blocker",
      boardPresentationStatus: "in_progress",
      depth: 1,
      ownerUserId: null,
    });
    const blockerRow = {
      ...child,
      blockedTaskId: rootId,
      relationCreatedAt: timestamp,
    };
    taskMocks.getById.mockResolvedValue(root);
    taskMocks.getSubtreeDiagnostics.mockResolvedValue({
      nodes: [root, child],
      blockersByTaskId: new Map([[rootId, [blockerRow]]]),
      readinessByTaskId: new Map([
        [rootId, {
          allBlockersDone: false,
          isDependencyReady: false,
          unresolvedBlockerTaskIds: [childId],
        }],
        [childId, ready()],
      ]),
      truncatedNodes: false,
      truncatedDepth: false,
      truncatedBlockerTaskIds: new Set(),
      caps,
    });
    const harness = createMockDb();

    const res = await request(createApp(harness.db))
      .get(`/api/tasks/${rootId}/diagnostics/subtree`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      diagnosis: expect.stringContaining("Blocked root appears to be the subtree stall point"),
      likelyReason: expect.stringContaining("Blocked root appears to be the subtree stall point"),
      nodeCount: 2,
      omittedUnauthorizedNodeCount: 0,
      truncated: false,
      caps,
    });
    const rootNode = res.body.nodes.find((node: { task: { id: string } }) => node.task.id === rootId);
    const childNode = res.body.nodes.find((node: { task: { id: string } }) => node.task.id === childId);
    expect(rootNode).toMatchObject({
      diagnosis: expect.stringContaining("blocked by Unfinished child blocker"),
      blockers: [expect.objectContaining({ id: childId, isUnresolved: true })],
    });
    expect(childNode).toMatchObject({ parentId: rootId, depth: 1 });
    expect(res.body.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "parent", fromTaskId: rootId, toTaskId: childId }),
      expect.objectContaining({ kind: "blocks", fromTaskId: childId, toTaskId: rootId }),
    ]));
    expect(harness.calls).toEqual([]);
  });

  it("returns no diagnosis for a quiet singleton subtree", async () => {
    const root = task({ title: "Quiet root", boardPresentationStatus: "todo" });
    taskMocks.getById.mockResolvedValue(root);
    taskMocks.getSubtreeDiagnostics.mockResolvedValue({
      nodes: [root],
      blockersByTaskId: new Map(),
      readinessByTaskId: new Map([[rootId, ready()]]),
      truncatedNodes: false,
      truncatedDepth: false,
      truncatedBlockerTaskIds: new Set(),
      caps,
    });

    const res = await request(createApp(createMockDb().db))
      .get(`/api/tasks/${rootId}/diagnostics/subtree`);

    expect(res.status).toBe(200);
    expect(res.body.diagnosis).toBeNull();
    expect(res.body.likelyReason).toBeNull();
    expect(res.body.nodes).toEqual([
      expect.objectContaining({ diagnosis: null, likelyReason: null, blockers: [], truncated: false }),
    ]);
    expect(res.body.edges).toEqual([]);
  });

  it("reports the canonical node cap when the service marks the subtree truncated", async () => {
    const nodes = Array.from({ length: 100 }, (_, index) => task({
      id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      parentId: index === 0 ? null : rootId,
      identifier: `PC-${index + 1}`,
      title: index === 0 ? "Wide root" : `Child ${String(index).padStart(3, "0")}`,
      boardPresentationStatus: "todo",
      depth: index === 0 ? 0 : 1,
    }));
    const root = nodes[0]!;
    taskMocks.getById.mockResolvedValue(root);
    taskMocks.getSubtreeDiagnostics.mockResolvedValue({
      nodes,
      blockersByTaskId: new Map(),
      readinessByTaskId: new Map(),
      truncatedNodes: true,
      truncatedDepth: false,
      truncatedBlockerTaskIds: new Set(),
      caps,
    });

    const res = await request(createApp(createMockDb().db))
      .get(`/api/tasks/${root.id}/diagnostics/subtree`);

    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(100);
    expect(res.body.nodeCount).toBe(100);
    expect(res.body.truncated).toBe(true);
    expect(res.body.truncatedSections).toMatchObject({ nodes: true });
    expect(res.body.omittedUnauthorizedNodeCount).toBeNull();
    expect(res.body.diagnosis).toContain("bounded to depth 8 and 100 nodes");
  });

  it("denies generic agent credentials before reading any subtree data", async () => {
    const harness = createMockDb();
    const actor = {
      type: "agent",
      agentId: "00000000-0000-4000-8000-000000000020",
      companyId,
      runId: "00000000-0000-4000-8000-000000000030",
      source: "internal",
    } as const;

    const res = await request(createApp(harness.db, actor))
      .get(`/api/tasks/${rootId}/diagnostics/subtree`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Agent credentials cannot access the generic REST API; use the run-scoped compiled interface",
      code: "compiled_run_interface_required",
    });
    expect(taskMocks.getById).not.toHaveBeenCalled();
    expect(taskMocks.getSubtreeDiagnostics).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });
});
