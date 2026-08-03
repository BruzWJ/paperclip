// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildNewAgentRuntimeConfig } from "./new-agent-runtime-config";

describe("buildNewAgentRuntimeConfig", () => {
  it("creates no run/session policy by default", () => {
    expect(buildNewAgentRuntimeConfig()).toEqual({});
  });

  it("stores only an explicitly enabled cheap model profile", () => {
    expect(
      buildNewAgentRuntimeConfig({
        cheapModel: "fixture-small",
        cheapModelEnabled: true,
      }),
    ).toEqual({
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: { model: "fixture-small" },
        },
      },
    });
  });
});
