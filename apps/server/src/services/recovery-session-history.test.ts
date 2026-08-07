import type { ProviderSafeRunTrace } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createRecoverySessionHistoryReader,
  recoveryAncestorAttemptId,
  RestoreSessionUnavailable,
} from "./recovery-session-history.js";

const capability = {
  companyId: "company",
  issueId: "issue",
  sessionId: "issue-session",
  ownershipEpoch: 2,
  targetAgentId: "agent",
  adapterConfigIdentity: "revision",
  runId: "trigger-run",
  attemptId: "replacement-attempt",
  refId: "ref",
  refOrdinal: 0,
  segmentOrdinal: 0,
};

function trace(runId: string): ProviderSafeRunTrace {
  return {
    runId,
    runKind: "productive",
    status: "succeeded",
    startedAt: null,
    finishedAt: null,
    outcome: "succeeded",
    turns: [{ kind: "assistant", timestamp: "2026-08-07T00:00:00.000Z" }],
    outputComments: [],
    nextCursor: null,
  };
}

describe("recovery session history", () => {
  it("keeps recovery eligibility across contiguous pre-send new retries", () => {
    expect(recoveryAncestorAttemptId(4, [
      { id: "retry", attemptGeneration: 3, sessionOperation: "new" },
      { id: "replacement", attemptGeneration: 2, sessionOperation: "new" },
      { id: "missing", attemptGeneration: 1, sessionOperation: "resume" },
    ])).toBe("missing");
    expect(recoveryAncestorAttemptId(2, [
      { id: "ordinary", attemptGeneration: 1, sessionOperation: "new" },
    ])).toBeNull();
  });

  it("returns the exact canonical run reads for all prior current-agent runs", async () => {
    const readCanonicalAgentRunTrace = vi.fn(
      async ({ runId }: { runId: string }) => trace(runId),
    );
    const reader = createRecoverySessionHistoryReader({
      repository: {
        async listPriorAgentRunIds() {
          return ["old-run", "another-run"];
        },
      },
      runTrace: { readCanonicalAgentRunTrace } as never,
    });

    await expect(reader.restore({ capability })).resolves.toEqual({
      runs: [trace("old-run"), trace("another-run")],
    });
    expect(readCanonicalAgentRunTrace).toHaveBeenCalledWith({
      companyId: "company",
      runId: "old-run",
    });
    expect(readCanonicalAgentRunTrace).toHaveBeenCalledWith({
      companyId: "company",
      runId: "another-run",
    });
    expect(readCanonicalAgentRunTrace).not.toHaveBeenCalledWith(
      expect.objectContaining({ runId: "trigger-run" }),
    );
  });

  it("continues only a listed restored run with its native trace cursor", async () => {
    const readCanonicalAgentRunTrace = vi.fn(
      async ({ runId }: { runId: string }) => trace(runId),
    );
    const reader = createRecoverySessionHistoryReader({
      repository: {
        async listPriorAgentRunIds() {
          return ["old-run"];
        },
      },
      runTrace: { readCanonicalAgentRunTrace } as never,
    });

    await reader.restore({
      capability,
      runId: "old-run",
      cursor: "run-trace-cursor",
    });
    expect(readCanonicalAgentRunTrace).toHaveBeenCalledWith({
      companyId: "company",
      runId: "old-run",
      cursor: "run-trace-cursor",
    });
    await expect(reader.restore({
      capability,
      runId: "trigger-run",
    })).rejects.toBeInstanceOf(RestoreSessionUnavailable);
  });
});
