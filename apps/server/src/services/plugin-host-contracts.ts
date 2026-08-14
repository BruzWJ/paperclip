import type { WorkerToHostMethods } from "@paperclipai/plugin-sdk";
import type { AgentSuspensionService } from "./agents.js";
import type { OrdinaryTaskRuntime } from "./ordinary-task-runtime.js";
import { authUsers, principalPermissionGrants } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { PermissionKey, PrincipalType } from "@paperclipai/shared";
import type { AuthorizationActor } from "./authorization.js";
import { sanitizeRecord } from "../redaction.js";
import type { PluginHostServicesContext } from "./plugin-host-services-context.js";
import { buildPluginHostServicesPluginHostEntityTools } from "./plugin-host-entity-tools.js";
import { buildPluginHostServicesPluginHostScopeActivity } from "./plugin-host-scope-activity.js";

/**
 * buildHostServices — creates a concrete implementation of the `HostServices`
 * interface for a specific plugin.
 *
 * This implementation delegates to the core Paperclip domain services,
 * providing the bridge between the plugin worker's SDK and the host platform.
 *
 * @param db - Database connection instance.
 * @param pluginId - The UUID of the plugin installation record.
 * @param eventBus - The system-wide event bus for publishing plugin events.
 * @returns An object implementing the HostServices interface for the plugin SDK.
 */
export type PluginTaskInstallationContext = {
  pluginInstallationId: string;
  pluginKey: string;
};

export type PluginTaskMutationContext = PluginTaskInstallationContext & {
  hostRpcOperationId: string;
};

/**
 * Canonical installation-bound task control plane. There is intentionally no
 * direct task-service fallback: an unconfigured host fails closed instead of
 * bypassing task ownership, creator, Session, or idempotency invariants.
 */
export interface PluginTaskControlPlane {
  list(
    params: WorkerToHostMethods["tasks.list"][0] & PluginTaskInstallationContext,
  ): Promise<WorkerToHostMethods["tasks.list"][1]>;
  get(
    params: WorkerToHostMethods["tasks.get"][0] & PluginTaskInstallationContext,
  ): Promise<WorkerToHostMethods["tasks.get"][1]>;
  create(
    params: WorkerToHostMethods["tasks.create"][0] &
      PluginTaskMutationContext & { callbackRegistrationActive: true },
  ): Promise<WorkerToHostMethods["tasks.create"][1]>;
  update(
    params: WorkerToHostMethods["tasks.update"][0] & PluginTaskMutationContext,
  ): Promise<WorkerToHostMethods["tasks.update"][1]>;
  withdraw(
    params: WorkerToHostMethods["tasks.withdraw"][0] & PluginTaskMutationContext,
  ): Promise<WorkerToHostMethods["tasks.withdraw"][1]>;
}

export interface PluginRunTaskContextReader {
  resolveContext(
    params: WorkerToHostMethods["run.context.resolve"][0] & PluginTaskInstallationContext,
  ): Promise<WorkerToHostMethods["run.context.resolve"][1]>;
  taskReach(
    params: WorkerToHostMethods["run.context.taskReach"][0] & PluginTaskInstallationContext,
  ): Promise<WorkerToHostMethods["run.context.taskReach"][1]>;
  listCompanyTasks(
    params: WorkerToHostMethods["run.tasks.listCompanyTasks"][0] & PluginTaskInstallationContext,
  ): Promise<WorkerToHostMethods["run.tasks.listCompanyTasks"][1]>;
  listSubTasks(
    params: WorkerToHostMethods["run.tasks.listSubTasks"][0] & PluginTaskInstallationContext,
  ): Promise<WorkerToHostMethods["run.tasks.listSubTasks"][1]>;
  readTaskComments(
    params: WorkerToHostMethods["run.tasks.readTaskComments"][0] & PluginTaskInstallationContext,
  ): Promise<WorkerToHostMethods["run.tasks.readTaskComments"][1]>;
  readTaskAgentRun(
    params: WorkerToHostMethods["run.tasks.readTaskAgentRun"][0] & PluginTaskInstallationContext,
  ): Promise<WorkerToHostMethods["run.tasks.readTaskAgentRun"][1]>;
}

export interface PluginRuntimeRecordsReader {
  readSession(
    params: WorkerToHostMethods["runtime.records.readSession"][0] & PluginTaskInstallationContext,
  ): Promise<WorkerToHostMethods["runtime.records.readSession"][1]>;
  readRun(
    params: WorkerToHostMethods["runtime.records.readRun"][0] & PluginTaskInstallationContext,
  ): Promise<WorkerToHostMethods["runtime.records.readRun"][1]>;
  readTaskComments(
    params: WorkerToHostMethods["runtime.records.readTaskComments"][0] & PluginTaskInstallationContext,
  ): Promise<WorkerToHostMethods["runtime.records.readTaskComments"][1]>;
}

export interface PluginHostServicesOptions {
  manifest: import("@paperclipai/shared").PaperclipPluginManifestV1;
  pluginTaskControlPlane: PluginTaskControlPlane;
  pluginRunTaskContextReader: PluginRunTaskContextReader;
  pluginRuntimeRecordsReader: PluginRuntimeRecordsReader;
  ordinaryTasks: OrdinaryTaskRuntime;
  secretsRuntime: import("../secrets/types.js").SecretsRuntimeConfig;
  taskExecutionCancellation: AgentSuspensionService;
}

export function buildPluginHostServicesPluginHostAuthorizationPolicy(
  scope: PluginHostServicesContext &
    ReturnType<typeof buildPluginHostServicesPluginHostEntityTools> &
    ReturnType<typeof buildPluginHostServicesPluginHostScopeActivity>,
) {
  const { db, companies, agents, tasks, access, inCompany } = scope;

  type StoredGrant = typeof principalPermissionGrants.$inferSelect;

  type PublicGrant = Omit<StoredGrant, "principalUserId" | "principalAgentId"> & {
    principalId: string;
  };

  const redactGrant = (grant: StoredGrant | PublicGrant) => {
    const principalId =
      "principalId" in grant
        ? grant.principalId
        : grant.principalType === "user"
          ? grant.principalUserId
          : grant.principalAgentId;
    if (!principalId) {
      throw new Error(`Invalid ${grant.principalType} permission grant ${grant.id}`);
    }
    const {
      principalUserId: _principalUserId,
      principalAgentId: _principalAgentId,
      ...stored
    } = grant as StoredGrant & { principalId?: string };
    return {
      ...stored,
      principalId,
      principalType: grant.principalType as PrincipalType,
      permissionKey: grant.permissionKey as PermissionKey,
      scope:
        grant.scope && typeof grant.scope === "object" ? sanitizeRecord(grant.scope) : (grant.scope ?? null),
    };
  };

  const loadPluginMember = async (companyId: string, memberId: string) => {
    const member = await access.getMemberById(companyId, memberId);
    if (!member) return null;
    const grants = await access.listPrincipalGrants(
      companyId,
      member.principalType as PrincipalType,
      member.principalId,
    );
    return {
      ...member,
      principalType: member.principalType as PrincipalType,
      status: member.status as "pending" | "active" | "suspended" | "archived",
      grants: grants.map(redactGrant),
    };
  };

  const resolvePluginTargetManagementSubject = async (
    subject: { type: "user"; userId: string } | { type: "agent"; agentId: string },
  ): Promise<AuthorizationActor> => {
    if (subject.type === "agent") {
      const persistedAgent = await agents.getById(subject.agentId);
      if (!persistedAgent) {
        return { type: "none", source: "none" };
      }
      return {
        type: "agent",
        agentId: persistedAgent.id,
        companyId: persistedAgent.companyId,
        source: "internal",
      };
    }
    const persistedUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, subject.userId))
      .then((rows) => rows[0] ?? null);
    if (!persistedUser) {
      return { type: "none", source: "none" };
    }
    return {
      type: "board",
      userId: persistedUser.id,
    };
  };

  const policyPathForResource = (resourceType: "company" | "agent" | "task") => {
    switch (resourceType) {
      case "agent":
        return { table: "agent" as const };
      case "task":
        return { table: "task" as const };
      case "company":
        return { table: "company" as const };
    }
  };

  const readAuthorizationPolicy = async (
    companyId: string,
    resourceType: "company" | "agent" | "task",
    resourceId: string,
  ) => {
    const pathInfo = policyPathForResource(resourceType);
    if (pathInfo.table === "agent") {
      const agent = await agents.getById(resourceId);
      if (!inCompany(agent, companyId)) return null;
      return {
        resourceType,
        resourceId,
        companyId,
        policy: null,
        updatedAt: agent.updatedAt,
      };
    }
    if (pathInfo.table === "task") {
      const task = await tasks.getById(resourceId);
      if (!inCompany(task, companyId)) return null;
      const policy =
        task.executionPolicy && typeof task.executionPolicy === "object"
          ? (task.executionPolicy as Record<string, unknown>).authorizationPolicy
          : null;
      return {
        resourceType,
        resourceId,
        companyId,
        policy:
          policy && typeof policy === "object" ? sanitizeRecord(policy as Record<string, unknown>) : null,
        updatedAt: task.updatedAt,
      };
    }
    const company = await companies.getById(resourceId);
    if (!company || company.id !== companyId) return null;
    return {
      resourceType,
      resourceId,
      companyId,
      policy: null,
      updatedAt: company.updatedAt,
    };
  };

  return {
    redactGrant,
    loadPluginMember,
    resolvePluginTargetManagementSubject,
    policyPathForResource,
    readAuthorizationPolicy,
  };
}
