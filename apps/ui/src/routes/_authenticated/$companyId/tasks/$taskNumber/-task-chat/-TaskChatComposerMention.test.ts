import { buildAgentMentionHref } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";

import type { TaskChatMentionTarget } from "./-TaskChatShared";
import { serializeTaskChatOwnerNotification } from "./-useTaskChatComposerController";

const target: TaskChatMentionTarget = {
  targetAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  ownershipEpoch: 7,
  name: "Research agent",
  icon: null,
};

describe("task chat owner notification", () => {
  it("serializes the selected current owner as a canonical agent link", () => {
    expect(serializeTaskChatOwnerNotification("Please check this", target)).toBe(
      `[@Research agent](${buildAgentMentionHref(target.targetAgentId, null)}) Please check this`,
    );
  });

  it("escapes the owner label and supports an otherwise empty message", () => {
    expect(
      serializeTaskChatOwnerNotification("", {
        ...target,
        name: "Research [lead]",
      }),
    ).toBe(`[@Research \\[lead\\]](${buildAgentMentionHref(target.targetAgentId, null)})`);
  });
});
