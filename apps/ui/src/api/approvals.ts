import type {
  Approval,
  ApprovalComment,
  HireAgentApprovalResubmission,
  Task,
} from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

export const approvalsApi = {
  list: (companyId: string, status?: string) =>
    api.get<Approval[]>(
      `/companies/${companyId}/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  get: (id: string, options?: RequestOptions) =>
    api.get<Approval>(`/approvals/${id}`, options),
  approve: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/approve`, { decisionNote }),
  reject: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/reject`, { decisionNote }),
  requestRevision: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/request-revision`, { decisionNote }),
  resubmit: (id: string, payload?: Record<string, unknown>) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { payload }),
  resubmitHire: (id: string, hireAgent: HireAgentApprovalResubmission) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { hireAgent }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listTasks: (id: string) => api.get<Task[]>(`/approvals/${id}/tasks`),
};
