import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildProjectMentionHref,
  buildRoutineMentionHref,
  buildUserMentionHref,
  extractAgentMentionIds,
  extractProjectMentionIds,
  extractRoutineMentionIds,
  extractUserMentionIds,
  parseAgentMentionHref,
  parseProjectMentionHref,
  parseRoutineMentionHref,
  parseUserMentionHref,
} from "./project-mentions.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const ROUTINE_ID = "abcdefac-cdef-4abc-8def-abcdefabcdef";
const USER_ID = "auth0|Board.User@example.test";

describe("project-mentions", () => {
  it("round-trips project mentions with color metadata", () => {
    const href = buildProjectMentionHref(PROJECT_ID, "#336699");
    expect(parseProjectMentionHref(href)).toEqual({
      projectId: PROJECT_ID,
      color: "#336699",
    });
    expect(extractProjectMentionIds(`[@Paperclip App](${href})`)).toEqual([
      PROJECT_ID,
    ]);
  });

  it("round-trips agent mentions with icon metadata", () => {
    const href = buildAgentMentionHref(AGENT_ID, "code");
    expect(parseAgentMentionHref(href)).toEqual({
      agentId: AGENT_ID,
      icon: "code",
    });
    expect(extractAgentMentionIds(`[@CodexCoder](${href})`)).toEqual([
      AGENT_ID,
    ]);
  });

  it("round-trips exact opaque user mentions without hostname normalization", () => {
    const href = buildUserMentionHref(USER_ID);
    expect(href).toBe("user://auth0%7CBoard.User%40example.test");
    expect(parseUserMentionHref(href)).toEqual({
      userId: USER_ID,
    });
    expect(extractUserMentionIds(`[@Taylor](${href})`)).toEqual([USER_ID]);
  });

  it("round-trips routine mentions", () => {
    const href = buildRoutineMentionHref(ROUTINE_ID);
    expect(parseRoutineMentionHref(href)).toEqual({
      routineId: ROUTINE_ID,
    });
    expect(
      extractRoutineMentionIds(`[/routine:Weekly review](${href})`),
    ).toEqual([ROUTINE_ID]);
  });

  it("rejects normalized aliases and unknown mention query keys", () => {
    expect(
      parseProjectMentionHref(`project://${PROJECT_ID}?color=336699`),
    ).toBeNull();
    expect(parseProjectMentionHref(`project://${PROJECT_ID}?c=ABC`)).toBeNull();
    expect(parseAgentMentionHref(`agent://${AGENT_ID}?icon=code`)).toBeNull();
    expect(
      parseRoutineMentionHref(`routine://${ROUTINE_ID}?source=legacy`),
    ).toBeNull();
    expect(parseUserMentionHref(`user://${USER_ID}`)).toBeNull();
    expect(
      parseUserMentionHref("user://auth0%7cBoard.User%40example.test"),
    ).toBeNull();
    expect(
      parseAgentMentionHref(`agent://${AGENT_ID.toUpperCase()}`),
    ).toBeNull();
  });

  it("rejects noncanonical builder inputs instead of normalizing or dropping them", () => {
    expect(() => buildProjectMentionHref(` ${PROJECT_ID}`, "#336699")).toThrow(
      /canonical UUID/,
    );
    expect(() => buildProjectMentionHref(PROJECT_ID, "#369")).toThrow(
      /six-digit/,
    );
    expect(() => buildProjectMentionHref(PROJECT_ID, "#ABCDEF")).toThrow(
      /lowercase/,
    );
    expect(() => buildAgentMentionHref(AGENT_ID, " Code ")).toThrow(
      /lowercase icon/,
    );
    expect(() => buildRoutineMentionHref(ROUTINE_ID.toUpperCase())).toThrow(
      /canonical UUID/,
    );
    expect(() => buildUserMentionHref("")).toThrow(/non-empty user ID/);
  });
});
