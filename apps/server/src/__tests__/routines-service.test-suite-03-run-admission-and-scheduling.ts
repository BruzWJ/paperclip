import * as t from "./routines-service.test-support.js";
const { describe, it, routine, snapshot, COMPANY_ID, ROUTINE_ID, NOW } = t;
const { createMockDb, ordinaryTasks, service, expect, queryValues, mocks } = t;

describe("routine service contracts without a database", () => {
  describe("run admission and scheduling", () => {
    it("interpolates variables and atomically correlates a fresh execution task", async () => {
      const existing = routine({
        title: "Triage {{repository}}",
        description: "Review {{repository}} at {{priority}} priority",
        variables: [
          {
            name: "repository",
            label: null,
            type: "text",
            defaultValue: null,
            required: true,
            options: [],
          },
          {
            name: "priority",
            label: null,
            type: "select",
            defaultValue: "high",
            required: true,
            options: ["high", "low"],
          },
        ],
      });
      const boundSnapshot = snapshot(existing);
      const createdRun = {
        id: "run-1",
        companyId: COMPANY_ID,
        routineId: ROUTINE_ID,
        triggerId: null,
        source: "api",
        status: "received",
        triggeredAt: NOW,
        idempotencyKey: null,
        triggerPayload: {
          variables: { repository: "paperclip", priority: "high" },
        },
        dispatchFingerprint: "fingerprint-1",
        routineRevisionId: existing.latestRevisionId,
        responsibleUserId: "revision-owner",
        linkedTaskId: null,
        coalescedIntoRunId: null,
        failureReason: null,
        completedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const finalRun = {
        ...createdRun,
        status: "task_created",
        linkedTaskId: "task-created-1",
      };
      const harness = createMockDb({
        select: [
          [existing],
          [{ snapshot: boundSnapshot }],
          [
            {
              pluginKey: "paperclip.routine-source",
              defaultsJson: {
                taskTemplate: {
                  surfaceVisibility: "plugin_operation",
                  originId: "operation:repository-triage",
                },
              },
              manifestJson: { displayName: "Routine Source" },
            },
          ],
          [{ responsibleUserId: "revision-owner", snapshot: boundSnapshot }],
          [],
          [],
        ],
        execute: [[]],
        insert: [[createdRun]],
        update: [[finalRun], []],
      });
      const ordinary = ordinaryTasks();
      ordinary.create.mockImplementationOnce(async (input) => {
        const persisted = {
          task: {
            id: finalRun.linkedTaskId,
            companyId: COMPANY_ID,
          },
          sessionId: "ses-created",
          authorityId: "authority-created",
          ref: { id: "ref-created" },
        };
        await input.correlate(harness.db, persisted);
        return persisted;
      });

      const run = await service(harness, ordinary).service.runRoutine(ROUTINE_ID, {
        source: "api",
        variables: { repository: "paperclip" },
      });

      expect(run).toEqual(finalRun);
      expect(ordinary.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Triage paperclip",
          request: "Review paperclip at high priority",
          ownerAgentId: existing.assigneeAgentId,
          creator: {
            kind: "routine",
            routineId: ROUTINE_ID,
            routineDispatchId: createdRun.id,
          },
          originKind: "plugin:paperclip.routine-source:operation",
          originId: "operation:repository-triage",
          originRunId: createdRun.id,
          responsibleUserId: "revision-owner",
        }),
      );
      expect(queryValues(harness, "insert")[0]).toEqual(
        expect.objectContaining({
          status: "received",
          triggerPayload: createdRun.triggerPayload,
          routineRevisionId: existing.latestRevisionId,
        }),
      );
      expect(harness.remaining("select")).toBe(0);
    });

    it.each([
      "",
      " operation:repository-triage",
      "operation:repository-triage ",
      "operation:\u0000repository-triage",
    ])("rejects persisted non-canonical managed routine originId %j", async (originId) => {
      const existing = routine();
      const harness = createMockDb({
        select: [
          [existing],
          [{ id: existing.latestRevisionId }],
          [
            {
              pluginKey: "paperclip.routine-source",
              defaultsJson: { taskTemplate: { originId } },
              manifestJson: { displayName: "Routine Source" },
            },
          ],
        ],
      });
      const ordinary = ordinaryTasks();

      await expect(
        service(harness, ordinary).service.runRoutine(ROUTINE_ID, {
          source: "api",
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: "Managed routine task template originId is not canonical",
      });
      expect(ordinary.create).not.toHaveBeenCalled();
      expect(harness.remaining("select")).toBe(0);
    });

    it.each([
      ["coalesce_if_active", "coalesced"],
      ["skip_if_active", "skipped"],
    ] as const)(
      "%s resolves a matching live task as %s without creating another task",
      async (concurrencyPolicy, expectedStatus) => {
        const existing = routine({ concurrencyPolicy });
        const boundSnapshot = snapshot(existing);
        const createdRun = {
          id: `run-${expectedStatus}`,
          companyId: COMPANY_ID,
          routineId: ROUTINE_ID,
          source: "api",
          status: "received",
          triggeredAt: NOW,
          responsibleUserId: "board-user",
        };
        const activeTask = {
          id: "task-active",
          companyId: COMPANY_ID,
          lifecycleStatus: "open",
          boardPresentationStatus: "in_progress",
          creatorRoutineDispatchId: "run-active",
        };
        const settledRun = {
          ...createdRun,
          status: expectedStatus,
          linkedTaskId: activeTask.id,
          coalescedIntoRunId: activeTask.creatorRoutineDispatchId,
          completedAt: NOW,
        };
        const harness = createMockDb({
          select: [
            [existing],
            [{ snapshot: boundSnapshot }],
            [],
            [{ responsibleUserId: "board-user", snapshot: boundSnapshot }],
            [activeTask],
          ],
          execute: [[]],
          insert: [[createdRun]],
          update: [[settledRun], []],
        });
        const ordinary = ordinaryTasks();

        await expect(
          service(harness, ordinary).service.runRoutine(ROUTINE_ID, {
            source: "api",
          }),
        ).resolves.toEqual(settledRun);
        expect(ordinary.create).not.toHaveBeenCalled();
        expect(queryValues(harness, "update")[0]).toEqual(
          expect.objectContaining({
            status: expectedStatus,
            linkedTaskId: activeTask.id,
          }),
        );
      },
    );

    it("claims and advances a paused project's due schedule without dispatching", async () => {
      const existing = routine({
        projectId: "project-1",
        catchUpPolicy: "enqueue_missed_with_cap",
      });
      const trigger = {
        id: "schedule-trigger",
        companyId: COMPANY_ID,
        routineId: ROUTINE_ID,
        kind: "schedule",
        enabled: true,
        cronExpression: "*/15 * * * *",
        timezone: "UTC",
        nextRunAt: new Date("2026-07-25T12:00:00.000Z"),
        createdAt: new Date("2026-07-25T10:00:00.000Z"),
      };
      const skippedRun = {
        id: "run-skipped-paused",
        companyId: COMPANY_ID,
        routineId: ROUTINE_ID,
        triggerId: trigger.id,
        source: "schedule",
        status: "skipped",
        failureReason: "paused",
        triggeredAt: NOW,
      };
      const harness = createMockDb({
        select: [[{ trigger, routine: existing, projectPausedAt: NOW }]],
        update: [[{ id: trigger.id }], [], []],
        insert: [[skippedRun]],
      });
      const ordinary = ordinaryTasks();

      await expect(service(harness, ordinary).service.tickScheduledTriggers(NOW)).resolves.toEqual({
        triggered: 0,
      });
      expect(queryValues(harness, "update")[0]).toEqual(
        expect.objectContaining({
          nextRunAt: new Date("2026-07-25T12:15:00.000Z"),
        }),
      );
      expect(queryValues(harness, "insert")[0]).toEqual(
        expect.objectContaining({
          status: "skipped",
          failureReason: "paused",
          linkedTaskId: null,
        }),
      );
      expect(ordinary.create).not.toHaveBeenCalled();
      expect(mocks.logActivity).toHaveBeenCalledWith(
        harness.db,
        expect.objectContaining({
          action: "routine.run_skipped",
          details: expect.objectContaining({ reason: "paused" }),
        }),
      );
    });

    it("suppresses an automatic schedule when worktree execution is disabled in General settings", async () => {
      const existing = routine();
      const trigger = {
        id: "schedule-trigger",
        companyId: COMPANY_ID,
        routineId: ROUTINE_ID,
        kind: "schedule",
        enabled: true,
        cronExpression: "*/15 * * * *",
        timezone: "UTC",
        nextRunAt: new Date("2026-07-25T12:00:00.000Z"),
        createdAt: new Date("2026-07-25T10:00:00.000Z"),
      };
      const skippedRun = {
        id: "run-skipped-worktree",
        companyId: COMPANY_ID,
        routineId: ROUTINE_ID,
        triggerId: trigger.id,
        source: "schedule",
        status: "skipped",
        failureReason: "worktree_execution_cutoff",
        triggeredAt: NOW,
      };
      const harness = createMockDb({
        select: [
          [
            {
              id: "instance-settings",
              singletonKey: "default",
              general: { enableWorktreeRunExecution: false },
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          [{ trigger, routine: existing, projectPausedAt: null }],
        ],
        update: [[{ id: trigger.id }], [], []],
        insert: [[skippedRun]],
      });
      const ordinary = ordinaryTasks();

      await expect(
        service(harness, ordinary, {
          PAPERCLIP_PUBLIC_URL: "https://paperclip.example/",
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-1",
        }).service.tickScheduledTriggers(NOW),
      ).resolves.toEqual({ triggered: 0 });

      expect(queryValues(harness, "insert")[0]).toEqual(
        expect.objectContaining({
          status: "skipped",
          failureReason: "worktree_execution_cutoff",
          linkedTaskId: null,
        }),
      );
      expect(ordinary.create).not.toHaveBeenCalled();
      expect(mocks.logActivity).toHaveBeenCalledWith(
        harness.db,
        expect.objectContaining({
          action: "routine.run_skipped",
          details: expect.objectContaining({
            reason: "worktree_execution_cutoff",
          }),
        }),
      );
      expect(harness.remaining("select")).toBe(0);
    });
  });

  describe("run lifecycle projection", () => {
    it.each([
      ["done", "completed", undefined],
      ["blocked", "failed", "Execution task moved to blocked"],
      ["cancelled", "failed", "Execution task moved to cancelled"],
    ] as const)(
      "maps an execution task in %s to a %s routine run",
      async (boardPresentationStatus, runStatus, failureReason) => {
        const task = {
          id: "task-execution",
          boardPresentationStatus,
          originKind: "routine_execution",
          originRunId: "run-linked",
        };
        const updatedRun = {
          id: task.originRunId,
          status: runStatus,
          failureReason: failureReason ?? null,
        };
        const harness = createMockDb({
          select: [[task]],
          update: [[updatedRun]],
        });

        await expect(service(harness).service.syncRunStatusForTask(task.id)).resolves.toEqual(updatedRun);
        expect(queryValues(harness, "update")[0]).toEqual(
          expect.objectContaining({
            status: runStatus,
            ...(failureReason ? { failureReason } : {}),
            completedAt: NOW,
          }),
        );
      },
    );

    it("ignores a task without canonical routine execution provenance", async () => {
      const harness = createMockDb({
        select: [
          [
            {
              id: "ordinary-task",
              boardPresentationStatus: "done",
              originKind: "manual",
              originRunId: null,
            },
          ],
        ],
      });

      await expect(service(harness).service.syncRunStatusForTask("ordinary-task")).resolves.toBeNull();
      expect(queryValues(harness, "update")).toHaveLength(0);
    });
  });
});
