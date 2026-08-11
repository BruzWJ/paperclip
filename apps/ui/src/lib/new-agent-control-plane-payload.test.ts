// @vitest-environment node

import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type { RuntimeAgentConfigurationValues } from "../components/RuntimeAgentConfigurationFields";
import { describe, expect, it } from "vitest";
import { buildNewAgentControlPlanePayloads } from "./new-agent-control-plane-payload";

const runtimeAccess = {
  contextGrants: {},
  actionGrants: {},
  mentionReachGrants: {},
} as RuntimeAgentConfigurationValues;

const configValues = { adapterType: "codex" } as CreateConfigValues;

function buildPayload(instruction?: string) {
  return buildNewAgentControlPlanePayloads({
    name: "Reviewer",
    instruction,
    reportsTo: null,
    runtimeAccess,
    configValues,
    adapterConfig: {},
    companySkillPins: [],
  });
}

describe("buildNewAgentControlPlanePayloads", () => {
  it("preserves authored instruction text in the runtime agent payload", () => {
    expect(buildPayload("  Review every change before reporting completion.  ").runtimeAgent)
      .toMatchObject({ instruction: "  Review every change before reporting completion.  " });
  });

  it("stores a blank or omitted instruction as null", () => {
    expect(buildPayload("   ").runtimeAgent).toMatchObject({ instruction: null });
    expect(buildPayload().runtimeAgent).toMatchObject({ instruction: null });
  });
});
