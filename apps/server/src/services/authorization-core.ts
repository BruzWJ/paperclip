import { and, eq } from "drizzle-orm";
import {
  agents,
  authUsers,
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import type { PermissionKey, PrincipalType } from "@paperclipai/shared";
import * as authz from "./authorization-foundation.js";

export async function isInstanceAdminForDb(db: Db, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const row = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

export function createAuthorizationCore(db: Db) {
  const isInstanceAdmin = (userId: string | null | undefined) => isInstanceAdminForDb(db, userId);

  async function getActiveMembership(companyId: string, principalType: PrincipalType, principalId: string) {
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
  ): Promise<authz.ResponsibleUserSnapshot> {
    const [user, membership] = await Promise.all([
      db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.id, userId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          companyId: companyMemberships.companyId,
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
    actor: Extract<authz.AuthorizationActor, { type: "agent" }>;
    companyId: string;
    userId: string;
  }): Promise<authz.ResponsibleUserSnapshot> {
    const actorWithMemo = input.actor as authz.ResponsibleUserActorWithMemo;
    const key = `${input.companyId}:${input.userId}`;
    actorWithMemo.__responsibleUserSnapshotMemo ??= new Map();
    const requestMemo = actorWithMemo.__responsibleUserSnapshotMemo.get(key);
    if (requestMemo) return requestMemo;

    const now = Date.now();
    const cached = authz.responsibleUserSnapshotCache.get(key);
    if (cached && cached.expiresAt > now) {
      actorWithMemo.__responsibleUserSnapshotMemo.set(key, cached.promise);
      return cached.promise;
    }

    const ttlMs = authz.responsibleUserSnapshotTtlMs();
    const promise = loadResponsibleUserSnapshot(input.companyId, input.userId);
    if (ttlMs > 0) {
      authz.responsibleUserSnapshotCache.set(key, {
        expiresAt: now + ttlMs,
        promise,
      });
      promise.catch(() => {
        if (authz.responsibleUserSnapshotCache.get(key)?.promise === promise) {
          authz.responsibleUserSnapshotCache.delete(key);
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
    action: authz.AuthorizationAction;
    permissionKey: PermissionKey;
    scope?: Record<string, unknown> | null;
  }): Promise<authz.PrincipalGrantDecision> {
    const membership = await getActiveMembership(input.companyId, input.principalType, input.principalId);
    if (!membership) {
      return authz.deny({
        action: input.action,
        reason: "deny_missing_membership",
        explanation: `${input.principalType} principal ${input.principalId} is not an active member of company ${input.companyId}.`,
      });
    }

    const grant = await findGrant(
      input.companyId,
      input.principalType,
      input.principalId,
      input.permissionKey,
    );
    if (!grant) {
      return authz.deny({
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
    if (!authz.scopeAllows(grant.scope, input.scope)) {
      return authz.deny({
        action: input.action,
        reason: "deny_scope",
        explanation: `Permission ${input.permissionKey} does not cover the requested scope.`,
        grant: grantDetails,
      });
    }

    return authz.allow({
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

  async function decideWithAgentConfigReadGrant(
    input: {
      action: authz.AuthorizationAction;
      scope?: Record<string, unknown> | null;
    },
    companyId: string,
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
    input: {
      action: authz.AuthorizationAction;
      scope?: Record<string, unknown> | null;
    },
    companyId: string,
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
      return authz.allow({
        action: input.action,
        reason: "allow_direct_change",
        explanation: `Allowed by direct change permission ${keys.direct}.`,
        grant: directDecision.grant,
      });
    }
    if (directDecision.reason === "deny_missing_membership") {
      return directDecision;
    }

    const suggestDecision = await decidePrincipalGrant({
      companyId,
      principalType,
      principalId,
      action: input.action,
      permissionKey: keys.suggest,
      scope: decisionScope,
    });
    if (suggestDecision.allowed) {
      if (authz.scopeBoolean(decisionScope, "consentedChange")) {
        return authz.allow({
          action: input.action,
          reason: "allow_consented_change",
          explanation: `Allowed by suggest permission ${keys.suggest} after accepted change consent.`,
          grant: suggestDecision.grant,
        });
      }
      return authz.deny({
        action: input.action,
        reason: "deny_missing_consent",
        explanation: `Permission ${keys.suggest} requires accepted change consent before applying this mutation.`,
        grant: suggestDecision.grant,
      });
    }
    if (suggestDecision.reason === "deny_missing_membership") {
      return suggestDecision;
    }
    if (directDecision.reason === "deny_scope") return directDecision;
    if (suggestDecision.reason === "deny_scope") return suggestDecision;

    return authz.deny({
      action: input.action,
      reason: "deny_no_grant",
      explanation: `Missing permission: ${keys.direct} or ${keys.suggest}.`,
    });
  }

  return {
    db,
    isInstanceAdmin,
    getActiveMembership,
    getResponsibleUserSnapshot,
    findGrant,
    decidePrincipalGrant,
    loadAgent,
    decideWithAgentConfigReadGrant,
    decideWithProtectedChangeGrants,
  };
}

export type ReturnTypeOfAuthorizationCore = ReturnType<typeof createAuthorizationCore>;
