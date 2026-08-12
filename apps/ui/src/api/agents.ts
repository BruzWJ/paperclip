import type {
  Agent,
  AgentAdapterConfigRevision,
  AgentAdapterRevisionConfigurationInput,
  AgentDetail,
  AgentRuntimeState,
  AgentOperationalConfigurationUpdateInput,
  AgentPluginManagementBinding,
  RuntimeAgentCreateConfigurationInput,
  RuntimeAgentConfigurationSnapshot,
  RuntimeAgentConfigurationUpdate,
  InvokableTaskOwnerCatalogEntry,
} from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

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
    currentAdapterConfigRevisionId: string | null;
    updatedAt: Date;
  };
  appended: boolean;
}

export interface AgentPluginManagementAdoptionResponse {
  agent: Agent;
  pluginManagement: AgentPluginManagementBinding;
}

function agentPath(id: string, suffix = "") {
  return `/agents/${encodeURIComponent(id)}${suffix}`;
}

export const agentsApi = {
  list: (companyId: string) => api.get<Agent[]>(`/companies/${companyId}/agents`),
  listInvokableTaskOwners: (companyId: string) =>
    api.get<InvokableTaskOwnerCatalogEntry[]>(
      `/companies/${encodeURIComponent(companyId)}/task-owner-catalog`,
    ),
  org: (companyId: string) => api.get<OrgNode[]>(`/companies/${companyId}/org`),
  get: (id: string, options?: RequestOptions) =>
    api.get<AgentDetail>(agentPath(id), options),
  getRuntimeConfiguration: (id: string) =>
    api.get<RuntimeAgentConfigurationSnapshot>(
      agentPath(id, "/runtime-configuration"),
    ),
  updateRuntimeConfiguration: (
    id: string,
    data: RuntimeAgentConfigurationUpdate,
  ) =>
    api.patch<RuntimeAgentConfigurationSnapshot>(
      agentPath(id, "/runtime-configuration"),
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
  ) =>
    api.post<AgentAdapterRevisionCreateResponse>(
      agentPath(id, "/adapter-config-revisions"),
      data,
    ),
  listAdapterConfigRevisions: (id: string) =>
    api.get<AgentAdapterConfigRevision[]>(
      agentPath(id, "/adapter-config-revisions"),
    ),
  getCurrentAdapterConfigRevision: (id: string) =>
    api.get<AgentAdapterConfigRevision | null>(
      agentPath(id, "/adapter-config-revisions/current"),
    ),
  updateOperationalConfiguration: (
    id: string,
    data: AgentOperationalConfigurationUpdateInput,
  ) =>
    api.patch<Agent>(
      agentPath(id, "/operational-configuration"),
      data,
    ),
  pause: (id: string) => api.post<Agent>(agentPath(id, "/pause"), {}),
  resume: (id: string) => api.post<Agent>(agentPath(id, "/resume"), {}),
  clearError: (id: string) =>
    api.post<Agent>(agentPath(id, "/clear-error"), {}),
  adoptPluginManagement: (id: string) =>
    api.post<AgentPluginManagementAdoptionResponse>(
      agentPath(id, "/plugin-management/adopt"),
      {},
    ),
  terminate: (id: string) => api.post<Agent>(agentPath(id, "/terminate"), {}),
  runtimeState: (id: string) =>
    api.get<AgentRuntimeState | null>(agentPath(id, "/runtime-state")),
};
