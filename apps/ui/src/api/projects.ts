import type { Project, ProjectCodebase, UpdateProjectCodebase } from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

function projectPath(id: string, suffix = "") {
  return `/projects/${encodeURIComponent(id)}${suffix}`;
}

export const projectsApi = {
  list: (companyId: string) => api.get<Project[]>(`/companies/${companyId}/projects`),
  get: (id: string, options?: RequestOptions) =>
    api.get<Project>(projectPath(id), options),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Project>(`/companies/${companyId}/projects`, data),
  update: (id: string, data: Record<string, unknown>) =>
    api.patch<Project>(projectPath(id), data),
  getCodebase: (id: string) =>
    api.get<ProjectCodebase>(projectPath(id, "/codebase")),
  updateCodebase: (id: string, data: UpdateProjectCodebase) =>
    api.patch<ProjectCodebase>(projectPath(id, "/codebase"), data),
};
