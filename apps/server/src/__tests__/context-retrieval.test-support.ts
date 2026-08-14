import { describe, expect, expectTypeOf, it } from "vitest";
import type { WorkerToHostMethods } from "@paperclipai/plugin-sdk";
import { resolveContextDial } from "../services/context-dial-resolver.ts";
import {
  ContextRetrievalDenied,
  ContextRetrievalInvalidCursor,
  createContextRetrievalService,
  type CanonicalRunTrace,
  type ContextRetrievalTaskProjection,
  type ContextRetrievalRepository,
} from "../services/context-retrieval.ts";
export function task(
  id: string,
  parentId: string | null,
  updatedAt = "2026-07-25T00:00:00.000Z",
): ContextRetrievalTaskProjection {
  return {
    id,
    identifier: `PAP-${id}`,
    title: `Task ${id}`,
    request: `Request ${id}`,
    status: "open",
    disposition: null,
    priority: "medium",
    creator: { kind: "system", sourceKind: "recovery" },
    owner: { kind: "agent", agentId: "agent-1" },
    parentId,
    directChildCount: 0,
    updatedAt,
  };
}

export function repository(): ContextRetrievalRepository {
  const reach = new Map([
    ["active", { sameCompany: true, active: true, descendant: false }],
    ["child", { sameCompany: true, active: false, descendant: true }],
    ["other", { sameCompany: true, active: false, descendant: false }],
  ]);
  return {
    async taskReach({ taskId }) {
      return reach.get(taskId) ?? null;
    },
    async listTopLevelTasks() {
      return [task("top-1", null), task("top-2", null)];
    },
    async listDirectChildren({ taskId }) {
      return [task("child", taskId)];
    },
    async listTaskComments({ taskId }) {
      return [
        {
          id: "comment-1",
          taskId,
          body: "First",
          author: { kind: "user", userId: "board-user" },
          runId: null,
          sequence: 1,
          createdAt: "2026-07-25T00:00:00.000Z",
        },
        {
          id: "comment-2",
          taskId,
          body: "Second",
          author: { kind: "agent", agentId: "agent-2" },
          runId: "run-1",
          sequence: 2,
          createdAt: "2026-07-25T00:01:00.000Z",
        },
      ];
    },
    async runTask({ runId }) {
      return runId === "run-child" ? { taskId: "child" } : null;
    },
    async readCanonicalRunTrace({ runId }) {
      return {
        runId,
        runKind: "productive",
        taskId: "child",
        status: "succeeded",
        startedAt: "2026-07-25T00:00:00.000Z",
        finishedAt: "2026-07-25T00:01:00.000Z",
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          knownDeltaAmount: "0",
        },
        turns: [
          {
            seq: 0,
            id: "msg_user",
            kind: "user",
            timestamp: "2026-07-25T00:00:00.000Z",
            text: "Inspect this",
            ...({ nativeSessionId: "forbidden" } as Record<string, unknown>),
          },
        ],
        outcome: null,
        comments: [],
      };
    },
  };
}

export function service(repo = repository()) {
  return createContextRetrievalService({
    cursorSecret: "test-cursor-secret",
    repository: repo,
  });
}

export function scope(grants: Parameters<typeof resolveContextDial>[0]["agent"]) {
  return {
    companyId: "company-1",
    activeTaskId: "active",
    dial: resolveContextDial({ agent: grants }).effective,
  };
}
export type ContextRetrievalService = ReturnType<typeof createContextRetrievalService>;

export { describe, expect, expectTypeOf, it, resolveContextDial };
export { ContextRetrievalDenied, ContextRetrievalInvalidCursor };
export { createContextRetrievalService };
export type { WorkerToHostMethods, CanonicalRunTrace, ContextRetrievalTaskProjection };
export type { ContextRetrievalRepository };
