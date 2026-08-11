import {
  agentContextGrants,
  agents,
  issueExecutionSessions,
  issueExecutionWorkspaceBindings,
  issues,
} from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import {
  admitIssueExecutionInTransaction,
  renderAgentInstructionBootstrap,
} from "./issue-execution-initial-start-admission.js";

type Input = Parameters<typeof admitIssueExecutionInTransaction>[0];

const work = {
  companyId: "company", issueId: "issue", sessionId: "session",
  ownershipEpoch: 2, contextEpoch: 0, mode: "owner",
  targetAgentId: "agent", issueExecutionAuthorityId: "authority",
  consultExecutionId: null, adapterConfigRevisionId: "revision",
  sourceKind: "issue_reassignment",
  actor: { kind: "user/board", userId: "user" }, previousOwnershipEpoch: 1,
  immutableSourceKey: "assign", sourceRecordId: "issue",
  exactText: "Do the work", idempotencyKey: "assign",
  comment: { author: { kind: "user", userId: "user" }, producingRun: null },
} as const satisfies Input["work"];

function transaction(instruction: string | null, carry = false) {
  const rows = new Map<unknown, readonly unknown[]>([
    [agents, [{ instruction }]],
    [issues, [{ companyId: "company", ownerKind: "agent", ownerAgentId: "agent",
      ownershipEpoch: 2, workMode: "parallel", harnessKind: null,
      originKind: "human", executionPolicy: null }]],
    [issueExecutionWorkspaceBindings, [{ id: "workspace" }]],
    [agentContextGrants, []],
    [issueExecutionSessions, carry ? [{ id: "carry" }] : []],
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
  const result = await admitIssueExecutionInTransaction({
    sessionAdmission, transaction: transaction(instruction, carry), work,
  });
  return { batch, result, single, workResult };
}

describe("canonical issue execution target admission", () => {
  it("preserves the exact board instruction before bootstrap guidance", () => {
    expect(renderAgentInstructionBootstrap("You are the CTO.")).toBe(
      "You are the CTO.\n\nThis is your role bootstrap turn, not issue work. Do not inspect the filesystem, workspace, repository, home directory, environment, global configuration, or provider configuration, and do not use provider-local tools. If you need organizational or company context, use only the Paperclip-managed tools available in this turn. Briefly acknowledge the role and end the turn; the issue request will arrive as a separate queued turn.",
    );
  });

  it("admits an instructed missing target as one ordered pair", async () => {
    const { batch, result, single, workResult } = await admit("Lead delivery.");
    expect(result).toBe(workResult);
    expect(single).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledWith({
      batchKey: "assign",
      sources: [expect.objectContaining({
        sourceKind: "issue_request",
        actor: { kind: "system", sourceKind: "issue_request", sourceId: "issue" },
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
