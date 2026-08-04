// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: taskKey, summarize-status
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrdinaryIssueRuntime } from "../services/ordinary-issue-runtime.js";
import { summarySlotService } from "../services/summary-slots.js";
import { createMockDb } from "./helpers/mock-db.js";

const routineMocks = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  runRoutine: vi.fn(),
}));

vi.mock("../services/routines.js", () => ({
  routineService: vi.fn(() => routineMocks),
}));

const companyId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const slotId = "44444444-4444-4444-8444-444444444444";
const issueId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-08-01T12:00:00.000Z");

const actor = {
  type: "user",
  userId: "board-user",
} as const;

function slotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: slotId,
    companyId,
    scopeKind: "project",
    scopeId: projectId,
    slotKey: "header",
    routineId: null,
    documentId: null,
    status: "idle",
    failureReason: null,
    generatingIssueId: null,
    lastGeneratedAt: null,
    lastGeneratedByAgentId: null,
    lastModel: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function routineRow() {
  return {
    id: slotId,
    companyId,
    projectId,
    folderId: null,
    goalId: null,
    parentIssueId: null,
    title: "Refresh project summary",
    description: "Summary request",
    assigneeAgentId: agentId,
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    env: null,
    originKind: "summary_slot",
    originId: slotId,
    createdAt: now,
    updatedAt: now,
  };
}

function issueRow(status = "todo") {
  return {
    id: issueId,
    companyId,
    identifier: "SUM-1",
    title: "Refresh project summary",
    boardPresentationStatus: status,
    ownerAgentId: agentId,
  };
}

function selector() {
  return {
    companyId,
    scopeKind: "project",
    scopeId: projectId,
    slotKey: "header",
  };
}

function service(db: ReturnType<typeof createMockDb>["db"]) {
  return summarySlotService(db, {
    ordinaryIssues: {} as OrdinaryIssueRuntime,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  routineMocks.get.mockResolvedValue(null);
  routineMocks.create.mockResolvedValue(routineRow());
  routineMocks.runRoutine.mockResolvedValue({
    id: "routine-run-1",
    status: "issue_created",
    linkedIssueId: issueId,
    failureReason: null,
  });
});

describe("summary slot ordinary-routine producer", () => {
  it("fails visibly instead of choosing a default owner", async () => {
    const harness = createMockDb({
      select: [[{ id: projectId }], []],
      insert: [[slotRow()]],
    });

    await expect(
      service(harness.db).dispatchRefresh(selector(), actor),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "summary_routine_not_configured" },
    });

    expect(routineMocks.create).not.toHaveBeenCalled();
    expect(routineMocks.runRoutine).not.toHaveBeenCalled();
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("creates one stable routine and dispatches one ordinary execution issue", async () => {
    const linked = slotRow({ routineId: slotId });
    const generating = slotRow({
      routineId: slotId,
      status: "generating",
      generatingIssueId: issueId,
    });
    const harness = createMockDb({
      select: [
        [{ id: projectId }],
        [],
        [linked],
        [issueRow()],
        [generating],
      ],
      insert: [[slotRow()], [linked]],
    });

    await expect(
      service(harness.db).dispatchRefresh(
        { ...selector(), ownerAgentId: agentId },
        actor,
      ),
    ).resolves.toMatchObject({
      alreadyGenerating: false,
      slot: {
        id: slotId,
        routineId: slotId,
        generatingIssueId: issueId,
      },
      generatingIssue: { id: issueId, identifier: "SUM-1" },
    });

    expect(routineMocks.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        projectId,
        assigneeAgentId: agentId,
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
      }),
      actor,
      {
        id: slotId,
        originKind: "summary_slot",
        originId: slotId,
      },
    );
    const request = routineMocks.create.mock.calls[0]?.[1]?.description as string;
    expect(request).toContain(
      "normal terminal `issue_update` message with status `done`",
    );
    expect(request).not.toMatch(
      /summarize-status|scope snapshot|summary API|taskKey|SUMMARY-DRAFT/,
    );
    expect(routineMocks.runRoutine).toHaveBeenCalledWith(
      slotId,
      expect.objectContaining({
        source: "manual",
        projectId,
        idempotencyKey: `summary-slot-refresh:${slotId}:initial`,
      }),
      actor,
    );
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("coalesces onto an active generation without dispatching again", async () => {
    const generating = slotRow({
      routineId: slotId,
      status: "generating",
      generatingIssueId: issueId,
    });
    const harness = createMockDb({
      select: [[{ id: projectId }], [generating], [issueRow("in_progress")]],
    });

    await expect(
      service(harness.db).dispatchRefresh(selector(), actor),
    ).resolves.toMatchObject({
      alreadyGenerating: true,
      slot: { id: slotId, generatingIssueId: issueId },
      generatingIssue: { id: issueId },
    });

    expect(routineMocks.get).not.toHaveBeenCalled();
    expect(routineMocks.create).not.toHaveBeenCalled();
    expect(routineMocks.runRoutine).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
  });
});
