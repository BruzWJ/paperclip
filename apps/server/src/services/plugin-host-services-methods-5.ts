import type { HostServices } from "@paperclipai/plugin-sdk";
import { activityLog, tasks as tasksTable, principalPermissionGrants } from "@paperclipai/db";
import { eq, and, desc, or } from "drizzle-orm";
import {
  isCanonicalUuid,
  taskExecutionPolicySchema,
  trustAuthorizationPolicySchema,
  type PermissionKey,
  type PrincipalType,
} from "@paperclipai/shared";
import { sanitizeRecord } from "../redaction.js";
import { badRequest } from "../errors.js";
import {
  readExactPluginListWindow,
  requireExactAuthorizationAuditDecision,
} from "./plugin-host-validation.js";
import type { PluginHostServicesScope } from "./plugin-host-services-context.js";

export function createPluginHostServicesMethods5(scope: PluginHostServicesScope) {
  const {
    db,
    agents,
    registeredCreatorCallbacks,
    tasks,
    access,
    authorization,
    scopedBus,
    ensureCompanyId,
    authorizationAuditDecisionCondition,
    ensurePluginAvailableForCompany,
    requireInCompany,
    logPluginActivity,
    redactGrant,
    resolvePluginTargetManagementSubject,
    readAuthorizationPolicy,
  } = scope;

  return {
    authorization: {
      async listGrants(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const principalType =
          params.principalType === "user" || params.principalType === "agent" ? params.principalType : null;
        if (params.principalType && !principalType) {
          throw new Error("principalType must be 'agent' or 'user'");
        }
        const conditions = [
          eq(principalPermissionGrants.companyId, companyId),
          principalType ? eq(principalPermissionGrants.principalType, principalType) : undefined,
          params.principalId
            ? principalType === "user"
              ? eq(principalPermissionGrants.principalUserId, params.principalId)
              : principalType === "agent"
                ? eq(principalPermissionGrants.principalAgentId, params.principalId)
                : isCanonicalUuid(params.principalId)
                  ? or(
                      eq(principalPermissionGrants.principalUserId, params.principalId),
                      eq(principalPermissionGrants.principalAgentId, params.principalId),
                    )
                  : eq(principalPermissionGrants.principalUserId, params.principalId)
            : undefined,
        ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
        const rows = await db
          .select()
          .from(principalPermissionGrants)
          .where(and(...conditions))
          .orderBy(
            principalPermissionGrants.principalType,
            principalPermissionGrants.principalUserId,
            principalPermissionGrants.principalAgentId,
            principalPermissionGrants.permissionKey,
          );
        return rows.map(redactGrant);
      },
      async setGrants(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        if (params.principalType !== "agent" && params.principalType !== "user") {
          throw new Error("principalType must be 'agent' or 'user'");
        }
        if (params.principalType === "agent") {
          requireInCompany("Agent", await agents.getById(params.principalId), companyId);
        } else {
          const membership = await access.getMembership(
            companyId,
            params.principalType as PrincipalType,
            params.principalId,
          );
          if (!membership) throw new Error("Principal is not a member of this company");
        }
        await access.setPrincipalGrants(
          companyId,
          params.principalType as PrincipalType,
          params.principalId,
          params.grants.map((grant) => ({
            permissionKey: grant.permissionKey as PermissionKey,
            scope: grant.scope ? sanitizeRecord(grant.scope) : null,
          })),
          params.grantedByUserId ?? null,
        );
        await logPluginActivity({
          companyId,
          action: "authorization.grants_updated_by_plugin",
          entityType: "principal_permission_grants",
          entityId: `${params.principalType}:${params.principalId}`,
          details: { grantCount: params.grants.length },
        });
        return access
          .listPrincipalGrants(companyId, params.principalType as PrincipalType, params.principalId)
          .then((rows) => rows.map(redactGrant));
      },
      async policySummary(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const [members, grants] = await Promise.all([
          access.listMembers(companyId),
          db
            .select({ id: principalPermissionGrants.id })
            .from(principalPermissionGrants)
            .where(eq(principalPermissionGrants.companyId, companyId)),
        ]);
        return {
          companyId,
          permissionsMode: "simple" as const,
          memberCount: members.length,
          activeMemberCount: members.filter((member) => member.status === "active").length,
          grantCount: grants.length,
          advancedPolicyAvailable: false as const,
        };
      },
      async getPolicy(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return readAuthorizationPolicy(companyId, params.resourceType, params.resourceId);
      },
      async updatePolicy(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        if (params.resourceType !== "task") {
          throw new Error("Plugin authorization policy updates only support task resources.");
        }
        const policyInput = params.policy ? sanitizeRecord(params.policy) : null;
        const parsedPolicy = policyInput ? trustAuthorizationPolicySchema.safeParse(policyInput) : null;
        if (parsedPolicy && !parsedPolicy.success) {
          throw badRequest("Plugin authorization policy must use the canonical task policy shape.");
        }
        const policy = parsedPolicy?.data ?? null;
        const task = requireInCompany("Task", await tasks.getById(params.resourceId), companyId);
        const executionPolicy =
          task.executionPolicy && typeof task.executionPolicy === "object"
            ? { ...(task.executionPolicy as Record<string, unknown>) }
            : {};
        if (policy) executionPolicy.authorizationPolicy = policy;
        else delete executionPolicy.authorizationPolicy;
        if (!taskExecutionPolicySchema.safeParse(executionPolicy).success) {
          throw badRequest("Plugin authorization policy must preserve the canonical task execution policy.");
        }
        await db
          .update(tasksTable)
          .set({ executionPolicy, updatedAt: new Date() })
          .where(eq(tasksTable.id, task.id));
        await logPluginActivity({
          companyId,
          action: "authorization.policy_updated_by_plugin",
          entityType: params.resourceType,
          entityId: params.resourceId,
          details: { hasPolicy: Boolean(policy) },
        });
        const updated = await readAuthorizationPolicy(companyId, params.resourceType, params.resourceId);
        if (!updated) throw new Error("Policy resource not found");
        return updated;
      },
      async previewAssignment(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return authorization.decide({
          actor: await resolvePluginTargetManagementSubject(params.subject),
          action: "agent_config:update",
          resource: { type: "agent", companyId, agentId: params.targetAgentId },
          scope: {
            requiresChangeGrant: true,
            targetAgentId: params.targetAgentId,
          },
        });
      },
      async searchAudit(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const { limit, offset } = readExactPluginListWindow(params, 50);
        const decisionFilter = requireExactAuthorizationAuditDecision(params.decision);
        const conditions = [
          eq(activityLog.companyId, companyId),
          params.action ? eq(activityLog.action, params.action) : undefined,
          params.actorType ? eq(activityLog.actorType, params.actorType) : undefined,
          params.actorId ? eq(activityLog.actorId, params.actorId) : undefined,
          params.entityType ? eq(activityLog.entityType, params.entityType) : undefined,
          params.entityId ? eq(activityLog.entityId, params.entityId) : undefined,
          decisionFilter ? authorizationAuditDecisionCondition(decisionFilter) : undefined,
        ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
        const rows = await db
          .select()
          .from(activityLog)
          .where(and(...conditions))
          .orderBy(desc(activityLog.createdAt))
          .limit(limit)
          .offset(offset);
        return rows.map((row) => ({
          ...row,
          details:
            row.details && typeof row.details === "object"
              ? sanitizeRecord(row.details)
              : (row.details ?? null),
        }));
      },
    },

    /** Release plugin event subscriptions owned by this worker runtime. */
    async dispose() {
      registeredCreatorCallbacks.clear();
      // Clear event bus subscriptions to prevent accumulation on worker restart.
      // Without this, each crash/restart cycle adds duplicate subscriptions.
      scopedBus.clear();
    },
  } satisfies Pick<HostServices & { dispose(): Promise<void> }, "authorization" | "dispose">;
}
