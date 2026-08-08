import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authUsers,
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
  userInboxAgentPolicies,
} from "@paperclipai/db";
import type {
  InboxAgentPolicyMode,
  PermissionKey,
  PrincipalType,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

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
      /**
       * `board_mcp` is constructed only by the dedicated Board MCP ingress
       * after a board API key has been resolved to a persisted user. It is a
       * trusted board-operator surface, not a value accepted by generic REST
       * request parsing.
       */
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
  | "skill_config:update"
  | "agent:read"
  | "company_scope:read"
  | "issue:comment"
  | "issue:mutate"
  | "issue:read"
  | "project:read"
  | "runtime:manage"
  | "secrets:read";

export type AuthorizationResource =
  | { type: "company"; companyId: string }
  | { type: "agent"; companyId: string; agentId?: string | null }
  | { type: "project"; companyId: string; projectId?: string | null }
  | {
      type: "issue";
      companyId: string;
      issueId?: string | null;
      projectId?: string | null;
      parentIssueId?: string | null;
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

type PrincipalGrantDecision = AuthorizationDecision & {
  grant?: NonNullable<AuthorizationDecision["grant"]>;
};

type ResponsibleUserSnapshot = {
  userId: string;
  companyId: string;
  userExists: boolean;
  activeMembership: {
    companyId: string;
    membershipRole?: string | null;
    status?: string;
  } | null;
};

type ResponsibleUserActorWithMemo = Extract<
  AuthorizationActor,
  { type: "agent" }
> & {
  __responsibleUserSnapshotMemo?: Map<string, Promise<ResponsibleUserSnapshot>>;
};

const responsibleUserSnapshotCache = new Map<
  string,
  { expiresAt: number; promise: Promise<ResponsibleUserSnapshot> }
>();

const GENERIC_AGENT_REST_ACTIONS = new Set<AuthorizationAction>([
  "agent:read",
  "company_scope:read",
  "issue:comment",
  "issue:mutate",
  "issue:read",
  "project:read",
  "runtime:manage",
  "secrets:read",
]);

function companyIdForResource(resource: AuthorizationResource) {
  return resource.companyId;
}

function permissionForAction(action: AuthorizationAction): PermissionKey | null {
  if (
    action === "agent_config:read" ||
    action === "agent_config:update" ||
    action === "skill_config:update" ||
    action === "agent:read" ||
    action === "company_scope:read" ||
    action === "issue:comment" ||
    action === "issue:mutate" ||
    action === "issue:read" ||
    action === "project:read" ||
    action === "runtime:manage" ||
    action === "secrets:read"
  ) {
    return null;
  }
  return action;
}

function allow(input: Omit<AuthorizationDecision, "allowed">): AuthorizationDecision {
  return { ...input, allowed: true };
}

function deny(input: Omit<AuthorizationDecision, "allowed">): AuthorizationDecision {
  return { ...input, allowed: false };
}

function scopeBoolean(scope: Record<string, unknown> | null | undefined, key: string) {
  return scope?.[key] === true;
}

function scopeValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function singularScopeKey(key: string) {
  return key.endsWith("Ids") ? `${key.slice(0, -3)}Id` : key;
}

/**
 * Grant scopes are exact, flat constraints. A plural `*Ids` grant key matches
 * the corresponding singular requested `*Id`; every other key must be present
 * with the same value.
 */
function scopeAllows(
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

function responsibleUserSnapshotTtlMs() {
  const raw = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_CACHE_TTL_MS?.trim();
  if (!raw) return 5_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5_000;
}

export function responsibleUserAuthzShadowMode() {
  const mode = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE?.trim().toLowerCase();
  const shadow = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW?.trim().toLowerCase();
  return mode === "shadow" || shadow === "1" || shadow === "true" || shadow === "yes";
}

function activeResponsibleUserCanAuthorizeAgentChange(
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

  if (
    action !== "agent_config:update" &&
    action !== "skill_config:update"
  ) {
    return false;
  }

  return Boolean(
    (agentDecision.reason === "allow_direct_change" ||
      agentDecision.reason === "allow_consented_change") &&
    agentDecision.grant?.principalType === "agent" &&
    agentDecision.grant.principalId === actorAgentId &&
    (
      agentDecision.grant.permissionKey === "agents:configure" ||
      agentDecision.grant.permissionKey === "agents:suggest-changes" ||
      agentDecision.grant.permissionKey === "skills:create" ||
      agentDecision.grant.permissionKey === "skills:suggest-changes"
    ),
  );
}

export function authorizationDeniedDetails(decision: AuthorizationDecision) {
  return {
    ...(decision.code ? { code: decision.code } : {}),
    reason: decision.reason,
  };
}

export function authorizationService(db: Db) {
  async function isInstanceAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    const row = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function getActiveMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ) {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, principalType),
          principalType === "user"
            ? eq(companyMemberships.principalUserId, principalId)
            : eq(companyMemberships.principalAgentId, principalId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function loadResponsibleUserSnapshot(
    companyId: string,
    userId: string,
  ): Promise<ResponsibleUserSnapshot> {
    const [user, membership] = await Promise.all([
      db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.id, userId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          companyId: companyMemberships.companyId,
          membershipRole: companyMemberships.membershipRole,
          status: companyMemberships.status,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalUserId, userId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null),
    ]);
    return {
      userId,
      companyId,
      userExists: Boolean(user),
      activeMembership: user ? membership : null,
    };
  }

  function getResponsibleUserSnapshot(input: {
    actor: Extract<AuthorizationActor, { type: "agent" }>;
    companyId: string;
    userId: string;
  }): Promise<ResponsibleUserSnapshot> {
    const actorWithMemo = input.actor as ResponsibleUserActorWithMemo;
    const key = `${input.companyId}:${input.userId}`;
    actorWithMemo.__responsibleUserSnapshotMemo ??= new Map();
    const requestMemo = actorWithMemo.__responsibleUserSnapshotMemo.get(key);
    if (requestMemo) return requestMemo;

    const now = Date.now();
    const cached = responsibleUserSnapshotCache.get(key);
    if (cached && cached.expiresAt > now) {
      actorWithMemo.__responsibleUserSnapshotMemo.set(key, cached.promise);
      return cached.promise;
    }

    const ttlMs = responsibleUserSnapshotTtlMs();
    const promise = loadResponsibleUserSnapshot(input.companyId, input.userId);
    if (ttlMs > 0) {
      responsibleUserSnapshotCache.set(key, { expiresAt: now + ttlMs, promise });
      promise.catch(() => {
        if (responsibleUserSnapshotCache.get(key)?.promise === promise) {
          responsibleUserSnapshotCache.delete(key);
        }
      });
    }
    actorWithMemo.__responsibleUserSnapshotMemo.set(key, promise);
    return promise;
  }

  async function findGrant(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ) {
    return db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          principalType === "user"
            ? eq(principalPermissionGrants.principalUserId, principalId)
            : eq(principalPermissionGrants.principalAgentId, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function decidePrincipalGrant(input: {
    companyId: string;
    principalType: PrincipalType;
    principalId: string;
    action: AuthorizationAction;
    permissionKey: PermissionKey;
    scope?: Record<string, unknown> | null;
  }): Promise<PrincipalGrantDecision> {
    const membership = await getActiveMembership(
      input.companyId,
      input.principalType,
      input.principalId,
    );
    if (!membership) {
      return deny({
        action: input.action,
        reason: "deny_missing_membership",
        explanation:
          `${input.principalType} principal ${input.principalId} is not an active member of company ${input.companyId}.`,
      });
    }

    const grant = await findGrant(
      input.companyId,
      input.principalType,
      input.principalId,
      input.permissionKey,
    );
    if (!grant) {
      return deny({
        action: input.action,
        reason: "deny_missing_grant",
        explanation: `Missing permission: ${input.permissionKey}.`,
      });
    }

    const grantDetails = {
      principalType: input.principalType,
      principalId: input.principalId,
      permissionKey: input.permissionKey,
      scope: grant.scope ?? null,
    };
    if (!scopeAllows(grant.scope, input.scope)) {
      return deny({
        action: input.action,
        reason: "deny_scope",
        explanation: `Permission ${input.permissionKey} does not cover the requested scope.`,
        grant: grantDetails,
      });
    }

    return allow({
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: `Allowed by explicit grant ${input.permissionKey}.`,
      grant: grantDetails,
    });
  }

  async function loadAgent(agentId: string) {
    return db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function decideBase(input: {
    actor: AuthorizationActor;
    action: AuthorizationAction;
    resource: AuthorizationResource;
    scope?: Record<string, unknown> | null;
  }, options: {
    ignoreInstanceAdmin?: boolean;
  } = {}): Promise<AuthorizationDecision> {
    const permissionKey = permissionForAction(input.action);
    const companyId = companyIdForResource(input.resource);

    async function decideWithAgentConfigReadGrant(
      principalType: PrincipalType,
      principalId: string,
      decisionScope: Record<string, unknown> | null | undefined = input.scope,
    ) {
      const configureDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: "agents:configure",
        scope: decisionScope,
      });
      if (configureDecision.allowed || configureDecision.reason === "deny_missing_membership") {
        return configureDecision;
      }

      const suggestDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: "agents:suggest-changes",
        scope: decisionScope,
      });
      if (suggestDecision.allowed || suggestDecision.reason === "deny_scope") {
        return suggestDecision;
      }
      return configureDecision;
    }

    async function decideWithProtectedChangeGrants(
      principalType: PrincipalType,
      principalId: string,
      keys: { direct: PermissionKey; suggest: PermissionKey },
      decisionScope: Record<string, unknown> | null | undefined = input.scope,
    ) {
      const directDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: keys.direct,
        scope: decisionScope,
      });
      if (directDecision.allowed) {
        return allow({
          action: input.action,
          reason: "allow_direct_change",
          explanation: `Allowed by direct change permission ${keys.direct}.`,
          grant: directDecision.grant,
        });
      }
      if (directDecision.reason === "deny_missing_membership") return directDecision;

      const suggestDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: keys.suggest,
        scope: decisionScope,
      });
      if (suggestDecision.allowed) {
        if (scopeBoolean(decisionScope, "consentedChange")) {
          return allow({
            action: input.action,
            reason: "allow_consented_change",
            explanation:
              `Allowed by suggest permission ${keys.suggest} after accepted change consent.`,
            grant: suggestDecision.grant,
          });
        }
        return deny({
          action: input.action,
          reason: "deny_missing_consent",
          explanation:
            `Permission ${keys.suggest} requires accepted change consent before applying this mutation.`,
          grant: suggestDecision.grant,
        });
      }
      if (suggestDecision.reason === "deny_missing_membership") return suggestDecision;
      if (directDecision.reason === "deny_scope") return directDecision;
      if (suggestDecision.reason === "deny_scope") return suggestDecision;

      return deny({
        action: input.action,
        reason: "deny_no_grant",
        explanation: `Missing permission: ${keys.direct} or ${keys.suggest}.`,
      });
    }

    if (input.actor.type === "none") {
      return deny({
        action: input.action,
        reason: "deny_unauthenticated",
        explanation: "Authentication required.",
      });
    }

    let exactAgentConfigTarget: { id: string; companyId: string } | null = null;
    if (input.action === "agent_config:read" || input.action === "agent_config:update") {
      if (input.resource.type !== "agent" || !input.resource.agentId) {
        return deny({
          action: input.action,
          reason: "deny_unsupported_action",
          explanation: "Agent configuration authorization requires an exact target agent.",
        });
      }
      const targetAgent = await loadAgent(input.resource.agentId);
      if (!targetAgent || targetAgent.companyId !== companyId) {
        return deny({
          action: input.action,
          reason: "deny_company_boundary",
          explanation: "Target agent was not found in the target company.",
        });
      }
      exactAgentConfigTarget = targetAgent;
    }

    if (input.actor.type === "board") {
      const boardUserId =
        typeof input.actor.userId === "string" &&
        input.actor.userId.length > 0 &&
        input.actor.userId === input.actor.userId.trim()
          ? input.actor.userId
          : null;
      if (!boardUserId) {
        return deny({
          action: input.action,
          reason: "deny_unauthenticated",
          explanation: "A persisted board user id is required.",
        });
      }
      const boardUser = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.id, boardUserId))
        .then((rows) => rows[0] ?? null);
      if (!boardUser) {
        return deny({
          action: input.action,
          reason: "deny_unauthenticated",
          explanation: "Board authorization requires an existing Better Auth user.",
        });
      }
      // A Board MCP bearer is a deliberate full-control board surface. Its
      // authentication and company membership boundary were already resolved
      // at ingress, and this branch ensures the canonical control-plane
      // services do not reintroduce per-action grants or viewer restrictions.
      // Keep the persisted active-membership check: it is tenant isolation,
      // rather than a grant or action-level access dial.
      if (input.actor.source === "board_mcp") {
        const membership = await getActiveMembership(
          companyId,
          "user",
          boardUserId,
        );
        if (!membership) {
          return deny({
            action: input.action,
            reason: "deny_missing_membership",
            explanation:
              `user principal ${boardUserId} is not an active member of company ${companyId}.`,
          });
        }
        return allow({
          action: input.action,
          reason: "allow_board_mcp",
          explanation:
            "Allowed by the authenticated full-control Board MCP operator.",
        });
      }
      if (
        !options.ignoreInstanceAdmin &&
        await isInstanceAdmin(boardUserId)
      ) {
        return allow({
          action: input.action,
          reason: "allow_instance_admin",
          explanation: "Allowed because the actor is an instance admin.",
        });
      }

      if (input.action === "agent_config:read") {
        return decideWithAgentConfigReadGrant("user", boardUserId, {
          targetAgentId: exactAgentConfigTarget!.id,
        });
      }
      if (input.action === "agent_config:update") {
        return decideWithProtectedChangeGrants("user", boardUserId, {
          direct: "agents:configure",
          suggest: "agents:suggest-changes",
        }, {
          requiresChangeGrant: scopeBoolean(input.scope, "requiresChangeGrant"),
          consentedChange: scopeBoolean(input.scope, "consentedChange"),
          targetAgentId: exactAgentConfigTarget!.id,
        });
      }
      if (input.action === "skill_config:update") {
        return decideWithProtectedChangeGrants("user", boardUserId, {
          direct: "skills:create",
          suggest: "skills:suggest-changes",
        });
      }

      if (!permissionKey) {
        const membership = await getActiveMembership(companyId, "user", boardUserId);
        if (!membership) {
          return deny({
            action: input.action,
            reason: "deny_missing_membership",
            explanation:
              `user principal ${boardUserId} is not an active member of company ${companyId}.`,
          });
        }

        const requiresNonViewer =
          input.action === "issue:comment" ||
          input.action === "issue:mutate" ||
          input.action === "runtime:manage" ||
          input.action === "secrets:read";
        if (requiresNonViewer && membership.membershipRole === "viewer") {
          return deny({
            action: input.action,
            reason: "deny_missing_grant",
            explanation: `Viewer membership does not grant ${input.action}.`,
          });
        }

        if (
          input.action === "agent:read" ||
          input.action === "company_scope:read" ||
          input.action === "issue:comment" ||
          input.action === "issue:mutate" ||
          input.action === "issue:read" ||
          input.action === "project:read" ||
          input.action === "runtime:manage" ||
          input.action === "secrets:read"
        ) {
          return allow({
            action: input.action,
            reason: "allow_simple_company_member",
            explanation: "Allowed by active same-company board membership.",
          });
        }

        return deny({
          action: input.action,
          reason: "deny_unsupported_action",
          explanation: `No board permission mapping exists for ${input.action}.`,
        });
      }

      return decidePrincipalGrant({
        companyId,
        principalType: "user",
        principalId: boardUserId,
        action: input.action,
        permissionKey,
        scope: input.scope,
      });
    }

    const actorAgentId = input.actor.agentId?.trim() || null;
    if (!actorAgentId) {
      return deny({
        action: input.action,
        reason: "deny_unauthenticated",
        explanation: "Agent authentication required.",
      });
    }
    if (input.actor.companyId !== companyId) {
      return deny({
        action: input.action,
        reason: "deny_company_boundary",
        explanation: "Agent credentials cannot access another company.",
      });
    }

    const actorAgent = await loadAgent(actorAgentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      return deny({
        action: input.action,
        reason: "deny_company_boundary",
        explanation: "Actor agent was not found in the target company.",
      });
    }

    if (input.action === "inbox:manage") {
      if (actorAgent.status === "pending_approval" || actorAgent.status === "terminated") {
        return deny({
          action: input.action,
          reason: "deny_missing_membership",
          explanation: "Actor agent is not active in the target company.",
        });
      }
      const responsibleUserId = input.actor.onBehalfOfUserId?.trim() || null;
      const explicitTargetUserId = typeof input.scope?.userId === "string"
        ? input.scope.userId.trim() || null
        : null;
      const targetUserId = explicitTargetUserId ?? responsibleUserId;
      if (!targetUserId) {
        return deny({
          action: input.action,
          reason: "inbox_target_user_unresolved",
          explanation:
            "Inbox target user could not be resolved from the request or responsible-user context.",
        });
      }

      const targetSnapshot = await getResponsibleUserSnapshot({
        actor: input.actor,
        companyId,
        userId: targetUserId,
      });
      if (!targetSnapshot.userExists || !targetSnapshot.activeMembership) {
        return deny({
          action: input.action,
          reason: "deny_missing_membership",
          explanation:
            `Inbox target user ${targetUserId} is not an active member of company ${companyId}.`,
        });
      }

      if (targetUserId !== responsibleUserId) {
        const grant = await findGrant(companyId, "agent", actorAgentId, "inbox:manage");
        if (!grant) {
          return deny({
            action: input.action,
            reason: "deny_missing_grant",
            explanation: "Missing permission: inbox:manage.",
          });
        }
        const grantDetails = {
          principalType: "agent" as const,
          principalId: actorAgentId,
          permissionKey: "inbox:manage" as const,
          scope: grant.scope ?? null,
        };
        if (!scopeAllows(grant.scope, { userId: targetUserId })) {
          return deny({
            action: input.action,
            reason: "deny_scope",
            explanation: "Permission inbox:manage does not cover the requested user.",
            grant: grantDetails,
          });
        }
        return allow({
          action: input.action,
          reason: "allow_explicit_grant",
          explanation: "Allowed by explicit grant inbox:manage.",
          inboxPolicyMode: "grant_override",
          grant: grantDetails,
        });
      }

      const policy = await db
        .select({
          mode: userInboxAgentPolicies.mode,
          allowedAgentIds: userInboxAgentPolicies.allowedAgentIds,
        })
        .from(userInboxAgentPolicies)
        .where(
          and(
            eq(userInboxAgentPolicies.companyId, companyId),
            eq(userInboxAgentPolicies.userId, targetUserId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (policy?.mode === "disabled") {
        return deny({
          action: input.action,
          reason: "inbox_management_disabled",
          explanation: `Inbox management is disabled for user ${targetUserId}.`,
        });
      }
      if (policy?.mode === "allowlist" && !policy.allowedAgentIds.includes(actorAgentId)) {
        return deny({
          action: input.action,
          reason: "inbox_agent_not_allowed",
          explanation: `Agent ${actorAgentId} is not allowed to manage user ${targetUserId}'s inbox.`,
        });
      }

      return allow({
        action: input.action,
        reason: "allow_self",
        inboxPolicyMode: policy?.mode ?? "open",
        explanation: policy?.mode === "allowlist"
          ? "Allowed by the responsible user's inbox agent allowlist."
          : "Allowed by the responsible user's default-open inbox policy.",
      });
    }

    if (GENERIC_AGENT_REST_ACTIONS.has(input.action)) {
      return deny({
        action: input.action,
        reason: "deny_unsupported_action",
        explanation:
          "Agent credentials cannot use generic REST content or control surfaces; use the run-scoped compiled interface.",
      });
    }

    if (input.action === "agent_config:read" || input.action === "agent_config:update") {
      const targetScope = {
        requiresChangeGrant: scopeBoolean(input.scope, "requiresChangeGrant"),
        consentedChange: scopeBoolean(input.scope, "consentedChange"),
        targetAgentId: exactAgentConfigTarget!.id,
      };
      if (input.action === "agent_config:read") {
        if (exactAgentConfigTarget!.id === actorAgentId) {
          return allow({
            action: input.action,
            reason: "allow_self",
            explanation: "Allowed because the actor is reading its own agent configuration.",
          });
        }
        return decideWithAgentConfigReadGrant("agent", actorAgentId, targetScope);
      }

      if (
        exactAgentConfigTarget!.id === actorAgentId
        && !scopeBoolean(input.scope, "requiresChangeGrant")
      ) {
        return allow({
          action: input.action,
          reason: "allow_self",
          explanation: "Allowed by the non-protected self-configuration rule.",
        });
      }
      return decideWithProtectedChangeGrants("agent", actorAgentId, {
        direct: "agents:configure",
        suggest: "agents:suggest-changes",
      }, targetScope);
    }

    if (input.action === "skill_config:update") {
      return decideWithProtectedChangeGrants("agent", actorAgentId, {
        direct: "skills:create",
        suggest: "skills:suggest-changes",
      });
    }

    if (permissionKey) {
      return decidePrincipalGrant({
        companyId,
        principalType: "agent",
        principalId: actorAgentId,
        action: input.action,
        permissionKey,
        scope: input.scope,
      });
    }

    return deny({
      action: input.action,
      reason: "deny_missing_grant",
      explanation: `No agent permission mapping exists for ${input.action}.`,
    });
  }

  async function applyResponsibleUserIntersection(
    input: {
      actor: AuthorizationActor;
      action: AuthorizationAction;
      resource: AuthorizationResource;
      scope?: Record<string, unknown> | null;
    },
    agentDecision: AuthorizationDecision,
  ): Promise<AuthorizationDecision> {
    if (input.actor.type !== "agent") {
      return agentDecision;
    }
    const responsibleUserId = input.actor.onBehalfOfUserId?.trim();
    if (
      input.action === "inbox:manage" ||
      !responsibleUserId ||
      !agentDecision.allowed
    ) {
      return agentDecision;
    }

    const companyId = companyIdForResource(input.resource);
    const snapshot = await getResponsibleUserSnapshot({
      actor: input.actor,
      companyId,
      userId: responsibleUserId,
    });
    const denyCode: AuthorizationDecision["code"] =
      snapshot.userExists && snapshot.activeMembership
        ? "RESPONSIBLE_USER_UNAUTHORIZED"
        : "RESPONSIBLE_USER_UNAVAILABLE";

    if (
      activeResponsibleUserCanAuthorizeAgentChange(
        input.action,
        snapshot.activeMembership,
        agentDecision,
        input.actor.agentId,
      )
    ) {
      return agentDecision;
    }

    const userDecision = snapshot.userExists && snapshot.activeMembership
      ? await decideBase({
          ...input,
          actor: {
            type: "board",
            userId: responsibleUserId,
          },
        }, { ignoreInstanceAdmin: true })
      : deny({
          action: input.action,
          reason: "deny_missing_membership",
          explanation:
            `Responsible user ${responsibleUserId} is unavailable for company ${companyId}.`,
        });

    if (userDecision.allowed) return agentDecision;

    const denied = deny({
      action: input.action,
      reason: userDecision.reason,
      code: denyCode,
      explanation:
        denyCode === "RESPONSIBLE_USER_UNAVAILABLE"
          ? `Responsible user ${responsibleUserId} is unavailable for company ${companyId}.`
          : `Responsible user ${responsibleUserId} is not authorized for ${input.action}: ${userDecision.explanation}`,
      grant: userDecision.grant,
    });

    logger.warn({
      authzMode: responsibleUserAuthzShadowMode() ? "shadow" : "enforce",
      code: denied.code,
      reason: userDecision.reason,
      action: input.action,
      resourceType: input.resource.type,
      companyId,
      actorAgentId: input.actor.agentId ?? null,
      responsibleUserId,
    }, "responsible-user authorization intersection denied");

    return responsibleUserAuthzShadowMode() ? agentDecision : denied;
  }

  async function decide(input: {
    actor: AuthorizationActor;
    action: AuthorizationAction;
    resource: AuthorizationResource;
    scope?: Record<string, unknown> | null;
  }): Promise<AuthorizationDecision> {
    const agentDecision = await decideBase(input);
    return applyResponsibleUserIntersection(input, agentDecision);
  }

  return {
    decide,
    decidePrincipalGrant,
  };
}
