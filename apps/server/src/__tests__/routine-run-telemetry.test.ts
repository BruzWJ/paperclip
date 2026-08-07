import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackRoutineRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackRoutineRun: mockTrackRoutineRun,
  };
});

import { routineService } from "../services/routines.ts";

describe("routine run telemetry", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits telemetry for an idempotently recovered routine run without a database", async () => {
    const companyId = randomUUID();
    const routineId = randomUUID();
    const agentId = randomUUID();
    const revisionId = randomUUID();
    const runId = randomUUID();
    const idempotencyKey = "routine-telemetry-existing-run";
    const now = new Date("2026-01-01T00:00:00.000Z");
    const routine = {
      id: routineId,
      companyId,
      projectId: null,
      folderId: null,
      goalId: null,
      parentIssueId: null,
      title: "Run telemetry test",
      description: "Routine body",
      assigneeAgentId: agentId,
      priority: "medium",
      contextAccessMask: null,
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
      env: null,
      responsibleUserId: null,
      latestRevisionId: revisionId,
      createdAt: now,
      updatedAt: now,
    };
    const snapshot = {
      version: 1,
      routine: {
        id: routineId,
        companyId,
        projectId: null,
        folderId: null,
        goalId: null,
        parentIssueId: null,
        title: routine.title,
        description: routine.description,
        assigneeAgentId: agentId,
        priority: "medium",
        contextAccessMask: null,
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
        env: null,
        responsibleUserId: null,
      },
      triggers: [],
    };
    const existingRun = {
      id: runId,
      companyId,
      routineId,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: now,
      idempotencyKey,
      triggerPayload: null,
      dispatchFingerprint: "already-dispatched",
      routineRevisionId: revisionId,
      responsibleUserId: null,
      linkedIssueId: randomUUID(),
      coalescedIntoRunId: null,
      failureReason: null,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const harness = createMockDb({
      select: [
        [routine],
        [{ snapshot }],
        [],
        [existingRun],
      ],
      execute: [[]],
    });
    const service = routineService(harness.db, {
      ordinaryIssues: {} as never,
    });

    const run = await service.runRoutine(routineId, {
      source: "manual",
      idempotencyKey,
    });

    expect(run).toBe(existingRun);
    expect(mockTrackRoutineRun).toHaveBeenCalledWith(mockTelemetryClient, {
      source: "manual",
      status: "issue_created",
    });
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("execute")).toBe(0);
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
  });
});
