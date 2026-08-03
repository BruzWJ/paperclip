import { describe, expect, it } from "vitest";
import {
  persistedSessionCompactionSettingsSchema,
  sessionCompactionRunContextSchema,
  sessionCompactionScopeSchema,
} from "../services/issue-session-compaction-contract.ts";
import {
  planIssueSessionRecoveryCompaction,
} from "../services/issue-session-compaction-postgres.ts";
import type {
  PersistedSessionCompactionModel,
} from "../services/issue-session-compaction-contract.ts";
import type {
  WithParts,
} from "../services/issue-session-compaction/index.ts";

const model: PersistedSessionCompactionModel = {
  modelRef: "summary-model",
  targetModelId: "summary-model",
  targetModelValue: "summary-model-value",
  contextTokenLimit: 100_000,
  outputTokenLimit: 10_000,
};

function user(id: string, text: string): WithParts {
  return {
    info: { id, role: "user", kind: "source" },
    parts: [{ type: "text", text }],
  };
}

function assistant(id: string, parentID: string, text: string): WithParts {
  return {
    info: {
      id,
      role: "assistant",
      parentID,
      providerID: "paperclip-acp",
      modelID: "summary-model",
      finish: "end_turn",
    },
    parts: [{ type: "text", text }],
  };
}

describe("recovery-only issue Session compaction contract", () => {
  it("accepts only exact recovery scope/audience pairs", () => {
    expect(
      sessionCompactionScopeSchema.parse({
        kind: "turns-recovery",
        id: "lineage-1",
        audience: "turns",
        sourceHighWaterSeq: 42,
      }),
    ).toMatchObject({ kind: "turns-recovery", audience: "turns" });
    expect(() =>
      sessionCompactionScopeSchema.parse({
        kind: "turns-recovery",
        id: "lineage-1",
        audience: "comments",
        sourceHighWaterSeq: 42,
      }),
    ).toThrow("scope and audience");
    expect(() =>
      sessionCompactionScopeSchema.parse({
        kind: "execution-lineage",
        id: "lineage-1",
        audience: "turns",
        sourceHighWaterSeq: 42,
      }),
    ).toThrow();
  });

  it("keeps the company setting sparse and rejects legacy/runtime keys", () => {
    expect(
      persistedSessionCompactionSettingsSchema.parse({
        auto: false,
        reserved: 0,
        tail_turns: 0,
      }),
    ).toEqual({ auto: false, reserved: 0, tail_turns: 0 });
    expect(() =>
      persistedSessionCompactionSettingsSchema.parse({
        auto: true,
        forcedRotation: true,
      }),
    ).toThrow();
  });

  it("requires the complete immutable target-not-found recovery identity", () => {
    const context = {
      version: "paperclip-recovery-compaction-run/v1" as const,
      issueId: "10000000-0000-4000-8000-000000000001",
      sessionId: "ses_recovery",
      ownershipEpoch: 1,
      contextEpoch: 2,
      executionLineageId: "10000000-0000-4000-8000-000000000002",
      targetAgentId: "10000000-0000-4000-8000-000000000003",
      adapterConfigRevisionId: "10000000-0000-4000-8000-000000000004",
      executionWorkspaceBindingId: "10000000-0000-4000-8000-000000000005",
      scope: {
        kind: "comments-recovery" as const,
        id: "thread-1",
        audience: "comments" as const,
        sourceHighWaterSeq: 9,
      },
      source: {
        runId: "10000000-0000-4000-8000-000000000006",
        runKind: "consult" as const,
        refId: "10000000-0000-4000-8000-000000000007",
        refOrdinal: 1,
        segmentOrdinal: 0,
        latestFinishedAssistantMessageId: null,
      },
      settings: {},
      model,
    };
    expect(sessionCompactionRunContextSchema.parse(context)).toEqual(context);
    expect(() =>
      sessionCompactionRunContextSchema.parse({
        ...context,
        mode: "automatic",
      }),
    ).toThrow();
  });

  it("does not cross the usable threshold for a small authorized view", async () => {
    const plan = await planIssueSessionRecoveryCompaction({
      messages: [user("msg_1", "small request"), assistant("msg_2", "msg_1", "small response")],
      settings: {},
      model,
    });
    expect(plan.overLimit).toBe(false);
    expect(plan.tokenCount).toBeLessThan(plan.usableTokens);
  });

  it("uses copied tail selection and deterministic transcript for an over-limit view", async () => {
    const oversized = "history ".repeat(40_000);
    const messages = [
      user("msg_old_user", oversized),
      assistant("msg_old_assistant", "msg_old_user", oversized),
      user("msg_recent_user", "recent request"),
      assistant("msg_recent_assistant", "msg_recent_user", "recent response"),
    ];
    const first = await planIssueSessionRecoveryCompaction({
      messages,
      settings: {
        auto: false,
        tail_turns: 1,
        preserve_recent_tokens: 8_000,
      },
      model,
    });
    const second = await planIssueSessionRecoveryCompaction({
      messages,
      settings: {
        auto: false,
        tail_turns: 1,
        preserve_recent_tokens: 8_000,
      },
      model,
    });
    expect(first.overLimit).toBe(true);
    expect(first.config.compaction?.auto).toBe(false);
    expect(first.tailStartMessageId).toBe("msg_recent_user");
    expect(first.head.map((entry) => entry.info.id)).toEqual([
      "msg_old_user",
      "msg_old_assistant",
    ]);
    expect(second.prompt).toBe(first.prompt);
  });
});
