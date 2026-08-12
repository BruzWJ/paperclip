// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildAgentUpdatePatch,
  type AgentConfigOverlay,
} from "./agent-config-patch";

function overlay(
  patch: Partial<AgentConfigOverlay> = {},
): AgentConfigOverlay {
  return {
    identity: {},
    adapterConfig: {},
    runtime: {},
    ...patch,
  };
}

describe("buildAgentUpdatePatch", () => {
  it("replaces adapter config without adding execution-session policy", () => {
    expect(
      buildAgentUpdatePatch(
        { model: "fixture-standard" },
        overlay({ adapterConfig: { model: "fixture-large" } }),
      ),
    ).toEqual({
      adapterConfig: { model: "fixture-large" },
    });
  });

  it("retains a nullable board-owned instruction in the outgoing patch", () => {
    expect(
      buildAgentUpdatePatch(
        { model: "fixture-standard" },
        overlay({ identity: { instruction: null } }),
      ),
    ).toEqual({ instruction: null });
  });
});
