import { activityLog, principalPermissionGrants } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import type { PluginAuthorizationAuditDecision, WorkerToHostMethods } from "@paperclipai/plugin-sdk";
import { isCanonicalUuid } from "@paperclipai/shared";
import {
  getStoredLocalFolders,
  inspectPluginLocalFolder,
  requireLocalFolderDeclaration,
} from "./plugin-local-folders.js";
import {
  assertPluginInstallationRequestScope,
  PluginTaskAuthorizationRejected,
} from "./plugin-task-authorization.js";
import { type ExactPluginListWindow } from "./plugin-host-validation.js";
import { type PluginHostServicesContext } from "./plugin-host-services-context.js";

export function buildPluginHostServicesPluginHostEntityTools(scope: PluginHostServicesContext) {
  const { db, pluginId, deliverEvent, options, pluginKey, registry } = scope;

  type StoredGrant = typeof principalPermissionGrants.$inferSelect;

  type PublicGrant = Omit<StoredGrant, "principalUserId" | "principalAgentId"> & {
    principalId: string;
  };

  const toPluginEntityRecord = (
    entity: NonNullable<Awaited<ReturnType<typeof registry.upsertEntity>>>,
  ): WorkerToHostMethods["entities.upsert"][1] => ({
    id: entity.id,
    entityType: entity.entityType,
    scopeKind: entity.scopeKind,
    scopeId: entity.scopeId,
    externalId: entity.externalId,
    title: entity.title,
    status: entity.status,
    data: entity.data,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  });

  const ensureCompanyId = (companyId?: string | null) => {
    if (!isCanonicalUuid(companyId)) {
      throw new Error("companyId must be an exact canonical UUID");
    }
    return companyId;
  };

  const applyWindow = <T>(rows: T[], window: ExactPluginListWindow): T[] => {
    if (window.limit === null) return rows.slice(window.offset);
    return rows.slice(window.offset, window.offset + window.limit);
  };

  const authorizationAuditDecisionCondition = (decisionFilter: PluginAuthorizationAuditDecision) => {
    const conditions = [
      sql`${activityLog.details}->>'decision' = ${decisionFilter}`,
      decisionFilter === "allow"
        ? sql`left(coalesce(${activityLog.details}->>'reason', ''), 6) = 'allow_'`
        : undefined,
      decisionFilter === "deny"
        ? sql`left(coalesce(${activityLog.details}->>'reason', ''), 5) = 'deny_'`
        : undefined,
      decisionFilter === "allow" ? sql`${activityLog.details}->>'allowed' = 'true'` : undefined,
      decisionFilter === "deny" ? sql`${activityLog.details}->>'allowed' = 'false'` : undefined,
    ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
    return sql`(${sql.join(conditions, sql` OR `)})`;
  };

  const ensurePluginAvailableForCompany = async (companyId: string) => {
    await assertPluginInstallationRequestScope(db, {
      companyId,
      pluginInstallationId: pluginId,
      pluginKey,
    });
  };

  const deliverSubscribedEvent = async (event: import("@paperclipai/plugin-sdk").PluginEvent) => {
    if (event.companyId) {
      try {
        await ensurePluginAvailableForCompany(ensureCompanyId(event.companyId));
      } catch (error) {
        if (error instanceof PluginTaskAuthorizationRejected) return;
        throw error;
      }
    }
    await deliverEvent({ event });
  };

  const getLocalFolderDeclaration = (folderKey: string) =>
    requireLocalFolderDeclaration(options.manifest.localFolders ?? [], folderKey);

  const getStoredLocalFolderConfig = async (companyId: string, folderKey: string) => {
    ensureCompanyId(companyId);
    await ensurePluginAvailableForCompany(companyId);
    const settings = await registry.getCompanySettings(pluginId, companyId);
    return getStoredLocalFolders(settings?.settingsJson)[folderKey] ?? null;
  };

  const inspectStoredLocalFolder = async (companyId: string, folderKey: string) => {
    const declaration = getLocalFolderDeclaration(folderKey);
    const stored = await getStoredLocalFolderConfig(companyId, folderKey);
    return inspectPluginLocalFolder({
      declaration,
      path: stored?.path ?? null,
    });
  };

  return {
    toPluginEntityRecord,
    ensureCompanyId,
    applyWindow,
    authorizationAuditDecisionCondition,
    ensurePluginAvailableForCompany,
    deliverSubscribedEvent,
    getLocalFolderDeclaration,
    getStoredLocalFolderConfig,
    inspectStoredLocalFolder,
  };
}
