import type { UserProfileResponse } from "@paperclipai/shared";
import { api } from "./client";

export const userProfilesApi = {
  get: (companyId: string, userId: string) =>
    api.get<UserProfileResponse>(
      `/companies/${companyId}/users/${encodeURIComponent(userId)}/profile`,
    ),
};
