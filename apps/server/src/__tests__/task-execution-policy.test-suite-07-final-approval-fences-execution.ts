import { vi } from "vitest";
import { taskExecutionPolicyControlService } from "../services/task-execution-policy.js";
import { createMockDb } from "./helpers/mock-db.js";
import * as t from "./task-execution-policy.test-support.js";

const NOW = new Date("2026-08-19T21:00:00.000Z");

t.describe("task execution policy terminal execution boundary", () => {
  t.it("fences final approval while preserving provider carry", async () => {
    const policy = t.makePolicy([
      { type: "approval", participants: [{ type: "agent", agentId: t.qaAgentId }] },
    ]);
    const task = {
      id: "task-1",
      companyId: "company-1",
      lifecycleStatus: "open",
      ownershipEpoch: 4,
      ...t.policyTask(policy, {
        boardPresentationStatus: "in_review",
        executionState: t.reviewState(policy.stages[0]!.id, {
          currentStageType: "approval",
        }),
      }),
    };
    const terminalUpdate = {
      disposition: { message: "Implementation is ready." },
      runId: "owner-run-1",
    };
    const decision = { id: "decision-final", outcome: "approved" };
    const updatedTask = {
      ...task,
      lifecycleStatus: "done",
      boardPresentationStatus: "done",
      disposition: terminalUpdate.disposition,
      completedAt: NOW,
    };
    const harness = createMockDb({
      execute: [[]],
      select: [[task], [], [terminalUpdate]],
      insert: [[decision]],
      update: [[updatedTask]],
    });
    const cancellations = {
      companyId: "company-1",
      taskId: "task-1",
      selector: { kind: "ownership_epoch" as const, ownershipEpoch: 4 },
      reason: "task_completed",
      fence: { refIds: [], correlationIds: [] },
      requests: [],
    };
    const request = vi.fn(async () => cancellations);
    const reconcile = vi.fn(async () => []);
    const service = taskExecutionPolicyControlService(harness.db, {
      clock: () => NOW,
      taskExecutionCancellation: {
        requestScopeCancellationsInTransaction: request,
        reconcileRequestedCancellations: reconcile,
      } as never,
    });

    await t.expect(service.decide({
      companyId: "company-1",
      taskId: "task-1",
      outcome: "approved",
      body: "Approved for completion.",
      idempotencyKey: "final-approval-1",
      actor: { agentId: t.qaAgentId, runId: "approval-run-1" },
    })).resolves.toEqual({ task: updatedTask, decision, retried: false });
    t.expect(request).toHaveBeenCalledWith(harness.db, {
      companyId: "company-1",
      taskId: "task-1",
      selector: { kind: "ownership_epoch", ownershipEpoch: 4 },
      reason: "task_completed",
      actor: { kind: "agent", agentId: t.qaAgentId },
      now: NOW,
      nativeContinuity: "preserve_carry",
    });
    t.expect(reconcile).toHaveBeenCalledWith(cancellations);
  });
});
