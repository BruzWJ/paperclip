import { describe, expect, it } from "vitest";
import { computeComposerOwnerPreview } from "../lib/owner-transition";
import { shouldRenderComposerOwnerPreview } from "./TaskChatThread";

describe("shouldRenderComposerOwnerPreview", () => {
  it("skips the spacer wrapper when the preview is empty", () => {
    const preview = computeComposerOwnerPreview({
      ownerTarget: "agent:agent-claude",
      currentOwnerValue: "agent:agent-claude",
      hasActiveRun: true,
      bodyHasAgentMention: false,
      plainNameCandidate: null,
    });

    expect(preview.kind).toBe("none");
    expect(shouldRenderComposerOwnerPreview("Assign Claude", preview)).toBe(false);
  });

  it("renders the spacer wrapper only when body text and a visible preview are present", () => {
    const preview = computeComposerOwnerPreview({
      ownerTarget: "agent:agent-qa",
      currentOwnerValue: "agent:agent-claude",
      hasActiveRun: true,
      bodyHasAgentMention: false,
      plainNameCandidate: null,
    });

    expect(preview.kind).not.toBe("none");
    expect(shouldRenderComposerOwnerPreview("Assign QA", preview)).toBe(true);
    expect(shouldRenderComposerOwnerPreview("   ", preview)).toBe(false);
  });
});
