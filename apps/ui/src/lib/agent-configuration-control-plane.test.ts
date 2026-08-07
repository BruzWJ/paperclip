// @vitest-environment node

import { describe, expect, it } from "vitest";
import { partitionAgentConfigurationPatch } from "./agent-configuration-control-plane";

describe("partitionAgentConfigurationPatch", () => {
  it("routes the board-owned instruction only to operational configuration", () => {
    expect(
      partitionAgentConfigurationPatch({
        name: "Reviewer",
        instruction: "Review every change before reporting completion.",
      }),
    ).toEqual({
      runtimeAgent: { name: "Reviewer" },
      operational: {
        instruction: "Review every change before reporting completion.",
      },
      hasAdapterRevisionChange: false,
    });
  });

  it("keeps an instruction clear request in the operational configuration", () => {
    expect(partitionAgentConfigurationPatch({ instruction: null })).toEqual({
      runtimeAgent: {},
      operational: { instruction: null },
      hasAdapterRevisionChange: false,
    });
  });
});
