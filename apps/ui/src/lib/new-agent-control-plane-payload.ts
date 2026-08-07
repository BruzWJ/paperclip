import type {
  AgentAdapterRevisionConfigurationInput,
  AgentOperationalConfigurationUpdateInput,
  CompanySkillChannel,
  CompanySkillPin,
  RuntimeAgentCreateConfigurationInput,
} from "@paperclipai/shared";
import { parseCompanySkillPins, parseMoneyAmount } from "@paperclipai/shared";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type { RuntimeAgentConfigurationValues } from "../components/RuntimeAgentConfigurationFields";
import { buildNewAgentRuntimeConfig } from "./new-agent-runtime-config";

export interface NewAgentControlPlanePayloads {
  runtimeAgent: RuntimeAgentCreateConfigurationInput;
  adapterRevision: AgentAdapterRevisionConfigurationInput;
  operational: AgentOperationalConfigurationUpdateInput;
}

export function buildNewAgentControlPlanePayloads(input: {
  name: string;
  title?: string;
  capabilities?: string;
  reportsTo?: string | null;
  runtimeAccess: RuntimeAgentConfigurationValues;
  configValues: CreateConfigValues;
  adapterConfig: Record<string, unknown>;
  companySkillPins: readonly CompanySkillPin[];
  skillChannel: CompanySkillChannel;
}): NewAgentControlPlanePayloads {
  return {
    runtimeAgent: {
      name: input.name.trim(),
      title: input.title?.trim() || null,
      capabilities: input.capabilities?.trim() || null,
      reportsTo: input.reportsTo ?? null,
      contextGrants: { ...input.runtimeAccess.contextGrants },
      actionGrants: { ...input.runtimeAccess.actionGrants },
      mentionReachGrants: { ...input.runtimeAccess.mentionReachGrants },
    },
    adapterRevision: {
      adapterType: input.configValues.adapterType,
      adapterConfig: input.adapterConfig,
      runtimeConfig: buildNewAgentRuntimeConfig({
        cheapModel: input.configValues.cheapModel,
        cheapModelEnabled: input.configValues.cheapModelEnabled,
      }),
      companySkillPins: parseCompanySkillPins(input.companySkillPins),
      skillChannel: input.skillChannel,
    },
    operational: {
      budgetMonthlyAmount: parseMoneyAmount("0"),
    },
  };
}
