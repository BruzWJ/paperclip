import { describe, expect, it } from "vitest";
import { isBoardActor } from "../../http/request-actor.js";
import {
  testBoardKeyActor,
  testBoardSessionActor,
} from "./request-actor.js";

describe("canonical request-actor test fixtures", () => {
  it("creates a complete Better Auth session actor with active memberships", () => {
    const actor = testBoardSessionActor({
      userId: "user-1",
      companyIds: ["company-1"],
    });

    expect(actor).toEqual({
      type: "board",
      source: "session",
      sessionId: "test-session-user-1",
      userId: "user-1",
      userName: "Test User",
      userEmail: "test@example.com",
      companyIds: ["company-1"],
      memberships: [{
        companyId: "company-1",
        membershipRole: "operator",
        status: "active",
      }],
      isInstanceAdmin: false,
    });
    expect(isBoardActor(actor)).toBe(true);
  });

  it("creates a complete board-key actor without masquerading as a session", () => {
    const actor = testBoardKeyActor({
      userId: "user-2",
      keyId: "board-key-2",
      companyIds: ["company-2"],
      isInstanceAdmin: true,
    });

    expect(actor.source).toBe("board_key");
    expect(actor.keyId).toBe("board-key-2");
    expect("sessionId" in actor).toBe(false);
    expect(actor.isInstanceAdmin).toBe(true);
    expect(isBoardActor(actor)).toBe(true);
  });

  it("copies explicit membership fixtures instead of sharing mutable state", () => {
    const memberships = [{
      companyId: "company-3",
      membershipRole: "viewer",
      status: "active",
    }];
    const actor = testBoardSessionActor({
      companyIds: ["company-3"],
      memberships,
    });

    expect(actor.memberships).toEqual(memberships);
    expect(actor.memberships).not.toBe(memberships);
    expect(actor.memberships[0]).not.toBe(memberships[0]);
  });
});
