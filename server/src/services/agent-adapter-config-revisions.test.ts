import type { AdapterImplementationIdentity } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { codexAdapter } from "../adapters/codex.js";
import {
  deriveAgentAdapterConfigRevision,
  type AgentAdapterRuntimeMetadata,
} from "./agent-adapter-config-revisions.js";

const implementationIdentity: AdapterImplementationIdentity = Object.freeze({
  adapterType: "codex",
  definitionVersion: "acp-subprocess/v1",
  protocolVersion: 1,
  origin: "builtin",
  packageName: "@paperclipai/server",
  packageVersion: "0.3.1",
  buildIdentity: "@paperclipai/server@0.3.1:codex",
  artifactDigest: "a".repeat(64),
});

const runtimeMetadata: AgentAdapterRuntimeMetadata = Object.freeze({
  implementationIdentity,
  definition: codexAdapter.definition,
});

function derive(model = "gpt-5.6") {
  return deriveAgentAdapterConfigRevision({
    adapterType: "codex",
    adapterConfig: { model },
    executionTarget: {
      environmentId: "00000000-0000-4000-8000-000000000001",
      driver: "local",
      digest: "b".repeat(64),
    },
    companySkillPins: [
      {
        key: "review",
        versionId: "00000000-0000-4000-8000-000000000003",
      },
    ],
    skillChannel: "isolated_skills_home",
    runtimeMetadata,
  });
}

describe("canonical ACP adapter configuration revision", () => {
  it("persists one declarative ACP configuration with exact model limits", () => {
    const revision = derive();
    expect(revision).toMatchObject({
      adapterType: "codex",
      adapterConfigSchemaVersion: "paperclip.acp-adapter-config/v1",
      normalizedConfig: { model: "gpt-5.6" },
      acpConfiguration: {
        contractVersion: "acp-subprocess/v1",
        launchProfile: {
          registryName: "codex",
          frontendPackage: "@agentclientprotocol/codex-acp",
          frontendVersion: "1.1.7",
          frontendDigest: "0deb6b820dfed8804cd76b16a50210fe12202e5e339b5edaa23f6987f1742e0a",
        },
        sessionConfigSelections: [
          { configId: "model", value: "gpt-5.6" },
        ],
        model: {
          id: "gpt-5.6",
          limits: {
            contextTokenLimit: 1_050_000,
            inputTokenLimit: 922_000,
            outputTokenLimit: 128_000,
          },
        },
        executionTargetSelector: {
          defaultEnvironmentId: "00000000-0000-4000-8000-000000000001",
          executionTargetDriver: "local",
          executionTargetDigest: "b".repeat(64),
        },
        workspaceSelector: {
          kind: "issue_execution_workspace",
        },
        companySkillPins: [
          {
            key: "review",
            versionId: "00000000-0000-4000-8000-000000000003",
          },
        ],
        skillChannel: "isolated_skills_home",
      },
    });
  });

  it("derives a stable digest from immutable ACP and execution facts", () => {
    expect(derive().digest).toBe(derive().digest);
    expect(derive("gpt-5.6-sol").digest).not.toBe(derive().digest);
  });

  it("fails closed for undeclared config and unsupported environments", () => {
    expect(() =>
      deriveAgentAdapterConfigRevision({
        adapterType: "codex",
        adapterConfig: { model: "gpt-5.6", apiKey: "must-not-exist" },
        executionTarget: {
          environmentId: "00000000-0000-4000-8000-000000000001",
          driver: "local",
          digest: "b".repeat(64),
        },
        companySkillPins: [],
        skillChannel: "operator_native",
        runtimeMetadata,
      }),
    ).toThrow(/unknown field apiKey/);
    expect(() =>
      deriveAgentAdapterConfigRevision({
        adapterType: "codex",
        adapterConfig: { model: "gpt-5.6" },
        executionTarget: {
          environmentId: "00000000-0000-4000-8000-000000000001",
          driver: "ssh",
          digest: "b".repeat(64),
        },
        companySkillPins: [],
        skillChannel: "operator_native",
        runtimeMetadata: {
          ...runtimeMetadata,
          definition: {
            ...runtimeMetadata.definition,
            environment: {
              ...runtimeMetadata.definition.environment,
              drivers: ["local"],
            },
          },
        },
      }),
    ).toThrow(/does not support execution target driver/);
  });
});
