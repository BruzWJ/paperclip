import type {
  ResourceMemberships,
  ResourceMembershipUpdateResult,
  UpdateResourceMembership,
} from "@paperclipai/shared";
import { api } from "./client";

export const resourceMembershipsApi = {
  listForUser: (companyId: string, userId: string) =>
    api.get<ResourceMemberships>(
      `/companies/${companyId}/users/${encodeURIComponent(userId)}/resource-memberships`,
    ),
  updateProject: (
    companyId: string,
    userId: string,
    projectId: string,
    data: UpdateResourceMembership,
  ) =>
    api.put<ResourceMembershipUpdateResult>(
      `/companies/${companyId}/users/${encodeURIComponent(userId)}/resource-memberships/projects/${projectId}`,
      data,
    ),
  updateAgent: (
    companyId: string,
    userId: string,
    agentId: string,
    data: UpdateResourceMembership,
  ) =>
    api.put<ResourceMembershipUpdateResult>(
      `/companies/${companyId}/users/${encodeURIComponent(userId)}/resource-memberships/agents/${agentId}`,
      data,
    ),
};
