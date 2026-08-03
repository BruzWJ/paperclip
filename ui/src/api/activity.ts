import type { ActivityEvent } from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

export const activityApi = {
  list: (
    companyId: string,
    filters?: { entityType?: string; entityId?: string; agentId?: string; limit?: number },
    options?: RequestOptions,
  ) => {
    const params = new URLSearchParams();
    if (filters?.entityType) params.set("entityType", filters.entityType);
    if (filters?.entityId) params.set("entityId", filters.entityId);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<ActivityEvent[]>(`/companies/${companyId}/activity${qs ? `?${qs}` : ""}`, options);
  },
  forIssue: (issueId: string) => api.get<ActivityEvent[]>(`/issues/${issueId}/activity`),
};
