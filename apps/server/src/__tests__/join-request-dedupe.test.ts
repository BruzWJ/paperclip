import { describe, expect, it } from "vitest";
import {
  collapseDuplicatePendingUserJoinRequests,
  findReusableUserJoinRequest,
} from "../lib/join-request-dedupe.js";

describe("findReusableUserJoinRequest", () => {
  it("reuses the newest pending request for the same user", () => {
    const rows = [
      {
        id: "pending-new",
        status: "pending_approval",
        requestingUserId: "user-1",
        requestEmailSnapshot: "person@example.com",
      },
      {
        id: "pending-old",
        status: "pending_approval",
        requestingUserId: "user-1",
        requestEmailSnapshot: "person@example.com",
      },
      {
        id: "other-user",
        status: "pending_approval",
        requestingUserId: "user-2",
        requestEmailSnapshot: "other@example.com",
      },
    ] as const;

    expect(
      findReusableUserJoinRequest(rows, {
        requestingUserId: "user-1",
        requestEmailSnapshot: "person@example.com",
      })?.id,
    ).toBe("pending-new");
  });

  it("falls back to email matching when the user id is unavailable", () => {
    const rows = [
      {
        id: "approved-existing",
        status: "approved",
        requestingUserId: null,
        requestEmailSnapshot: "Person@Example.com",
      },
      {
        id: "unidentified-request",
        status: "pending_approval",
        requestingUserId: null,
        requestEmailSnapshot: null,
      },
    ] as const;

    expect(
      findReusableUserJoinRequest(rows, {
        requestingUserId: null,
        requestEmailSnapshot: "person@example.com",
      })?.id,
    ).toBe("approved-existing");
  });
});

describe("collapseDuplicatePendingUserJoinRequests", () => {
  it("keeps only the newest pending user row per requester", () => {
    const rows = [
      {
        id: "user-new",
        status: "pending_approval",
        requestingUserId: "user-1",
        requestEmailSnapshot: "person@example.com",
      },
      {
        id: "user-old",
        status: "pending_approval",
        requestingUserId: "user-1",
        requestEmailSnapshot: "person@example.com",
      },
      {
        id: "approved-history",
        status: "approved",
        requestingUserId: "user-1",
        requestEmailSnapshot: "person@example.com",
      },
      {
        id: "unidentified-pending",
        status: "pending_approval",
        requestingUserId: null,
        requestEmailSnapshot: null,
      },
    ] as const;

    expect(
      collapseDuplicatePendingUserJoinRequests(rows).map((row) => row.id),
    ).toEqual(["user-new", "approved-history", "unidentified-pending"]);
  });
});
