import "./tasks-service.test-suite-01-rejects-noncanonical-secondary-task-resource.js";
import * as t from "./tasks-service.test-support.js";
import { createMockDb } from "./helpers/mock-db.js";
import { taskService } from "../services/tasks.js";
import { buildAgentMentionHref, buildProjectMentionHref } from "@paperclipai/shared";
const { describe, it, taskRow, dependencies, taskId, now } = t;
const { companyId, expect, ownerAgentId } = t;

describe("task list, lookup, and mentions", () => {
  it("projects bounded list payloads, current bindings, active runs, and last activity", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000030";
    const runId = "00000000-0000-4000-8000-000000000031";
    const agentId = "00000000-0000-4000-8000-000000000032";
    const request = `${"x".repeat(1199)}— still valid after truncation`;
    // The list query returns a base64-encoded, byte-bounded preview so the
    // service can finish truncation on a Unicode code-point boundary.
    const row = taskRow({
      request: Buffer.from(request, "utf8").toString("base64"),
    });
    const lastCommentAt = new Date("2026-07-30T19:00:00.000Z");
    dependencies.currentOwnerRunLinkages.mockResolvedValue(
      new Map([
        [
          taskId,
          {
            runId,
            runStatus: "running",
            agentId,
            sourceKind: "mention",
            sourceRecordId: "mention-1",
            startedAt: now,
            finishedAt: null,
            createdAt: now,
          },
        ],
      ]),
    );
    const harness = createMockDb({
      select: [
        [row],
        [],
        [
          {
            companyId,
            taskId,
            ownershipEpoch: 1,
            executionWorkspaceId: workspaceId,
          },
        ],
        [{ taskId, latestCommentAt: lastCommentAt }],
        [],
      ],
    });
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
    await expect(
      taskService(counted.db).count(companyId, {
        ownerAgentId: null,
        status: ["todo", "in_progress"],
      }),
    ).resolves.toBe(2);

    for (const operation of ["list", "count"] as const) {
      const harness = createMockDb();
      const service = taskService(harness.db);
      await expect(
        service[operation](companyId, {
          ownerAgentId: "not-a-uuid",
        }),
      ).rejects.toThrow(/ownerAgentId/i);
      expect(harness.calls).toEqual([]);
    }
  });

  it("resolves only structured same-company agent mentions and ignores raw @name text", async () => {
    const localId = "00000000-0000-4000-8000-000000000033";
    const foreignId = "00000000-0000-4000-8000-000000000034";
    const harness = createMockDb({ select: [[{ id: localId }]] });
    const service = taskService(harness.db);

    await expect(
      service.findMentionedAgents(
        companyId,
        [
          `[@Local](${buildAgentMentionHref(localId)})`,
          `[@Foreign](${buildAgentMentionHref(foreignId)})`,
        ].join(" "),
      ),
    ).resolves.toEqual([localId]);
    const raw = createMockDb();
    await expect(
      taskService(raw.db).findMentionedAgents(companyId, "@Local please inspect"),
    ).resolves.toEqual([]);
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

    const bounded = createMockDb({
      select: [[taskMentionRow], [{ id: titleProjectId }]],
    });
    await expect(
      taskService(bounded.db).findMentionedProjectIds(taskId, {
        includeCommentBodies: false,
      }),
    ).resolves.toEqual([titleProjectId]);

    const complete = createMockDb({
      select: [
        [taskMentionRow],
        [
          {
            body: `See [Comment](${buildProjectMentionHref(commentProjectId)})`,
          },
        ],
        [{ id: titleProjectId }, { id: commentProjectId }],
      ],
    });
    await expect(taskService(complete.db).findMentionedProjectIds(taskId)).resolves.toEqual([
      titleProjectId,
      commentProjectId,
    ]);
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

    const taskNumberHarness = createMockDb({
      select: [[row], [], []],
    });
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
        taskService(invalid.db).getByCompanyTaskNumber(companyId, invalidTaskNumber),
      ).resolves.toBeNull();
      expect(invalid.calls).toEqual([]);
    }

    const invalidCompany = createMockDb();
    await expect(taskService(invalidCompany.db).getByCompanyTaskNumber("company-1", 42)).resolves.toBeNull();
    expect(invalidCompany.calls).toEqual([]);

    const duplicate = createMockDb({
      select: [[row, { ...row, id: ownerAgentId }]],
    });
    await expect(taskService(duplicate.db).getByCompanyTaskNumber(companyId, 42)).rejects.toThrow(
      "Task number is not unique within its company",
    );
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
    await expect(
      service.archiveInbox(companyId, taskId, "user-1", archivedAt, {
        archivedByActorType: "agent",
        archivedByAgentId: ownerAgentId,
        archivedByRunId: "run-1",
      }),
    ).resolves.toEqual(archive);
    const values = harness.calls.find((call) => call.operation === "insert" && call.method === "values")
      ?.args[0];
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
    await expect(taskService(unarchive.db).unarchiveInbox(companyId, taskId, "user-1")).resolves.toEqual(
      archive,
    );
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

    const resurfaced = createMockDb({
      select: [[{ taskId, latestCommentAt: activityAt }], [], [archiveRow(olderArchiveAt)]],
    });
    await expect(taskService(resurfaced.db).getActiveInboxArchiveFields(task, "user-1")).resolves.toEqual({});

    const retained = createMockDb({
      select: [[{ taskId, latestCommentAt: activityAt }], [], [archiveRow(newerArchiveAt)]],
    });
    await expect(taskService(retained.db).getActiveInboxArchiveFields(task, "user-1")).resolves.toEqual({
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
    const harness = createMockDb({
      select: [[{ id: anchorId, createdAt: anchorAt }], [comment]],
    });
    const service = taskService(harness.db);

    await expect(
      service.listComments(taskId, {
        afterCommentId: anchorId,
        order: "asc",
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: commentId,
        body: "A later user comment",
      }),
    ]);
    expect(dependencies.getGeneral).toHaveBeenCalledTimes(1);
    expect(harness.remaining("select")).toBe(0);
  });
});
