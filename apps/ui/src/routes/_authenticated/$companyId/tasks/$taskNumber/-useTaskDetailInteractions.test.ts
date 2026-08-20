import { describe, expect, it } from "vitest";

import { validateTaskChatAgentMentionSubmission } from "./-useTaskDetailInteractions";

const mention = {
  targetAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  ownershipEpoch: 7,
};
const task = {
  ownerAgentId: mention.targetAgentId,
  ownershipEpoch: mention.ownershipEpoch,
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
});
