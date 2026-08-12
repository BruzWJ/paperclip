import type { SidebarOrderPreference, UpsertSidebarOrderPreference } from "@paperclipai/shared";
import { api } from "./client";

export const sidebarPreferencesApi = {
  getCompanyOrder: (userId: string) =>
    api.get<SidebarOrderPreference>(
      `/users/${encodeURIComponent(userId)}/sidebar-preferences`,
    ),
  updateCompanyOrder: (userId: string, data: UpsertSidebarOrderPreference) =>
    api.put<SidebarOrderPreference>(
      `/users/${encodeURIComponent(userId)}/sidebar-preferences`,
      data,
    ),
  getProjectOrder: (companyId: string, userId: string) =>
    api.get<SidebarOrderPreference>(
      `/companies/${companyId}/users/${encodeURIComponent(userId)}/sidebar-preferences`,
    ),
  updateProjectOrder: (
    companyId: string,
    userId: string,
    data: UpsertSidebarOrderPreference,
  ) =>
    api.put<SidebarOrderPreference>(
      `/companies/${companyId}/users/${encodeURIComponent(userId)}/sidebar-preferences`,
      data,
    ),
};
