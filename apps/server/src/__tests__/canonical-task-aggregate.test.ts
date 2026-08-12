import { describe, expect, it, vi } from "vitest";
import type { tasks } from "@paperclipai/db";
import {
  allocateCanonicalTaskIdentityInTx,
  assertCanonicalTaskCreatorProvenance,
  CanonicalTaskAggregateRejected,
  persistCanonicalTaskAggregateInTx,
} from "../services/canonical-task-aggregate.js";
import { createMockDb } from "./helpers/mock-db.js";

vi.mock("../services/execution-workspaces.js", () => ({
  reserveTaskExecutionWorkspaceBinding: vi.fn(),
}));

type TaskInsert = typeof tasks.$inferInsert & { id: string };

function ordinaryCollectiveBoardTask(
  overrides: Partial<TaskInsert> = {},
): TaskInsert {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    companyId: "00000000-0000-4000-8000-000000000002",
    request: "Canonical creator constraint fixture",
    lifecycleStatus: "open",
    boardPresentationStatus: "todo",
    ownerKind: "agent",
    ownerAgentId: "00000000-0000-4000-8000-000000000003",
    ownershipEpoch: 1,
    creatorKind: "user/board",
    creatorUserId: null,
    taskNumber: 1,
    identifier: "PAP-1",
    ...overrides,
  };
}

function rejectionReason(task: TaskInsert): string {
  try {
    assertCanonicalTaskCreatorProvenance(task);
  } catch (error) {
    expect(error).toBeInstanceOf(CanonicalTaskAggregateRejected);
    return (error as CanonicalTaskAggregateRejected).reason;
  }
  throw new Error("Expected canonical creator validation to reject");
}

describe("canonical task aggregate creator provenance", () => {
  it("atomically allocates one exact company-prefixed task identity", async () => {
    const harness = createMockDb({
      update: [[{ taskNumber: 42, taskPrefix: "PAP" }]],
    });

    await expect(allocateCanonicalTaskIdentityInTx(
      harness.db as never,
      "00000000-0000-4000-8000-000000000002",
      new Date("2026-08-12T00:00:00.000Z"),
    )).resolves.toEqual({ taskNumber: 42, identifier: "PAP-42" });
    expect(harness.remaining("update")).toBe(0);
  });

  it("rejects an identity that does not exactly match the allocated company state", async () => {
    const harness = createMockDb({
      select: [[{ taskPrefix: "PAP", taskCounter: 1 }]],
    });

    await expect(persistCanonicalTaskAggregateInTx(harness.db as never, {
      task: ordinaryCollectiveBoardTask({ identifier: "ALT-1" }),
      session: {
        id: "ses_canonical_identity",
        now: new Date("2026-08-12T00:00:00.000Z"),
      },
      authority: null,
    })).rejects.toMatchObject({ reason: "task_identifier_invalid" });
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
  });

  it("accepts both named-user and collective-board creators", () => {
    expect(() =>
      assertCanonicalTaskCreatorProvenance(
        ordinaryCollectiveBoardTask({
          creatorUserId:
            "00000000-0000-4000-8000-000000000004",
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertCanonicalTaskCreatorProvenance(
        ordinaryCollectiveBoardTask(),
      ),
    ).not.toThrow();
  });

  it("accepts a system creator with complete escalation provenance", () => {
    expect(() =>
      assertCanonicalTaskCreatorProvenance(
        ordinaryCollectiveBoardTask({
          id: "00000000-0000-4000-8000-000000000010",
          parentId: null,
          ownerKind: "board",
          ownerAgentId: null,
          creatorKind: "system",
          creatorUserId: null,
          creatorSystemSourceKind: "recovery",
          creatorSystemSourceId: "recovery:edge-1",
          escalatedFromAffectedTaskId:
            "00000000-0000-4000-8000-000000000011",
          escalatedFromTriggeringRunId: null,
          escalatedFromReason: "creator_execution_superseded",
          affectedOwnershipEpoch: 1,
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a system creator without escalation provenance", () => {
    expect(
      rejectionReason(
        ordinaryCollectiveBoardTask({
          ownerKind: "board",
          ownerAgentId: null,
          creatorKind: "system",
          creatorUserId: null,
          creatorSystemSourceKind: "recovery",
          creatorSystemSourceId: "recovery:edge-1",
        }),
      ),
    ).toBe("escalation_provenance_invalid");
  });

  it("rejects escalation provenance on a non-system creator", () => {
    expect(
      rejectionReason(
        ordinaryCollectiveBoardTask({
          escalatedFromAffectedTaskId:
            "00000000-0000-4000-8000-000000000011",
          escalatedFromTriggeringRunId: null,
          escalatedFromReason: "creator_execution_superseded",
          affectedOwnershipEpoch: 1,
        }),
      ),
    ).toBe("escalation_provenance_invalid");
  });

  it("retains strict unrelated-field nullability for collective-board creators", () => {
    expect(
      rejectionReason(
        ordinaryCollectiveBoardTask({
          creatorPluginKey: "not-a-user-board-field",
        }),
      ),
    ).toBe("creator_shape_invalid");
  });

  it("runs creator provenance validation before the aggregate performs any database write", async () => {
    const databaseAccess = vi.fn();
    const tx = new Proxy(
      {},
      {
        get() {
          databaseAccess();
          throw new Error("database access occurred");
        },
      },
    ) as Parameters<typeof persistCanonicalTaskAggregateInTx>[0];

    await expect(
      persistCanonicalTaskAggregateInTx(tx, {
        task: ordinaryCollectiveBoardTask({
          ownerKind: "board",
          ownerAgentId: null,
          creatorKind: "system",
          creatorUserId: null,
          creatorSystemSourceKind: "recovery",
          creatorSystemSourceId: "recovery:no-provenance",
        }),
        session: {
          id: "ses_creator_constraint",
          now: new Date("2026-07-30T00:00:00.000Z"),
        },
        authority: null,
      }),
    ).rejects.toMatchObject({
      reason: "escalation_provenance_invalid",
    });
    expect(databaseAccess).not.toHaveBeenCalled();
  });
});
