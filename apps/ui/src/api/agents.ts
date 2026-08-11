import type {
  Agent,
  AgentAdapterConfigRevision,
  AgentAdapterRevisionConfigurationInput,
  AgentCompanySkillPinsResponse,
  AgentDetail,
  AgentRuntimeState,
  AgentOperationalConfigurationUpdateInput,
  AgentPluginManagementBinding,
  ClearAgentErrorResponse,
  RuntimeAgentCreateConfigurationInput,
  RuntimeAgentConfigurationSnapshot,
  RuntimeAgentConfigurationUpdate,
  CompanySkillPin,
  InvokableIssueOwnerCatalogEntry,
} from "@paperclipai/shared";
import type {
  AdapterModelProfileDefinition,
  AdapterModelProfileKey,
} from "@paperclipai/adapter-utils";
import { api } from "./client";

export type { AdapterModelProfileKey };
export type AdapterModelProfile = AdapterModelProfileDefinition;

export interface OrgNode {
  id: string;
  name: string;
  subtitle: string;
  status: string;
  reports: OrgNode[];
}

export interface RuntimeAgentCreateResponse {
  agent: Agent;
  configuration: RuntimeAgentConfigurationSnapshot;
  auditId: string;
  retried: boolean;
}

export interface AgentAdapterRevisionCreateResponse {
  revision: AgentAdapterConfigRevision;
  current: {
    agentId: string;
    adapterType: string | null;
    adapterConfig: Record<string, unknown> | null;
    runtimeConfig: Record<string, unknown>;
    currentAdapterConfigRevisionId: string | null;
    updatedAt: Date;
  };
  appended: boolean;
}

export interface AgentPluginManagementAdoptionResponse {
  agent: Agent;
  pluginManagement: AgentPluginManagementBinding;
}

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}companyId=${encodeURIComponent(companyId)}`;
}

function agentPath(id: string, companyId?: string, suffix = "") {
  return withCompanyScope(`/agents/${encodeURIComponent(id)}${suffix}`, companyId);
}

export const agentsApi = {
  list: (companyId: string) => api.get<Agent[]>(`/companies/${companyId}/agents`),
  listInvokableIssueOwners: (companyId: string) =>
    api.get<InvokableIssueOwnerCatalogEntry[]>(
      `/companies/${encodeURIComponent(companyId)}/issue-owner-catalog`,
    ),
  org: (companyId: string) => api.get<OrgNode[]>(`/companies/${companyId}/org`),
  get: (id: string, companyId?: string) =>
    api.get<AgentDetail>(agentPath(id, companyId)),
  getRuntimeConfiguration: (id: string, companyId?: string) =>
    api.get<RuntimeAgentConfigurationSnapshot>(
      agentPath(id, companyId, "/runtime-configuration"),
    ),
  updateRuntimeConfiguration: (
    id: string,
    data: RuntimeAgentConfigurationUpdate,
    companyId?: string,
  ) =>
    api.patch<RuntimeAgentConfigurationSnapshot>(
      agentPath(id, companyId, "/runtime-configuration"),
      data,
    ),
  createRuntimeAgent: (
    companyId: string,
    data: RuntimeAgentCreateConfigurationInput,
    idempotencyKey: string,
  ) =>
    api.post<RuntimeAgentCreateResponse>(
      `/companies/${companyId}/runtime-agents`,
      data,
      { headers: { "Idempotency-Key": idempotencyKey } },
    ),
  createAdapterConfigRevision: (
    id: string,
    data: AgentAdapterRevisionConfigurationInput,
    companyId?: string,
  ) =>
    api.post<AgentAdapterRevisionCreateResponse>(
      agentPath(id, companyId, "/adapter-config-revisions"),
      data,
    ),
  listAdapterConfigRevisions: (id: string, companyId?: string) =>
    api.get<AgentAdapterConfigRevision[]>(
      agentPath(id, companyId, "/adapter-config-revisions"),
    ),
  getCurrentAdapterConfigRevision: (id: string, companyId?: string) =>
    api.get<AgentAdapterConfigRevision | null>(
      agentPath(id, companyId, "/adapter-config-revisions/current"),
    ),
  updateOperationalConfiguration: (
    id: string,
    data: AgentOperationalConfigurationUpdateInput,
    companyId?: string,
  ) =>
    api.patch<Agent>(
      agentPath(id, companyId, "/operational-configuration"),
      data,
    ),
  pause: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/pause"), {}),
  resume: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/resume"), {}),
  clearError: (id: string, companyId?: string) =>
    api.post<ClearAgentErrorResponse>(agentPath(id, companyId, "/clear-error"), {}),
  adoptPluginManagement: (id: string, companyId?: string) =>
    api.post<AgentPluginManagementAdoptionResponse>(
      agentPath(id, companyId, "/plugin-management/adopt"),
      {},
    ),
  terminate: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/terminate"), {}),
  companySkillPins: (
    id: string,
    companyId?: string,
  ) =>
    api.get<AgentCompanySkillPinsResponse>(
      agentPath(id, companyId, "/company-skill-pins"),
    ),
  replaceCompanySkillPins: (
    id: string,
    entries: CompanySkillPin[],
    companyId?: string,
  ) =>
    api.put<AgentCompanySkillPinsResponse>(
      agentPath(id, companyId, "/company-skill-pins"),
      { entries },
    ),
  runtimeState: (id: string, companyId?: string) =>
    api.get<AgentRuntimeState | null>(agentPath(id, companyId, "/runtime-state")),
  adapterModelProfiles: (companyId: string, type: string) =>
    api.get<AdapterModelProfile[]>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/model-profiles`,
    ),
};
