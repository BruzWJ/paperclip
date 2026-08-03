import { describe, expect, it } from "vitest";
import {
  experimentalChatMessagesTransform,
  experimentalCompactionAutocontinue,
  experimentalSessionCompacting,
} from "./policy.js";

describe("Paperclip session compaction policy", () => {
  it("adds no compaction context or replacement prompt", () => {
    expect(experimentalSessionCompacting()).toEqual({
      context: [],
      prompt: undefined,
    });
  });

  it("returns the selected messages by identity", () => {
    const messages = Object.freeze([{ role: "user", content: "exact request" }]);
    expect(experimentalChatMessagesTransform(messages)).toBe(messages);
  });

  it("keeps automatic continuation enabled without an extension hook", () => {
    expect(experimentalCompactionAutocontinue()).toEqual({ enabled: true });
  });
});
