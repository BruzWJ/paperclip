import { and, eq } from "drizzle-orm";
import { type Db, agents, pluginEntities, pluginManagedResources } from "@paperclipai/db";
import {
  type Agent,
  type PluginManagedAgentDeclaration,
  type PluginManagedAgentResolution,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { MANAGED_AGENT_ENTITY_TYPE } from "./plugin-managed-agent-binding.js";
import {
  bindingExternalId,
  managedEntityAgentId,
  managedEntityPluginKey,
} from "./plugin-managed-agent-triage.js";
import { type PluginManagedAgentsContext } from "./plugin-managed-agents.js";

export function buildPluginManagedAgentsPluginManagedAgentResolution(scope: PluginManagedAgentsContext) {
  const { db, options, pluginKey } = scope;

  function declarationFor(agentKey: string) {
    const declaration = options.manifest.agents?.find((agent) => agent.agentKey === agentKey);
    if (!declaration) {
      throw notFound(`Managed agent declaration not found: ${agentKey}`);
    }
    return declaration;
  }

  async function getBinding(companyId: string, agentKey: string, database: Db = db) {
    return database
      .select()
      .from(pluginEntities)
      .where(
        and(
          eq(pluginEntities.pluginId, options.pluginId),
          eq(pluginEntities.companyId, companyId),
          eq(pluginEntities.entityType, MANAGED_AGENT_ENTITY_TYPE),
          eq(pluginEntities.externalId, bindingExternalId(companyId, agentKey)),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getManagedResourceBinding(companyId: string, agentKey: string, database: Db = db) {
    return database
      .select()
      .from(pluginManagedResources)
      .where(
        and(
          eq(pluginManagedResources.companyId, companyId),
          eq(pluginManagedResources.pluginId, options.pluginId),
          eq(pluginManagedResources.resourceKind, "agent"),
          eq(pluginManagedResources.resourceKey, agentKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function upsertBinding(
    companyId: string,
    declaration: PluginManagedAgentDeclaration,
    agentId: string,
    extraData: Record<string, unknown> = {},
    database: Db = db,
  ) {
    const defaultsJson = {
      agentKey: declaration.agentKey,
      displayName: declaration.displayName,
      title: declaration.title ?? null,
      capabilities: declaration.capabilities ?? null,
    };
    const managedResource = await getManagedResourceBinding(companyId, declaration.agentKey, database);
    const originalDeclarationRef = {
      pluginInstallationId: options.pluginId,
      pluginKey,
      pluginVersion: options.manifest.version,
      resourceKind: "agent",
      resourceKey: declaration.agentKey,
      declaration,
    };
    if (managedResource) {
      if (managedResource.lifecycleState !== "active") {
        throw conflict(
          `Managed agent binding '${declaration.agentKey}' is ${managedResource.lifecycleState} and cannot be reacquired`,
        );
      }
      if (managedResource.resourceId !== agentId) {
        throw conflict(`Managed agent binding '${declaration.agentKey}' cannot be relinked to another agent`);
      }
      if (managedResource.pluginKey !== pluginKey) {
        throw conflict(`Managed agent binding '${declaration.agentKey}' crossed its immutable plugin key`);
      }
      if (!managedResource.originalDeclarationRef) {
        throw conflict(
          `Managed agent binding '${declaration.agentKey}' lost its immutable declaration provenance`,
        );
      }
      const updatedResource = await database
        .update(pluginManagedResources)
        .set({
          defaultsJson,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pluginManagedResources.id, managedResource.id),
            eq(pluginManagedResources.lifecycleState, "active"),
          ),
        )
        .returning({ id: pluginManagedResources.id })
        .then((rows) => rows[0] ?? null);
      if (!updatedResource) {
        throw conflict(
          `Managed agent binding '${declaration.agentKey}' lost its active lifecycle transition`,
        );
      }
    } else {
      await database.insert(pluginManagedResources).values({
        companyId,
        pluginId: options.pluginId,
        pluginKey,
        resourceKind: "agent",
        resourceKey: declaration.agentKey,
        resourceId: agentId,
        defaultsJson,
        lifecycleState: "active",
        originalDeclarationRef,
      });
    }

    const externalId = bindingExternalId(companyId, declaration.agentKey);
    const data = {
      pluginKey,
      resourceKind: "agent",
      resourceKey: declaration.agentKey,
      agentId,
      declarationSnapshot: declaration,
      lastReconciledAt: new Date().toISOString(),
      ...extraData,
    };
    const existing = await getBinding(companyId, declaration.agentKey, database);
    if (managedResource && !existing) {
      throw conflict(`Managed agent binding '${declaration.agentKey}' lost its paired entity`);
    }
    if (!managedResource && existing) {
      throw conflict(`Managed agent entity '${declaration.agentKey}' lost its paired resource binding`);
    }
    if (existing) {
      if (existing.status !== "active") {
        throw conflict(
          `Managed agent entity '${declaration.agentKey}' is ${existing.status} and cannot be reacquired`,
        );
      }
      const existingAgentId = managedEntityAgentId(existing);
      if (existingAgentId !== agentId) {
        throw conflict(`Managed agent entity '${declaration.agentKey}' cannot be relinked to another agent`);
      }
      if (managedEntityPluginKey(existing) !== pluginKey) {
        throw conflict(`Managed agent entity '${declaration.agentKey}' crossed its immutable plugin key`);
      }
      const updatedEntity = await database
        .update(pluginEntities)
        .set({
          scopeKind: "company",
          scopeId: companyId,
          companyId,
          title: declaration.displayName,
          status: "active",
          data,
          updatedAt: new Date(),
        })
        .where(and(eq(pluginEntities.id, existing.id), eq(pluginEntities.status, "active")))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updatedEntity) {
        throw conflict(`Managed agent entity '${declaration.agentKey}' lost its active lifecycle transition`);
      }
      return updatedEntity;
    }
    return database
      .insert(pluginEntities)
      .values({
        pluginId: options.pluginId,
        companyId,
        entityType: MANAGED_AGENT_ENTITY_TYPE,
        scopeKind: "company",
        scopeId: companyId,
        externalId,
        title: declaration.displayName,
        status: "active",
        data,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function resolution(
    companyId: string,
    declaration: PluginManagedAgentDeclaration,
    agent: Agent | null,
    status: PluginManagedAgentResolution["status"],
    approvalId?: string | null,
  ): Promise<PluginManagedAgentResolution> {
    return {
      pluginKey,
      resourceKind: "agent",
      resourceKey: declaration.agentKey,
      companyId,
      agentId: agent?.id ?? null,
      agent,
      status,
      approvalId: approvalId ?? null,
    };
  }

  return {
    declarationFor,
    getBinding,
    getManagedResourceBinding,
    upsertBinding,
    resolution,
  };
}
