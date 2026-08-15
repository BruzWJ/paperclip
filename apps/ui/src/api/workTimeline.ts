import type { WorkTimelineResult } from "@paperclipai/shared";
import { api } from "./client";

export interface WorkTimelineParams {
  from?: string;
  to?: string;
  userId?: string;
  goalId?: string;
  projectId?: string;
  taskId?: string;
  limit?: number;
  offset?: number;
}

function query(params: WorkTimelineParams): string {
  const search = new URLSearchParams();
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.userId) search.set("userId", params.userId);
  if (params.goalId) search.set("goalId", params.goalId);
  if (params.projectId) search.set("projectId", params.projectId);
  if (params.taskId) search.set("taskId", params.taskId);
  if (params.limit) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const workTimelineApi = {
  get: (companyId: string, params: WorkTimelineParams = {}) =>
    api.get<WorkTimelineResult>(`/companies/${companyId}/timeline${query(params)}`),
};
