import * as t from "./task-tree-control-service.test-support.js";
const { describe, registerSuiteSetup, it, task, randomUUID, serviceMocks } = t;
const { baseTime, createMockDb, taskTreeControlService, companyId, expect } = t;
const { boardUserId, hold, member } = t;

describe("taskTreeControlService without a database process", () => {
  registerSuiteSetup();

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
    serviceMocks.resolveCurrentTaskOwnerRunLinkages.mockResolvedValue(
      new Map([
        [
          runningChild.id,
          {
            runId,
            taskId: runningChild.id,
            agentId,
            startedAt: baseTime,
            createdAt: baseTime,
          },
        ],
      ]),
    );
    const harness = createMockDb({
      select: [[root], [runningChild, doneChild], [], []],
    });

    const preview = await taskTreeControlService(harness.db).preview(companyId, root.id, { mode: "pause" });

    expect(preview.tasks.map((row) => [row.id, row.depth, row.skipReason])).toEqual([
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
    expect(preview.warnings.map((warning) => warning.code)).toContain("running_runs_present");
    expect(harness.calls.some((call) => call.operation !== "select")).toBe(false);
  });

  it("keeps human-owned work static with no affected agent execution", async () => {
    const root = task({
      title: "Human validation",
      status: "in_progress",
      ownerUserId: boardUserId,
    });
    const harness = createMockDb({ select: [[root], [], []] });

    const preview = await taskTreeControlService(harness.db).preview(companyId, root.id, { mode: "pause" });

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

    const preview = await taskTreeControlService(harness.db).preview(companyId, reopened.id, {
      mode: "cancel",
    });

    expect(preview.tasks).toEqual([
      expect.objectContaining({
        id: reopened.id,
        skipReason: null,
      }),
    ]);
    expect(preview.totals).toMatchObject({
      affectedTasks: 1,
      skippedTasks: 0,
    });
  });

  it("fails closed when the root is outside the requested company", async () => {
    const harness = createMockDb({ select: [[]] });

    await expect(
      taskTreeControlService(harness.db).preview(companyId, randomUUID(), {
        mode: "pause",
      }),
    ).rejects.toMatchObject({ status: 404 });

    expect(harness.remaining("select")).toBe(0);
  });

  it("creates a normalized pause snapshot and records the named-board command", async () => {
    const root = task({ ownerUserId: boardUserId });
    const createdHold = hold({ rootTaskId: root.id });
    const createdMember = member({
      holdId: createdHold.id,
      taskId: root.id,
    });
    const harness = createMockDb({
      select: [[root], [], [], [{ id: root.id, ownershipEpoch: 1 }]],
      insert: [[createdHold], [createdMember]],
      execute: [[]],
    });

    const result = await taskTreeControlService(harness.db, {
      taskExecutionCancellation: {
        requestRunningTaskInterruptionsInTransaction:
          serviceMocks.requestRunningTaskInterruptionsInTransaction,
        reconcileRequestedCancellations: serviceMocks.reconcileRequestedCancellations,
        requestScopeCancellationsInTransaction: serviceMocks.requestScopeCancellationsInTransaction,
      },
    }).createHold(companyId, root.id, {
      mode: "pause",
      reason: "operator requested pause",
      actor: {
        actorType: "user",
        actorId: boardUserId,
        userId: boardUserId,
      },
    });

    expect(result.hold).toMatchObject({
      id: createdHold.id,
      mode: "pause",
      status: "active",
      members: [
        expect.objectContaining({
          taskId: root.id,
          skipped: false,
        }),
      ],
    });
    expect(serviceMocks.recordNamedBoardLifecycleCommandInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorUserId: boardUserId,
        subtype: "tree_control_pause",
        sourceCommandId: createdHold.id,
      }),
    );
    expect(serviceMocks.requestRunningTaskInterruptionsInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        taskId: root.id,
        ownershipEpoch: 1,
        reason: "active_subtree_pause_hold",
      }),
    );
    expect(serviceMocks.reconcileRequestedCancellations).toHaveBeenCalledOnce();
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
    expect(harness.remaining("execute")).toBe(0);
    expect(harness.calls.findIndex((call) => call.operation === "execute")).toBeLessThan(
      harness.calls.findIndex((call) => call.operation === "select"),
    );
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
    const snapshot = member({
      holdId: existing.id,
      taskId: rootTaskId,
    });
    const harness = createMockDb({
      select: [
        [existing],
        [snapshot],
        [{ id: rootTaskId, ownershipEpoch: 1 }],
        [{ id: rootTaskId, taskNumber: 1 }],
      ],
      update: [[released]],
    });

    const result = await taskTreeControlService(harness.db).releaseHold(companyId, rootTaskId, existing.id, {
      reason: "operator resumed",
      actor: {
        actorType: "user",
        actorId: boardUserId,
        userId: boardUserId,
      },
    });

    expect(result).toMatchObject({
      id: existing.id,
      status: "released",
      releaseReason: "operator resumed",
      members: [expect.objectContaining({ taskId: rootTaskId })],
    });
    expect(serviceMocks.recordNamedBoardLifecycleCommandInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subtype: "tree_control_release",
      }),
    );
  });

  it.each(["cancel", "resume", "restore"] as const)("rejects direct release of a %s hold", async (mode) => {
    const rootTaskId = randomUUID();
    const existing = hold({ rootTaskId, mode });
    const harness = createMockDb({ select: [[existing]] });

    await expect(
      taskTreeControlService(harness.db).releaseHold(companyId, rootTaskId, existing.id, {
        reason: "invalid direct release",
        actor: {
          actorType: "user",
          actorId: boardUserId,
          userId: boardUserId,
        },
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("allows internal cleanup to release a failed restore command", async () => {
    const rootTaskId = randomUUID();
    const existing = hold({ rootTaskId, mode: "restore" });
    const released = { ...existing, status: "released" };
    const harness = createMockDb({
      select: [[existing], []],
      update: [[released]],
    });

    await expect(
      taskTreeControlService(harness.db).releaseHold(companyId, rootTaskId, existing.id, {
        actor: { actorType: "system", actorId: "restore-cleanup" },
        internal: true,
      }),
    ).resolves.toMatchObject({ status: "released", mode: "restore" });
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
        reconcileRequestedCancellations: serviceMocks.reconcileRequestedCancellations,
        requestScopeCancellationsInTransaction: serviceMocks.requestScopeCancellationsInTransaction,
      },
    }).createHold(companyId, rootTaskId, {
      mode: "cancel",
      reason: "cancel subtree",
      actor: {
        actorType: "user",
        actorId: boardUserId,
        userId: boardUserId,
      },
    });

    expect(result.cancelledTaskIds).toEqual([childTaskId]);
    expect(serviceMocks.recordNamedBoardLifecycleCommandInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subtype: "tree_control_cancel",
      }),
    );
    expect(serviceMocks.requestScopeCancellationsInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        taskId: childTaskId,
        selector: { kind: "ownership_epoch", ownershipEpoch: 1 },
        reason: "task_tree_cancelled",
        nativeContinuity: "preserve_carry",
      }),
    );
    expect(serviceMocks.reconcileRequestedCancellations).toHaveBeenCalledOnce();
    expect(harness.calls.findIndex((call) => call.operation === "execute")).toBeLessThan(
      harness.calls.findIndex((call) => call.operation === "select"),
    );
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
      select: [
        [
          {
            id: pauseHold.id,
            rootTaskId,
            reason: pauseHold.reason,
            releasePolicy: pauseHold.releasePolicy,
          },
        ],
        ...parentRows,
      ],
    });

    const gate = await taskTreeControlService(harness.db).getActivePauseHoldGate(companyId, descendantTaskId);

    expect(gate).toMatchObject({
      holdId: pauseHold.id,
      rootTaskId,
      taskId: descendantTaskId,
      isRoot: false,
      mode: "pause",
    });
    expect(harness.remaining("select")).toBe(0);
  });
});
