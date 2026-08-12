import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeTimelineWindow,
  workTimelineService,
} from "../services/work-timeline.js";
import { createMockDb } from "./helpers/mock-db.js";

const runMocks = vi.hoisted(() => ({
  listTaskExecutionRunsForActivity: vi.fn(),
  listTaskExecutionRunsForWorkTimeline: vi.fn(),
}));

vi.mock("../services/task-execution-run-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-execution-run-service.js")>();
  return {
    ...actual,
    listTaskExecutionRunsForActivity: runMocks.listTaskExecutionRunsForActivity,
    listTaskExecutionRunsForWorkTimeline: runMocks.listTaskExecutionRunsForWorkTimeline,
  };
});

const from = new Date("2026-06-01T00:00:00.000Z");
const to = new Date("2026-06-08T00:00:00.000Z");

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    parentId: null,
    taskNumber: 1,
    identifier: "PAP-1",
    title: "Canonical redesign",
    creatorKind: "system",
    creatorAgentId: null,
    creatorUserId: null,
    ownerAgentId: null,
    ownerUserId: null,
    boardPresentationStatus: "in_progress",
    createdAt: new Date("2026-06-02T12:00:00.000Z"),
    ...overrides,
  };
}

describe("work timeline aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMocks.listTaskExecutionRunsForActivity.mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    runMocks.listTaskExecutionRunsForWorkTimeline.mockResolvedValue({
      items: [],
      nextCursor: null,
    });
  });

  it("normalizes timeline windows with a 31-day cap and rejects inverted ranges", () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    const capped = normalizeTimelineWindow({
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2027-01-01T00:00:00.000Z"),
    }, now);
    expect(capped).toEqual({
      from: new Date("2026-05-30T12:00:00.000Z"),
      to: now,
      capped: true,
    });

    const inverted = normalizeTimelineWindow({
      from: new Date("2026-06-10T00:00:00.000Z"),
      to: new Date("2026-06-01T00:00:00.000Z"),
    }, now);
    expect(inverted.capped).toBe(true);
    expect(inverted.from).toEqual(new Date("2026-05-25T00:00:00.000Z"));
  });

  it("returns a complete empty contract when no task source contributes work", async () => {
    const mock = createMockDb({ select: [[], [], [], []] });

    const result = await workTimelineService(mock.db).getTimeline({
      companyId: "company-1",
      from,
      to,
      limit: 25,
      offset: 0,
    });

    expect(result).toEqual({
      actors: [],
      spans: [],
      events: [],
      edges: [],
      pagination: { limit: 25, offset: 0, totalTasks: 0, hasMore: false },
      window: { from: from.toISOString(), to: to.toISOString(), capped: false },
    });
    expect(runMocks.listTaskExecutionRunsForActivity).toHaveBeenCalledWith(
      mock.db,
      expect.objectContaining({ companyId: "company-1", limit: 200 }),
    );
    expect(mock.remaining("select")).toBe(0);
  });

  it("emits canonical creation, comment, approval, assignment, and run records", async () => {
    const task = taskRow({
      creatorKind: "user/board",
      creatorUserId: "user-creator",
      ownerAgentId: "agent-owner",
    });
    runMocks.listTaskExecutionRunsForWorkTimeline.mockResolvedValue({
      items: [{
        runId: "run-1",
        companyId: "company-1",
        taskId: "task-1",
        targetAgentId: "agent-owner",
        kind: "agent",
        status: "succeeded",
        retryOfRunId: null,
        createdAt: new Date("2026-06-03T09:00:00.000Z"),
        startedAt: new Date("2026-06-03T09:01:00.000Z"),
        finishedAt: new Date("2026-06-03T09:05:00.000Z"),
      }],
      nextCursor: null,
    });
    const mock = createMockDb({
      select: [
        [{ id: "task-1" }],
        [],
        [],
        [],
        [task],
        [{
          taskId: "task-1",
          authorAgentId: "agent-owner",
          authorUserId: null,
          createdAt: new Date("2026-06-03T10:00:00.000Z"),
        }],
        [{
          taskId: "task-1",
          decidedByUserId: "user-reviewer",
          decidedAt: new Date("2026-06-03T11:00:00.000Z"),
          requestedByAgentId: null,
          requestedByUserId: null,
          createdAt: new Date("2026-06-03T10:30:00.000Z"),
        }],
        [],
        [{ id: "agent-owner", name: "Owner", icon: null }],
        [
          { id: "user-creator", name: "Creator", image: null },
          { id: "user-reviewer", name: "Reviewer", image: null },
        ],
      ],
    });

    const result = await workTimelineService(mock.db).getTimeline({
      companyId: "company-1",
      from,
      to,
    });

    expect(result.actors).toEqual(expect.arrayContaining([
      { id: "user:user-creator", type: "user", name: "Creator", avatar: null },
      { id: "agent:agent-owner", type: "agent", name: "Owner", avatar: null },
      { id: "user:user-reviewer", type: "user", name: "Reviewer", avatar: null },
    ]));
    expect(result.spans).toEqual([
      expect.objectContaining({
        runId: "run-1",
        actorId: "agent:agent-owner",
        taskNumber: 1,
        taskIdentifier: "PAP-1",
        status: "succeeded",
      }),
    ]);
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "created", actorId: "user:user-creator" }),
      expect.objectContaining({ kind: "commented", actorId: "agent:agent-owner" }),
      expect.objectContaining({ kind: "approved", actorId: "user:user-reviewer" }),
    ]));
    expect(result.edges).toEqual([
      expect.objectContaining({
        kind: "assignment",
        fromActorId: "user:user-creator",
        toActorId: "agent:agent-owner",
      }),
    ]);
    expect(mock.remaining("select")).toBe(0);
  });

  it("filters unreadable tasks before querying their timeline details", async () => {
    const canReadTask = vi.fn().mockResolvedValue(false);
    const mock = createMockDb({
      select: [
        [{ id: "task-1" }],
        [],
        [],
        [],
        [taskRow()],
      ],
    });

    const result = await workTimelineService(mock.db).getTimeline({
      companyId: "company-1",
      from,
      to,
      canReadTask,
    });

    expect(canReadTask).toHaveBeenCalledWith(expect.objectContaining({
      id: "task-1",
      companyId: "company-1",
      boardPresentationStatus: "in_progress",
    }));
    expect(result.events).toEqual([]);
    expect(runMocks.listTaskExecutionRunsForWorkTimeline).not.toHaveBeenCalled();
    expect(mock.remaining("select")).toBe(0);
  });
});
