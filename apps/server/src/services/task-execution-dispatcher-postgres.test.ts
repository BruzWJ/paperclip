import { taskExecutionRefs } from "@paperclipai/db";
import { describe, expect, it } from "vitest";
import { createMockDb } from "../__tests__/helpers/mock-db.js";
import {
  classifyExpiredPromptClosure,
  PostgresTaskExecutionDispatchRejected,
} from "./task-execution-dispatcher-postgres.js";
import { selectSessionOperation } from "./task-execution-dispatcher-postgres-part-3.js";

const revokedAt = new Date("2026-07-26T18:00:00.000Z");

function owner(overrides: Record<string, unknown> = {}) {
  return {
    promptTransmissionPhase: "not_transmitted",
    outcome: null,
    outcomeReferenceId: null,
    protocolSettlementState: null,
    accountingId: null,
    costEventId: null,
    settlementVersion: 0,
    settledAt: null,
    ...overrides,
  } as never;
}

function capability(revocationReason: string, overrides: Record<string, unknown> = {}) {
  return {
    state: "revoked",
    revocationReason,
    revokedAt,
    activatedAt: null,
    targetSessionCorrelationId: null,
    ...overrides,
  } as never;
}

describe("expired prompt durable closure classification", () => {
  it("preserves the one fresh-session pre-send retry", () => {
    expect(
      classifyExpiredPromptClosure({
        owner: owner(),
        capability: capability("pre_send_retry"),
      }),
    ).toEqual({
      kind: "retry",
      reason: "transport_transient",
      retryAt: new Date(revokedAt.getTime() + 1_000),
    });
  });

  it("keeps steering cancellation open until ACPX closes it exactly", () => {
    expect(
      classifyExpiredPromptClosure({
        owner: owner({ promptTransmissionPhase: "transmitted" }),
        capability: capability("active_run_steering", {
          activatedAt: new Date(revokedAt.getTime() - 1),
          targetSessionCorrelationId: "correlation-id",
        }),
      }),
    ).toEqual({ kind: "open" });
    expect(
      classifyExpiredPromptClosure({
        owner: owner({
          promptTransmissionPhase: "transmitted",
          outcome: "cancelled",
          protocolSettlementState: "incomplete",
          settlementVersion: 1,
          settledAt: revokedAt,
        }),
        capability: capability("active_run_steering", {
          activatedAt: new Date(revokedAt.getTime() - 1),
          targetSessionCorrelationId: "correlation-id",
        }),
      }),
    ).toEqual({
      kind: "terminal",
      outcome: "cancelled",
      reason: "active_run_steering",
      protocolSettled: false,
    });
  });

  it("treats persisted not-sent and incomplete outcomes as terminal", () => {
    expect(
      classifyExpiredPromptClosure({
        owner: owner({
          outcome: "released_unsent",
          outcomeReferenceId: "not-sent-reference",
          protocolSettlementState: "not_sent",
          settlementVersion: 1,
          settledAt: revokedAt,
        }),
        capability: capability("pre_send_failure"),
      }),
    ).toEqual({
      kind: "terminal",
      outcome: "failed",
      reason: "pre_send_failure",
      protocolSettled: false,
    });
    expect(
      classifyExpiredPromptClosure({
        owner: owner({
          promptTransmissionPhase: "transmitted",
          outcome: "failed",
          outcomeReferenceId: "incomplete-reference",
          protocolSettlementState: "incomplete",
          settlementVersion: 1,
          settledAt: revokedAt,
        }),
        capability: capability("prompt_failed_incomplete", {
          activatedAt: new Date(revokedAt.getTime() - 1),
        }),
      }),
    ).toEqual({
      kind: "terminal",
      outcome: "failed",
      reason: "prompt_failed_incomplete",
      protocolSettled: false,
    });
  });

  it("maps only official settled outcomes and preserves event reconstruction", () => {
    expect(
      classifyExpiredPromptClosure({
        owner: owner({
          promptTransmissionPhase: "transmitted",
          outcome: "refused",
          outcomeReferenceId: "settlement-reference",
          protocolSettlementState: "settled",
          accountingId: "accounting-id",
          costEventId: "cost-id",
          settlementVersion: 1,
          settledAt: revokedAt,
        }),
        capability: capability("protocol_settled", {
          activatedAt: new Date(revokedAt.getTime() - 1),
          targetSessionCorrelationId: "correlation-id",
        }),
      }),
    ).toEqual({
      kind: "terminal",
      outcome: "succeeded",
      reason: "protocol_settled",
      protocolSettled: true,
    });
  });

  it("rejects a revoked decision that disagrees with the durable owner", () => {
    expect(() =>
      classifyExpiredPromptClosure({
        owner: owner({
          promptTransmissionPhase: "transmitted",
          outcome: "ambiguous",
          outcomeReferenceId: "ambiguous-reference",
          protocolSettlementState: "incomplete",
          settlementVersion: 1,
          settledAt: revokedAt,
        }),
        capability: capability("protocol_settled"),
      }),
    ).toThrow(PostgresTaskExecutionDispatchRejected);
  });
});

const contextDial = {
  carry_context: true,
  read_task_comments: false,
  read_task_agent_run: false,
  list_sub_tasks: false,
  read_sub_task_comments: false,
  read_sub_task_agent_run: false,
  list_company_tasks: false,
  read_company_task_comments: false,
  read_company_task_agent_run: false,
} as const;

function sessionRef(overrides: Record<string, unknown> = {}) {
  return {
    id: "ref-1",
    companyId: "company-1",
    taskId: "task-1",
    sessionId: "session-1",
    ownershipEpoch: 1,
    previousOwnershipEpoch: null,
    executionScopeId: "scope-1",
    executionLineageId: "lineage-1",
    mode: "owner",
    sourceKind: "task_request",
    sourceRecordId: "task-1",
    messageKind: "user",
    targetAgentId: "agent-1",
    laneOrdinal: 0,
    taskExecutionAuthorityId: "authority-1",
    consultExecutionId: null,
    adapterConfigRevisionId: "revision-1",
    contextEpoch: 0,
    counterpartTaskId: null,
    counterpartAuthorityId: null,
    counterpartOwnershipEpoch: null,
    consultCallerRefId: null,
    consultChainToken: null,
    ...overrides,
  } as unknown as typeof taskExecutionRefs.$inferSelect;
}

function baseOperation(input: {
  ref: ReturnType<typeof sessionRef>;
  selects: readonly unknown[];
  carry?: boolean;
}) {
  const { ref } = input;
  return selectSessionOperation(
    createMockDb({ select: input.selects }).db as never,
    {
      async resolve() {
        return {
          contextDial: {
            ...contextDial,
            carry_context: input.carry ?? true,
          },
        };
      },
    } as never,
    {
      run: {
        companyId: ref.companyId,
        taskId: ref.taskId,
        ownershipEpoch: ref.ownershipEpoch,
        targetAgentId: ref.targetAgentId,
        adapterConfigRevisionId: ref.adapterConfigRevisionId,
        executionWorkspaceBindingId: "workspace-1",
        executionMode: ref.mode,
        taskExecutionAuthorityId: ref.taskExecutionAuthorityId,
        consultExecutionId: ref.consultExecutionId,
        runId: "run-1",
      } as never,
      promptKind: "base",
      ref,
      refOrdinal: 0,
      segmentOrdinal: 0,
    },
  );
}

function operationScenario(input: {
  kind: "singleton" | "instruction" | "failed_bootstrap" | "ordinary";
  ref?: Record<string, unknown>;
  carry?: boolean;
  correlation?: boolean;
  instruction?: string | null;
}) {
  const ref = sessionRef(
    input.kind === "instruction"
      ? { messageKind: "synthetic" }
      : input.kind === "failed_bootstrap"
        ? { id: "ref-2", laneOrdinal: 1 }
        : input.ref,
  );
  const grouped =
    input.kind === "instruction"
      ? [ref, sessionRef({ id: "ref-2", laneOrdinal: 1 })]
      : input.kind === "failed_bootstrap"
        ? [sessionRef({ messageKind: "synthetic", disposition: "terminal" }), ref]
        : [ref];
  const tail =
    input.kind === "failed_bootstrap"
      ? [
          [
            {
              runId: "bootstrap-run",
              refOrdinal: 0,
              outcome: "failed",
              protocolSettlementState: "incomplete",
              correlation: null,
            },
          ],
        ]
      : [
          [{ instruction: input.instruction ?? null }],
          ...(input.carry === false ? [] : [[...(input.correlation ? [{ id: "carry-1" }] : [])]]),
        ];
  return baseOperation({ ref, selects: [grouped, ...tail], carry: input.carry });
}

describe("base prompt ACPX session operation", () => {
  it.each([
    ["singleton initial work", { kind: "singleton" }, "new"],
    ["paired instruction", { kind: "instruction", carry: false }, "new"],
    [
      "later exact carry",
      {
        kind: "ordinary",
        ref: { sourceKind: "human_comment_mention", laneOrdinal: 2 },
        instruction: "Lead delivery.",
        correlation: true,
      },
      "resume",
    ],
    [
      "instructionless reassignment without carry",
      {
        kind: "ordinary",
        carry: false,
        ref: { ownershipEpoch: 2, previousOwnershipEpoch: 1, sourceKind: "task_reassignment" },
      },
      "new",
    ],
  ] as const)("selects %s", async (_name, input, expected) => {
    await expect(operationScenario(input)).resolves.toBe(expected);
  });

  it.each([
    [
      "failed bootstrap",
      { kind: "failed_bootstrap" },
      "ordered session-start work lost its exact bootstrap correlation",
    ],
    [
      "instructed work without carry",
      { kind: "ordinary", instruction: "Lead delivery.", ref: { laneOrdinal: 2 } },
      "instructed work lost its exact carry or ordered session start",
    ],
    [
      "instructed reassignment singleton",
      {
        kind: "ordinary",
        carry: false,
        instruction: "Lead delivery.",
        ref: { ownershipEpoch: 2, previousOwnershipEpoch: 1, sourceKind: "task_reassignment" },
      },
      "instructed work lost its exact carry or ordered session start",
    ],
  ] as const)("rejects %s", async (_name, input, error) => {
    await expect(operationScenario(input)).rejects.toThrow(error);
  });
});
