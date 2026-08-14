import type { Db } from "@paperclipai/db";
import { createAuthorizationCore, type ReturnTypeOfAuthorizationCore } from "./authorization-core.js";
import { decideAuthorizationBase } from "./authorization-decision.js";
import {
  activeResponsibleUserCanAuthorizeAgentChange,
  authorizationDeniedDetails,
  responsibleUserAuthzShadowMode,
  companyIdForResource,
  deny,
  type AuthorizationAction,
  type AuthorizationActor,
  type AuthorizationDecision,
  type AuthorizationResource,
} from "./authorization-foundation.js";

import { logger } from "../middleware/logger.js";

export function buildResponsibleUserIntersection(
  core: ReturnTypeOfAuthorizationCore,
  decideBase: (
    input: {
      actor: AuthorizationActor;
      action: AuthorizationAction;
      resource: AuthorizationResource;
      scope?: Record<string, unknown> | null;
    },
    options?: { ignoreInstanceAdmin?: boolean },
  ) => Promise<AuthorizationDecision>,
) {
  const { getResponsibleUserSnapshot } = core;

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
    const responsibleUserId = input.actor.onBehalfOfUserId;
    if (
      responsibleUserId !== undefined &&
      responsibleUserId !== null &&
      (responsibleUserId.length === 0 || responsibleUserId.trim() !== responsibleUserId)
    ) {
      return deny({
        action: input.action,
        reason: "deny_missing_membership",
        code: "RESPONSIBLE_USER_UNAVAILABLE",
        explanation: "Responsible-user context must contain an exact user ID.",
      });
    }
    if (input.action === "inbox:manage" || !responsibleUserId || !agentDecision.allowed) {
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

    const userDecision =
      snapshot.userExists && snapshot.activeMembership
        ? await decideBase(
            {
              ...input,
              actor: {
                type: "board",
                userId: responsibleUserId,
              },
            },
            { ignoreInstanceAdmin: true },
          )
        : deny({
            action: input.action,
            reason: "deny_missing_membership",
            explanation: `Responsible user ${responsibleUserId} is unavailable for company ${companyId}.`,
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

    logger.warn(
      {
        authzMode: responsibleUserAuthzShadowMode() ? "shadow" : "enforce",
        code: denied.code,
        reason: userDecision.reason,
        action: input.action,
        resourceType: input.resource.type,
        companyId,
        actorAgentId: input.actor.agentId ?? null,
        responsibleUserId,
      },
      "responsible-user authorization intersection denied",
    );

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

  return { applyResponsibleUserIntersection };
}
export type {
  AuthorizationActor,
  AuthorizationAction,
  AuthorizationResource,
  AuthorizationDecision,
} from "./authorization-foundation.js";
export {
  activeResponsibleUserCanAuthorizeAgentChange,
  authorizationDeniedDetails,
  responsibleUserAuthzShadowMode,
};

export function authorizationService(db: Db) {
  const core = createAuthorizationCore(db);
  const decideBase = (
    input: Parameters<typeof decideAuthorizationBase>[1],
    options?: Parameters<typeof decideAuthorizationBase>[2],
  ) => decideAuthorizationBase(core, input, options);
  const { applyResponsibleUserIntersection } = buildResponsibleUserIntersection(core, decideBase);
  const decide = async (input: Parameters<typeof decideBase>[0]) => {
    const agentDecision = await decideBase(input);
    return applyResponsibleUserIntersection(input, agentDecision);
  };
  return {
    decide,
    decidePrincipalGrant: core.decidePrincipalGrant,
    isInstanceAdmin: core.isInstanceAdmin,
  };
}
