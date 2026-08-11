import { describe, expect, it, vi } from "vitest";
import type { tasks } from "@paperclipai/db";
import {
  assertCanonicalTaskCreatorProvenance,
  CanonicalTaskAggregateRejected,
  persistCanonicalTaskAggregateInTx,
} from "../services/canonical-task-aggregate.js";

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
