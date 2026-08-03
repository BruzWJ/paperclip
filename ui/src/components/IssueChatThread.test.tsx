import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canStopIssueChatRun,
  resolveAssistantMessageFoldedState,
  shouldRenderComposerOwnerPreview,
} from "./IssueChatThread";

describe("IssueChatThread canonical run helpers", () => {
  it("uses trimming only as a blank predicate and submits the original body", () => {
    const source = readFileSync(
      new URL("./IssueChatThread.tsx", import.meta.url),
      "utf8",
    );
    expect(source.match(/if \(!body\.trim\(\) \|\| submitting\) return;/g)).toHaveLength(2);
    expect(source).toContain("const submittedBody = body;");
    expect(source).not.toContain("const submittedBody = body.trim();");
    expect(source).not.toContain("const submittedBody = trimmed;");
  });

  it("only exposes run stop affordances for canonical active states", () => {
    expect(
      canStopIssueChatRun({
        runId: "run-1",
        runStatus: "running",
        activeRunIds: new Set(),
      }),
    ).toBe(true);
    expect(
      canStopIssueChatRun({
        runId: "run-1",
        runStatus: "completed",
        activeRunIds: new Set(),
      }),
    ).toBe(false);
  });

  it("keeps the current message unfolded when it is no longer foldable", () => {
    expect(
      resolveAssistantMessageFoldedState({
        messageId: "message-1",
        currentFolded: true,
        isFoldable: false,
        previousMessageId: "message-1",
        previousIsFoldable: true,
      }),
    ).toBe(false);
  });

  it("shows an ownership preview only for a non-empty explicit change", () => {
    expect(
      shouldRenderComposerOwnerPreview("Please continue", {
        kind: "notify_agent",
        tone: "neutral",
        text: "Notify",
        chip: { kind: "agent", id: "agent-1" },
      }),
    ).toBe(true);
    expect(
      shouldRenderComposerOwnerPreview("", {
        kind: "notify_agent",
        tone: "neutral",
        text: "Notify",
        chip: { kind: "agent", id: "agent-1" },
      }),
    ).toBe(false);
  });
});
