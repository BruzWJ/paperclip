import { buildAgentMentionHref } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";

import type { TaskChatMentionTarget } from "./-TaskChatShared";
import {
  findTaskChatMentionQuery,
  reconcileTaskChatMentionSelection,
  replaceTaskChatMentionQuery,
  serializeTaskChatMention,
  taskChatMentionMatchesQuery,
} from "./-useTaskChatComposerController";

const target: TaskChatMentionTarget = {
  targetAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  ownershipEpoch: 7,
  name: "Research agent",
  icon: null,
};

describe("task chat agent mention helpers", () => {
  it("finds the active @ query at the caret without treating email text as a mention", () => {
    expect(findTaskChatMentionQuery("Ask @res", 8)).toEqual({
      start: 4,
      end: 8,
      query: "res",
    });
    expect(findTaskChatMentionQuery("Ask (@Research ag", 17)).toEqual({
      start: 5,
      end: 17,
      query: "Research ag",
    });
    expect(findTaskChatMentionQuery("ops@example", 11)).toBeNull();
  });

  it("replaces only the caret query with a readable agent token", () => {
    const body = "Ask @res tomorrow";
    const query = findTaskChatMentionQuery(body, 8)!;
    expect(replaceTaskChatMentionQuery(body, query, target)).toEqual({
      body: "Ask @Research agent tomorrow",
      cursor: 19,
      mentionStart: 4,
      mentionEnd: 19,
    });
  });

  it("matches the owner by a case-insensitive partial name", () => {
    expect(taskChatMentionMatchesQuery(target, "RESEARCH ag")).toBe(true);
    expect(taskChatMentionMatchesQuery(target, "designer")).toBe(false);
  });

  it("serializes the selected readable token into the canonical agent link", () => {
    expect(
      serializeTaskChatMention("Please ask @Research agent next", {
        target,
        start: 11,
        end: 26,
      }),
    ).toBe(`Please ask [@Research agent](${buildAgentMentionHref(target.targetAgentId, null)}) next`);
    expect(
      serializeTaskChatMention("Please ask Research agent next", {
        target,
        start: 11,
        end: 26,
      }),
    ).toBeNull();
  });

  it("keeps intent tied to the selected occurrence", () => {
    const body = "@Research agent then @Research agent";
    const selection = { target, start: 21, end: 36 };

    expect(reconcileTaskChatMentionSelection(body, "@Research agent then ", selection)).toBeNull();
  });
});
