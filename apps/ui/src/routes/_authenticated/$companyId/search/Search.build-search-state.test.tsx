import { describe, expect, it } from "vitest";
import { buildSearchState } from ".";

describe("buildSearchState", () => {
  it("writes q and a non-default scope", () => {
    expect(buildSearchState("auth flake", "comments")).toMatchObject({
      q: "auth flake",
      scope: "comments",
    });
  });

  it("omits empty query and default search values", () => {
    expect(buildSearchState("   ", "all")).toMatchObject({
      q: undefined,
      scope: undefined,
      sort: undefined,
    });
  });

  it("returns typed filter arrays and the exact canonical owner id", () => {
    expect(
      buildSearchState(
        "release",
        "tasks",
        {
          status: ["todo"],
          priority: ["high"],
          ownerAgentId: "33333333-3333-4333-8333-333333333333",
        },
        "updated",
      ),
    ).toMatchObject({
      q: "release",
      scope: "tasks",
      sort: "updated",
      status: ["todo"],
      priority: ["high"],
      ownerAgentId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("rejects contradictory owner filter state", () => {
    expect(() =>
      buildSearchState("release", "tasks", {
        ownerAgentId: "33333333-3333-4333-8333-333333333333",
        ownerUserId: "user-1",
      }),
    ).toThrow("Search filters cannot contain both an agent owner and a user owner");
  });
});
