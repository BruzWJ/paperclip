import { canonicalizeMoneyAmount, type Agent, type AgentAdapterConfigRevision } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  buildAdapterRevisionConfiguration,
  partitionAgentConfigurationPatch,
} from "./agent-configuration-control-plane";

function configuredAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    companyId: "00000000-0000-4000-8000-000000000002",
    name: "Agent",
    urlKey: "agent",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex",
    adapterConfig: {
      model: "gpt-5.6",
    },
    currentAdapterConfigRevisionId:
      "00000000-0000-4000-8000-000000000003",
    runtimeConfig: {},
    defaultEnvironmentId:
      "00000000-0000-4000-8000-000000000004",
    budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
    knownSpendAmount: canonicalizeMoneyAmount("0"),
    pauseReason: null,
    pausedAt: null,
    governance: {},
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function configuredRevision(): AgentAdapterConfigRevision {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    companyId: "00000000-0000-4000-8000-000000000002",
    agentId: "00000000-0000-4000-8000-000000000001",
    revisionNumber: 1,
    adapterType: "codex",
    implementationIdentity: {
      adapterType: "codex",
      definitionVersion: "acp-subprocess/v1",
      protocolVersion: 1,
      origin: "builtin",
      packageName: "@paperclipai/server",
      packageVersion: "0.3.1",
      buildIdentity: "@paperclipai/server@0.3.1:codex",
      artifactDigest: "a".repeat(64),
    },
    adapterConfigSchemaVersion: "paperclip.acp-adapter-config/v1",
    defaultEnvironmentId: "00000000-0000-4000-8000-000000000004",
    executionTargetDriver: "local",
    executionTargetDigest: "b".repeat(64),
    normalizedConfig: { model: "gpt-5.6" },
    runtimeConfig: {},
    acpConfiguration: {
      contractVersion: "acp-subprocess/v1",
      launchProfile: {
        registryName: "codex",
        targetNativeCli: "codex",
        command: "codex-acp",
        args: [],
        frontendPackage: "@agentclientprotocol/codex-acp",
        frontendVersion: "1.1.7",
        frontendDigest: "0deb6b820dfed8804cd76b16a50210fe12202e5e339b5edaa23f6987f1742e0a",
      },
      sessionConfigSelections: [{ configId: "model", value: "gpt-5.6" }],
      model: {
        id: "gpt-5.6",
        label: "GPT-5.6",
        value: "gpt-5.6",
        limits: {
          contextTokenLimit: 1_050_000,
          inputTokenLimit: 922_000,
          outputTokenLimit: 128_000,
        },
      },
      executionTargetSelector: {
        defaultEnvironmentId: "00000000-0000-4000-8000-000000000004",
        executionTargetDriver: "local",
        executionTargetDigest: "b".repeat(64),
      },
      workspaceSelector: { kind: "issue_execution_workspace" },
      companySkillPins: [
        {
          key: "research",
          versionId: "00000000-0000-4000-8000-000000000005",
        },
      ],
      skillChannel: "isolated_skills_home",
    },
    digest: "c".repeat(64),
    parentRevisionId: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("agent configuration control-plane partition", () => {
  it("never sends adapter or operational fields through the runtime identity owner", () => {
    expect(
      partitionAgentConfigurationPatch({
        name: "Renamed",
        title: "Builder",
        reportsTo: null,
        capabilities: "Build",
        defaultEnvironmentId:
          "00000000-0000-4000-8000-000000000004",
        adapterType: "codex",
        adapterConfig: { model: "gpt-5.6-sol" },
        runtimeConfig: { modelProfiles: { cheap: { enabled: true } } },
        replaceAdapterConfig: true,
        knownSpendAmount: canonicalizeMoneyAmount("999"),
      }),
    ).toEqual({
      runtimeAgent: {
        name: "Renamed",
        title: "Builder",
        reportsTo: null,
        capabilities: "Build",
      },
      operational: {},
      hasAdapterRevisionChange: true,
    });
  });

  it("builds one complete immutable revision and fails closed for an unconfigured agent", () => {
    expect(
      buildAdapterRevisionConfiguration({
        agent: configuredAgent(),
        currentRevision: configuredRevision(),
        patch: { runtimeConfig: { modelProfiles: { cheap: { enabled: true } } } },
      }),
    ).toEqual({
      adapterType: "codex",
      adapterConfig: {
        model: "gpt-5.6",
      },
      defaultEnvironmentId:
        "00000000-0000-4000-8000-000000000004",
      runtimeConfig: { modelProfiles: { cheap: { enabled: true } } },
      companySkillPins: [
        {
          key: "research",
          versionId: "00000000-0000-4000-8000-000000000005",
        },
      ],
      skillChannel: "isolated_skills_home",
    });

    expect(() =>
      buildAdapterRevisionConfiguration({
        agent: configuredAgent({
          adapterType: null,
          adapterConfig: null,
          currentAdapterConfigRevisionId: null,
        }),
        currentRevision: configuredRevision(),
        patch: {},
      }),
    ).toThrow(/exact current adapter revision/);
  });
});
