import {
  agentContextGrants,
  agents,
  taskExecutionSessions,
  taskExecutionWorkspaceBindings,
  tasks,
} from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import {
  admitTaskExecutionInTransaction,
  renderAgentInstructionBootstrap,
} from "./task-execution-initial-start-admission.js";

type Input = Parameters<typeof admitTaskExecutionInTransaction>[0];

const work = {
  companyId: "company", taskId: "task", sessionId: "session",
  ownershipEpoch: 2, contextEpoch: 0, mode: "owner",
  targetAgentId: "agent", taskExecutionAuthorityId: "authority",
  consultExecutionId: null, adapterConfigRevisionId: "revision",
  sourceKind: "task_reassignment",
  actor: { kind: "user/board", userId: "user" }, previousOwnershipEpoch: 1,
  immutableSourceKey: "assign", sourceRecordId: "task",
  exactText: "Do the work", idempotencyKey: "assign",
  comment: { author: { kind: "user", userId: "user" }, producingRun: null },
} as const satisfies Input["work"];

function transaction(instruction: string | null, carry = false) {
  const rows = new Map<unknown, readonly unknown[]>([
    [agents, [{ instruction }]],
    [tasks, [{ companyId: "company", ownerKind: "agent", ownerAgentId: "agent",
      ownershipEpoch: 2, workMode: "parallel", harnessKind: null,
      originKind: "human", executionPolicy: null }]],
    [taskExecutionWorkspaceBindings, [{ id: "workspace" }]],
    [agentContextGrants, []],
    [taskExecutionSessions, carry ? [{ id: "carry" }] : []],
  ]);
  return {
    select() {
      let table: unknown;
      const builder = {
        from(value: unknown) { table = value; return builder; },
        where() { return builder; }, limit() { return builder; },
        for() { return Promise.resolve(rows.get(table) ?? []); },
      };
      return builder;
    },
  } as unknown as Input["transaction"];
}

async function admit(instruction: string | null, carry = false) {
  const workResult = { ref: { id: "work" } };
  const single = vi.fn(async () => workResult);
  const batch = vi.fn(async () => [{ ref: { id: "bootstrap" } }, workResult]);
  const sessionAdmission = {
    admitExecutionSource: single,
    admitExecutionSourceBatch: batch,
  } as unknown as Input["sessionAdmission"];
  const result = await admitTaskExecutionInTransaction({
    sessionAdmission, transaction: transaction(instruction, carry), work,
  });
  return { batch, result, single, workResult };
}

describe("canonical task execution target admission", () => {
  it("preserves the exact board instruction before bootstrap guidance", () => {
    expect(renderAgentInstructionBootstrap("You are the CTO.")).toBe(
      "You are the CTO.\n\nThis is your role bootstrap turn, not task work. Do not inspect the filesystem, workspace, repository, home directory, environment, global configuration, or provider configuration, and do not use provider-local tools. If you need organizational or company context, use only the Paperclip-managed tools available in this turn. Briefly acknowledge the role and end the turn; the task request will arrive as a separate queued turn.",
    );
  });

  it("admits an instructed missing target as one ordered pair", async () => {
    const { batch, result, single, workResult } = await admit("Lead delivery.");
    expect(result).toBe(workResult);
    expect(single).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledWith({
      batchKey: "assign",
      sources: [expect.objectContaining({
        sourceKind: "task_request",
        actor: { kind: "system", sourceKind: "task_request", sourceId: "task" },
        immutableSourceKey: "assign:bootstrap",
      }), work],
    }, expect.anything());
  });

  it.each([[null, false], ["Lead delivery.", true]] as const)(
    "admits one work ref for instruction %s with carry %s",
    async (instruction, carry) => {
      const { batch, single, workResult, result } = await admit(instruction, carry);
      expect(result).toBe(workResult);
      expect(single).toHaveBeenCalledOnce();
      expect(batch).not.toHaveBeenCalled();
    },
  );
});
