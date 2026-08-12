import type {
  Agent,
  AgentAdapterConfigRevision,
  AgentAdapterRevisionConfigurationInput,
  AgentOperationalConfigurationUpdateInput,
  RuntimeAgentConfigurationUpdate,
} from "@paperclipai/shared";
import { agentAdapterAcpConfigurationSchema } from "@paperclipai/shared";

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
  if (input.currentRevision) {
    agentAdapterAcpConfigurationSchema.parse(
      input.currentRevision.acpConfiguration,
    );
  }

  const currentAdapterType =
    input.currentRevision?.acpConfiguration.launchProfile.registryName ?? null;
  const currentAdapterConfig = input.currentRevision
    ? Object.fromEntries(
        input.currentRevision.acpConfiguration.sessionConfigSelections.map(
          (selection) => [selection.configId, selection.value],
        ),
      )
    : null;
  const adapterType =
    (input.patch.adapterType as string | undefined) ?? currentAdapterType;
  const adapterConfig =
    (input.patch.adapterConfig as Record<string, string | boolean> | undefined) ??
    currentAdapterConfig;
  if (!adapterType || !adapterConfig) {
    throw new Error(
      "Select an adapter and complete its configuration before saving.",
    );
  }
  return {
    adapterType,
    adapterConfig,
  };
}
