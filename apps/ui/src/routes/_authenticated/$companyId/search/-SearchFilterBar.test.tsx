import { describe, expect, it } from "vitest";

import { buildSearchFilterOptions } from "./-SearchFilterBar";

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "user-1";

describe("search filter bar options", () => {
  it("builds owner options from exact identities without a board sentinel", () => {
    const options = buildSearchFilterOptions({
      agents: [{ id: AGENT_ID, name: "Codex" }],
      projects: [],
      labels: [],
      currentUserId: USER_ID,
    });

    expect(options.owner.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: USER_ID, label: "Me" },
      { value: AGENT_ID, label: "Codex" },
    ]);
  });
});
