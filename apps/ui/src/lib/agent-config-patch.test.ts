// @vitest-environment node

import { canonicalizeMoneyAmount, type Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  buildAgentUpdatePatch,
  type AgentConfigOverlay,
} from "./agent-config-patch";

function agent(): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent",
    title: "Engineer",
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    instruction: null,
    adapterType: "codex",
    adapterConfig: { model: "fixture-standard" },
    currentAdapterConfigRevisionId: null,
    runtimeConfig: {},
    budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
    knownSpendAmount: canonicalizeMoneyAmount("0"),
    pauseReason: null,
    pausedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    urlKey: "agent",
  };
}

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
        agent(),
        overlay({ adapterConfig: { model: "fixture-large" } }),
      ),
    ).toEqual({
      adapterConfig: { model: "fixture-large" },
      replaceAdapterConfig: true,
    });
  });

  it("stores the optional cheap profile under modelProfiles", () => {
    expect(
      buildAgentUpdatePatch(
        agent(),
        overlay({
          modelProfiles: {
            cheap: {
              enabled: true,
              adapterConfig: { model: "fixture-small" },
            },
          },
        }),
      ),
    ).toEqual({
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: { model: "fixture-small" },
          },
        },
      },
    });
  });

  it("removes the optional cheap profile canonically", () => {
    const existing = agent();
    existing.runtimeConfig = {
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: { model: "fixture-small" },
        },
      },
    };

    expect(
      buildAgentUpdatePatch(
        existing,
        overlay({ modelProfiles: { cheap: { cleared: true } } }),
      ),
    ).toEqual({ runtimeConfig: {} });
  });

  it("retains a nullable board-owned instruction in the outgoing patch", () => {
    expect(
      buildAgentUpdatePatch(
        agent(),
        overlay({ identity: { instruction: null } }),
      ),
    ).toEqual({ instruction: null });
  });
});
