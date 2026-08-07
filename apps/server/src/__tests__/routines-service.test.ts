import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockDb as createQueuedMockDb,
  type MockDbHarness,
  type MockDbPlan,
} from "./helpers/mock-db.js";

const mocks = vi.hoisted(() => ({
  resolveOwner: vi.fn(),
  terminalizeRoutineEdges: vi.fn(),
  logActivity: vi.fn(),
  secrets: {
    normalizeEnvBindingsForPersistence: vi.fn(),
    syncEnvBindingsForTarget: vi.fn(),
    createBound: vi.fn(),
    remove: vi.fn(),
    rotate: vi.fn(),
    resolveSecretValue: vi.fn(),
  },
}));

vi.mock("../services/agent-invokability.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../services/agent-invokability.js")
  >();
  return {
    ...actual,
    resolveInvokableIssueOwnerInTransaction: mocks.resolveOwner,
  };
});

vi.mock(
  "../services/system-escalation-postgres.js",
  async (importActual) => {
    const actual = await importActual<
      typeof import("../services/system-escalation-postgres.js")
    >();
    return {
      ...actual,
      terminalizeRoutineCreatorEdgesInTransaction:
        mocks.terminalizeRoutineEdges,
    };
  },
);

vi.mock("../services/issue-session/admission.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../services/issue-session/admission.js")
  >();
  return {
    ...actual,
    createIssueSessionAdmissionService: vi.fn(() => ({})),
  };
});

vi.mock("../services/secrets.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../services/secrets.js")
  >();
  return {
    ...actual,
    secretService: vi.fn(() => mocks.secrets),
  };
});

vi.mock("../services/activity-log.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../services/activity-log.js")
  >();
  return { ...actual, logActivity: mocks.logActivity };
});

vi.mock("../telemetry.js", async (importActual) => {
  const actual = await importActual<typeof import("../telemetry.js")>();
  return { ...actual, getTelemetryClient: vi.fn(() => null) };
});

import {
  nextCronTickInTimeZone,
  routineService,
} from "../services/routines.js";

const COMPANY_ID = "company-1";
const ROUTINE_ID = "routine-1";
const USER_ACTOR = { type: "user", userId: "board-user" } as const;
const NOW = new Date("2026-07-25T12:08:00.000Z");

/**
 * Routines deliberately distinguish a root Db from its transaction executor
 * when deciding whether to open a nested transaction. Keep those identities
 * distinct while delegating every operation to the same deterministic queues.
 */
function createMockDb(plan: MockDbPlan = {}): MockDbHarness {
  const harness = createQueuedMockDb(plan);
  let transactionDb: typeof harness.db;
  transactionDb = new Proxy(harness.db, {
    get(target, property) {
      if (property === "transaction") {
        return vi.fn(async (callback: (tx: typeof harness.db) => unknown) =>
          callback(transactionDb));
      }
      return Reflect.get(target, property);
    },
  });
  const rootDb = new Proxy(harness.db, {
    get(target, property) {
      if (property === "transaction") {
        return vi.fn(async (callback: (tx: typeof harness.db) => unknown) =>
          callback(transactionDb));
      }
      return Reflect.get(target, property);
    },
  });
  return { ...harness, db: rootDb };
}

function routine(overrides: Record<string, unknown> = {}) {
  return {
    id: ROUTINE_ID,
    companyId: COMPANY_ID,
    projectId: null,
    folderId: null,
    goalId: null,
    parentIssueId: null,
    title: "Repository triage",
    description: "Review the repository",
    assigneeAgentId: "agent-owner",
    priority: "medium",
    contextAccessMask: null,
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    activityGatePolicy: "always",
    activityGateScope: "company",
    variables: [],
    env: null,
    responsibleUserId: "board-user",
    originKind: "manual",
    originId: null,
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    createdByAgentId: null,
    createdByUserId: "board-user",
    updatedByAgentId: null,
    updatedByUserId: "board-user",
    createdAt: new Date("2026-07-25T10:00:00.000Z"),
    updatedAt: new Date("2026-07-25T10:00:00.000Z"),
    ...overrides,
  };
}

function snapshot(row: ReturnType<typeof routine>, triggers: unknown[] = []) {
  return {
    version: 1 as const,
    routine: {
      id: row.id,
      companyId: row.companyId,
      projectId: row.projectId,
      goalId: row.goalId,
      parentIssueId: row.parentIssueId,
      title: row.title,
      description: row.description,
      assigneeAgentId: row.assigneeAgentId,
      priority: row.priority,
      contextAccessMask: row.contextAccessMask,
      status: row.status,
      concurrencyPolicy: row.concurrencyPolicy,
      catchUpPolicy: row.catchUpPolicy,
      variables: row.variables,
      env: row.env,
      responsibleUserId: row.responsibleUserId,
    },
    triggers,
  };
}

function revision(
  row: ReturnType<typeof routine>,
  overrides: Record<string, unknown> = {},
) {
  const revisionNumber = Number(
    overrides.revisionNumber ?? row.latestRevisionNumber,
  );
  return {
    id: `revision-${revisionNumber}`,
    companyId: row.companyId,
    routineId: row.id,
    revisionNumber,
    title: row.title,
    description: row.description,
    snapshot: snapshot(row),
    changeSummary: null,
    restoredFromRevisionId: null,
    createdByAgentId: null,
    createdByUserId: "board-user",
    createdByRunId: null,
    responsibleUserId: row.responsibleUserId,
    createdAt: NOW,
    ...overrides,
  };
}

function descriptionDocument(row: ReturnType<typeof routine>) {
  return {
    id: "document-1",
    companyId: row.companyId,
    routineId: row.id,
    key: "description",
    title: "Routine description",
    format: "markdown",
    latestBody: row.description ?? "",
    latestRevisionId: "document-revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "board-user",
    updatedByAgentId: null,
    updatedByUserId: "board-user",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function ordinaryIssues() {
  return {
    create: vi.fn(),
    dispatchRef: vi.fn().mockResolvedValue(undefined),
  };
}

function service(
  harness: MockDbHarness,
  ordinary = ordinaryIssues(),
  runtimeEnv: Record<string, string | undefined> = {
    PAPERCLIP_PUBLIC_URL: "https://paperclip.example/",
  },
) {
  return {
    ordinary,
    service: routineService(harness.db, {
      runtimeEnv,
      ordinaryIssues: ordinary as never,
    }),
  };
}

function queryValues(harness: MockDbHarness, operation: "insert" | "update") {
  const valueMethod = operation === "insert" ? "values" : "set";
  return harness.calls
    .filter(
      (call) => call.operation === operation && call.method === valueMethod,
    )
    .map((call) => call.args[0]);
}

function creationHarness(created: ReturnType<typeof routine>) {
  const createdRevision = revision(created, {
    id: "revision-1",
    revisionNumber: 1,
    snapshot: snapshot(created),
    changeSummary: "Created routine",
  });
  const committed = {
    ...created,
    latestRevisionId: createdRevision.id,
    latestRevisionNumber: 1,
  };
  const document = {
    id: "document-1",
    companyId: created.companyId,
    title: "Routine description",
    format: "markdown",
    latestBody: created.description ?? "",
    latestRevisionId: null,
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "board-user",
    updatedByAgentId: null,
    updatedByUserId: "board-user",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const documentRevision = {
    id: "document-revision-1",
    documentId: document.id,
  };
  return {
    committed,
    harness: createMockDb({
      select: [[], []],
      insert: [
        [created],
        [createdRevision],
        [document],
        [documentRevision],
        [],
      ],
      update: [[committed], []],
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.resolveOwner.mockReset();
  mocks.terminalizeRoutineEdges.mockReset();
  mocks.logActivity.mockReset();
  for (const candidate of Object.values(mocks.secrets)) candidate.mockReset();
  mocks.resolveOwner.mockResolvedValue({ revisionId: "agent-revision-1" });
  mocks.terminalizeRoutineEdges.mockResolvedValue([]);
  mocks.logActivity.mockResolvedValue(undefined);
  mocks.secrets.normalizeEnvBindingsForPersistence.mockImplementation(
    async (_companyId, env) => env,
  );
  mocks.secrets.syncEnvBindingsForTarget.mockResolvedValue(undefined);
  mocks.secrets.remove.mockResolvedValue(undefined);
  mocks.secrets.rotate.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("routine service contracts without a database", () => {
  describe("schedule calculation", () => {
    it("preserves custom cron minutes and returns the next zoned tick", () => {
      expect(
        nextCronTickInTimeZone("7,37 * * * *", "UTC", NOW),
      ).toEqual(new Date("2026-07-25T12:37:00.000Z"));
      expect(
        nextCronTickInTimeZone(
          "0 9 * * 1-5",
          "America/Denver",
          new Date("2026-07-24T16:00:00.000Z"),
        ),
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
            parentIssueId: null,
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
          parentIssueId: null,
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
        expect.objectContaining({ status: "paused", assigneeAgentId: null }),
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
            parentIssueId: null,
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
          { title: existing.title },
          USER_ACTOR,
        ),
      ).resolves.toBe(existing);
      expect(
        harness.calls.filter((call) =>
          ["insert", "update", "delete"].includes(call.operation),
        ),
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
            baseRevisionId: "stale-revision",
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
        select: [
          [existing],
          [],
          [existing],
          [],
          [],
          [],
          [descriptionDocument(existing)],
        ],
        execute: [[]],
        update: [[updated], [committed]],
        insert: [[appendedRevision]],
      });
      mocks.terminalizeRoutineEdges.mockResolvedValueOnce([
        { dispatchRefId: "escalation-ref-1" },
        { dispatchRefId: null },
      ]);
      const ordinary = ordinaryIssues();

      await expect(
        service(harness, ordinary).service.update(
          existing.id,
          { status: "archived", baseRevisionId: existing.latestRevisionId },
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
      const harness = createMockDb({ select: [[existing], [current]] });

      await expect(
        service(harness).service.restoreRevision(
          existing.id,
          current.id,
          USER_ACTOR,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        harness.calls.filter((call) =>
          ["insert", "update", "delete", "execute"].includes(call.operation),
        ),
      ).toHaveLength(0);
    });

    it("prevents an agent from restoring a revision assigned to another agent", async () => {
      const existing = routine();
      const targetRoutine = routine({
        assigneeAgentId: "different-agent",
        latestRevisionId: "historical-revision",
      });
      const target = revision(targetRoutine, {
        id: "historical-revision",
        snapshot: snapshot(targetRoutine),
      });
      const harness = createMockDb({ select: [[existing], [target]] });

      await expect(
        service(harness).service.restoreRevision(
          existing.id,
          target.id,
          { type: "agent", agentId: "calling-agent" },
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(mocks.resolveOwner).not.toHaveBeenCalled();
    });
  });

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
        select: [
          [existing],
          [existing],
          [trigger],
          [descriptionDocument(existing)],
        ],
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
      expect(queryValues(harness, "insert")[1]).toEqual(
        expect.objectContaining({ revisionNumber: 2 }),
      );
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
        harness.calls.filter((call) =>
          ["insert", "update", "delete", "execute"].includes(call.operation),
        ),
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
        select: [
          [trigger],
          [existing],
          [{ id: trigger.secretId, companyId: COMPANY_ID }],
        ],
      });
      mocks.secrets.resolveSecretValue.mockResolvedValueOnce("top-secret");
      const rawBody = Buffer.from('{"event":"push"}');
      const valid = createHmac("sha256", "top-secret")
        .update(rawBody)
        .digest("hex");

      await expect(
        service(harness).service.firePublicTrigger(trigger.publicId, {
          rawBody,
          hubSignatureHeader: `sha256=${valid.slice(0, -1)}0`,
        }),
      ).rejects.toMatchObject({ status: 401 });
      expect(queryValues(harness, "insert")).toHaveLength(0);
      expect(queryValues(harness, "update")).toHaveLength(0);
    });
  });

  describe("run admission and scheduling", () => {
    it("interpolates variables and atomically correlates a fresh execution issue", async () => {
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
        linkedIssueId: null,
        coalescedIntoRunId: null,
        failureReason: null,
        completedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const finalRun = {
        ...createdRun,
        status: "issue_created",
        linkedIssueId: "issue-created-1",
      };
      const harness = createMockDb({
        select: [
          [existing],
          [{ snapshot: boundSnapshot }],
          [],
          [{ responsibleUserId: "revision-owner", snapshot: boundSnapshot }],
          [],
          [],
        ],
        execute: [[]],
        insert: [[createdRun]],
        update: [[finalRun], []],
      });
      const ordinary = ordinaryIssues();
      ordinary.create.mockImplementationOnce(async (input) => {
        const persisted = {
          issue: { id: finalRun.linkedIssueId, companyId: COMPANY_ID },
          sessionId: "ses-created",
          authorityId: "authority-created",
          ref: { id: "ref-created" },
        };
        await input.correlate(harness.db, persisted);
        return persisted;
      });

      const run = await service(harness, ordinary).service.runRoutine(
        ROUTINE_ID,
        {
          source: "api",
          variables: { repository: "paperclip" },
        },
      );

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
          originKind: "routine_execution",
          originRunId: createdRun.id,
          responsibleUserId: "revision-owner",
          contextAccessMask: null,
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
      ["coalesce_if_active", "coalesced"],
      ["skip_if_active", "skipped"],
    ] as const)(
      "%s resolves a matching live issue as %s without creating another issue",
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
        const activeIssue = {
          id: "issue-active",
          companyId: COMPANY_ID,
          lifecycleStatus: "open",
          boardPresentationStatus: "in_progress",
          creatorRoutineDispatchId: "run-active",
        };
        const settledRun = {
          ...createdRun,
          status: expectedStatus,
          linkedIssueId: activeIssue.id,
          coalescedIntoRunId: activeIssue.creatorRoutineDispatchId,
          completedAt: NOW,
        };
        const harness = createMockDb({
          select: [
            [existing],
            [{ snapshot: boundSnapshot }],
            [],
            [{ responsibleUserId: "board-user", snapshot: boundSnapshot }],
            [activeIssue],
          ],
          execute: [[]],
          insert: [[createdRun]],
          update: [[settledRun], []],
        });
        const ordinary = ordinaryIssues();

        await expect(
          service(harness, ordinary).service.runRoutine(ROUTINE_ID, {
            source: "api",
          }),
        ).resolves.toEqual(settledRun);
        expect(ordinary.create).not.toHaveBeenCalled();
        expect(queryValues(harness, "update")[0]).toEqual(
          expect.objectContaining({
            status: expectedStatus,
            linkedIssueId: activeIssue.id,
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
        select: [
          [{ trigger, routine: existing, projectPausedAt: NOW }],
        ],
        update: [[{ id: trigger.id }], [], []],
        insert: [[skippedRun]],
      });
      const ordinary = ordinaryIssues();

      await expect(
        service(harness, ordinary).service.tickScheduledTriggers(NOW),
      ).resolves.toEqual({ triggered: 0 });
      expect(queryValues(harness, "update")[0]).toEqual(
        expect.objectContaining({
          nextRunAt: new Date("2026-07-25T12:15:00.000Z"),
        }),
      );
      expect(queryValues(harness, "insert")[0]).toEqual(
        expect.objectContaining({
          status: "skipped",
          failureReason: "paused",
          linkedIssueId: null,
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
          [{
            id: "instance-settings",
            singletonKey: "default",
            general: { enableWorktreeRunExecution: false },
            createdAt: NOW,
            updatedAt: NOW,
          }],
          [{ trigger, routine: existing, projectPausedAt: null }],
        ],
        update: [[{ id: trigger.id }], [], []],
        insert: [[skippedRun]],
      });
      const ordinary = ordinaryIssues();

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
          linkedIssueId: null,
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
      ["blocked", "failed", "Execution issue moved to blocked"],
      ["cancelled", "failed", "Execution issue moved to cancelled"],
    ] as const)(
      "maps an execution issue in %s to a %s routine run",
      async (boardPresentationStatus, runStatus, failureReason) => {
        const issue = {
          id: "issue-execution",
          boardPresentationStatus,
          originKind: "routine_execution",
          originRunId: "run-linked",
        };
        const updatedRun = {
          id: issue.originRunId,
          status: runStatus,
          failureReason: failureReason ?? null,
        };
        const harness = createMockDb({
          select: [[issue]],
          update: [[updatedRun]],
        });

        await expect(
          service(harness).service.syncRunStatusForIssue(issue.id),
        ).resolves.toEqual(updatedRun);
        expect(queryValues(harness, "update")[0]).toEqual(
          expect.objectContaining({
            status: runStatus,
            ...(failureReason ? { failureReason } : {}),
            completedAt: NOW,
          }),
        );
      },
    );

    it("ignores an issue without canonical routine execution provenance", async () => {
      const harness = createMockDb({
        select: [[{
          id: "ordinary-issue",
          boardPresentationStatus: "done",
          originKind: "manual",
          originRunId: null,
        }]],
      });

      await expect(
        service(harness).service.syncRunStatusForIssue("ordinary-issue"),
      ).resolves.toBeNull();
      expect(queryValues(harness, "update")).toHaveLength(0);
    });
  });
});
