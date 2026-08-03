import type {
  Agent,
  AgentAdapterConfigRevision,
  AgentAdapterRevisionConfigurationInput,
  AgentOperationalConfigurationUpdateInput,
  RuntimeAgentConfigurationUpdate,
} from "@paperclipai/shared";
import { agentAdapterAcpConfigurationSchema } from "@paperclipai/shared";

const RUNTIME_AGENT_IDENTITY_KEYS = [
  "name",
  "title",
  "reportsTo",
  "capabilities",
] as const;
const OPERATIONAL_KEYS = [] as const;
const ADAPTER_REVISION_KEYS = [
  "adapterType",
  "adapterConfig",
  "runtimeConfig",
  "defaultEnvironmentId",
] as const;

function selectOwnKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
) {
  return Object.fromEntries(
    keys
      .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
      .map((key) => [key, value[key]]),
  );
}

export function partitionAgentConfigurationPatch(
  patch: Record<string, unknown>,
) {
  return {
    runtimeAgent:
      selectOwnKeys(
        patch,
        RUNTIME_AGENT_IDENTITY_KEYS,
      ) as RuntimeAgentConfigurationUpdate,
    operational:
      selectOwnKeys(
        patch,
        OPERATIONAL_KEYS,
      ) as AgentOperationalConfigurationUpdateInput,
    hasAdapterRevisionChange: ADAPTER_REVISION_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(patch, key),
    ),
  };
}

export function buildAdapterRevisionConfiguration(input: {
  agent: Agent;
  currentRevision: AgentAdapterConfigRevision;
  patch: Record<string, unknown>;
}): AgentAdapterRevisionConfigurationInput {
  if (
    !input.agent.currentAdapterConfigRevisionId
    || input.currentRevision.id !== input.agent.currentAdapterConfigRevisionId
    || input.currentRevision.agentId !== input.agent.id
    || input.currentRevision.companyId !== input.agent.companyId
  ) {
    throw new Error(
      "Load the agent's exact current adapter revision before saving.",
    );
  }
  const acpConfiguration = agentAdapterAcpConfigurationSchema.parse(
    input.currentRevision.acpConfiguration,
  );
  const adapterType =
    (input.patch.adapterType as Agent["adapterType"] | undefined) ??
    input.agent.adapterType;
  const adapterConfig =
    (input.patch.adapterConfig as Record<string, unknown> | undefined) ??
    input.agent.adapterConfig;
  if (!adapterType || !adapterConfig) {
    throw new Error(
      "Select an adapter and complete its configuration before saving.",
    );
  }
  const defaultEnvironmentId =
    (input.patch.defaultEnvironmentId as string | null | undefined) ??
    input.agent.defaultEnvironmentId;
  if (!defaultEnvironmentId) {
    throw new Error(
      "Select an execution environment before saving.",
    );
  }
  return {
    adapterType,
    adapterConfig,
    defaultEnvironmentId,
    runtimeConfig:
      (input.patch.runtimeConfig as Record<string, unknown> | undefined) ??
      input.agent.runtimeConfig,
    companySkillPins: [...acpConfiguration.companySkillPins],
    skillChannel: acpConfiguration.skillChannel,
  };
}
