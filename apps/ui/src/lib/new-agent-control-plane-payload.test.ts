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

  it("preserves the exact ACPX schema selection in adapter config", () => {
    const payload = buildNewAgentControlPlanePayloads({
      name: "Reviewer",
      reportsTo: null,
      runtimeAccess,
      configValues: {
        adapterType: "codex",
        adapterSchemaValues: { model: "gpt-5.6-sol" },
      },
      adapterConfig: {
        model: "gpt-5.6-sol",
      },
    });

    expect(payload.adapterRevision).toEqual({
      adapterType: "codex",
      adapterConfig: {
        model: "gpt-5.6-sol",
      },
    });
  });
});
