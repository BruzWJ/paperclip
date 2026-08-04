import { describe, expect, it } from "vitest";
import { deriveIssueUserContext } from "../services/issues.ts";

function makeIssue(overrides?: Partial<{
  creatorUserId: string | null;
  ownerUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}>) {
  return {
    creatorUserId: null,
    ownerUserId: null,
    createdAt: new Date("2026-03-06T10:00:00.000Z"),
    updatedAt: new Date("2026-03-06T11:00:00.000Z"),
    ...overrides,
  };
}

describe("deriveIssueUserContext", () => {
  it("marks issue unread when external comments are newer than my latest comment", () => {
    const context = deriveIssueUserContext(
      makeIssue({ creatorUserId: "user-1" }),
      "user-1",
      {
        myLastCommentAt: new Date("2026-03-06T12:00:00.000Z"),
        myLastReadAt: null,
        lastExternalCommentAt: new Date("2026-03-06T13:00:00.000Z"),
      },
    );

    expect(context.myLastTouchAt?.toISOString()).toBe("2026-03-06T12:00:00.000Z");
    expect(context.lastExternalCommentAt?.toISOString()).toBe("2026-03-06T13:00:00.000Z");
    expect(context.isUnreadForMe).toBe(true);
  });

  it("marks issue read when my latest comment is newest", () => {
    const context = deriveIssueUserContext(
      makeIssue({ creatorUserId: "user-1" }),
      "user-1",
      {
        myLastCommentAt: new Date("2026-03-06T14:00:00.000Z"),
        myLastReadAt: null,
        lastExternalCommentAt: new Date("2026-03-06T13:00:00.000Z"),
      },
    );

    expect(context.isUnreadForMe).toBe(false);
  });

  it("uses issue creation time as fallback touch point for creator", () => {
    const context = deriveIssueUserContext(
      makeIssue({ creatorUserId: "user-1", createdAt: new Date("2026-03-06T09:00:00.000Z") }),
      "user-1",
      {
        myLastCommentAt: null,
        myLastReadAt: null,
        lastExternalCommentAt: new Date("2026-03-06T10:00:00.000Z"),
      },
    );

    expect(context.myLastTouchAt?.toISOString()).toBe("2026-03-06T09:00:00.000Z");
    expect(context.isUnreadForMe).toBe(true);
  });

  it("uses issue updated time as fallback touch point for owner", () => {
    const context = deriveIssueUserContext(
      makeIssue({ ownerUserId: "user-1", updatedAt: new Date("2026-03-06T15:00:00.000Z") }),
      "user-1",
      {
        myLastCommentAt: null,
        myLastReadAt: null,
        lastExternalCommentAt: new Date("2026-03-06T14:59:00.000Z"),
      },
    );

    expect(context.myLastTouchAt?.toISOString()).toBe("2026-03-06T15:00:00.000Z");
    expect(context.isUnreadForMe).toBe(false);
  });

  it("uses latest read timestamp to clear unread without requiring a comment", () => {
    const context = deriveIssueUserContext(
      makeIssue({ creatorUserId: "user-1", createdAt: new Date("2026-03-06T09:00:00.000Z") }),
      "user-1",
      {
        myLastCommentAt: null,
        myLastReadAt: new Date("2026-03-06T11:30:00.000Z"),
        lastExternalCommentAt: new Date("2026-03-06T11:00:00.000Z"),
      },
    );

    expect(context.myLastTouchAt?.toISOString()).toBe("2026-03-06T11:30:00.000Z");
    expect(context.isUnreadForMe).toBe(false);
  });

  it("handles SQL timestamp strings without throwing", () => {
    const context = deriveIssueUserContext(
      makeIssue({
        creatorUserId: "user-1",
        createdAt: new Date("2026-03-06T09:00:00.000Z"),
      }),
      "user-1",
      {
        myLastCommentAt: "2026-03-06T10:00:00.000Z",
        myLastReadAt: null,
        lastExternalCommentAt: "2026-03-06T11:00:00.000Z",
      },
    );

    expect(context.myLastTouchAt?.toISOString()).toBe("2026-03-06T10:00:00.000Z");
    expect(context.lastExternalCommentAt?.toISOString()).toBe("2026-03-06T11:00:00.000Z");
    expect(context.isUnreadForMe).toBe(true);
  });
});
