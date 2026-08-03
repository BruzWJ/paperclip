import { describe, expect, it } from "vitest";
import {
  classifyExpiredPromptClosure,
  PostgresIssueExecutionDispatchRejected,
} from "./issue-execution-dispatcher-postgres.js";

const revokedAt = new Date("2026-07-26T18:00:00.000Z");

function owner(
  overrides: Record<string, unknown> = {},
) {
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

function capability(
  revocationReason: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    state: "revoked",
    revocationReason,
    revokedAt,
    activatedAt: null,
    targetSessionCorrelationId: null,
    ...overrides,
  } as never;
}

function attempt(sessionOperation = "new") {
  return { sessionOperation } as never;
}

describe("expired prompt durable closure classification", () => {
  it("reuses the exact target-not-found and pre-send retry decisions", () => {
    expect(
      classifyExpiredPromptClosure({
        owner: owner(),
        capability: capability("target_not_found"),
        attempt: attempt("resume"),
      }),
    ).toEqual({
      kind: "retry",
      reason: "target_not_found_recovery",
      retryAt: revokedAt,
    });
    expect(
      classifyExpiredPromptClosure({
        owner: owner(),
        capability: capability("pre_send_retry"),
        attempt: attempt(),
      }),
    ).toEqual({
      kind: "retry",
      reason: "transport_transient",
      retryAt: new Date(revokedAt.getTime() + 1_000),
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
        attempt: attempt(),
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
        attempt: attempt(),
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
        attempt: attempt(),
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
        attempt: attempt(),
      })
    ).toThrow(PostgresIssueExecutionDispatchRejected);
  });
});
