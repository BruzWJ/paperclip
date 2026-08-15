import type { Agent } from "@paperclipai/shared";

import type { CompanyUserProfile } from "@/lib/company-members";

export interface DocumentActorLookups {
  agentMap?: ReadonlyMap<
    string,
    Pick<Agent, "id" | "name"> & Partial<Pick<Agent, "icon">>
  >;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile>;
}
