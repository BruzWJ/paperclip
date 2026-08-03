import { describe, expect, it, vi } from "vitest";
import type { IssueSessionMessage } from "@paperclipai/shared/issue-session";
import {
  assembleIssueSessionRecoveryPrompt,
  createIssueSessionTargetNotFoundRecovery,
  issueSessionRecoveryAssembledContentDigest,
  issueSessionRecoveryDepthForDial,
  issueSessionRecoverySelectionIdentityDigest,
  IssueSessionRecoveryRejected,
  serializeIssueSessionRecoveryHistory,
  type IssueSessionRecoveryMember,
  type IssueSessionRecoverySelectionIdentity,
  type PinnedIssueSessionRecoverySelection,
} from "./issue-session-recovery.js";
import type { ResolvedIssueExecutionPrompt } from "./issue-execution-attempt-executor.js";

const commentMembers = [
  {
    kind: "comment" as const,
    id: "comment-1",
    canonicalMessageId: "message-1",
    sourceSequence: 4,
    authorKind: "user" as const,
    body: "Earlier <comment>",
  },
  {
    kind: "comment" as const,
    id: "comment-2",
    canonicalMessageId: "message-2",
    sourceSequence: 9,
    authorKind: "agent" as const,
    body: "Agent report",
  },
] satisfies readonly IssueSessionRecoveryMember[];

const assistantMessage = {
  id: "message-2",
  sessionID: "session",
  type: "assistant",
  agent: "agent",
  model: { id: "model", providerID: "provider" },
  content: [
    { id: "text", type: "text", text: "answer" },
    { id: "reasoning", type: "reasoning", text: "safe reasoning" },
  ],
  finish: "stop",
  time: { created: 2, completed: 3 },
} as unknown as IssueSessionMessage;

const turnMembers = [
  {
    kind: "message" as const,
    id: "message-1",
    sourceSequence: 4,
    selectionRole: "history" as const,
    message: {
      id: "message-1",
      sessionID: "session",
      type: "user",
      text: "question",
      files: [],
      agents: [],
      time: { created: 1 },
    } as unknown as IssueSessionMessage,
  },
  {
    kind: "message" as const,
    id: "message-2",
    sourceSequence: 9,
    selectionRole: "retained-tail" as const,
    message: assistantMessage,
  },
] satisfies readonly IssueSessionRecoveryMember[];

const identity: IssueSessionRecoverySelectionIdentity = {
  companyId: "company",
  issueId: "issue",
  sessionId: "session",
  visibility: "active",
  scopeKind: "comments-recovery",
  scopeId: "scope",
  audience: "comments",
  ownershipEpoch: 2,
  targetAgentId: "agent",
  laneKind: "owner",
  contextEpoch: 3,
  executionLineageId: "lineage",
  sourceHighWaterSeq: 10,
  effectiveContextDigest: "a".repeat(64),
  selectedCheckpointControlId: null,
  latestFinishedAssistantMessageId: "message-2",
  sourceRunId: "run",
  sourceRefId: "ref",
  sourceRefOrdinal: 0,
  sourceSegmentOrdinal: 0,
};

function selected(
  sourceText = "  exact current request\n",
): PinnedIssueSessionRecoverySelection {
  const selectionIdentityDigest =
    issueSessionRecoverySelectionIdentityDigest({
      identity,
      members: commentMembers,
    });
  const assembled = assembleIssueSessionRecoveryPrompt({
    depth: "thread",
    checkpoint: null,
    members: commentMembers,
    sourceText,
  });
  return {
    id: "selection",
    ...identity,
    depth: "thread",
    checkpoint: null,
    members: commentMembers,
    selectionIdentityDigest,
    expectedAssembledContentDigest:
      issueSessionRecoveryAssembledContentDigest(assembled),
  };
}

function prompt(
  sourceText = "  exact current request\n",
): ResolvedIssueExecutionPrompt {
  return {
    carryContext: true,
    sourceText,
  } as ResolvedIssueExecutionPrompt;
}

describe("canonical missing-target recovery", () => {
  it("uses full turns over comments and requires true carry", () => {
    expect(
      issueSessionRecoveryDepthForDial({
        carry_context: true,
        read_issue_comments: true,
        read_issue_agent_run: true,
      }),
    ).toBe("turns");
    expect(
      issueSessionRecoveryDepthForDial({
        carry_context: true,
        read_issue_comments: true,
        read_issue_agent_run: false,
      }),
    ).toBe("thread");
    expect(
      issueSessionRecoveryDepthForDial({
        carry_context: false,
        read_issue_comments: true,
        read_issue_agent_run: true,
      }),
    ).toBeNull();
  });

  it("serializes comments only inside the exact versioned delimiter", () => {
    const value = assembleIssueSessionRecoveryPrompt({
      depth: "thread",
      checkpoint: null,
      members: commentMembers,
      sourceText: "new request",
    });
    expect(value).toBe(
      '<paperclip-issue-session-context depth="thread">\n' +
        '{"version":"paperclip-issue-session-recovery/v1","depth":"thread","comments":[{"id":"comment-1","seq":4,"authorKind":"user","body":"Earlier \\u003ccomment\\u003e"},{"id":"comment-2","seq":9,"authorKind":"agent","body":"Agent report"}]}\n' +
        "</paperclip-issue-session-context>\n\nnew request",
    );
    expect(value).not.toContain("safe reasoning");
  });

  it("serializes canonical turns including safe reasoning without a provider lowerer", () => {
    const value = serializeIssueSessionRecoveryHistory({
      depth: "turns",
      checkpoint: null,
      members: turnMembers,
    });
    expect(value).toContain('"depth":"turns"');
    expect(value).toContain("safe reasoning");
    expect(value).not.toContain('"selectionRole"');
  });

  it("rejects mixed audiences, unordered members, and empty selections without a checkpoint", () => {
    expect(() =>
      serializeIssueSessionRecoveryHistory({
        depth: "thread",
        checkpoint: null,
        members: turnMembers,
      }),
    ).toThrow(IssueSessionRecoveryRejected);
    expect(() =>
      serializeIssueSessionRecoveryHistory({
        depth: "thread",
        checkpoint: null,
        members: [...commentMembers].reverse(),
      }),
    ).toThrow(IssueSessionRecoveryRejected);
    expect(() =>
      serializeIssueSessionRecoveryHistory({
        depth: "thread",
        checkpoint: null,
        members: [],
      }),
    ).toThrow(IssueSessionRecoveryRejected);
  });

  it("accepts a checkpoint-only full-summary recovery with no retained tail", () => {
    expect(
      assembleIssueSessionRecoveryPrompt({
        depth: "turns",
        checkpoint: {
          id: "checkpoint",
          requestMessageId: "request-message",
          assistantMessageId: "summary-message",
          summaryText: "Complete compacted history",
          tailStartMessageId: null,
        },
        members: [],
        sourceText: "continue",
      }),
    ).toContain('"turns":[]');
  });

  it("returns the exact source without a selection for authorized no-context recovery", async () => {
    const repository = {
      prepare: vi.fn(async (resolved: ResolvedIssueExecutionPrompt) => ({
        kind: "no_context" as const,
        sourceText: resolved.sourceText,
      })),
    };
    const service = createIssueSessionTargetNotFoundRecovery({ repository });
    await expect(
      service.prepareReplacementPrompt(prompt()),
    ).resolves.toBe("  exact current request\n");
  });

  it("rebuilds, verifies, and consumes a pinned identity-only selection", async () => {
    const sourceText = "  exact current request\n";
    const selection = selected(sourceText);
    const repository = {
      prepare: vi.fn(async () => ({
        kind: "selected" as const,
        sourceText,
        selection,
      })),
    };
    const service = createIssueSessionTargetNotFoundRecovery({ repository });
    const value = await service.prepareReplacementPrompt(prompt(sourceText));
    expect(value.endsWith(sourceText)).toBe(true);
  });

  it("fails closed when pinned member bytes or source bytes change", async () => {
    const sourceText = "request";
    const canonical = selected(sourceText);
    const changed = {
      ...canonical,
      members: [
        {
          ...canonical.members[0],
          body: "changed after selection",
        },
        canonical.members[1],
      ],
    } as PinnedIssueSessionRecoverySelection;
    const repository = {
      prepare: vi.fn(async () => ({
        kind: "selected" as const,
        sourceText,
        selection: changed,
      })),
    };
    const service = createIssueSessionTargetNotFoundRecovery({ repository });
    await expect(
      service.prepareReplacementPrompt(prompt(sourceText)),
    ).rejects.toBeInstanceOf(IssueSessionRecoveryRejected);
  });

  it("rejects false-carry callers before repository access", async () => {
    const repository = {
      prepare: vi.fn(),
    };
    const service = createIssueSessionTargetNotFoundRecovery({ repository });
    await expect(
      service.prepareReplacementPrompt({
        ...prompt(),
        carryContext: false,
      }),
    ).rejects.toBeInstanceOf(IssueSessionRecoveryRejected);
    expect(repository.prepare).not.toHaveBeenCalled();
  });
});
