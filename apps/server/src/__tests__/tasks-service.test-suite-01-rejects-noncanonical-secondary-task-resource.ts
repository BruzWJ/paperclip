import * as t from "./tasks-service.test-support.js";
import { createMockDb } from "./helpers/mock-db.js";
import { InvokableTaskOwnerRejected } from "../services/agent-invokability.js";
import { deriveTaskUserContext, parseStatusFilter, taskService } from "../services/tasks.js";
import { MAX_TASK_REQUEST_DEPTH } from "@paperclipai/shared";
const {
  describe,
  it,
  expect,
  ownerAgentId,
  taskId,
  taskRow,
  dependencies,
  now,
  setValues,
  companyId,
  goalId,
} = t;

describe("task service pure contracts", () => {
  it("rejects noncanonical secondary task resource UUIDs before DB access", async () => {
    const harness = createMockDb();
    const service = taskService(harness.db);
    const uppercaseUuid = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";

    await expect(service.getLabelById(uppercaseUuid)).resolves.toBeNull();
    await expect(service.deleteLabel(uppercaseUuid)).resolves.toBeNull();
    await expect(service.getComment(uppercaseUuid)).resolves.toBeNull();
    await expect(service.getAttachmentById(uppercaseUuid)).resolves.toBeNull();
    await expect(service.removeAttachment(uppercaseUuid)).resolves.toBeNull();
    await expect(service.getBoardComment(uppercaseUuid, uppercaseUuid, uppercaseUuid)).resolves.toBeNull();
    await expect(
      service.getBoardCommentThread(uppercaseUuid, uppercaseUuid, uppercaseUuid),
    ).resolves.toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it("accepts only the canonical repeated status representation", () => {
    expect(parseStatusFilter(["todo", "in_progress", "blocked"])).toEqual(["todo", "in_progress", "blocked"]);
    expect(() => parseStatusFilter("todo,in_progress")).toThrow();
    expect(() => parseStatusFilter(["todo", "todo"])).toThrow();
    expect(() => parseStatusFilter("unknown")).toThrow();
    expect(parseStatusFilter(undefined)).toEqual([]);
  });

  it("derives touch and unread state from canonical user activity", () => {
    expect(
      deriveTaskUserContext(
        {
          creatorUserId: "user-1",
          ownerUserId: null,
          createdAt: "2026-07-30T10:00:00.000Z",
          updatedAt: "2026-07-30T10:00:00.000Z",
        },
        "user-1",
        {
          myLastCommentAt: "2026-07-30T11:00:00.000Z",
          myLastReadAt: "2026-07-30T12:00:00.000Z",
          lastExternalCommentAt: "2026-07-30T13:00:00.000Z",
        },
      ),
    ).toEqual({
      myLastTouchAt: new Date("2026-07-30T12:00:00.000Z"),
      lastExternalCommentAt: new Date("2026-07-30T13:00:00.000Z"),
      isUnreadForMe: true,
    });
  });
});

describe("task ownership and lifecycle mutation", () => {
  it.each([
    ["ownerAgentId", ownerAgentId],
    ["ownerKind", "agent"],
    ["ownershipEpoch", 2],
    ["parentId", "00000000-0000-4000-8000-000000000099"],
    ["parentOwnershipEpoch", 2],
    ["request", "replacement request"],
    ["creatorUserId", "user-2"],
    ["lifecycleStatus", "cancelled"],
    ["disposition", { message: "replacement disposition" }],
    ["completedAt", new Date("2026-07-30T12:00:00.000Z")],
    ["cancelledAt", new Date("2026-07-30T12:00:00.000Z")],
  ])("rejects direct mutation of canonical %s", async (field, value) => {
    const harness = createMockDb();
    const service = taskService(harness.db);
    await expect(
      service.updateControlState(taskId, {
        [field]: value,
      } as never),
    ).rejects.toThrow(`Task ${field} is immutable or has a dedicated canonical command`);
    expect(harness.calls).toEqual([]);
  });

  it("rejects direct mutation of the execution-workspace binding", async () => {
    const harness = createMockDb();
    const service = taskService(harness.db);
    await expect(
      service.updateControlState(taskId, {
        executionWorkspaceId: "00000000-0000-4000-8000-000000000012",
      } as never),
    ).rejects.toThrow("executionWorkspaceId is managed by the current task execution workspace binding");
    expect(harness.calls).toEqual([]);
  });

  it("requires an owner before entering in-progress lifecycle", async () => {
    const existing = taskRow({
      ownerKind: "board",
      ownerUserId: null,
      ownerAssignmentSource: null,
    });
    const harness = createMockDb({ select: [[existing]] });
    const service = taskService(harness.db);

    await expect(
      service.updateControlState(taskId, {
        boardPresentationStatus: "in_progress",
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "in_progress tasks require an owner",
    });
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("requires an assigned agent to remain invokable before entering in-progress", async () => {
    const existing = taskRow({
      ownerKind: "agent",
      ownerAgentId,
      ownerUserId: null,
      ownerAssignmentSource: "mention",
    });
    dependencies.invokableOwner.mockRejectedValue(
      new InvokableTaskOwnerRejected("Agent is paused", "owner_not_invokable:paused", {
        agentStatus: "paused",
      }),
    );
    const harness = createMockDb({ select: [[existing], []] });
    const service = taskService(harness.db);

    await expect(
      service.updateControlState(taskId, {
        boardPresentationStatus: "in_progress",
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "task_owner_not_invokable",
        reason: "owner_not_invokable:paused",
        ownerAgentId,
      },
    });
    expect(dependencies.invokableOwner).toHaveBeenCalledWith(harness.db, {
      companyId,
      ownerAgentId,
    });
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("does not enter in-progress while explicit blockers remain unresolved", async () => {
    const blockerId = "00000000-0000-4000-8000-000000000013";
    const existing = taskRow();
    const harness = createMockDb({
      select: [[existing], [{ id: blockerId }]],
    });
    const service = taskService(harness.db);

    await expect(
      service.updateControlState(taskId, {
        boardPresentationStatus: "in_progress",
        blockedByTaskIds: [blockerId],
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { unresolvedBlockerTaskIds: [blockerId] },
    });
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("applies terminal lifecycle timestamps and clamps request depth", async () => {
    const existing = taskRow();
    const updated = taskRow({
      boardPresentationStatus: "done",
      lifecycleStatus: "done",
      requestDepth: MAX_TASK_REQUEST_DEPTH,
      completedAt: now,
      updatedAt: now,
    });
    const harness = createMockDb({
      select: [[existing], [], []],
      update: [[updated]],
    });
    const service = taskService(harness.db);

    await expect(
      service.updateControlState(taskId, {
        boardPresentationStatus: "done",
        requestDepth: MAX_TASK_REQUEST_DEPTH + 20,
      }),
    ).resolves.toMatchObject({
      id: taskId,
      boardPresentationStatus: "done",
      labels: [],
      executionWorkspaceId: null,
    });

    expect(setValues(harness.calls)[0]).toMatchObject({
      boardPresentationStatus: "done",
      requestDepth: MAX_TASK_REQUEST_DEPTH,
      cancelledAt: null,
      goalId,
    });
    expect(setValues(harness.calls)[0]?.completedAt).toBeInstanceOf(Date);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it("updates title only through its dedicated command and synchronizes the task ref", async () => {
    const updated = taskRow({ title: "Renamed task" });
    const harness = createMockDb({
      select: [[], [], []],
      update: [[updated]],
    });
    const service = taskService(harness.db);

    await expect(service.updateTitle(taskId, "Renamed task")).resolves.toMatchObject({
      id: taskId,
      title: "Renamed task",
      labels: [],
    });
    expect(setValues(harness.calls)[0]).toMatchObject({
      title: "Renamed task",
    });
    expect(dependencies.syncTask).toHaveBeenCalledWith(taskId, harness.db);
  });
});

describe("task hierarchy and dependency diagnostics", () => {
  it("returns a bounded subtree with blocker readiness and per-node truncation", async () => {
    const childId = "00000000-0000-4000-8000-000000000020";
    const grandchildId = "00000000-0000-4000-8000-000000000021";
    const blockerId = "00000000-0000-4000-8000-000000000022";
    const secondBlockerId = "00000000-0000-4000-8000-000000000023";
    const subtree = [
      { ...taskRow(), depth: 0 },
      {
        ...taskRow({
          id: childId,
          parentId: taskId,
          title: "Child",
        }),
        depth: 1,
      },
      {
        ...taskRow({
          id: grandchildId,
          parentId: childId,
          title: "Grandchild",
        }),
        depth: 2,
      },
    ];
    const blocker = {
      id: blockerId,
      companyId,
      projectId: null,
      parentId: null,
      taskNumber: 50,
      identifier: "PC-50",
      title: "Primary blocker",
      boardPresentationStatus: "todo",
      priority: "high",
      ownerAgentId: null,
      ownerUserId: "user-2",
      blockedTaskId: childId,
      relationCreatedAt: now,
      rowNumber: 1,
    };
    const harness = createMockDb({
      select: [
        [{ id: taskId, companyId }],
        [
          {
            taskId: childId,
            blockerTaskId: blockerId,
            blockerStatus: "todo",
            blockerExecutionWorkspaceId: null,
          },
        ],
      ],
      execute: [
        subtree,
        [
          blocker,
          {
            ...blocker,
            id: secondBlockerId,
            title: "Overflow blocker",
            rowNumber: 2,
          },
        ],
      ],
    });
    const service = taskService(harness.db);

    const diagnostics = await service.getSubtreeDiagnostics(taskId, {
      maxDepth: 1,
      maxNodes: 2,
      maxBlockersPerNode: 1,
    });

    expect(diagnostics.nodes.map((node) => node.id)).toEqual([taskId, childId]);
    expect(diagnostics.readinessByTaskId.get(childId)).toMatchObject({
      blockerTaskIds: [blockerId],
      unresolvedBlockerTaskIds: [blockerId],
      isDependencyReady: false,
    });
    expect(diagnostics.blockersByTaskId.get(childId)).toEqual([
      expect.objectContaining({
        id: blockerId,
        title: "Primary blocker",
      }),
    ]);
    expect(diagnostics.truncatedDepth).toBe(true);
    expect(diagnostics.truncatedNodes).toBe(false);
    expect(diagnostics.truncatedBlockerTaskIds).toEqual(new Set([childId]));
    expect(diagnostics.caps).toEqual({
      maxDepth: 1,
      maxNodes: 2,
      maxBlockersPerNode: 1,
    });
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("execute")).toBe(0);
  });

  it("projects blocked-by and blocking edges into sorted task summaries", async () => {
    const blockerId = "00000000-0000-4000-8000-000000000024";
    const dependentId = "00000000-0000-4000-8000-000000000025";
    const relation = (currentTaskId: string, relatedId: string, title: string, taskNumber: number) => ({
      currentTaskId,
      relatedId,
      taskNumber,
      identifier: `PC-${taskNumber}`,
      title,
      boardPresentationStatus: "todo",
      priority: "medium",
      ownerAgentId: null,
      ownerUserId: "user-1",
    });
    const harness = createMockDb({
      select: [
        [{ id: taskId, companyId }],
        [relation(taskId, blockerId, "Blocker", 50)],
        [relation(taskId, dependentId, "Dependent", 51)],
        [],
      ],
    });
    const service = taskService(harness.db);

    await expect(service.getRelationSummaries(taskId)).resolves.toEqual({
      blockedBy: [
        expect.objectContaining({
          id: blockerId,
          title: "Blocker",
        }),
      ],
      blocks: [
        expect.objectContaining({
          id: dependentId,
          title: "Dependent",
        }),
      ],
    });
    expect(harness.remaining("select")).toBe(0);
  });
});
