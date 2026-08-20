import { taskExecutionSessions } from "@paperclipai/db";
import { expect, it } from "vitest";
import { createMockDb } from "../__tests__/helpers/mock-db.js";
import { createPostgresTaskExecutionDispatcherRepositoryGroup3 } from "./task-execution-dispatcher-postgres-group-3.js";

it("preserves the eligible carry correlation when continuity is requested", async () => {
  const harness = createMockDb({ select: [[], []], update: [[{ id: "fenced" }]] });
  const repository = createPostgresTaskExecutionDispatcherRepositoryGroup3(
    { database: harness.db, idFactory: () => "unused" } as never,
    {} as never,
    {} as never,
  );

  const result = await repository.fenceRevokedExecutionAuthorityInTransaction(harness.db as never, {
    companyId: "company-1",
    selector: { kind: "ownership_epoch", taskId: "task-1", ownershipEpoch: 4 },
    reason: "task_completed",
    at: new Date("2026-08-19T12:00:00.000Z"),
    nativeContinuity: "preserve_carry",
  });

  expect(result.correlationIds).toEqual([]);
  expect(
    harness.calls.some(
      (call) => call.operation === "update" && call.method === "update" && call.args[0] === taskExecutionSessions,
    ),
  ).toBe(false);
});
