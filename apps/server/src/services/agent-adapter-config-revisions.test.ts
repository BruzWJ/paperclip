import type { AdapterImplementationIdentity } from "@paperclipai/shared";
import type { AcpSubprocessAdapterDefinition } from "@paperclipai/adapter-utils";
import { describe, expect, it } from "vitest";
import {
  deriveAgentAdapterConfigRevision,
  type AgentAdapterRuntimeMetadata,
} from "./agent-adapter-config-revisions.js";

const FIXTURE_AGENT = "fixture-agent";

const implementationIdentity: AdapterImplementationIdentity = Object.freeze({
  adapterType: FIXTURE_AGENT,
  definitionVersion: "acpx-runtime/v1",
  protocolVersion: 1,
  origin: "builtin",
  packageName: "acpx",
  packageVersion: "runtime",
  buildIdentity: `acpx-runtime:${FIXTURE_AGENT}`,
  artifactDigest: "a".repeat(64),
});

const fixtureDefinition: AcpSubprocessAdapterDefinition = Object.freeze({
  version: "acpx-runtime/v1",
  launchProfile: Object.freeze({ registryName: FIXTURE_AGENT }),
  environment: Object.freeze({
    cwd: "execution-workspace",
    additionalDirectories: "authorized-workspace-only",
    drivers: Object.freeze(["local"] as const),
    environmentKeys: Object.freeze([]),
  }),
  runtime: Object.freeze({
    controls: Object.freeze(["session/status", "session/set_config_option"]),
  }),
  ui: Object.freeze({
    label: FIXTURE_AGENT,
    description: "Fixture emitted by ACPX discovery.",
  }),
  configSchema: Object.freeze({
    fields: Object.freeze([
      Object.freeze({
        key: "model",
        label: "Model",
        type: "select" as const,
        options: Object.freeze([
          Object.freeze({ label: "Fixture model one", value: "model-1" }),
          Object.freeze({ label: "Fixture model two", value: "model-2" }),
        ]),
        required: true,
      }),
      Object.freeze({
        key: "reasoning_effort",
        label: "Reasoning effort",
        type: "select" as const,
        options: Object.freeze([
          Object.freeze({ label: "Low", value: "low" }),
          Object.freeze({ label: "High", value: "high" }),
        ]),
        required: true,
      }),
    ]),
  }),
  configOptions: Object.freeze([
    Object.freeze({
      id: "model",
      configKey: "model",
      label: "Model",
      required: true as const,
      values: Object.freeze([
        Object.freeze({ label: "Fixture model one", value: "model-1" }),
        Object.freeze({ label: "Fixture model two", value: "model-2" }),
      ]),
    }),
    Object.freeze({
      id: "reasoning_effort",
      configKey: "reasoning_effort",
      label: "Reasoning effort",
      required: true as const,
      values: Object.freeze([
        Object.freeze({ label: "Low", value: "low" }),
        Object.freeze({ label: "High", value: "high" }),
      ]),
    }),
  ]),
  modelConfigOptionId: "model",
  models: Object.freeze([
    Object.freeze({
      id: "model-1",
      label: "Fixture model one",
      value: "model-1",
      limits: null,
    }),
    Object.freeze({
      id: "model-2",
      label: "Fixture model two",
      value: "model-2",
      limits: null,
    }),
  ]),
  modelProfiles: Object.freeze([]),
  configurationDoc: "Supplied by the fixture ACPX discovery result.",
});

const runtimeMetadata: AgentAdapterRuntimeMetadata = Object.freeze({
  implementationIdentity,
  definition: fixtureDefinition,
});

function derive(model = "model-1", reasoningEffort = "high") {
  return deriveAgentAdapterConfigRevision({
    adapterType: FIXTURE_AGENT,
    adapterConfig: { model, reasoning_effort: reasoningEffort },
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
    skillChannel: "operator_native",
    runtimeMetadata,
  });
}

describe("canonical ACP adapter configuration revision", () => {
  it("persists ACPX model and reasoning selections in the immutable JSON configuration", () => {
    const revision = derive();
    expect(revision).toMatchObject({
      adapterType: FIXTURE_AGENT,
      adapterConfigSchemaVersion: "paperclip.acp-adapter-config/v1",
      normalizedConfig: { model: "model-1", reasoning_effort: "high" },
      acpConfiguration: {
        contractVersion: "acpx-runtime/v1",
        launchProfile: {
          registryName: FIXTURE_AGENT,
        },
        sessionConfigSelections: [
          { configId: "model", value: "model-1" },
          { configId: "reasoning_effort", value: "high" },
        ],
        model: {
          id: "model-1",
          limits: null,
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
        skillChannel: "operator_native",
      },
    });
  });

  it("derives a stable digest from immutable ACP and execution facts", () => {
    expect(derive().digest).toBe(derive().digest);
    expect(derive("model-2").digest).not.toBe(derive().digest);
  });

  it("fails closed for undeclared config and unsupported environments", () => {
    expect(() =>
      deriveAgentAdapterConfigRevision({
        adapterType: FIXTURE_AGENT,
        adapterConfig: {
          model: "model-1",
          reasoning_effort: "high",
          apiKey: "must-not-exist",
        },
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
        adapterType: FIXTURE_AGENT,
        adapterConfig: { model: "model-1", reasoning_effort: "high" },
        executionTarget: {
          environmentId: "00000000-0000-4000-8000-000000000001",
          driver: "local",
          digest: "b".repeat(64),
        },
        companySkillPins: [],
        skillChannel: "isolated_skills_home",
        runtimeMetadata,
      }),
    ).toThrow(/isolated skills-home contract/);
    expect(() =>
      deriveAgentAdapterConfigRevision({
        adapterType: FIXTURE_AGENT,
        adapterConfig: { model: "model-1", reasoning_effort: "high" },
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
