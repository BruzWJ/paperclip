import { describe, expect, it } from "vitest";

import { validateTaskChatAgentMentionSubmission } from "./-useTaskDetailInteractions";

const mention = {
  targetAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  ownershipEpoch: 7,
};
const task = {
  ownerAgentId: mention.targetAgentId,
  ownershipEpoch: mention.ownershipEpoch,
  lifecycleStatus: "open" as const,
};

describe("task detail comment mention submission", () => {
  it("preserves the exact current-owner mention tuple", () => {
    expect(validateTaskChatAgentMentionSubmission({ task, mention })).toBe(mention);
  });

  it("rejects stale intent instead of downgrading it to a plain comment", () => {
    expect(() =>
      validateTaskChatAgentMentionSubmission({
        task: { ...task, ownershipEpoch: mention.ownershipEpoch + 1 },
        mention,
      }),
    ).toThrow("task owner changed");
  });

  it("rejects mention combinations that the canonical comment schema forbids", () => {
    expect(() =>
      validateTaskChatAgentMentionSubmission({
        task,
        mention,
        replyToCommentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).toThrow("reply cannot also mention");
    expect(() =>
      validateTaskChatAgentMentionSubmission({
        task,
        mention,
        ownerChange: { ownerAgentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      }),
    ).toThrow("cannot change the owner and mention");
  });

  it("rejects agent notification for a terminal task", () => {
    expect(() =>
      validateTaskChatAgentMentionSubmission({
        task: { ...task, lifecycleStatus: "done" },
        mention,
      }),
    ).toThrow("open or blocked task");
  });

  it("rejects changing the owner while replying before any mutation can run", () => {
    expect(() =>
      validateTaskChatAgentMentionSubmission({
        task,
        ownerChange: { ownerAgentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
        replyToCommentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).toThrow("reply cannot change");
  });
});
