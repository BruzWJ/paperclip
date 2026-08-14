import type { InboxAgentPolicyMode, PermissionKey, PrincipalType } from "@paperclipai/shared";

/**
 * A persisted authorization subject, not an authority assertion.
 *
 * Board authority is resolved from Better Auth users, instance roles, and
 * company memberships. Request-level snapshots such as `isInstanceAdmin` and
 * `companyIds` deliberately do not belong to this contract.
 */
export type AuthorizationActor =
  | {
      type: "board";
      userId: string;
      /** Constructed only after Board MCP resolves an existing board API key. */
      source?: "session" | "board_key" | "board_mcp";
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId?: string | null;
      onBehalfOfUserId?: string | null;
      source: "internal";
    }
  | {
      type: "none";
      source?: "none";
    };

export type AuthorizationAction =
  | PermissionKey
  | "agent_config:read"
  | "agent_config:update"
  | "agent:read"
  | "company_scope:read"
  | "task:comment"
  | "task:mutate"
  | "task:read"
  | "project:read"
  | "runtime:manage"
  | "secrets:read";

export type AuthorizationResource =
  | { type: "company"; companyId: string }
  | { type: "agent"; companyId: string; agentId?: string | null }
  | { type: "project"; companyId: string; projectId?: string | null }
  | {
      type: "task";
      companyId: string;
      taskId?: string | null;
      projectId?: string | null;
      parentTaskId?: string | null;
      ownerKind?: "agent" | "user" | "board" | null;
      ownerAgentId?: string | null;
      ownerUserId?: string | null;
      originKind?: string | null;
      originId?: string | null;
    };

export type AuthorizationDecision = {
  allowed: boolean;
  action: AuthorizationAction;
  explanation: string;
  inboxPolicyMode?: InboxAgentPolicyMode | "grant_override";
  code?: "RESPONSIBLE_USER_UNAUTHORIZED" | "RESPONSIBLE_USER_UNAVAILABLE";
  reason:
    | "allow_instance_admin"
    | "allow_board_mcp"
    | "allow_explicit_grant"
    | "allow_direct_change"
    | "allow_consented_change"
    | "allow_self"
    | "allow_company_member"
    | "allow_simple_company_member"
    | "inbox_target_user_unresolved"
    | "inbox_management_disabled"
    | "inbox_agent_not_allowed"
    | "deny_unauthenticated"
    | "deny_company_boundary"
    | "deny_missing_membership"
    | "deny_missing_grant"
    | "deny_missing_consent"
    | "deny_no_grant"
    | "deny_policy_restricted"
    | "deny_low_trust_boundary"
    | "deny_scope"
    | "deny_unsupported_action";
  grant?: {
    principalType: PrincipalType;
    principalId: string;
    permissionKey: PermissionKey;
    scope: Record<string, unknown> | null;
  };
};

export type PrincipalGrantDecision = AuthorizationDecision & {
  grant?: NonNullable<AuthorizationDecision["grant"]>;
};

export type ResponsibleUserSnapshot = {
  userId: string;
  companyId: string;
  userExists: boolean;
  activeMembership: {
    companyId: string;
    membershipRole?: string | null;
    status?: string;
  } | null;
};

export type ResponsibleUserActorWithMemo = Extract<AuthorizationActor, { type: "agent" }> & {
  __responsibleUserSnapshotMemo?: Map<string, Promise<ResponsibleUserSnapshot>>;
};

export const responsibleUserSnapshotCache = new Map<
  string,
  { expiresAt: number; promise: Promise<ResponsibleUserSnapshot> }
>();

export const GENERIC_AGENT_REST_ACTIONS = new Set<AuthorizationAction>([
  "agent:read",
  "company_scope:read",
  "task:comment",
  "task:mutate",
  "task:read",
  "project:read",
  "runtime:manage",
  "secrets:read",
]);

export function companyIdForResource(resource: AuthorizationResource) {
  return resource.companyId;
}

export function permissionForAction(action: AuthorizationAction): PermissionKey | null {
  if (
    action === "agent_config:read" ||
    action === "agent_config:update" ||
    action === "agent:read" ||
    action === "company_scope:read" ||
    action === "task:comment" ||
    action === "task:mutate" ||
    action === "task:read" ||
    action === "project:read" ||
    action === "runtime:manage" ||
    action === "secrets:read"
  ) {
    return null;
  }
  return action;
}

export function allow(input: Omit<AuthorizationDecision, "allowed">): AuthorizationDecision {
  return { ...input, allowed: true };
}

export function deny(input: Omit<AuthorizationDecision, "allowed">): AuthorizationDecision {
  return { ...input, allowed: false };
}

export function scopeBoolean(scope: Record<string, unknown> | null | undefined, key: string) {
  return scope?.[key] === true;
}

export function scopeValues(value: unknown): string[] {
  if (typeof value === "string") {
    return value.length > 0 && value.trim() === value ? [value] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.trim() === entry,
  );
}

export function singularScopeKey(key: string) {
  return key.endsWith("Ids") ? `${key.slice(0, -3)}Id` : key;
}

/**
 * Grant scopes are exact, flat constraints. A plural `*Ids` grant key matches
 * the corresponding singular requested `*Id`; every other key must be present
 * with the same value.
 */
export function scopeAllows(
  grantScope: Record<string, unknown> | null,
  requestedScope: Record<string, unknown> | null | undefined,
) {
  if (!grantScope || Object.keys(grantScope).length === 0) return true;
  if (!requestedScope) return false;

  for (const [grantKey, grantValue] of Object.entries(grantScope)) {
    const requestedKey = singularScopeKey(grantKey);
    const requestedValue = requestedScope[requestedKey];
    const allowedValues = scopeValues(grantValue);
    if (allowedValues.length > 0) {
      if (typeof requestedValue !== "string" || !allowedValues.includes(requestedValue)) {
        return false;
      }
      continue;
    }

    if (Array.isArray(grantValue)) return false;
    if (requestedValue !== grantValue) return false;
  }
  return true;
}

export function responsibleUserSnapshotTtlMs() {
  const raw = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_CACHE_TTL_MS?.trim();
  if (!raw) return 5_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5_000;
}

export function responsibleUserAuthzShadowMode() {
  const mode = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE;
  if (mode === undefined || mode === "enforce") return false;
  if (mode === "shadow") return true;
  throw new Error('PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE must be exactly "enforce" or "shadow"');
}

export function activeResponsibleUserCanAuthorizeAgentChange(
  action: AuthorizationAction,
  membership: ResponsibleUserSnapshot["activeMembership"],
  agentDecision: AuthorizationDecision,
  actorAgentId: string | null | undefined,
) {
  if (
    !membership ||
    membership.status !== "active" ||
    membership.membershipRole === "viewer" ||
    !agentDecision.allowed
  ) {
    return false;
  }

  if (action === "agent_config:update" && agentDecision.reason === "allow_self") {
    return true;
  }

  if (action !== "agent_config:update") {
    return false;
  }

  return Boolean(
    (agentDecision.reason === "allow_direct_change" || agentDecision.reason === "allow_consented_change") &&
    agentDecision.grant?.principalType === "agent" &&
    agentDecision.grant.principalId === actorAgentId &&
    (agentDecision.grant.permissionKey === "agents:configure" ||
      agentDecision.grant.permissionKey === "agents:suggest-changes"),
  );
}

export function authorizationDeniedDetails(decision: AuthorizationDecision) {
  return {
    ...(decision.code ? { code: decision.code } : {}),
    reason: decision.reason,
  };
}
