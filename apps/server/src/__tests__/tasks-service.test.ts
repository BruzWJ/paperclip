import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentMentionHref,
  buildProjectMentionHref,
  MAX_TASK_REQUEST_DEPTH,
} from "@paperclipai/shared";
import {
  InvokableTaskOwnerRejected,
} from "../services/agent-invokability.js";
import {
  deriveTaskUserContext,
  taskService,
  parseStatusFilter,
} from "../services/tasks.js";
import { createMockDb } from "./helpers/mock-db.js";

const dependencies = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  defaultGoal: vi.fn(),
  invokableOwner: vi.fn(),
  syncTask: vi.fn(),
  currentOwnerRunLinkages: vi.fn(),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: dependencies.getGeneral,
  }),
}));

vi.mock("../services/goals.js", () => ({
  getDefaultCompanyGoal: dependencies.defaultGoal,
}));

vi.mock("../services/agent-invokability.js", async () => ({
  ...await vi.importActual<typeof import("../services/agent-invokability.js")>(
    "../services/agent-invokability.js",
  ),
  resolveInvokableTaskOwnerFromDb: dependencies.invokableOwner,
}));

vi.mock("../services/task-references.js", () => ({
  syncTask: dependencies.syncTask,
}));

vi.mock("../services/productive-run-linkage.js", () => ({
  resolveCurrentTaskOwnerRunLinkages: dependencies.currentOwnerRunLinkages,
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const ownerAgentId = "00000000-0000-4000-8000-000000000003";
const goalId = "00000000-0000-4000-8000-000000000004";
const now = new Date("2026-07-30T18:00:00.000Z");

function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: taskId,
    companyId,
    taskNumber: 42,
    identifier: "PC-42",
    title: "Canonical task",
    request: "Canonical task request",
    requestDepth: 0,
    lifecycleStatus: "open",
    boardPresentationStatus: "todo",
    disposition: null,
    priority: "medium",
    parentId: null,
    parentOwnershipEpoch: null,
    projectId: null,
    goalId,
    ownerKind: "user",
    ownerAgentId: null,
    ownerUserId: "user-1",
    ownerAssignmentSource: "user_creator_withdrawal",
    ownershipEpoch: 1,
    creatorKind: "user/board",
    creatorAuthorityId: null,
    creatorAdapterConfigRevisionId: null,
    creatorUserId: "user-1",
    creatorPluginInstallationId: null,
    creatorPluginKey: null,
    creatorCallbackKey: null,
    creatorCallbackVersion: null,
    creatorRoutineId: null,
    creatorRoutineDispatchId: null,
    creatorSystemSourceKind: null,
    creatorSystemSourceId: null,
    originKind: null,
    originId: null,
    hiddenAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setValues(calls: ReturnType<typeof createMockDb>["calls"]) {
  return calls
    .filter((call) => call.operation === "update" && call.method === "set")
    .map((call) => call.args[0] as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
  dependencies.defaultGoal.mockResolvedValue({ id: goalId });
  dependencies.invokableOwner.mockResolvedValue({ owner: {}, revision: {}, revisionId: "revision-1" });
  dependencies.syncTask.mockResolvedValue(undefined);
  dependencies.currentOwnerRunLinkages.mockResolvedValue(new Map());
});

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
    await expect(
      service.getBoardComment(uppercaseUuid, uppercaseUuid, uppercaseUuid),
    ).resolves.toBeNull();
    await expect(
      service.getBoardCommentThread(
        uppercaseUuid,
        uppercaseUuid,
        uppercaseUuid,
      ),
    ).resolves.toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it("accepts only the canonical repeated status representation", () => {
    expect(parseStatusFilter(["todo", "in_progress", "blocked"])).toEqual([
      "todo",
      "in_progress",
      "blocked",
    ]);
    expect(() => parseStatusFilter("todo,in_progress")).toThrow();
    expect(() => parseStatusFilter(["todo", "todo"])).toThrow();
    expect(() => parseStatusFilter("unknown")).toThrow();
    expect(parseStatusFilter(undefined)).toEqual([]);
  });

  it("derives touch and unread state from canonical user activity", () => {
    expect(deriveTaskUserContext({
      creatorUserId: "user-1",
      ownerUserId: null,
      createdAt: "2026-07-30T10:00:00.000Z",
      updatedAt: "2026-07-30T10:00:00.000Z",
    }, "user-1", {
      myLastCommentAt: "2026-07-30T11:00:00.000Z",
      myLastReadAt: "2026-07-30T12:00:00.000Z",
      lastExternalCommentAt: "2026-07-30T13:00:00.000Z",
    })).toEqual({
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
    await expect(service.updateControlState(taskId, { [field]: value } as never))
      .rejects.toThrow(`Task ${field} is immutable or has a dedicated canonical command`);
    expect(harness.calls).toEqual([]);
  });

  it("rejects direct mutation of the execution-workspace binding", async () => {
    const harness = createMockDb();
    const service = taskService(harness.db);
    await expect(service.updateControlState(taskId, {
      executionWorkspaceId: "00000000-0000-4000-8000-000000000012",
    } as never)).rejects.toThrow(
      "executionWorkspaceId is managed by the current task execution workspace binding",
    );
    expect(harness.calls).toEqual([]);
  });

  it("requires an owner before entering in-progress lifecycle", async () => {
    const existing = taskRow({ ownerKind: "board", ownerUserId: null, ownerAssignmentSource: null });
    const harness = createMockDb({ select: [[existing]] });
    const service = taskService(harness.db);

    await expect(service.updateControlState(taskId, {
      boardPresentationStatus: "in_progress",
    })).rejects.toMatchObject({
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
    dependencies.invokableOwner.mockRejectedValue(new InvokableTaskOwnerRejected(
      "Agent is paused",
      "owner_not_invokable:paused",
      { agentStatus: "paused" },
    ));
    const harness = createMockDb({ select: [[existing], []] });
    const service = taskService(harness.db);

    await expect(service.updateControlState(taskId, {
      boardPresentationStatus: "in_progress",
    })).rejects.toMatchObject({
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
    const harness = createMockDb({ select: [[existing], [{ id: blockerId }]] });
    const service = taskService(harness.db);

    await expect(service.updateControlState(taskId, {
      boardPresentationStatus: "in_progress",
      blockedByTaskIds: [blockerId],
    })).rejects.toMatchObject({
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

    await expect(service.updateControlState(taskId, {
      boardPresentationStatus: "done",
      requestDepth: MAX_TASK_REQUEST_DEPTH + 20,
    })).resolves.toMatchObject({
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
    expect(setValues(harness.calls)[0]).toMatchObject({ title: "Renamed task" });
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
      { ...taskRow({ id: childId, parentId: taskId, title: "Child" }), depth: 1 },
      { ...taskRow({ id: grandchildId, parentId: childId, title: "Grandchild" }), depth: 2 },
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
        [{
          taskId: childId,
          blockerTaskId: blockerId,
          blockerStatus: "todo",
          blockerExecutionWorkspaceId: null,
        }],
      ],
      execute: [subtree, [
        blocker,
        { ...blocker, id: secondBlockerId, title: "Overflow blocker", rowNumber: 2 },
      ]],
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
      expect.objectContaining({ id: blockerId, title: "Primary blocker" }),
    ]);
    expect(diagnostics.truncatedDepth).toBe(true);
    expect(diagnostics.truncatedNodes).toBe(false);
    expect(diagnostics.truncatedBlockerTaskIds).toEqual(new Set([childId]));
    expect(diagnostics.caps).toEqual({ maxDepth: 1, maxNodes: 2, maxBlockersPerNode: 1 });
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("execute")).toBe(0);
  });

  it("projects blocked-by and blocking edges into sorted task summaries", async () => {
    const blockerId = "00000000-0000-4000-8000-000000000024";
    const dependentId = "00000000-0000-4000-8000-000000000025";
    const relation = (
      currentTaskId: string,
      relatedId: string,
      title: string,
      taskNumber: number,
    ) => ({
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
    const harness = createMockDb({ select: [
      [{ id: taskId, companyId }],
      [relation(taskId, blockerId, "Blocker", 50)],
      [relation(taskId, dependentId, "Dependent", 51)],
      [],
    ] });
    const service = taskService(harness.db);

    await expect(service.getRelationSummaries(taskId)).resolves.toEqual({
      blockedBy: [expect.objectContaining({ id: blockerId, title: "Blocker" })],
      blocks: [expect.objectContaining({ id: dependentId, title: "Dependent" })],
    });
    expect(harness.remaining("select")).toBe(0);
  });
});

describe("task list, lookup, and mentions", () => {
  it("projects bounded list payloads, current bindings, active runs, and last activity", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000030";
    const runId = "00000000-0000-4000-8000-000000000031";
    const agentId = "00000000-0000-4000-8000-000000000032";
    const request = `${"x".repeat(1199)}— still valid after truncation`;
    // The list query returns a base64-encoded, byte-bounded preview so the
    // service can finish truncation on a Unicode code-point boundary.
    const row = taskRow({ request: Buffer.from(request, "utf8").toString("base64") });
    const lastCommentAt = new Date("2026-07-30T19:00:00.000Z");
    dependencies.currentOwnerRunLinkages.mockResolvedValue(new Map([[taskId, {
      runId,
      runStatus: "running",
      agentId,
      sourceKind: "mention",
      sourceRecordId: "mention-1",
      startedAt: now,
      finishedAt: null,
      createdAt: now,
    }]]));
    const harness = createMockDb({ select: [
      [row],
      [],
      [{ companyId, taskId, ownershipEpoch: 1, executionWorkspaceId: workspaceId }],
      [{ taskId, latestCommentAt: lastCommentAt }],
      [],
    ] });
    const service = taskService(harness.db);

    const [result] = await service.list(companyId, {
      participantAgentId: agentId,
      ownerAgentId: null,
      status: ["todo", "in_progress"],
      limit: 25,
    });

    expect(result).toMatchObject({
      id: taskId,
      request: `${"x".repeat(1199)}—`,
      executionWorkspaceId: workspaceId,
      activeRun: { id: runId, status: "running", agentId },
      lastActivityAt: lastCommentAt,
      labels: [],
    });
    expect(result?.request).toHaveLength(1200);
    expect(harness.remaining("select")).toBe(0);
  });

  it("normalizes count output and rejects malformed owner filters before querying", async () => {
    const counted = createMockDb({ select: [[{ count: "2" }]] });
    await expect(taskService(counted.db).count(companyId, {
      ownerAgentId: null,
      status: ["todo", "in_progress"],
    })).resolves.toBe(2);

    for (const operation of ["list", "count"] as const) {
      const harness = createMockDb();
      const service = taskService(harness.db);
      await expect(service[operation](companyId, { ownerAgentId: "not-a-uuid" }))
        .rejects.toThrow(/ownerAgentId/i);
      expect(harness.calls).toEqual([]);
    }
  });

  it("resolves only structured same-company agent mentions and ignores raw @name text", async () => {
    const localId = "00000000-0000-4000-8000-000000000033";
    const foreignId = "00000000-0000-4000-8000-000000000034";
    const harness = createMockDb({ select: [[{ id: localId }]] });
    const service = taskService(harness.db);

    await expect(service.findMentionedAgents(companyId, [
      `[@Local](${buildAgentMentionHref(localId)})`,
      `[@Foreign](${buildAgentMentionHref(foreignId)})`,
    ].join(" "))).resolves.toEqual([localId]);
    const raw = createMockDb();
    await expect(taskService(raw.db).findMentionedAgents(companyId, "@Local please inspect"))
      .resolves.toEqual([]);
    expect(raw.calls).toEqual([]);
  });

  it("can bound project mention discovery to task fields or include comment bodies", async () => {
    const titleProjectId = "00000000-0000-4000-8000-000000000035";
    const commentProjectId = "00000000-0000-4000-8000-000000000036";
    const taskMentionRow = {
      companyId,
      title: `Link [Title](${buildProjectMentionHref(titleProjectId)})`,
      request: null,
    };

    const bounded = createMockDb({ select: [[taskMentionRow], [{ id: titleProjectId }]] });
    await expect(taskService(bounded.db).findMentionedProjectIds(taskId, {
      includeCommentBodies: false,
    })).resolves.toEqual([titleProjectId]);

    const complete = createMockDb({ select: [
      [taskMentionRow],
      [{ body: `See [Comment](${buildProjectMentionHref(commentProjectId)})` }],
      [{ id: titleProjectId }, { id: commentProjectId }],
    ] });
    await expect(taskService(complete.db).findMentionedProjectIds(taskId))
      .resolves.toEqual([titleProjectId, commentProjectId]);
  });

  it("keeps UUID lookup and company-scoped task-number lookup as separate canonical operations", async () => {
    const row = taskRow({ identifier: "PC1A2-1064" });
    const harness = createMockDb({ select: [[row], [], []] });
    const service = taskService(harness.db);

    await expect(service.getById(taskId)).resolves.toMatchObject({
      id: taskId,
      identifier: "PC1A2-1064",
      labels: [],
    });

    const taskNumberHarness = createMockDb({ select: [[row], [], []] });
    await expect(
      taskService(taskNumberHarness.db).getByCompanyTaskNumber(companyId, 42),
    ).resolves.toMatchObject({
      id: taskId,
      taskNumber: 42,
      labels: [],
    });

    for (const nonUuid of ["PC1A2-1064", "pc1a2-1064", "not-a-uuid"]) {
      const invalid = createMockDb();
      await expect(taskService(invalid.db).getById(nonUuid)).resolves.toBeNull();
      expect(invalid.calls).toEqual([]);
    }

    for (const invalidTaskNumber of [0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = createMockDb();
      await expect(
        taskService(invalid.db).getByCompanyTaskNumber(
          companyId,
          invalidTaskNumber,
        ),
      ).resolves.toBeNull();
      expect(invalid.calls).toEqual([]);
    }

    const invalidCompany = createMockDb();
    await expect(
      taskService(invalidCompany.db).getByCompanyTaskNumber("company-1", 42),
    ).resolves.toBeNull();
    expect(invalidCompany.calls).toEqual([]);

    const duplicate = createMockDb({ select: [[row, { ...row, id: ownerAgentId }]] });
    await expect(
      taskService(duplicate.db).getByCompanyTaskNumber(companyId, 42),
    ).rejects.toThrow("Task number is not unique within its company");
  });
});

describe("task inbox and comment lifecycle", () => {
  it("persists canonical archive attribution and removes it explicitly", async () => {
    const archivedAt = new Date("2026-07-30T20:00:00.000Z");
    const archive = {
      companyId,
      taskId,
      userId: "user-1",
      archivedByActorType: "agent",
      archivedByAgentId: ownerAgentId,
      archivedByRunId: "run-1",
      archivedAt,
      updatedAt: archivedAt,
    };
    const harness = createMockDb({ insert: [[archive]] });
    const service = taskService(harness.db);
    await expect(service.archiveInbox(companyId, taskId, "user-1", archivedAt, {
      archivedByActorType: "agent",
      archivedByAgentId: ownerAgentId,
      archivedByRunId: "run-1",
    })).resolves.toEqual(archive);
    const values = harness.calls.find(
      (call) => call.operation === "insert" && call.method === "values",
    )?.args[0];
    expect(values).toMatchObject({
      companyId,
      taskId,
      userId: "user-1",
      archivedByActorType: "agent",
      archivedByAgentId: ownerAgentId,
      archivedByRunId: "run-1",
      archivedAt,
    });

    const unarchive = createMockDb({ delete: [[archive]] });
    await expect(taskService(unarchive.db).unarchiveInbox(companyId, taskId, "user-1"))
      .resolves.toEqual(archive);
  });

  it("resurfaces an archive after newer task activity but retains a newer archive", async () => {
    const task = {
      id: taskId,
      companyId,
      updatedAt: new Date("2026-07-30T10:00:00.000Z"),
    };
    const activityAt = new Date("2026-07-30T13:00:00.000Z");
    const olderArchiveAt = new Date("2026-07-30T12:00:00.000Z");
    const newerArchiveAt = new Date("2026-07-30T14:00:00.000Z");
    const archiveRow = (archivedAt: Date) => ({
      taskId,
      archivedAt,
      archivedByActorType: "user" as const,
      archivedByAgentId: null,
      archivedByRunId: null,
    });

    const resurfaced = createMockDb({ select: [
      [{ taskId, latestCommentAt: activityAt }],
      [],
      [archiveRow(olderArchiveAt)],
    ] });
    await expect(taskService(resurfaced.db).getActiveInboxArchiveFields(task, "user-1"))
      .resolves.toEqual({});

    const retained = createMockDb({ select: [
      [{ taskId, latestCommentAt: activityAt }],
      [],
      [archiveRow(newerArchiveAt)],
    ] });
    await expect(taskService(retained.db).getActiveInboxArchiveFields(task, "user-1"))
      .resolves.toEqual({
        archivedAt: newerArchiveAt,
        archivedByActorType: "user",
        archivedByAgentId: null,
        archivedByRunId: null,
      });
  });

  it("reads a bounded comment page after its canonical anchor", async () => {
    const anchorId = "00000000-0000-4000-8000-000000000040";
    const commentId = "00000000-0000-4000-8000-000000000041";
    const anchorAt = new Date("2026-07-30T10:00:00.000Z");
    const comment = {
      id: commentId,
      companyId,
      taskId,
      body: "A later user comment",
      authorType: "user",
      authorUserId: "user-1",
      authorAgentId: null,
      authorPluginKey: null,
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-07-30T11:00:00.000Z"),
      updatedAt: new Date("2026-07-30T11:00:00.000Z"),
    };
    const harness = createMockDb({ select: [
      [{ id: anchorId, createdAt: anchorAt }],
      [comment],
    ] });
    const service = taskService(harness.db);

    await expect(service.listComments(taskId, {
      afterCommentId: anchorId,
      order: "asc",
      limit: 10,
    })).resolves.toEqual([
      expect.objectContaining({ id: commentId, body: "A later user comment" }),
    ]);
    expect(dependencies.getGeneral).toHaveBeenCalledTimes(1);
    expect(harness.remaining("select")).toBe(0);
  });
});
