import { and, eq } from "drizzle-orm";
import { authUsers, userInboxAgentPolicies } from "@paperclipai/db";
import * as authz from "./authorization-foundation.js";
import type { ReturnTypeOfAuthorizationCore } from "./authorization-core.js";

export async function decideAuthorizationBase(
  core: ReturnTypeOfAuthorizationCore,
  input: {
    actor: authz.AuthorizationActor;
    action: authz.AuthorizationAction;
    resource: authz.AuthorizationResource;
    scope?: Record<string, unknown> | null;
  },
  options: {
    ignoreInstanceAdmin?: boolean;
  } = {},
): Promise<authz.AuthorizationDecision> {
  const {
    db,
    isInstanceAdmin,
    getActiveMembership,
    getResponsibleUserSnapshot,
    findGrant,
    decidePrincipalGrant,
    loadAgent,
    decideWithAgentConfigReadGrant,
    decideWithProtectedChangeGrants,
  } = core;
  const permissionKey = authz.permissionForAction(input.action);
  const companyId = authz.companyIdForResource(input.resource);

  if (input.actor.type === "none") {
    return authz.deny({
      action: input.action,
      reason: "deny_unauthenticated",
      explanation: "Authentication required.",
    });
  }

  let exactAgentConfigTarget: { id: string; companyId: string } | null = null;
  if (input.action === "agent_config:read" || input.action === "agent_config:update") {
    if (input.resource.type !== "agent" || !input.resource.agentId) {
      return authz.deny({
        action: input.action,
        reason: "deny_unsupported_action",
        explanation: "Agent configuration authorization requires an exact target agent.",
      });
    }
    const targetAgent = await loadAgent(input.resource.agentId);
    if (!targetAgent || targetAgent.companyId !== companyId) {
      return authz.deny({
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
      return authz.deny({
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
      return authz.deny({
        action: input.action,
        reason: "deny_unauthenticated",
        explanation: "Board authorization requires an existing Better Auth user.",
      });
    }
    if (input.actor.source === "board_mcp") {
      const membership = await getActiveMembership(companyId, "user", boardUserId);
      if (!membership) {
        return authz.deny({
          action: input.action,
          reason: "deny_missing_membership",
          explanation: `user principal ${boardUserId} is not an active member of company ${companyId}.`,
        });
      }
      return authz.allow({
        action: input.action,
        reason: "allow_board_mcp",
        explanation: "Allowed by the authenticated full-control Board MCP operator.",
      });
    }
    if (!options.ignoreInstanceAdmin && (await isInstanceAdmin(boardUserId))) {
      return authz.allow({
        action: input.action,
        reason: "allow_instance_admin",
        explanation: "Allowed because the actor is an instance admin.",
      });
    }

    if (input.action === "agent_config:read") {
      return decideWithAgentConfigReadGrant(input, companyId, "user", boardUserId, {
        targetAgentId: exactAgentConfigTarget!.id,
      });
    }
    if (input.action === "agent_config:update") {
      return decideWithProtectedChangeGrants(
        input,
        companyId,
        "user",
        boardUserId,
        {
          direct: "agents:configure",
          suggest: "agents:suggest-changes",
        },
        {
          requiresChangeGrant: authz.scopeBoolean(input.scope, "requiresChangeGrant"),
          consentedChange: authz.scopeBoolean(input.scope, "consentedChange"),
          targetAgentId: exactAgentConfigTarget!.id,
        },
      );
    }
    if (!permissionKey) {
      const membership = await getActiveMembership(companyId, "user", boardUserId);
      if (!membership) {
        return authz.deny({
          action: input.action,
          reason: "deny_missing_membership",
          explanation: `user principal ${boardUserId} is not an active member of company ${companyId}.`,
        });
      }

      const requiresNonViewer =
        input.action === "task:comment" ||
        input.action === "task:mutate" ||
        input.action === "runtime:manage" ||
        input.action === "secrets:read";
      if (requiresNonViewer && membership.membershipRole === "viewer") {
        return authz.deny({
          action: input.action,
          reason: "deny_missing_grant",
          explanation: `Viewer membership does not grant ${input.action}.`,
        });
      }

      if (
        input.action === "agent:read" ||
        input.action === "company_scope:read" ||
        input.action === "task:comment" ||
        input.action === "task:mutate" ||
        input.action === "task:read" ||
        input.action === "project:read" ||
        input.action === "runtime:manage" ||
        input.action === "secrets:read"
      ) {
        return authz.allow({
          action: input.action,
          reason: "allow_simple_company_member",
          explanation: "Allowed by active same-company board membership.",
        });
      }

      return authz.deny({
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

  const actorAgentId =
    typeof input.actor.agentId === "string" &&
    input.actor.agentId.length > 0 &&
    input.actor.agentId.trim() === input.actor.agentId
      ? input.actor.agentId
      : null;
  if (!actorAgentId) {
    return authz.deny({
      action: input.action,
      reason: "deny_unauthenticated",
      explanation: "Internal agent execution authority required.",
    });
  }
  if (input.actor.companyId !== companyId) {
    return authz.deny({
      action: input.action,
      reason: "deny_company_boundary",
      explanation: "Agent execution authority cannot cross company boundaries.",
    });
  }

  const actorAgent = await loadAgent(actorAgentId);
  if (!actorAgent || actorAgent.companyId !== companyId) {
    return authz.deny({
      action: input.action,
      reason: "deny_company_boundary",
      explanation: "Actor agent was not found in the target company.",
    });
  }

  if (input.action === "inbox:manage") {
    if (actorAgent.status === "pending_approval" || actorAgent.status === "terminated") {
      return authz.deny({
        action: input.action,
        reason: "deny_missing_membership",
        explanation: "Actor agent is not active in the target company.",
      });
    }
    if (
      input.actor.onBehalfOfUserId !== undefined &&
      input.actor.onBehalfOfUserId !== null &&
      (typeof input.actor.onBehalfOfUserId !== "string" ||
        input.actor.onBehalfOfUserId.length === 0 ||
        input.actor.onBehalfOfUserId.trim() !== input.actor.onBehalfOfUserId)
    ) {
      return authz.deny({
        action: input.action,
        reason: "inbox_target_user_unresolved",
        explanation: "Responsible-user context must contain an exact user ID.",
      });
    }
    if (
      input.scope?.userId !== undefined &&
      input.scope.userId !== null &&
      (typeof input.scope.userId !== "string" ||
        input.scope.userId.length === 0 ||
        input.scope.userId.trim() !== input.scope.userId)
    ) {
      return authz.deny({
        action: input.action,
        reason: "inbox_target_user_unresolved",
        explanation: "Inbox scope must contain an exact user ID.",
      });
    }
    const responsibleUserId =
      typeof input.actor.onBehalfOfUserId === "string" &&
      input.actor.onBehalfOfUserId.length > 0 &&
      input.actor.onBehalfOfUserId.trim() === input.actor.onBehalfOfUserId
        ? input.actor.onBehalfOfUserId
        : null;
    const explicitTargetUserId =
      typeof input.scope?.userId === "string" &&
      input.scope.userId.length > 0 &&
      input.scope.userId.trim() === input.scope.userId
        ? input.scope.userId
        : null;
    const targetUserId = explicitTargetUserId ?? responsibleUserId;
    if (!targetUserId) {
      return authz.deny({
        action: input.action,
        reason: "inbox_target_user_unresolved",
        explanation: "Inbox target user could not be resolved from the request or responsible-user context.",
      });
    }

    const targetSnapshot = await getResponsibleUserSnapshot({
      actor: input.actor,
      companyId,
      userId: targetUserId,
    });
    if (!targetSnapshot.userExists || !targetSnapshot.activeMembership) {
      return authz.deny({
        action: input.action,
        reason: "deny_missing_membership",
        explanation: `Inbox target user ${targetUserId} is not an active member of company ${companyId}.`,
      });
    }

    if (targetUserId !== responsibleUserId) {
      const grant = await findGrant(companyId, "agent", actorAgentId, "inbox:manage");
      if (!grant) {
        return authz.deny({
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
      if (!authz.scopeAllows(grant.scope, { userId: targetUserId })) {
        return authz.deny({
          action: input.action,
          reason: "deny_scope",
          explanation: "Permission inbox:manage does not cover the requested user.",
          grant: grantDetails,
        });
      }
      return authz.allow({
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
        and(eq(userInboxAgentPolicies.companyId, companyId), eq(userInboxAgentPolicies.userId, targetUserId)),
      )
      .then((rows) => rows[0] ?? null);

    if (policy?.mode === "disabled") {
      return authz.deny({
        action: input.action,
        reason: "inbox_management_disabled",
        explanation: `Inbox management is disabled for user ${targetUserId}.`,
      });
    }
    if (policy?.mode === "allowlist" && !policy.allowedAgentIds.includes(actorAgentId)) {
      return authz.deny({
        action: input.action,
        reason: "inbox_agent_not_allowed",
        explanation: `Agent ${actorAgentId} is not allowed to manage user ${targetUserId}'s inbox.`,
      });
    }

    return authz.allow({
      action: input.action,
      reason: "allow_self",
      inboxPolicyMode: policy?.mode ?? "open",
      explanation:
        policy?.mode === "allowlist"
          ? "Allowed by the responsible user's inbox agent allowlist."
          : "Allowed by the responsible user's default-open inbox policy.",
    });
  }

  if (authz.GENERIC_AGENT_REST_ACTIONS.has(input.action)) {
    return authz.deny({
      action: input.action,
      reason: "deny_unsupported_action",
      explanation:
        "Internal agent execution authority cannot use generic REST content or control surfaces; use the run-scoped compiled interface.",
    });
  }

  if (input.action === "agent_config:read" || input.action === "agent_config:update") {
    const targetScope = {
      requiresChangeGrant: authz.scopeBoolean(input.scope, "requiresChangeGrant"),
      consentedChange: authz.scopeBoolean(input.scope, "consentedChange"),
      targetAgentId: exactAgentConfigTarget!.id,
    };
    if (input.action === "agent_config:read") {
      if (exactAgentConfigTarget!.id === actorAgentId) {
        return authz.allow({
          action: input.action,
          reason: "allow_self",
          explanation: "Allowed because the actor is reading its own agent configuration.",
        });
      }
      return decideWithAgentConfigReadGrant(input, companyId, "agent", actorAgentId, targetScope);
    }

    if (
      exactAgentConfigTarget!.id === actorAgentId &&
      !authz.scopeBoolean(input.scope, "requiresChangeGrant")
    ) {
      return authz.allow({
        action: input.action,
        reason: "allow_self",
        explanation: "Allowed by the non-protected self-configuration rule.",
      });
    }
    return decideWithProtectedChangeGrants(
      input,
      companyId,
      "agent",
      actorAgentId,
      {
        direct: "agents:configure",
        suggest: "agents:suggest-changes",
      },
      targetScope,
    );
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

  return authz.deny({
    action: input.action,
    reason: "deny_missing_grant",
    explanation: `No agent permission mapping exists for ${input.action}.`,
  });
}
