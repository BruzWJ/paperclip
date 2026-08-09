import type {
  Agent,
  AgentAdapterConfigRevision,
  AgentAdapterRevisionConfigurationInput,
  AgentOperationalConfigurationUpdateInput,
  RuntimeAgentConfigurationUpdate,
} from "@paperclipai/shared";
import { publicAgentAdapterAcpConfigurationSchema } from "@paperclipai/shared";

const RUNTIME_AGENT_CONFIGURATION_KEYS = [
  "name",
  "title",
  "reportsTo",
  "capabilities",
  "instruction",
  "contextGrants",
  "actionGrants",
  "mentionReachGrants",
] as const;
const OPERATIONAL_KEYS = [] as const;
const ADAPTER_REVISION_KEYS = [
  "adapterType",
  "adapterConfig",
  "runtimeConfig",
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
        RUNTIME_AGENT_CONFIGURATION_KEYS,
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
  currentRevision: AgentAdapterConfigRevision | null;
  patch: Record<string, unknown>;
}): AgentAdapterRevisionConfigurationInput {
  if (
    input.agent.currentAdapterConfigRevisionId !== null
    && (!input.currentRevision
      || input.currentRevision.id !== input.agent.currentAdapterConfigRevisionId
      || input.currentRevision.agentId !== input.agent.id
      || input.currentRevision.companyId !== input.agent.companyId)
  ) {
    throw new Error("Load the agent's exact current adapter revision before saving.");
  }
  const acpConfiguration = input.currentRevision
    ? publicAgentAdapterAcpConfigurationSchema.parse(
        input.currentRevision.acpConfiguration,
      )
    : null;

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
  return {
    adapterType,
    adapterConfig,
    runtimeConfig:
      (input.patch.runtimeConfig as Record<string, unknown> | undefined) ??
      input.agent.runtimeConfig,
    companySkillPins: acpConfiguration?.companySkillPins ?? [],
    skillChannel: acpConfiguration?.skillChannel ?? "operator_native",
  };
}
