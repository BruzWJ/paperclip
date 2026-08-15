import type {
  AgentAdapterRevisionConfigurationInput,
  AgentOperationalConfigurationUpdateInput,
  RuntimeAgentCreateConfigurationInput,
} from "@paperclipai/shared";
import { parseMoneyAmount } from "@paperclipai/shared";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type { RuntimeAgentConfigurationValues } from "./runtime-agent-configuration";

export interface NewAgentControlPlanePayloads {
  runtimeAgent: RuntimeAgentCreateConfigurationInput;
  adapterRevision: AgentAdapterRevisionConfigurationInput;
  operational: AgentOperationalConfigurationUpdateInput;
}

export function buildNewAgentControlPlanePayloads(input: {
  name: string;
  title?: string;
  capabilities?: string;
  instruction?: string;
  reportsTo?: string | null;
  runtimeAccess: RuntimeAgentConfigurationValues;
  configValues: CreateConfigValues;
  adapterConfig: Record<string, string | boolean>;
}): NewAgentControlPlanePayloads {
  return {
    runtimeAgent: {
      name: input.name.trim(),
      title: input.title?.trim() || null,
      capabilities: input.capabilities?.trim() || null,
      reportsTo: input.reportsTo ?? null,
      instruction: input.instruction?.trim().length ? input.instruction : null,
      contextGrants: { ...input.runtimeAccess.contextGrants },
      actionGrants: { ...input.runtimeAccess.actionGrants },
      mentionReachGrants: { ...input.runtimeAccess.mentionReachGrants },
    },
    adapterRevision: {
      adapterType: input.configValues.adapterType,
      adapterConfig: input.adapterConfig,
    },
    operational: {
      budgetMonthlyAmount: parseMoneyAmount("0"),
    },
  };
}
