import { describe, expect, it } from "vitest";
import {
  classifyIssueLivenessFollowupWithoutAction,
  decideIssueLivenessFollowupFinalizationAuthority,
  decideIssueLivenessActionSettlement,
  ISSUE_LIVENESS_FOLLOWUP_TEXT,
  recordIssueLivenessActionInTransaction,
  shouldClaimIssueLivenessFrontier,
} from "./issue-liveness-reconciliation.js";

function decisionRow(
  patch: Partial<{
    admittedAt: Date;
    acceptedActionKind: "issue_update" | null;
    supersededBeforeAttentionAt: Date | null;
    boardAttentionEmittedAt: Date | null;
    exitActionKind: "mention_agent" | null;
  }> = {},
) {
  return {
    id: "reconciliation-1",
    admittedAt: patch.admittedAt ?? new Date("2026-08-01T12:00:00.000Z"),
    acceptedActionKind: patch.acceptedActionKind ?? null,
    supersededBeforeAttentionAt:
      patch.supersededBeforeAttentionAt ?? null,
    boardAttentionEmittedAt: patch.boardAttentionEmittedAt ?? null,
    exitActionKind: patch.exitActionKind ?? null,
  };
}

describe("issue liveness reconciliation", () => {
  it("retains the exact versioned P17 system reply", () => {
    expect(ISSUE_LIVENESS_FOLLOWUP_TEXT).toBe(
      "This issue is still active but no work is queued. Explicitly mention the agent who should continue. If you own the issue and no further work should continue, use issue_update to set its lifecycle state.",
    );
  });

  it("records a post-admission action as the mutually exclusive initial settlement", () => {
    const row = decisionRow();
    expect(
      decideIssueLivenessActionSettlement(
        row,
        new Date("2026-08-01T12:00:01.000Z"),
      ),
    ).toBe("accepted");
    expect(
      decideIssueLivenessActionSettlement(
        row,
        new Date("2026-08-01T12:00:00.000Z"),
      ),
    ).toBeNull();
    expect(
      decideIssueLivenessActionSettlement(
        row,
        new Date("2026-08-01T11:59:59.999Z"),
      ),
    ).toBeNull();
  });

  it("rejects legacy or malformed action references before consulting storage", async () => {
    for (const reference of [
      "issue_creator_withdrawal_audit:legacy-id",
      "issue_update:",
      "issue_execution_prompt_segment:run-id:ref-id:0",
    ]) {
      await expect(
        recordIssueLivenessActionInTransaction(
          undefined as never,
          reference as never,
        ),
      ).rejects.toMatchObject({
        code: "issue_liveness_reconciliation_rejected",
      });
    }
  });

  it("records an action after emitted Attention as an exit only", () => {
    const row = decisionRow({
      boardAttentionEmittedAt: new Date("2026-08-01T12:00:02.000Z"),
    });
    expect(
      decideIssueLivenessActionSettlement(
        row,
        new Date("2026-08-01T12:00:03.000Z"),
      ),
    ).toBe("exit");
    expect(
      decideIssueLivenessActionSettlement(
        row,
        new Date("2026-08-01T12:00:02.000Z"),
      ),
    ).toBeNull();
  });

  it("never overwrites accepted, superseded, or exited audit branches", () => {
    const committedAt = new Date("2026-08-01T12:00:10.000Z");
    expect(
      decideIssueLivenessActionSettlement(
        decisionRow({ acceptedActionKind: "issue_update" }),
        committedAt,
      ),
    ).toBeNull();
    expect(
      decideIssueLivenessActionSettlement(
        decisionRow({
          supersededBeforeAttentionAt: new Date(
            "2026-08-01T12:00:02.000Z",
          ),
        }),
        committedAt,
      ),
    ).toBeNull();
    expect(
      decideIssueLivenessActionSettlement(
        decisionRow({
          boardAttentionEmittedAt: new Date(
            "2026-08-01T12:00:02.000Z",
          ),
          exitActionKind: "mention_agent",
        }),
        committedAt,
      ),
    ).toBeNull();
  });

  it("distinguishes plain successful no-action text from failed or output-free follow-ups", () => {
    expect(
      classifyIssueLivenessFollowupWithoutAction({
        terminalClassification: "succeeded",
        finalizationAction: "comment_only",
      }),
    ).toBe("agent_no_action");
    expect(
      classifyIssueLivenessFollowupWithoutAction({
        terminalClassification: "succeeded",
        finalizationAction: "no_conversational_output",
      }),
    ).toBe("agent_followup_failed");
    for (const terminalClassification of [
      "interrupted",
      "failed",
      "cancelled",
      "timed_out",
    ] as const) {
      expect(
        classifyIssueLivenessFollowupWithoutAction({
          terminalClassification,
          finalizationAction: "comment_only",
        }),
      ).toBe("agent_followup_failed");
    }
  });

  it("consumes a superseded pre-send retry-source finalization without settling liveness", () => {
    expect(
      decideIssueLivenessFollowupFinalizationAuthority({
        authoritativeRunId: "retry-run",
        finalizedRunId: "retry-source-run",
        finalizedRunIsRetryAncestor: true,
        directRetrySuccessorCount: 0,
      }),
    ).toBe("consume_retry_source");
  });

  it("allows only the terminal retry-chain owner to settle liveness", () => {
    expect(
      decideIssueLivenessFollowupFinalizationAuthority({
        authoritativeRunId: "terminal-retry-run",
        finalizedRunId: "terminal-retry-run",
        finalizedRunIsRetryAncestor: false,
        directRetrySuccessorCount: 0,
      }),
    ).toBe("settle_terminal_owner");
    expect(() =>
      decideIssueLivenessFollowupFinalizationAuthority({
        authoritativeRunId: "retry-source-run",
        finalizedRunId: "retry-source-run",
        finalizedRunIsRetryAncestor: false,
        directRetrySuccessorCount: 1,
      })
    ).toThrow(/must receive authority/);
    expect(() =>
      decideIssueLivenessFollowupFinalizationAuthority({
        authoritativeRunId: "unrelated-run",
        finalizedRunId: "retry-source-run",
        finalizedRunIsRetryAncestor: false,
        directRetrySuccessorCount: 0,
      })
    ).toThrow(/outside its exact retry chain/);
  });

  it("claims only an entirely idle, receivable, current frontier", () => {
    const baseline = {
      issueCurrentAndNonterminal: true,
      creatorEdgeReceivable: true,
      queuedRefExists: false,
      activeAgentRunExists: false,
      explicitSourceActionExists: false,
      reconciliationExists: false,
    };
    expect(shouldClaimIssueLivenessFrontier(baseline)).toBe(true);
    for (const blocking of [
      { issueCurrentAndNonterminal: false },
      { creatorEdgeReceivable: false },
      { queuedRefExists: true },
      { activeAgentRunExists: true },
      { explicitSourceActionExists: true },
      { reconciliationExists: true },
    ]) {
      expect(
        shouldClaimIssueLivenessFrontier({ ...baseline, ...blocking }),
      ).toBe(false);
    }
  });
});
