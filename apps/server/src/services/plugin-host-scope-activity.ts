import { invites, principalPermissionGrants } from "@paperclipai/db";
import { and, isNull, isNotNull, gt, lte } from "drizzle-orm";
import { resolveUserInviteRole } from "./company-member-roles.js";
import { logActivity } from "./activity-log.js";
import { type PluginHostServicesContext } from "./plugin-host-services-context.js";
import { buildPluginHostServicesPluginHostEntityTools } from "./plugin-host-entity-tools.js";

export function buildPluginHostServicesPluginHostScopeActivity(
  scope: PluginHostServicesContext & ReturnType<typeof buildPluginHostServicesPluginHostEntityTools>,
) {
  const { db, pluginId, pluginKey, ensureCompanyId } = scope;

  type StoredGrant = typeof principalPermissionGrants.$inferSelect;

  type PublicGrant = Omit<StoredGrant, "principalUserId" | "principalAgentId"> & {
    principalId: string;
  };

  const inCompany = <T extends { companyId: string | null | undefined }>(
    record: T | null | undefined,
    companyId: string,
  ): record is T => Boolean(record && record.companyId === companyId);

  const requireInCompany = <T extends { companyId: string | null | undefined }>(
    entityName: string,
    record: T | null | undefined,
    companyId: string,
  ): T => {
    if (!inCompany(record, companyId)) {
      throw new Error(`${entityName} not found`);
    }
    return record;
  };

  const pluginActivityDetails = (
    details: Record<string, unknown> | null | undefined,
    actor?: {
      actorAgentId?: string | null;
      actorUserId?: string | null;
      actorRunId?: string | null;
    },
  ) => {
    const initiatingActorType = actor?.actorAgentId ? "agent" : actor?.actorUserId ? "user" : null;
    const initiatingActorId = actor?.actorAgentId ?? actor?.actorUserId ?? null;
    return {
      ...(details ?? {}),
      sourcePluginId: pluginId,
      sourcePluginKey: pluginKey,
      initiatingActorType,
      initiatingActorId,
      initiatingAgentId: actor?.actorAgentId ?? null,
      initiatingUserId: actor?.actorUserId ?? null,
      initiatingRunId: actor?.actorRunId ?? null,
    };
  };

  const logPluginActivity = async (input: {
    companyId: string;
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown> | null;
    actor?: {
      actorAgentId?: string | null;
      actorUserId?: string | null;
      actorRunId?: string | null;
    };
  }) => {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "plugin",
      actorId: pluginId,
      agentId: input.actor?.actorAgentId ?? null,
      runId: input.actor?.actorRunId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      details: pluginActivityDetails(input.details, input.actor),
    });
  };

  const inviteState = (invite: typeof invites.$inferSelect) => {
    if (invite.revokedAt) return "revoked" as const;
    if (invite.acceptedAt) return "accepted" as const;
    if (invite.expiresAt <= new Date()) return "expired" as const;
    return "active" as const;
  };

  const redactInvite = (invite: typeof invites.$inferSelect) => {
    if (invite.source === "bootstrap_admin_cli") {
      throw new Error("Bootstrap invites are outside company plugin scope");
    }
    const { tokenHash: _tokenHash, defaultsPayload, ...safeInvite } = invite;
    return {
      ...safeInvite,
      companyId: ensureCompanyId(invite.companyId),
      inviteType: "company_join" as const,
      source: invite.source,
      userRole: resolveUserInviteRole(defaultsPayload as Record<string, unknown> | null),
      state: inviteState(invite),
    };
  };

  const inviteStateWhereClause = (state: unknown) => {
    const now = new Date();
    switch (state) {
      case "active":
        return and(isNull(invites.revokedAt), isNull(invites.acceptedAt), gt(invites.expiresAt, now));
      case "accepted":
        return isNotNull(invites.acceptedAt);
      case "expired":
        return and(isNull(invites.revokedAt), isNull(invites.acceptedAt), lte(invites.expiresAt, now));
      case "revoked":
        return isNotNull(invites.revokedAt);
      default:
        return undefined;
    }
  };

  return {
    inCompany,
    requireInCompany,
    pluginActivityDetails,
    logPluginActivity,
    inviteState,
    redactInvite,
    inviteStateWhereClause,
  };
}
