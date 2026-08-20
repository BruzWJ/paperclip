import { describe, expect, it } from "vitest";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import {
  AcpPromptSettlementRejected,
  resolveAcpPromptAccountingModel,
  settleAcpPromptInTransaction,
  type SettleAcpPromptInTransactionInput,
} from "./acp-prompt-settlement.js";

const noDatabase = {} as TaskSessionDbTransaction;

function validInput(): SettleAcpPromptInTransactionInput {
  return {
    identity: {
      companyId: "00000000-0000-4000-8000-000000000001",
      taskId: "00000000-0000-4000-8000-000000000002",
      sessionId: "ses_settlement",
      agentId: "00000000-0000-4000-8000-000000000003",
      runId: "00000000-0000-4000-8000-000000000004",
      runKind: "productive",
      refId: "00000000-0000-4000-8000-000000000005",
      runOrdinal: 0,
      attemptId: "00000000-0000-4000-8000-000000000006",
      adapterConfigRevisionId:
        "00000000-0000-4000-8000-000000000007",
    },
    settlement: {
      kind: "protocol_settled",
      stopReason: "end_turn",
      occupancy: { used: 10, size: 100, cost: null },
    },
    promptSettlementReferenceId:
      "00000000-0000-4000-8000-000000000008",
    terminalUsageReference: "capability:1:usage",
    terminalStopReference: "capability:1:stop",
    stepEnded: {
      eventId: "evt_settlement",
      eventSeq: 10,
      assistantMessageId: "msg_settlement",
    },
    settledAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("canonical ACP prompt settlement boundary", () => {
  it("uses terminal occupancy when ACP exposes no portable model limits", () => {
    expect(
      resolveAcpPromptAccountingModel(null, 100),
    ).toEqual({ selectedModelId: null, contextTokenLimit: 100 });
    expect(
      resolveAcpPromptAccountingModel(
        { value: "target-selected" },
        100,
      ),
    ).toEqual({ selectedModelId: "target-selected", contextTokenLimit: 100 });
  });

  it("uses observed occupancy as the sole accounting window", () => {
    expect(
      resolveAcpPromptAccountingModel(
        { value: "target-selected" },
        99,
      ),
    ).toEqual({ selectedModelId: "target-selected", contextTokenLimit: 99 });
  });

  it("rejects malformed terminal occupancy before reaching persistence", async () => {
    const input = validInput();
    await expect(
      settleAcpPromptInTransaction(noDatabase, {
        ...input,
        settlement: {
          ...input.settlement,
          occupancy: { used: 101, size: 100, cost: null },
        },
      }),
    ).rejects.toBeInstanceOf(AcpPromptSettlementRejected);
  });

  it("rejects noncanonical terminal references before reaching persistence", async () => {
    const input = validInput();
    await expect(
      settleAcpPromptInTransaction(noDatabase, {
        ...input,
        terminalUsageReference: " usage ",
      }),
    ).rejects.toThrow("canonical string");
  });
});
