import { describe, expect, it } from "vitest";
import { applyOwnerSelectionId, ownerSelectionId, type SearchFilters } from "./search-filters";

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "user-1";

describe("owner search filter identity", () => {
  it("uses the exact persisted owner id as the selection value", () => {
    expect(ownerSelectionId({ ownerAgentId: AGENT_ID })).toBe(AGENT_ID);
    expect(ownerSelectionId({ ownerUserId: USER_ID })).toBe(USER_ID);
  });

  it("maps only the exact current user id or a canonical agent UUID", () => {
    expect(applyOwnerSelectionId({}, USER_ID, USER_ID)).toEqual({
      ownerUserId: USER_ID,
    });
    expect(applyOwnerSelectionId({}, AGENT_ID, USER_ID)).toEqual({
      ownerAgentId: AGENT_ID,
    });
    expect(applyOwnerSelectionId({ ownerAgentId: AGENT_ID }, undefined, USER_ID)).toEqual({});
  });

  it.each(["me", "board", `agent:${AGENT_ID}`, "33333333-3333-4333-8333-AAAAAAAAAAAA"])(
    "rejects the legacy or non-canonical owner selection %s",
    (ownerId) => {
      expect(() => applyOwnerSelectionId({} as SearchFilters, ownerId, USER_ID)).toThrow(
        "Owner agent selection must be a canonical UUID",
      );
    },
  );
});
