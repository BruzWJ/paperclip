import { describe, expect, it } from "vitest";
import { companies, tasks, type Db } from "@paperclipai/db";
import {
  logActivity,
  persistActivityLog,
  publishCommittedActivity,
  resolveResponsibleUserIdForActivity,
  type LogActivityInput,
} from "../services/activity-log.js";
import { subscribeLiveEvents } from "../services/live-events.js";
import { createMockDb } from "./helpers/mock-db.js";

type TableRows = Map<unknown, Array<Record<string, unknown>>>;

const companyId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000003";
const runId = "00000000-0000-4000-8000-000000000004";

function createReader(rowsByTable: TableRows) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          expect(condition).toBeDefined();
          return Promise.resolve(rowsByTable.get(table) ?? []);
        },
      }),
    }),
  } as unknown as Db;
}

function activityInput(
  overrides: Partial<LogActivityInput> = {},
): LogActivityInput {
  return {
    companyId,
    actorType: "agent",
    actorId: agentId,
    action: "task.updated",
    entityType: "task",
    entityId: taskId,
    agentId,
    ...overrides,
  };
}

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000005",
    companyId,
    actorType: "agent",
    actorId: agentId,
    action: "task.updated",
    entityType: "task",
    entityId: taskId,
    agentId,
    runId: null,
    responsibleUserId: "task-user",
    details: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("resolveResponsibleUserIdForActivity", () => {
  it("attributes user actions directly without database lookups", async () => {
    const db = {
      select: () => {
        throw new Error("user attribution should not query the database");
      },
    } as unknown as Db;

    await expect(
      resolveResponsibleUserIdForActivity(
        db,
        activityInput({
          actorType: "user",
          actorId: "user-1",
          entityType: "company",
          entityId: companyId,
        }),
      ),
    ).resolves.toBe("user-1");
  });

  it("uses task attribution when an activity has a run id", async () => {
    const db = createReader(
      new Map([
        [tasks, [{ responsibleUserId: "task-user", creatorUserId: null }]],
        [companies, [{ defaultResponsibleUserId: "default-user" }]],
      ]),
    );

    await expect(
      resolveResponsibleUserIdForActivity(
        db,
        activityInput({
          runId,
        }),
      ),
    ).resolves.toBe("task-user");
  });

  it("uses explicit task context for non-task activity", async () => {
    const db = createReader(
      new Map([
        [tasks, [{ responsibleUserId: "task-user", creatorUserId: null }]],
        [companies, [{ defaultResponsibleUserId: "default-user" }]],
      ]),
    );

    await expect(
      resolveResponsibleUserIdForActivity(
        db,
        activityInput({
          entityType: "task_execution_run",
          entityId: runId,
          taskId,
        }),
      ),
    ).resolves.toBe("task-user");
  });

  it("falls back to the company default responsible user", async () => {
    const db = createReader(
      new Map([[companies, [{ defaultResponsibleUserId: "default-user" }]]]),
    );

    await expect(
      resolveResponsibleUserIdForActivity(
        db,
        activityInput({
          entityType: "company",
          entityId: companyId,
        }),
      ),
    ).resolves.toBe("default-user");
  });

  it("uses task creator attribution when responsibleUserId is absent", async () => {
    const db = createReader(
      new Map([
        [tasks, [{ responsibleUserId: null, creatorUserId: "creator-user" }]],
        [companies, [{ defaultResponsibleUserId: "default-user" }]],
      ]),
    );

    await expect(
      resolveResponsibleUserIdForActivity(db, activityInput()),
    ).resolves.toBe("creator-user");
  });

  it("ignores malformed UUID-backed identifiers", async () => {
    const db = createReader(
      new Map([
        [tasks, [{ responsibleUserId: "task-user", creatorUserId: null }]],
        [companies, [{ defaultResponsibleUserId: "default-user" }]],
      ]),
    );

    await expect(
      resolveResponsibleUserIdForActivity(
        db,
        activityInput({
          runId: "not-a-run-uuid",
          entityId: "not-an-task-uuid",
          details: { taskId },
        }),
      ),
    ).resolves.toBe("default-user");
  });

  it("does not normalize whitespace around a task UUID", async () => {
    const db = createReader(
      new Map([
        [tasks, [{ responsibleUserId: "task-user", creatorUserId: null }]],
        [companies, [{ defaultResponsibleUserId: "default-user" }]],
      ]),
    );

    await expect(
      resolveResponsibleUserIdForActivity(
        db,
        activityInput({
          entityType: "task_execution_run",
          entityId: runId,
          taskId: ` ${taskId}`,
        }),
      ),
    ).resolves.toBe("default-user");
  });
});

describe("logActivity responsible-user stamping", () => {
  it("rejects transaction handles so publication cannot precede commit", async () => {
    const transaction = createReader(new Map());

    await expect(logActivity(transaction, activityInput())).rejects.toThrow(
      "transaction owners must persist and publish after commit",
    );
  });

  it("persists company-default attribution for an out-of-run agent action", async () => {
    const { db, calls } = createMockDb({
      select: [
        [{ general: { censorUsernameInLogs: false } }],
        [{ defaultResponsibleUserId: "default-user" }],
      ],
      insert: [
        [
          activityRow({
            entityType: "agent",
            entityId: agentId,
            responsibleUserId: "default-user",
          }),
        ],
      ],
    });
    await logActivity(
      db,
      activityInput({
        companyId,
        actorId: agentId,
        agentId,
        entityType: "agent",
        entityId: agentId,
      }),
    );

    expect(
      calls.find((call) => call.method === "values")?.args[0],
    ).toMatchObject({
      companyId,
      actorId: agentId,
      agentId,
      responsibleUserId: "default-user",
    });
  });

  it("publishes a canonical task UUID only after the transaction owner commits", async () => {
    const { db } = createMockDb({
      select: [
        [{ general: { censorUsernameInLogs: false } }],
        [{ responsibleUserId: "task-user", creatorUserId: null }],
      ],
      insert: [[activityRow()]],
    });
    const events: Array<{ payload: { taskId: string | null } }> = [];
    const unsubscribe = subscribeLiveEvents((event) => events.push(event));

    try {
      const persisted = await persistActivityLog(
        db,
        activityInput({
          details: { identifier: "PAP-1", taskId: "not-authoritative" },
        }),
      );
      expect(events).toEqual([]);
      publishCommittedActivity(persisted);
    } finally {
      unsubscribe();
    }

    expect(events.at(-1)?.payload.taskId).toBe(taskId);
  });
});
