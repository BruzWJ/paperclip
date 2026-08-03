import { decodeIssueSessionMessage } from "@paperclipai/shared/issue-session";
import { describe, expect, it } from "vitest";
import {
  lowerIssueSessionRecoveryMembersForActivePruneEffects,
} from "../issue-session-recovery-postgres.js";
import {
  issueSessionPrunedToolKey,
  lowerIssueSessionMessageForActivePruneEffects,
  PRUNED_TOOL_RESULT_PLACEHOLDER,
} from "./active-prune-effects.js";

function assistantWithCompletedTool() {
  return decodeIssueSessionMessage({
    id: "msg_assistant",
    sessionID: "ses_session_1",
    type: "assistant",
    agent: "agent-1",
    model: { id: "model-1", providerID: "provider-1" },
    content: [
      {
        type: "tool",
        id: "tool-1",
        name: "read",
        provider: {
          executed: true,
          metadata: { provider: { trace: "provider-private" } },
        },
        state: {
          status: "completed",
          input: { path: "large.txt" },
          content: [{ type: "text", text: "large result" }],
          structured: { answer: 42 },
          result: { raw: "large result" },
        },
        time: { created: 1 },
      },
      { type: "text", id: "text-1", text: "kept" },
    ],
    finish: "stop",
    time: { created: 1, completed: 2 },
  });
}

describe("recovery-only active tool-prune lowering", () => {
  it("keeps the canonical row immutable and removes every result path", () => {
    const original = assistantWithCompletedTool();
    const effects = new Set([
      issueSessionPrunedToolKey("msg_assistant", "tool-1"),
    ]);
    const lowered = lowerIssueSessionMessageForActivePruneEffects(
      original,
      effects,
    );

    expect(lowered).not.toBe(original);
    const originalTool = original.type === "assistant"
      ? original.content.find((part) => part.type === "tool")
      : undefined;
    const loweredTool = lowered.type === "assistant"
      ? lowered.content.find((part) => part.type === "tool")
      : undefined;
    expect(originalTool).toMatchObject({
      state: {
        content: [{ type: "text", text: "large result" }],
        structured: { answer: 42 },
        result: { raw: "large result" },
      },
    });
    expect(loweredTool).toMatchObject({
      provider: {
        executed: true,
        metadata: { provider: { trace: "provider-private" } },
      },
      state: {
        status: "completed",
        input: { path: "large.txt" },
        structured: {},
        content: [
          { type: "text", text: PRUNED_TOOL_RESULT_PLACEHOLDER },
        ],
      },
    });
    expect(
      lowered.type === "assistant"
        ? lowered.content.find((part) => part.type === "text")
        : undefined,
    ).toMatchObject({ type: "text", text: "kept" });
    expect(
      (lowered.type === "assistant" && lowered.content[0]?.type === "tool")
        ? lowered.content[0].state
        : null,
    ).not.toHaveProperty("result");
  });

  it("rebuilds a pinned recovery member idempotently with the same effect", () => {
    const member = {
      kind: "message" as const,
      id: "msg_assistant",
      sourceSequence: 7,
      selectionRole: "retained-tail" as const,
      message: assistantWithCompletedTool(),
    };
    const effects = new Set([
      issueSessionPrunedToolKey("msg_assistant", "tool-1"),
    ]);

    const first = lowerIssueSessionRecoveryMembersForActivePruneEffects(
      [member],
      effects,
    );
    const rebuilt = lowerIssueSessionRecoveryMembersForActivePruneEffects(
      first,
      effects,
    );

    expect(rebuilt).toEqual(first);
    expect(rebuilt[0]).toMatchObject({
      id: member.id,
      sourceSequence: member.sourceSequence,
      selectionRole: "retained-tail",
    });
    const rebuiltMessage = rebuilt[0]?.kind === "message"
      ? rebuilt[0].message
      : null;
    const rebuiltTool = rebuiltMessage?.type === "assistant"
      ? rebuiltMessage.content.find((part) => part.type === "tool")
      : undefined;
    expect(rebuiltTool).toMatchObject({
      state: {
        content: [
          { type: "text", text: PRUNED_TOOL_RESULT_PLACEHOLDER },
        ],
      },
    });
  });
});
