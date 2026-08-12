import type {
  InviteSource,
  JoinRequest,
  PermissionKey,
} from "@paperclipai/shared";
import { api } from "./client";

export type UserCompanyRole = "owner" | "admin" | "operator" | "viewer";

type InviteSummary = {
  id: string;
  companyId: string | null;
  companyName?: string | null;
  companyLogoUrl?: string | null;
  companyBrandColor?: string | null;
  inviteType: "company_join" | "bootstrap_admin";
  userRole?: UserCompanyRole | null;
  expiresAt: string;
  invitedByUserName?: string | null;
  joinRequestStatus?: JoinRequest["status"] | null;
};

type CliAuthChallengeStatus = {
  id: string;
  status: "pending" | "approved" | "cancelled" | "expired";
  command: string;
  clientName: string | null;
  requestedAccess: "board" | "instance_admin_required";
  requestedCompanyId: string | null;
  requestedCompanyName: string | null;
  approvedAt: string | null;
  cancelledAt: string | null;
  expiresAt: string;
  approvedByUser: { id: string; name: string; email: string } | null;
  requiresSignIn: boolean;
  canApprove: boolean;
  currentUserId: string | null;
};

type CompanyInviteCreated = {
  id: string;
  token: string;
  inviteUrl: string;
  expiresAt: string;
  source: InviteSource;
  userRole?: UserCompanyRole | null;
  companyName?: string | null;
};

export type CompanyMemberGrant = {
  id: string;
  companyId: string;
  principalType: "user";
  principalId: string;
  permissionKey: PermissionKey;
  scope: Record<string, unknown> | null;
  grantedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CompanyMember = {
  id: string;
  companyId: string;
  principalType: "user";
  principalId: string;
  status: "pending" | "active" | "suspended" | "archived";
  membershipRole: UserCompanyRole;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
  } | null;
  grants: CompanyMemberGrant[];
  removal?: {
    canArchive: boolean;
    reason: string | null;
  };
};

export type ArchiveCompanyMemberResponse = {
  member: CompanyMember;
};

export type CompanyMembersResponse = {
  members: CompanyMember[];
  access: {
    currentUserRole: UserCompanyRole | null;
    canManageMembers: boolean;
    canInviteUsers: boolean;
    canApproveJoinRequests: boolean;
  };
};

export type CompanyUserDirectoryEntry = {
  principalId: string;
  status: "active";
  user: {
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
  } | null;
};

export type CompanyUserDirectoryResponse = {
  users: CompanyUserDirectoryEntry[];
};

export type CompanyInviteRecord = {
  id: string;
  companyId: string | null;
  companyName: string | null;
  inviteType: "company_join" | "bootstrap_admin";
  userRole: UserCompanyRole | null;
  defaultsPayload: Record<string, unknown> | null;
  expiresAt: string;
  source: InviteSource;
  invitedByUserId: string | null;
  revokedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
  state: "active" | "revoked" | "accepted" | "expired";
  invitedByUser: {
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
  } | null;
  relatedJoinRequestId: string | null;
};

export type CompanyInviteListResponse = {
  invites: CompanyInviteRecord[];
  nextOffset: number | null;
};

export type CompanyJoinRequest = JoinRequest & {
  requesterUser: {
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
  } | null;
  approvedByUser: {
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
  } | null;
  rejectedByUser: {
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
  } | null;
  invite: {
    id: string;
    inviteType: "company_join" | "bootstrap_admin";
    userRole: UserCompanyRole | null;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
    acceptedAt: string | null;
    invitedByUser: {
      id: string;
      email: string | null;
      name: string | null;
      image: string | null;
    } | null;
  } | null;
};

export type AdminUserDirectoryEntry = {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  isInstanceAdmin: boolean;
  activeCompanyMembershipCount: number;
};

export type UserCompanyAccessEntry = {
  id: string;
  companyId: string;
  principalType: "user";
  principalId: string;
  status: "pending" | "active" | "suspended" | "archived";
  membershipRole: UserCompanyRole;
  createdAt: string;
  updatedAt: string;
  companyName: string | null;
  companyStatus: "active" | "paused" | "archived" | null;
};

export type UserCompanyAccessResponse = {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
    isInstanceAdmin: boolean;
  } | null;
  companyAccess: UserCompanyAccessEntry[];
};

export type CurrentBoardAccess = {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
  } | null;
  userId: string;
  isInstanceAdmin: boolean;
  companyIds: string[];
  memberships?: Array<{
    companyId: string;
    membershipRole: UserCompanyRole;
    status: "pending" | "active" | "suspended" | "archived";
  }>;
  source: string;
  keyId: string | null;
};

function buildInviteListQuery(options: {
  state?: "active" | "revoked" | "accepted" | "expired";
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (options.state) params.set("state", options.state);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.offset) params.set("offset", String(options.offset));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const accessApi = {
  createCompanyInvite: (
    companyId: string,
    input: {
      userRole?: UserCompanyRole | null;
    } = {},
  ) => api.post<CompanyInviteCreated>(`/companies/${companyId}/invites`, input),

  getInvite: (token: string) =>
    api.get<InviteSummary>(`/invites/${encodeURIComponent(token)}`),

  acceptInvite: (token: string) =>
    api.post<JoinRequest | { bootstrapAccepted: true; userId: string }>(
      `/invites/${encodeURIComponent(token)}/accept`,
      {},
    ),

  listInvites: (
    companyId: string,
    options: {
      state?: "active" | "revoked" | "accepted" | "expired";
      limit?: number;
      offset?: number;
    } = {},
  ) =>
    api.get<CompanyInviteListResponse>(
      `/companies/${companyId}/invites${buildInviteListQuery(options)}`,
    ),

  revokeInvite: (inviteId: string) =>
    api.post(`/invites/${inviteId}/revoke`, {}),

  listJoinRequests: (
    companyId: string,
    status: "pending_approval" | "approved" | "rejected" = "pending_approval",
  ) =>
    api.get<CompanyJoinRequest[]>(
      `/companies/${companyId}/join-requests?status=${status}`,
    ),

  listMembers: (companyId: string) =>
    api.get<CompanyMembersResponse>(`/companies/${companyId}/members`),

  listUserDirectory: (companyId: string) =>
    api.get<CompanyUserDirectoryResponse>(
      `/companies/${companyId}/user-directory`,
    ),

  updateMember: (
    companyId: string,
    memberId: string,
    input: {
      membershipRole?: UserCompanyRole;
      status?: "pending" | "active" | "suspended";
    },
  ) =>
    api.patch<CompanyMember>(
      `/companies/${companyId}/members/${memberId}`,
      input,
    ),

  archiveMember: (companyId: string, memberId: string) =>
    api.post<ArchiveCompanyMemberResponse>(
      `/companies/${companyId}/members/${memberId}/archive`,
      {},
    ),

  approveJoinRequest: (companyId: string, requestId: string) =>
    api.post<JoinRequest>(
      `/companies/${companyId}/join-requests/${requestId}/approve`,
      {},
    ),

  rejectJoinRequest: (companyId: string, requestId: string) =>
    api.post<JoinRequest>(
      `/companies/${companyId}/join-requests/${requestId}/reject`,
      {},
    ),

  claimBootstrapAdmin: () =>
    api.post<{ claimed: true; userId: string }>("/bootstrap/claim", {}),

  getCliAuthChallenge: (id: string, token: string) =>
    api.get<CliAuthChallengeStatus>(
      `/cli-auth/challenges/${encodeURIComponent(id)}?${new URLSearchParams({ token }).toString()}`,
    ),

  approveCliAuthChallenge: (id: string, token: string) =>
    api.post<{
      approved: boolean;
      status: string;
      userId: string;
      keyId: string | null;
      expiresAt: string;
    }>(`/cli-auth/challenges/${encodeURIComponent(id)}/approve`, { token }),

  cancelCliAuthChallenge: (id: string, token: string) =>
    api.post<{ cancelled: boolean; status: string }>(
      `/cli-auth/challenges/${encodeURIComponent(id)}/cancel`,
      { token },
    ),

  searchAdminUsers: (query: string) =>
    api.get<AdminUserDirectoryEntry[]>(
      `/admin/users?${new URLSearchParams({ query }).toString()}`,
    ),

  promoteInstanceAdmin: (userId: string) =>
    api.post(`/admin/users/${userId}/promote-instance-admin`, {}),

  demoteInstanceAdmin: (userId: string) =>
    api.post(`/admin/users/${userId}/demote-instance-admin`, {}),

  getUserCompanyAccess: (userId: string) =>
    api.get<UserCompanyAccessResponse>(`/admin/users/${userId}/company-access`),

  setUserCompanyAccess: (userId: string, companyIds: string[]) =>
    api.put<UserCompanyAccessResponse>(
      `/admin/users/${userId}/company-access`,
      { companyIds },
    ),

  getCurrentBoardAccess: (userId: string) =>
    api.get<CurrentBoardAccess>(
      `/cli-auth/users/${encodeURIComponent(userId)}`,
    ),
};
