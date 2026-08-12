import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  isBoardActor,
  type RequestActor,
} from "../http/request-actor.js";
import {
  assertBoard,
  getBoardUserId,
} from "../routes/authz.js";

function requestWithActor(actor: RequestActor): Request {
  return { actor } as Request;
}

const canonicalBoardActor: RequestActor = {
  type: "board",
  source: "session",
  userId: "user-1",
  sessionId: "session-1",
  userName: "User One",
  userEmail: "user@example.com",
  companyIds: ["company-1"],
  memberships: [{
    companyId: "company-1",
    membershipRole: "owner",
    status: "active",
  }],
  isInstanceAdmin: false,
};

describe("canonical HTTP request actor", () => {
  it("accepts only nonblank board identity with its source-specific id", () => {
    expect(isBoardActor(canonicalBoardActor)).toBe(true);
    expect(isBoardActor({
      ...canonicalBoardActor,
      userId: " ",
    })).toBe(false);
    expect(isBoardActor({
      ...canonicalBoardActor,
      sessionId: " ",
    })).toBe(false);
    expect(isBoardActor({
      ...canonicalBoardActor,
      source: "board_key",
      keyId: "board-key-1",
      sessionId: undefined,
    } as RequestActor)).toBe(true);
    expect(isBoardActor({
      ...canonicalBoardActor,
      source: "board_key",
      keyId: " ",
      sessionId: undefined,
    } as RequestActor)).toBe(false);
    expect(isBoardActor({
      ...canonicalBoardActor,
      source: "internal",
      keyId: "board-key-1",
      sessionId: undefined,
    } as unknown as RequestActor)).toBe(false);
  });

  it("extracts the canonical board user id without a mixed actor wrapper", () => {
    expect(getBoardUserId(requestWithActor(canonicalBoardActor))).toBe(
      "user-1",
    );

    expect(() =>
      assertBoard(requestWithActor({
        type: "none",
        source: "none",
      })),
    ).toThrow(/Board access required/);
  });
});
