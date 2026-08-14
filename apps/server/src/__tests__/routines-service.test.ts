import "./routines-service.test-suite-03-run-admission-and-scheduling.js";
import * as t from "./routines-service.test-support.js";
import { createHmac } from "node:crypto";
import { nextCronTickInTimeZone } from "../services/routines.js";
const { describe, it, expect, NOW, routine } = t;
const { creationHarness, service, COMPANY_ID, USER_ACTOR, mocks, queryValues } = t;
const { createMockDb, revision, snapshot, descriptionDocument, ordinaryTasks } = t;
const { ROUTINE_ID, HISTORICAL_REVISION_ID, CALLING_AGENT_ID } = t;

describe("routine service contracts without a database", () => {
  describe("schedule calculation", () => {
    it("preserves custom cron minutes and returns the next zoned tick", () => {
      expect(nextCronTickInTimeZone("7,37 * * * *", "UTC", NOW)).toEqual(
        new Date("2026-07-25T12:37:00.000Z"),
      );
      expect(
        nextCronTickInTimeZone("0 9 * * 1-5", "America/Denver", new Date("2026-07-24T16:00:00.000Z")),
      ).toEqual(new Date("2026-07-27T15:00:00.000Z"));
    });

    it.each([
      ["invalid cron", "61 * * * *", "UTC"],
      ["invalid timezone", "0 * * * *", "Mars/Olympus"],
    ])("rejects an %s before scheduling", (_label, cron, timeZone) => {
      expect(() => nextCronTickInTimeZone(cron, timeZone, NOW)).toThrow();
    });
  });

  describe("creation and revisions", () => {
    it("creates an active routine with revision 1 and validates its owner", async () => {
      const created = routine({
        latestRevisionId: null,
        latestRevisionNumber: 0,
      });
      const { harness, committed } = creationHarness(created);
      const { service: routines } = service(harness);

      await expect(
        routines.create(
          COMPANY_ID,
          {
            projectId: null,
            goalId: null,
            parentTaskId: null,
            title: created.title,
            description: created.description,
            assigneeAgentId: created.assigneeAgentId,
            priority: "medium",
            status: "active",
            concurrencyPolicy: "coalesce_if_active",
            catchUpPolicy: "skip_missed",
          },
          USER_ACTOR,
        ),
      ).resolves.toEqual(committed);
      expect(mocks.resolveOwner).toHaveBeenCalledWith(expect.anything(), {
        companyId: COMPANY_ID,
        ownerAgentId: "agent-owner",
      });
      expect(queryValues(harness, "insert")[0]).toEqual(
        expect.objectContaining({
          companyId: COMPANY_ID,
          status: "active",
          responsibleUserId: USER_ACTOR.userId,
        }),
      );
      expect(queryValues(harness, "insert")[1]).toEqual(
        expect.objectContaining({
          revisionNumber: 1,
          changeSummary: "Created routine",
        }),
      );
      expect(harness.remaining("select")).toBe(0);
    });

    it("canonicalizes an agentless active draft to paused", async () => {
      const created = routine({
        assigneeAgentId: null,
        status: "paused",
        latestRevisionId: null,
        latestRevisionNumber: 0,
      });
      const { harness } = creationHarness(created);

      const result = await service(harness).service.create(
        COMPANY_ID,
        {
          projectId: null,
          goalId: null,
          parentTaskId: null,
          title: created.title,
          description: created.description,
          assigneeAgentId: null,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
        },
        USER_ACTOR,
      );

      expect(result.status).toBe("paused");
      expect(queryValues(harness, "insert")[0]).toEqual(
        expect.objectContaining({
          status: "paused",
          assigneeAgentId: null,
        }),
      );
      expect(mocks.resolveOwner).not.toHaveBeenCalled();
    });

    it("rejects malformed inferred date defaults before persistence", async () => {
      const harness = createMockDb();

      await expect(
        service(harness).service.create(
          COMPANY_ID,
          {
            projectId: null,
            goalId: null,
            parentTaskId: null,
            title: "Review from {{startDate}}",
            description: null,
            assigneeAgentId: null,
            priority: "medium",
            status: "draft",
            concurrencyPolicy: "coalesce_if_active",
            catchUpPolicy: "skip_missed",
            variables: [
              {
                name: "startDate",
                type: "date",
                defaultValue: "2026-02-30",
                required: true,
                options: [],
              },
            ],
          },
          USER_ACTOR,
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(harness.calls).toHaveLength(0);
    });

    it("does not append a revision for a no-op update", async () => {
      const existing = routine();
      const harness = createMockDb({
        select: [[existing], [], [existing]],
        execute: [[]],
      });

      await expect(
        service(harness).service.update(
          existing.id,
          {
            title: existing.title,
            baseRevisionId: existing.latestRevisionId,
          },
          USER_ACTOR,
        ),
      ).resolves.toBe(existing);
      expect(
        harness.calls.filter((call) => ["insert", "update", "delete"].includes(call.operation)),
      ).toHaveLength(0);
    });

    it("rejects a stale base revision before mutation", async () => {
      const existing = routine();
      const harness = createMockDb({
        select: [[existing], [], [existing]],
        execute: [[]],
      });

      await expect(
        service(harness).service.update(
          existing.id,
          {
            title: "Conflicting title",
            baseRevisionId: "99999999-9999-4999-8999-999999999999",
          },
          USER_ACTOR,
        ),
      ).rejects.toMatchObject({
        status: 409,
        details: { currentRevisionId: existing.latestRevisionId },
      });
      expect(queryValues(harness, "update")).toHaveLength(0);
      expect(queryValues(harness, "insert")).toHaveLength(0);
    });

    it("archives through an append-only revision and dispatches structural-loss escalation", async () => {
      const existing = routine();
      const updated = routine({ status: "archived" });
      const appendedRevision = revision(updated, {
        id: "revision-2",
        revisionNumber: 2,
        snapshot: snapshot(updated),
        changeSummary: "Updated routine",
      });
      const committed = routine({
        status: "archived",
        latestRevisionId: appendedRevision.id,
        latestRevisionNumber: 2,
      });
      const harness = createMockDb({
        select: [[existing], [], [existing], [], [], [], [descriptionDocument(existing)]],
        execute: [[]],
        update: [[updated], [committed]],
        insert: [[appendedRevision]],
      });
      mocks.terminalizeRoutineEdges.mockResolvedValueOnce([
        { dispatchRefId: "escalation-ref-1" },
        { dispatchRefId: null },
      ]);
      const ordinary = ordinaryTasks();

      await expect(
        service(harness, ordinary).service.update(
          existing.id,
          {
            status: "archived",
            baseRevisionId: existing.latestRevisionId,
          },
          USER_ACTOR,
        ),
      ).resolves.toEqual(committed);
      expect(mocks.terminalizeRoutineEdges).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Object),
        expect.objectContaining({
          companyId: COMPANY_ID,
          routineId: ROUTINE_ID,
          sourceId: `routine-archived:${ROUTINE_ID}`,
        }),
      );
      expect(ordinary.dispatchRef).toHaveBeenCalledOnce();
      expect(ordinary.dispatchRef).toHaveBeenCalledWith("escalation-ref-1");
      expect(queryValues(harness, "insert")[0]).toEqual(
        expect.objectContaining({
          revisionNumber: 2,
          changeSummary: "Updated routine",
        }),
      );
    });

    it("rejects restoring the current latest revision without writes", async () => {
      const existing = routine();
      const current = revision(existing);
      const harness = createMockDb({
        select: [[existing], [current]],
      });

      await expect(
        service(harness).service.restoreRevision(existing.id, current.id, USER_ACTOR),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        harness.calls.filter((call) => ["insert", "update", "delete", "execute"].includes(call.operation)),
      ).toHaveLength(0);
    });

    it("prevents an agent from restoring a revision assigned to another agent", async () => {
      const existing = routine();
      const targetRoutine = routine({
        assigneeAgentId: "different-agent",
        latestRevisionId: HISTORICAL_REVISION_ID,
      });
      const target = revision(targetRoutine, {
        id: HISTORICAL_REVISION_ID,
        snapshot: snapshot(targetRoutine),
      });
      const harness = createMockDb({
        select: [[existing], [target]],
      });

      await expect(
        service(harness).service.restoreRevision(existing.id, target.id, {
          type: "agent",
          agentId: CALLING_AGENT_ID,
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(mocks.resolveOwner).not.toHaveBeenCalled();
    });
  });
});

describe("routine service contracts without a database", () => {
  describe("trigger contracts", () => {
    it("persists a custom schedule exactly and appends its routine revision", async () => {
      const existing = routine({
        variables: [
          {
            name: "repository",
            label: null,
            type: "text",
            defaultValue: "paperclip",
            required: true,
            options: [],
          },
        ],
      });
      const trigger = {
        id: "trigger-1",
        companyId: COMPANY_ID,
        routineId: ROUTINE_ID,
        kind: "schedule",
        label: "Twice hourly",
        enabled: true,
        cronExpression: "7,37 * * * *",
        timezone: "UTC",
        nextRunAt: new Date("2026-07-25T12:37:00.000Z"),
        publicId: null,
        secretId: null,
        signingMode: null,
        replayWindowSec: null,
        lastRotatedAt: null,
        lastFiredAt: null,
        lastResult: null,
        createdByAgentId: null,
        createdByUserId: "board-user",
        updatedByAgentId: null,
        updatedByUserId: "board-user",
        createdAt: NOW,
        updatedAt: NOW,
      };
      const triggerSnapshot = {
        id: trigger.id,
        kind: trigger.kind,
        label: trigger.label,
        enabled: trigger.enabled,
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
        publicId: null,
        signingMode: null,
        replayWindowSec: null,
      };
      const appendedRevision = revision(existing, {
        id: "revision-2",
        revisionNumber: 2,
        snapshot: snapshot(existing, [triggerSnapshot]),
        changeSummary: "Created schedule trigger",
      });
      const committed = routine({
        ...existing,
        latestRevisionId: appendedRevision.id,
        latestRevisionNumber: 2,
      });
      const harness = createMockDb({
        select: [[existing], [existing], [trigger], [descriptionDocument(existing)]],
        execute: [[]],
        insert: [[trigger], [appendedRevision]],
        update: [[committed]],
      });

      const result = await service(harness).service.createTrigger(
        ROUTINE_ID,
        {
          kind: "schedule",
          label: trigger.label,
          enabled: true,
          cronExpression: trigger.cronExpression,
          timezone: trigger.timezone,
        },
        USER_ACTOR,
      );

      expect(result).toEqual({
        trigger,
        secretMaterial: null,
        revision: appendedRevision,
      });
      expect(queryValues(harness, "insert")[0]).toEqual(
        expect.objectContaining({
          cronExpression: "7,37 * * * *",
          timezone: "UTC",
          nextRunAt: trigger.nextRunAt,
        }),
      );
      expect(queryValues(harness, "insert")[1]).toEqual(expect.objectContaining({ revisionNumber: 2 }));
    });

    it("rejects an enabled schedule when a required variable has no default", async () => {
      const existing = routine({
        variables: [
          {
            name: "repository",
            label: null,
            type: "text",
            defaultValue: null,
            required: true,
            options: [],
          },
        ],
      });
      const harness = createMockDb({ select: [[existing]] });

      await expect(
        service(harness).service.createTrigger(
          ROUTINE_ID,
          {
            kind: "schedule",
            enabled: true,
            cronExpression: "0 * * * *",
            timezone: "UTC",
          },
          USER_ACTOR,
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(
        harness.calls.filter((call) => ["insert", "update", "delete", "execute"].includes(call.operation)),
      ).toHaveLength(0);
    });

    it("rejects a bad GitHub webhook signature before scheduling a run", async () => {
      const trigger = {
        id: "webhook-trigger",
        companyId: COMPANY_ID,
        routineId: ROUTINE_ID,
        kind: "webhook",
        enabled: true,
        publicId: "public-trigger",
        secretId: "secret-1",
        signingMode: "github_hmac",
        replayWindowSec: 300,
      };
      const existing = routine();
      const harness = createMockDb({
        select: [[trigger], [existing], [{ id: trigger.secretId, companyId: COMPANY_ID }]],
      });
      mocks.secrets.resolveSecretValue.mockResolvedValueOnce("top-secret");
      const rawBody = Buffer.from('{"event":"push"}');
      const valid = createHmac("sha256", "top-secret").update(rawBody).digest("hex");

      await expect(
        service(harness).service.firePublicTrigger(trigger.publicId, {
          rawBody,
          signatureHeader: `sha256=${valid.slice(0, -1)}0`,
        }),
      ).rejects.toMatchObject({ status: 401 });
      expect(queryValues(harness, "insert")).toHaveLength(0);
      expect(queryValues(harness, "update")).toHaveLength(0);
    });
  });
});
