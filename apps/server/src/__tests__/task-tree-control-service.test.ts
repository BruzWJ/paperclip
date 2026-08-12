import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";

const serviceMocks = vi.hoisted(() => ({
  recordNamedBoardLifecycleCommandInTransaction: vi.fn(async () => undefined),
  resolveCurrentTaskOwnerRunLinkages: vi.fn(async () => new Map()),
  requestRunningTaskInterruptionsInTransaction: vi.fn(),
  reconcileRequestedCancellations: vi.fn(),
  requestScopeCancellationsInTransaction: vi.fn(),
}));

vi.mock("../services/task-board-lifecycle-command.js", () => ({
  recordNamedBoardLifecycleCommandInTransaction:
    serviceMocks.recordNamedBoardLifecycleCommandInTransaction,
}));

vi.mock("../services/productive-run-linkage.js", () => ({
  resolveCurrentTaskOwnerRunLinkages:
    serviceMocks.resolveCurrentTaskOwnerRunLinkages,
}));

import { taskTreeControlService } from "../services/task-tree-control.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const boardUserId = "board-user";
const baseTime = new Date("2026-04-21T10:00:00.000Z");

function task(input: {
  id?: string;
  taskNumber?: number | null;
  parentId?: string | null;
  title?: string;
  status?: string;
  lifecycleStatus?: "open" | "blocked" | "done" | "cancelled";
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  createdAt?: Date;
}) {
  const id = input.id ?? randomUUID();
  return {
    id,
    companyId,
    taskNumber: input.taskNumber ?? 1,
    identifier: `TST-${id.slice(0, 4)}`,
    title: input.title ?? "Task",
    parentId: input.parentId ?? null,
    boardPresentationStatus: input.status ?? "todo",
    lifecycleStatus:
      input.lifecycleStatus ??
      (input.status === "done" || input.status === "cancelled"
        ? input.status
        : input.status === "blocked"
          ? "blocked"
          : "open"),
    ownerAgentId: input.ownerAgentId ?? null,
    ownerUserId: input.ownerUserId ?? null,
    ownershipEpoch: 1,
    createdAt: input.createdAt ?? baseTime,
    updatedAt: input.createdAt ?? baseTime,
  };
}

function hold(input: {
  id?: string;
  rootTaskId: string;
  mode?: "pause" | "resume" | "cancel" | "restore";
  status?: "active" | "released";
  actorType?: "user" | "agent" | "system";
}) {
  return {
    id: input.id ?? randomUUID(),
    companyId,
    rootTaskId: input.rootTaskId,
    mode: input.mode ?? "pause",
    status: input.status ?? "active",
    reason: "operator requested control",
    releasePolicy: { strategy: "manual" },
    createdByActorType: input.actorType ?? "user",
    createdByAgentId: null,
    createdByUserId:
      (input.actorType ?? "user") === "user" ? boardUserId : null,
    createdByRunId: null,
    releasedAt: null,
    releasedByActorType: null,
    releasedByAgentId: null,
    releasedByUserId: null,
    releasedByRunId: null,
    releaseReason: null,
    releaseMetadata: null,
    createdAt: baseTime,
    updatedAt: baseTime,
  };
}

function member(input: {
  holdId: string;
  taskId: string;
  status?: string;
  skipped?: boolean;
  skipReason?: string | null;
  parentTaskId?: string | null;
}) {
  return {
    id: randomUUID(),
    companyId,
    holdId: input.holdId,
    taskId: input.taskId,
    parentTaskId: input.parentTaskId ?? null,
    depth: input.parentTaskId ? 1 : 0,
    taskIdentifier: `TST-${input.taskId.slice(0, 4)}`,
    taskTitle: "Task",
    taskStatus: input.status ?? "todo",
    ownerAgentId: null,
    ownerUserId: boardUserId,
    activeRunId: null,
    activeRunStatus: null,
    skipped: input.skipped ?? false,
    skipReason: input.skipReason ?? null,
    createdAt: baseTime,
  };
}

describe("taskTreeControlService without a database process", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.resolveCurrentTaskOwnerRunLinkages.mockResolvedValue(new Map());
    serviceMocks.requestRunningTaskInterruptionsInTransaction.mockResolvedValue({
      companyId,
      taskId: "task",
      ownershipEpoch: 1,
      reason: "active_subtree_pause_hold",
      requests: [],
    });
    serviceMocks.requestScopeCancellationsInTransaction.mockResolvedValue({
      companyId,
      taskId: "task",
      selector: { kind: "ownership_epoch", ownershipEpoch: 1 },
      reason: "task_tree_cancelled",
      fence: { refIds: [], correlationIds: [] },
      requests: [],
    });
    serviceMocks.reconcileRequestedCancellations.mockResolvedValue([]);
  });

  it("previews a subtree, terminal skips, and active execution without mutations", async () => {
    const root = task({ title: "Root" });
    const agentId = randomUUID();
    const runningChild = task({
      parentId: root.id,
      title: "Running child",
      status: "in_progress",
      ownerAgentId: agentId,
    });
    const doneChild = task({
      parentId: root.id,
      title: "Done child",
      status: "done",
    });
    const runId = randomUUID();
    serviceMocks.resolveCurrentTaskOwnerRunLinkages.mockResolvedValue(new Map([
      [runningChild.id, {
        runId,
        taskId: runningChild.id,
        agentId,
        startedAt: baseTime,
        createdAt: baseTime,
      }],
    ]));
    const harness = createMockDb({
      select: [[root], [runningChild, doneChild], [], []],
    });

    const preview = await taskTreeControlService(harness.db).preview(
      companyId,
      root.id,
      { mode: "pause" },
    );

    expect(preview.tasks.map((row) => [row.id, row.depth, row.skipReason]))
      .toEqual([
        [root.id, 0, null],
        [runningChild.id, 1, null],
        [doneChild.id, 1, "terminal_status"],
      ]);
    expect(preview.totals).toMatchObject({
      totalTasks: 3,
      affectedTasks: 2,
      skippedTasks: 1,
      activeRuns: 1,
      affectedAgents: 1,
    });
    expect(preview.warnings.map((warning) => warning.code))
      .toContain("running_runs_present");
    expect(harness.calls.some((call) => call.operation !== "select")).toBe(false);
  });

  it("keeps human-owned work static with no affected agent execution", async () => {
    const root = task({
      title: "Human validation",
      status: "in_progress",
      ownerUserId: boardUserId,
    });
    const harness = createMockDb({ select: [[root], [], []] });

    const preview = await taskTreeControlService(harness.db).preview(
      companyId,
      root.id,
      { mode: "pause" },
    );

    expect(preview.tasks).toEqual([
      expect.objectContaining({
        id: root.id,
        ownerAgentId: null,
        ownerUserId: boardUserId,
        activeRun: null,
        skipped: false,
      }),
    ]);
    expect(preview.activeRuns).toEqual([]);
    expect(preview.affectedAgents).toEqual([]);
  });

  it("uses lifecycle rather than stale terminal presentation for tree control", async () => {
    const reopened = task({
      status: "done",
      lifecycleStatus: "open",
      ownerAgentId: randomUUID(),
    });
    const harness = createMockDb({
      select: [[reopened], [], []],
    });

    const preview = await taskTreeControlService(harness.db).preview(
      companyId,
      reopened.id,
      { mode: "cancel" },
    );

    expect(preview.tasks).toEqual([
      expect.objectContaining({ id: reopened.id, skipReason: null }),
    ]);
    expect(preview.totals).toMatchObject({
      affectedTasks: 1,
      skippedTasks: 0,
    });
  });

  it("fails closed when the root is outside the requested company", async () => {
    const harness = createMockDb({ select: [[]] });

    await expect(
      taskTreeControlService(harness.db).preview(
        companyId,
        randomUUID(),
        { mode: "pause" },
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(harness.remaining("select")).toBe(0);
  });

  it("creates a normalized pause snapshot and records the named-board command", async () => {
    const root = task({ ownerUserId: boardUserId });
    const createdHold = hold({ rootTaskId: root.id });
    const createdMember = member({ holdId: createdHold.id, taskId: root.id });
    const harness = createMockDb({
      select: [[root], [], [], [{ id: root.id, ownershipEpoch: 1 }]],
      insert: [[createdHold], [createdMember]],
      execute: [[]],
    });

    const result = await taskTreeControlService(harness.db, {
      taskExecutionCancellation: {
        requestRunningTaskInterruptionsInTransaction:
          serviceMocks.requestRunningTaskInterruptionsInTransaction,
        reconcileRequestedCancellations:
          serviceMocks.reconcileRequestedCancellations,
        requestScopeCancellationsInTransaction:
          serviceMocks.requestScopeCancellationsInTransaction,
      },
    }).createHold(
      companyId,
      root.id,
      {
        mode: "pause",
        reason: "operator requested pause",
        actor: {
          actorType: "user",
          actorId: boardUserId,
          userId: boardUserId,
        },
      },
    );

    expect(result.hold).toMatchObject({
      id: createdHold.id,
      mode: "pause",
      status: "active",
      members: [expect.objectContaining({ taskId: root.id, skipped: false })],
    });
    expect(serviceMocks.recordNamedBoardLifecycleCommandInTransaction)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId,
          actorUserId: boardUserId,
          subtype: "tree_control_pause",
          sourceCommandId: createdHold.id,
        }),
      );
    expect(serviceMocks.requestRunningTaskInterruptionsInTransaction)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId,
          taskId: root.id,
          ownershipEpoch: 1,
          reason: "active_subtree_pause_hold",
        }),
      );
    expect(serviceMocks.reconcileRequestedCancellations)
      .toHaveBeenCalledOnce();
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
    expect(harness.remaining("execute")).toBe(0);
    expect(harness.calls.findIndex((call) => call.operation === "execute"))
      .toBeLessThan(harness.calls.findIndex((call) => call.operation === "select"));
  });

  it("releases a hold and records a separate named-board lifecycle command", async () => {
    const rootTaskId = randomUUID();
    const existing = hold({ rootTaskId });
    const released = {
      ...existing,
      status: "released",
      releaseReason: "operator resumed",
      releasedAt: new Date("2026-04-21T11:00:00.000Z"),
    };
    const snapshot = member({ holdId: existing.id, taskId: rootTaskId });
    const harness = createMockDb({
      select: [
        [existing],
        [snapshot],
        [{ id: rootTaskId, ownershipEpoch: 1 }],
        [{ id: rootTaskId, taskNumber: 1 }],
      ],
      update: [[released]],
    });

    const result = await taskTreeControlService(harness.db).releaseHold(
      companyId,
      rootTaskId,
      existing.id,
      {
        reason: "operator resumed",
        actor: {
          actorType: "user",
          actorId: boardUserId,
          userId: boardUserId,
        },
      },
    );

    expect(result).toMatchObject({
      id: existing.id,
      status: "released",
      releaseReason: "operator resumed",
      members: [expect.objectContaining({ taskId: rootTaskId })],
    });
    expect(serviceMocks.recordNamedBoardLifecycleCommandInTransaction)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ subtype: "tree_control_release" }),
      );
  });

  it.each(["cancel", "resume", "restore"] as const)(
    "rejects direct release of a %s hold",
    async (mode) => {
      const rootTaskId = randomUUID();
      const existing = hold({ rootTaskId, mode });
      const harness = createMockDb({ select: [[existing]] });

      await expect(
        taskTreeControlService(harness.db).releaseHold(
          companyId,
          rootTaskId,
          existing.id,
          {
            reason: "invalid direct release",
            actor: {
              actorType: "user",
              actorId: boardUserId,
              userId: boardUserId,
            },
          },
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(harness.calls.some((call) => call.operation === "update"))
        .toBe(false);
    },
  );

  it("allows internal cleanup to release a failed restore command", async () => {
    const rootTaskId = randomUUID();
    const existing = hold({ rootTaskId, mode: "restore" });
    const released = { ...existing, status: "released" };
    const harness = createMockDb({
      select: [[existing], []],
      update: [[released]],
    });

    await expect(taskTreeControlService(harness.db).releaseHold(
      companyId,
      rootTaskId,
      existing.id,
      {
        actor: { actorType: "system", actorId: "restore-cleanup" },
        internal: true,
      },
    )).resolves.toMatchObject({ status: "released", mode: "restore" });
  });

  it("commits a cancel hold, lifecycle update, and execution fence together", async () => {
    const rootTaskId = randomUUID();
    const childTaskId = randomUUID();
    const root = task({ id: rootTaskId, title: "Root" });
    const child = task({
      id: childTaskId,
      parentId: rootTaskId,
      title: "Running child",
    });
    const cancelHold = hold({ rootTaskId, mode: "cancel" });
    const cancelMember = member({
      holdId: cancelHold.id,
      taskId: childTaskId,
      parentTaskId: rootTaskId,
      status: "in_progress",
    });
    const updatedTask = {
      id: childTaskId,
      companyId,
      ownershipEpoch: 1,
      identifier: "TST-2",
      title: "Running child",
      boardPresentationStatus: "cancelled",
      ownerAgentId: null,
    };
    const harness = createMockDb({
      select: [[root], [child], [], []],
      insert: [[cancelHold], [cancelMember]],
      update: [[updatedTask]],
      execute: [[]],
    });

    const result = await taskTreeControlService(harness.db, {
      taskExecutionCancellation: {
        requestRunningTaskInterruptionsInTransaction:
          serviceMocks.requestRunningTaskInterruptionsInTransaction,
        reconcileRequestedCancellations:
          serviceMocks.reconcileRequestedCancellations,
        requestScopeCancellationsInTransaction:
          serviceMocks.requestScopeCancellationsInTransaction,
      },
    })
      .createHold(companyId, rootTaskId, {
        mode: "cancel",
        reason: "cancel subtree",
        actor: {
          actorType: "user",
          actorId: boardUserId,
          userId: boardUserId,
        },
      });

    expect(result.cancelledTaskIds).toEqual([childTaskId]);
    expect(serviceMocks.recordNamedBoardLifecycleCommandInTransaction)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ subtype: "tree_control_cancel" }),
      );
    expect(serviceMocks.requestScopeCancellationsInTransaction)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId,
          taskId: childTaskId,
          selector: { kind: "ownership_epoch", ownershipEpoch: 1 },
          reason: "task_tree_cancelled",
        }),
      );
    expect(serviceMocks.reconcileRequestedCancellations)
      .toHaveBeenCalledOnce();
    expect(harness.calls.findIndex((call) => call.operation === "execute"))
      .toBeLessThan(harness.calls.findIndex((call) => call.operation === "select"));
  });

  it("walks pause-hold ancestry beyond fifteen levels", async () => {
    const taskPath = Array.from({ length: 17 }, () => randomUUID());
    const rootTaskId = taskPath[0]!;
    const descendantTaskId = taskPath.at(-1)!;
    const pauseHold = hold({ rootTaskId });
    const parentRows = taskPath
      .slice(1)
      .reverse()
      .map((currentId) => {
        const currentIndex = taskPath.indexOf(currentId);
        return [{ parentId: taskPath[currentIndex - 1] ?? null }];
      });
    const harness = createMockDb({
      select: [[{
        id: pauseHold.id,
        rootTaskId,
        reason: pauseHold.reason,
        releasePolicy: pauseHold.releasePolicy,
      }], ...parentRows],
    });

    const gate = await taskTreeControlService(harness.db)
      .getActivePauseHoldGate(companyId, descendantTaskId);

    expect(gate).toMatchObject({
      holdId: pauseHold.id,
      rootTaskId,
      taskId: descendantTaskId,
      isRoot: false,
      mode: "pause",
    });
    expect(harness.remaining("select")).toBe(0);
  });

  it("resumes only active pause holds rooted in the selected subtree", async () => {
    const root = task({ title: "Root" });
    const child = task({ parentId: root.id, title: "Child" });
    const paused = hold({ rootTaskId: child.id });
    const resume = hold({ rootTaskId: root.id, mode: "resume", status: "active" });
    const releasedResume = {
      ...resume,
      status: "released",
      releaseReason: "resume subtree",
      releaseMetadata: {
        resumedPauseHoldIds: [paused.id],
        resumeMode: "subtree",
      },
    };
    const rootMember = member({ holdId: resume.id, taskId: root.id });
    const childMember = member({
      holdId: resume.id,
      taskId: child.id,
      parentTaskId: root.id,
    });
    const harness = createMockDb({
      select: [
        [root],
        [child],
        [],
        [],
        [paused],
        [{ taskId: child.id }],
        [{ id: child.id, ownershipEpoch: 1 }],
      ],
      insert: [[resume], [rootMember, childMember]],
      update: [[], [releasedResume]],
    });

    const result = await taskTreeControlService(harness.db).createHold(
      companyId,
      root.id,
      {
        mode: "resume",
        reason: "resume subtree",
        actor: {
          actorType: "user",
          actorId: boardUserId,
          userId: boardUserId,
        },
      },
    );

    expect(result.resumedPauseHoldIds).toEqual([paused.id]);
    expect(result.hold).toMatchObject({
      id: resume.id,
      mode: "resume",
      status: "released",
      members: [
        expect.objectContaining({ taskId: root.id }),
        expect.objectContaining({ taskId: child.id }),
      ],
    });
    expect(serviceMocks.recordNamedBoardLifecycleCommandInTransaction)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          subtype: "tree_control_resume",
          sourceCommandId: resume.id,
        }),
      );
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it("marks restore conflicts from the active cancel snapshot", async () => {
    const root = task({ status: "cancelled" });
    const child = task({
      parentId: root.id,
      status: "cancelled",
      lifecycleStatus: "open",
    });
    const cancelHold = hold({ rootTaskId: root.id, mode: "cancel" });
    const rootSnapshot = member({
      holdId: cancelHold.id,
      taskId: root.id,
      status: "todo",
    });
    const childSnapshot = member({
      holdId: cancelHold.id,
      taskId: child.id,
      parentTaskId: root.id,
      status: "in_progress",
    });
    const harness = createMockDb({
      select: [
        [root],
        [child],
        [],
        [],
        [cancelHold],
        [rootSnapshot, childSnapshot],
        [
          { id: root.id, taskNumber: root.taskNumber },
          { id: child.id, taskNumber: child.taskNumber },
        ],
      ],
    });

    const preview = await taskTreeControlService(harness.db).preview(
      companyId,
      root.id,
      { mode: "restore" },
    );

    expect(preview.tasks.map((row) => [row.id, row.skipReason]))
      .toEqual([
        [root.id, null],
        [child.id, "changed_after_cancel"],
      ]);
    expect(preview.warnings.map((warning) => warning.code))
      .toContain("restore_conflicts_present");
  });
});
