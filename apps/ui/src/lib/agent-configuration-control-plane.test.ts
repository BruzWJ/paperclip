// @vitest-environment node

import { describe, expect, it } from "vitest";
import { partitionAgentConfigurationPatch } from "./agent-configuration-control-plane";

describe("partitionAgentConfigurationPatch", () => {
  it("routes the instruction to runtime agent configuration", () => {
    expect(
      partitionAgentConfigurationPatch({
        name: "Reviewer",
        instruction: "Review every change before reporting completion.",
      }),
    ).toEqual({
      runtimeAgent: {
        name: "Reviewer",
        instruction: "Review every change before reporting completion.",
      },
      operational: {},
      hasAdapterRevisionChange: false,
    });
  });

  it("keeps an instruction clear request in the runtime agent configuration", () => {
    expect(partitionAgentConfigurationPatch({ instruction: null })).toEqual({
      runtimeAgent: { instruction: null },
      operational: {},
      hasAdapterRevisionChange: false,
    });
  });
});
