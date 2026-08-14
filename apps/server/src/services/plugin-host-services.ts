import { type Db, invites, principalPermissionGrants } from "@paperclipai/db";
import type { HostServices, HostToWorkerMethods } from "@paperclipai/plugin-sdk";
import type { PluginEventBus } from "./plugin-event-bus.js";
import type { PluginHostServicesOptions } from "./plugin-host-contracts.js";

import {
  createPluginHostServicesContext,
  type PluginHostServicesScope,
} from "./plugin-host-services-context.js";
import { buildPluginHostServicesPluginHostEntityTools } from "./plugin-host-entity-tools.js";
import { buildPluginHostServicesPluginHostScopeActivity } from "./plugin-host-scope-activity.js";
import { buildPluginHostServicesPluginHostAuthorizationPolicy } from "./plugin-host-contracts.js";
import { createPluginHostServicesMethods1 } from "./plugin-host-services-methods-1.js";
import { createPluginHostServicesMethods2 } from "./plugin-host-services-methods-2.js";
import { createPluginHostServicesMethods5 } from "./plugin-host-services-methods-5.js";
import { eq, and, desc, isNull } from "drizzle-orm";
import { type PrincipalType } from "@paperclipai/shared";
import { createCompanyInvite } from "./company-invite-creation.js";
import { sanitizeRecord } from "../redaction.js";
import { readExactPluginListWindow } from "./plugin-host-validation.js";

export type PluginHostServicesMethods3 = Pick<
  HostServices & { dispose(): Promise<void> },
  "tasks" | "runTasks" | "agents" | "goals"
>;

export function createPluginHostServicesMethods3(scope: PluginHostServicesScope): PluginHostServicesMethods3 {
  const {
    pluginId,
    options,
    pluginKey,
    agents,
    managedAgents,
    registeredCreatorCallbacks,
    tasks,
    goals,
    pluginTaskRuntime,
    ensureCompanyId,
    applyWindow,
    ensurePluginAvailableForCompany,
    inCompany,
    requireInCompany,
  } = scope;

  return {
    tasks: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return pluginTaskRuntime.list({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return pluginTaskRuntime.get({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async registerCreatorCallback(params) {
        const { callbackKey, callbackVersion } = params;
        if (
          callbackKey.length === 0 ||
          callbackKey !== callbackKey.trim() ||
          callbackVersion.length === 0 ||
          callbackVersion !== callbackVersion.trim()
        ) {
          throw new Error("Creator callback key and version must be exact non-empty strings");
        }
        registeredCreatorCallbacks.add(`${callbackKey}\u0000${callbackVersion}`);
        return {
          callbackKey,
          callbackVersion,
          registered: true as const,
        };
      },
      async create(params, operation) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        if (!registeredCreatorCallbacks.has(`${params.callbackKey}\u0000${params.callbackVersion}`)) {
          throw new Error(
            `Creator callback is not registered: ${params.callbackKey}@${params.callbackVersion}`,
          );
        }
        return pluginTaskRuntime.create({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
          hostRpcOperationId: operation.hostRpcOperationId,
          callbackRegistrationActive: true,
        });
      },
      async update(params, operation) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return pluginTaskRuntime.update({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
          hostRpcOperationId: operation.hostRpcOperationId,
        });
      },
      async withdraw(params, operation) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return pluginTaskRuntime.withdraw({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
          hostRpcOperationId: operation.hostRpcOperationId,
        });
      },
    },

    runTasks: {
      async resolveContext(params) {
        return options.pluginRunTaskContextReader.resolveContext({
          ...params,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async taskReach(params) {
        return options.pluginRunTaskContextReader.taskReach({
          ...params,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async listCompanyTasks(params) {
        return options.pluginRunTaskContextReader.listCompanyTasks({
          ...params,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async listSubTasks(params) {
        return options.pluginRunTaskContextReader.listSubTasks({
          ...params,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async readTaskComments(params) {
        return options.pluginRunTaskContextReader.readTaskComments({
          ...params,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async readTaskAgentRun(params) {
        return options.pluginRunTaskContextReader.readTaskAgentRun({
          ...params,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
    },

    agents: {
      async list(params) {
        const window = readExactPluginListWindow(params, null);
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rows = await agents.list(companyId);
        return applyWindow(
          rows.filter((agent) => !params.status || agent.status === params.status),
          window,
        );
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        return inCompany(agent, companyId) ? agent : null;
      },
      async pause(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        const updated = await agents.pause(params.agentId, {
          actor: { kind: "system" },
          taskExecutionCancellation: options.taskExecutionCancellation,
        });
        if (!updated) throw new Error("Agent not found after pause");
        return updated;
      },
      async resume(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        const updated = await agents.resume(params.agentId);
        if (!updated) throw new Error("Agent not found after resume");
        return updated;
      },
      async managedGet(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedAgents.get(params.agentKey, companyId);
      },
      async managedReconcile(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedAgents.reconcile(params.agentKey, companyId);
      },
      async managedReset(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedAgents.reset(params.agentKey, companyId);
      },
    },

    goals: {
      async list(params) {
        const window = readExactPluginListWindow(params, null);
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rows = await goals.list(companyId);
        return applyWindow(
          rows.filter(
            (goal) =>
              (!params.level || goal.level === params.level) &&
              (!params.status || goal.status === params.status),
          ),
          window,
        );
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const goal = await goals.getById(params.goalId);
        return inCompany(goal, companyId) ? goal : null;
      },
      async create(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return goals.create(companyId, {
          title: params.title,
          description: params.description,
          level: params.level,
          status: params.status,
          parentId: params.parentId,
          ownerAgentId: params.ownerAgentId,
        });
      },
      async update(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany("Goal", await goals.getById(params.goalId), companyId);
        const updated = await goals.update(params.goalId, params.patch);
        if (!updated) throw new Error("Goal not found");
        return updated;
      },
    },
  } satisfies Pick<HostServices & { dispose(): Promise<void> }, "tasks" | "runTasks" | "agents" | "goals">;
}

export function createPluginHostServicesMethods4(scope: PluginHostServicesScope) {
  const {
    db,
    access,
    ensureCompanyId,
    ensurePluginAvailableForCompany,
    logPluginActivity,
    redactInvite,
    inviteStateWhereClause,
    redactGrant,
    loadPluginMember,
  } = scope;

  return {
    access: {
      async listMembers(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rows = await access.listMembers(companyId);
        const visibleRows = params.includeArchived ? rows : rows.filter((row) => row.status !== "archived");
        const grants = await db
          .select()
          .from(principalPermissionGrants)
          .where(eq(principalPermissionGrants.companyId, companyId));
        const grantsByPrincipal = new Map<string, typeof grants>();
        for (const grant of grants) {
          const principalId = grant.principalType === "user" ? grant.principalUserId : grant.principalAgentId;
          if (!principalId) {
            throw new Error(`Invalid ${grant.principalType} permission grant ${grant.id}`);
          }
          const key = `${grant.principalType}:${principalId}`;
          const existing = grantsByPrincipal.get(key) ?? [];
          existing.push(grant);
          grantsByPrincipal.set(key, existing);
        }
        return visibleRows.map((member) => ({
          ...member,
          principalType: member.principalType as PrincipalType,
          status: member.status as "pending" | "active" | "suspended" | "archived",
          grants: (grantsByPrincipal.get(`${member.principalType}:${member.principalId}`) ?? []).map(
            redactGrant,
          ),
        }));
      },
      async getMember(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return loadPluginMember(companyId, params.memberId);
      },
      async updateMember(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const updated = await access.updateMember(companyId, params.memberId, params.patch);
        if (!updated) throw new Error("Member not found");
        await logPluginActivity({
          companyId,
          action: "company_member.updated_by_plugin",
          entityType: "company_membership",
          entityId: params.memberId,
          details: {
            patch: sanitizeRecord(params.patch as Record<string, unknown>),
          },
        });
        return (await loadPluginMember(companyId, params.memberId))!;
      },
      async listInvites(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const { limit, offset } = readExactPluginListWindow(params, 20);
        const stateClause = inviteStateWhereClause(params.state);
        const rows = await db
          .select()
          .from(invites)
          .where(
            stateClause
              ? and(eq(invites.companyId, companyId), stateClause)
              : eq(invites.companyId, companyId),
          )
          .orderBy(desc(invites.createdAt))
          .limit(limit + 1)
          .offset(offset);
        const hasMore = rows.length > limit;
        return {
          invites: rows.slice(0, limit).map(redactInvite),
          nextOffset: hasMore ? offset + limit : null,
        };
      },
      async createInvite(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const { token, invite: created } = await createCompanyInvite(db, {
          companyId,
          provenance: { source: "plugin_host" },
          userRole: params.userRole,
        });
        await logPluginActivity({
          companyId,
          action: "invite.created_by_plugin",
          entityType: "invite",
          entityId: created.id,
          details: {
            expiresAt: created.expiresAt.toISOString(),
          },
        });
        return { ...redactInvite(created), token };
      },
      async revokeInvite(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const invite = await db
          .select()
          .from(invites)
          .where(and(eq(invites.id, params.inviteId), eq(invites.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!invite) throw new Error("Invite not found");
        if (invite.acceptedAt) throw new Error("Invite already consumed");
        if (invite.revokedAt) return redactInvite(invite);
        const revoked = await db
          .update(invites)
          .set({ revokedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(invites.id, invite.id),
              eq(invites.companyId, companyId),
              isNull(invites.revokedAt),
              isNull(invites.acceptedAt),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!revoked) throw new Error("Invite was not revoked");
        await logPluginActivity({
          companyId,
          action: "invite.revoked_by_plugin",
          entityType: "invite",
          entityId: invite.id,
        });
        return redactInvite(revoked);
      },
    },
  } satisfies Pick<HostServices & { dispose(): Promise<void> }, "access">;
}

export type {
  PluginTaskControlPlane,
  PluginRunTaskContextReader,
  PluginRuntimeRecordsReader,
  PluginHostServicesOptions,
} from "./plugin-host-contracts.js";

export function buildHostServices(
  db: Db,
  pluginId: string,
  eventBus: PluginEventBus,
  deliverEvent: (params: HostToWorkerMethods["onEvent"][0]) => Promise<void>,
  options: PluginHostServicesOptions,
): HostServices & { dispose(): Promise<void> } {
  const context = createPluginHostServicesContext(db, pluginId, eventBus, deliverEvent, options);
  const helpers1 = buildPluginHostServicesPluginHostEntityTools(context);
  const scope1 = { ...context, ...helpers1 };
  const helpers2 = buildPluginHostServicesPluginHostScopeActivity(scope1);
  const scope2 = { ...scope1, ...helpers2 };
  const helpers3 = buildPluginHostServicesPluginHostAuthorizationPolicy(scope2);
  const scope3 = { ...scope2, ...helpers3 };
  const scope = scope3;
  const methods1 = createPluginHostServicesMethods1(scope);
  const methods2 = createPluginHostServicesMethods2(scope);
  const methods3 = createPluginHostServicesMethods3(scope);
  const methods4 = createPluginHostServicesMethods4(scope);
  const methods5 = createPluginHostServicesMethods5(scope);
  return { ...methods1, ...methods2, ...methods3, ...methods4, ...methods5 };
}
