import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  pluginEntities,
  pluginManagedResources,
} from "@paperclipai/db";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  type Agent,
  type PaperclipPluginManifestV1,
  type PluginManagedAgentDeclaration,
  type PluginManagedAgentResolution,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import {
  agentService,
  terminateAgentToTombstoneInTransaction,
  type AgentLifecycleCancellationService,
  type AgentLifecyclePostCommit,
  type AgentSuspensionService,
} from "./agents.js";
import { logActivity } from "./activity-log.js";
import {
  createRuntimeAgentConfigurationService,
  RuntimeAgentConfigurationDenied,
} from "./runtime-agent-configuration.js";
import {
  withdrawOpenHireApprovalForAgentInTransaction,
  type ApprovalLifecycleTransaction,
  type HireRejectionAgentTerminationInput,
} from "./approvals.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import type {
  RequestedAgentRunCancellations,
  RequestedAgentSuspensions,
} from "./issue-execution-cancellation.js";
import { lockCompanyAgentGraph } from "./agent-org-graph-lock.js";

const MANAGED_AGENT_ENTITY_TYPE = "managed_agent";
type PluginManagedAgentBinding =
  typeof pluginManagedResources.$inferSelect;

async function lockPairedManagedAgentEntity(
  tx: IssueSessionDbTransaction,
  binding: PluginManagedAgentBinding,
) {
  const rows = await tx
    .select()
    .from(pluginEntities)
    .where(
      and(
        eq(pluginEntities.pluginId, binding.pluginId),
        eq(pluginEntities.companyId, binding.companyId),
        eq(pluginEntities.entityType, MANAGED_AGENT_ENTITY_TYPE),
        eq(
          pluginEntities.externalId,
          bindingExternalId(binding.companyId, binding.resourceKey),
        ),
      ),
    )
    .limit(2)
    .for("update");
  if (rows.length !== 1) {
    throw conflict(
      "Plugin-managed agent binding lost its unique paired entity",
    );
  }
  const entity = rows[0]!;
  if (
    entity.status !== binding.lifecycleState ||
    entity.scopeKind !== "company" ||
    entity.scopeId !== binding.companyId ||
    binding.pluginKey !== managedEntityPluginKey(entity) ||
    binding.resourceId !== managedEntityAgentId(entity)
  ) {
    throw conflict(
      "Plugin-managed agent binding and entity disagree on lifecycle or identity",
    );
  }
  return entity;
}

interface PausePluginManagedAgentsIntoTriageInput {
  pluginId: string;
  pluginKey: string;
  reason: string;
  actorType?: "system" | "user";
  actorId?: string | null;
}

interface PausePluginManagedAgentsIntoTriageResult {
  triagePausedAgentIds: string[];
  suspensionRequests: RequestedAgentSuspensions[];
}

export async function getPluginManagedAgentBinding(
  db: Db,
  input: { companyId: string; agentId: string },
) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(pluginManagedResources)
      .where(
        and(
          eq(pluginManagedResources.companyId, input.companyId),
          eq(pluginManagedResources.resourceKind, "agent"),
          eq(pluginManagedResources.resourceId, input.agentId),
        ),
      )
      .orderBy(desc(pluginManagedResources.updatedAt))
      .limit(2)
      .for("share");
    if (rows.length > 1) {
      throw conflict(
        "Agent has multiple plugin-managed lifecycle bindings",
      );
    }
    const binding = rows[0] ?? null;
    if (binding) {
      await lockPairedManagedAgentEntity(tx, binding);
    }
    return binding;
  });
}

export async function adoptPluginManagedAgentFromBoard(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    actorUserId: string;
  },
) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const graph = await lockCompanyAgentGraph(tx, input.companyId);
    const bindingRows = await tx
      .select()
      .from(pluginManagedResources)
      .where(
        and(
          eq(pluginManagedResources.companyId, input.companyId),
          eq(pluginManagedResources.resourceKind, "agent"),
          eq(pluginManagedResources.resourceId, input.agentId),
        ),
      )
      .orderBy(desc(pluginManagedResources.updatedAt))
      .limit(2)
      .for("update");
    if (bindingRows.length > 1) {
      throw conflict(
        "Agent has multiple active plugin-managed lifecycle bindings",
      );
    }
    const binding = bindingRows[0] ?? null;
    if (!binding) throw notFound("Plugin-managed agent binding not found");
    if (binding.lifecycleState !== "triage_paused") {
      throw conflict(
        "Only a plugin-managed agent in board triage can be adopted",
        {
          code: "plugin_managed_agent_not_in_triage",
          lifecycleState: binding.lifecycleState,
        },
      );
    }
    const pairedEntity = await lockPairedManagedAgentEntity(tx, binding);

    const agent = graph.agents.find(
      (candidate) => candidate.id === input.agentId,
    );
    if (!agent || agent.status === "terminated") {
      throw conflict("Plugin-managed agent can no longer be adopted", {
        code: "plugin_managed_agent_not_adoptable",
      });
    }
    if (agent.status !== "paused") {
      throw conflict("Plugin-managed agent must remain paused during adoption", {
        code: "plugin_managed_agent_triage_state_conflict",
      });
    }

    const audit = {
      event: "plugin_managed_agent_adopted",
      pluginInstallationId: binding.pluginId,
      pluginKey: binding.pluginKey,
      resourceKey: binding.resourceKey,
      resourceId: binding.resourceId,
      previousLifecycleState: binding.lifecycleState,
      previousAgentStatus: agent.status,
      actorType: "user",
      actorId: input.actorUserId,
      occurredAt: now.toISOString(),
    };
    const adopted = await tx
      .update(pluginManagedResources)
      .set({
        lifecycleState: "adopted",
        lifecycleReason: "board_adopted",
        adoptedAt: now,
        lifecycleActorType: "user",
        lifecycleActorId: input.actorUserId,
        lifecycleAudit: audit,
        updatedAt: now,
      })
      .where(
        and(
          eq(pluginManagedResources.id, binding.id),
          eq(pluginManagedResources.lifecycleState, "triage_paused"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!adopted) {
      throw conflict("Plugin-managed agent adoption lost its locked transition");
    }
    const adoptedEntity = await tx
      .update(pluginEntities)
      .set({ status: "adopted", updatedAt: now })
      .where(
        and(
          eq(pluginEntities.id, pairedEntity.id),
          eq(pluginEntities.status, "triage_paused"),
        ),
      )
      .returning({ id: pluginEntities.id })
      .then((rows) => rows[0] ?? null);
    if (!adoptedEntity) {
      throw conflict(
        "Plugin-managed agent adoption lost its managed-entity transition",
      );
    }
    await logActivity(tx as unknown as Db, {
      companyId: binding.companyId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "plugin.managed_agent.adopted",
      entityType: "agent",
      entityId: binding.resourceId,
      details: audit,
    });
    return adopted;
  });
}

async function recordPluginManagedAgentTerminationInTransaction(
  tx: IssueSessionDbTransaction,
  input: {
    binding: PluginManagedAgentBinding;
    previousAgentStatus: string;
    actorUserId: string;
    event:
      | "plugin_managed_agent_terminated_by_board"
      | "plugin_managed_agent_terminated_by_hire_rejection";
    sourceId: string;
    now: Date;
  },
) {
  const pairedEntity = await lockPairedManagedAgentEntity(tx, input.binding);
  const audit = {
    event: input.event,
    pluginInstallationId: input.binding.pluginId,
    pluginKey: input.binding.pluginKey,
    resourceKey: input.binding.resourceKey,
    resourceId: input.binding.resourceId,
    previousLifecycleState: input.binding.lifecycleState,
    previousAgentStatus: input.previousAgentStatus,
    actorType: "user",
    actorId: input.actorUserId,
    reason: "agent_terminated",
    sourceId: input.sourceId,
    occurredAt: input.now.toISOString(),
  };
  const terminatedBinding = await tx
    .update(pluginManagedResources)
    .set({
      lifecycleState: "terminated",
      lifecycleReason: "agent_terminated",
      terminatedAt: input.now,
      lifecycleActorType: "user",
      lifecycleActorId: input.actorUserId,
      lifecycleAudit: audit,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(pluginManagedResources.id, input.binding.id),
        inArray(pluginManagedResources.lifecycleState, [
          "active",
          "triage_paused",
        ]),
      ),
    )
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!terminatedBinding) {
    throw conflict(
      "Plugin-managed agent termination lost its locked binding transition",
    );
  }
  const entity = await tx
    .update(pluginEntities)
    .set({ status: "terminated", updatedAt: input.now })
    .where(
      and(
        eq(pluginEntities.id, pairedEntity.id),
        inArray(pluginEntities.status, ["active", "triage_paused"]),
      ),
    )
    .returning({ id: pluginEntities.id })
    .then((rows) => rows[0] ?? null);
  if (!entity) {
    throw conflict(
      "Plugin-managed agent termination lost its managed-entity transition",
    );
  }
  await logActivity(tx as unknown as Db, {
    companyId: input.binding.companyId,
    actorType: "user",
    actorId: input.actorUserId,
    action: "plugin.managed_agent.terminated",
    entityType: "agent",
    entityId: input.binding.resourceId,
    details: audit,
  });
  return terminatedBinding;
}

export async function terminateAgentForHireRejectionInTransaction(
  tx: ApprovalLifecycleTransaction,
  input: HireRejectionAgentTerminationInput,
  cancellation: AgentLifecycleCancellationService,
) {
  const graph = await lockCompanyAgentGraph(tx, input.companyId);
  const bindingRows = await tx
    .select()
    .from(pluginManagedResources)
    .where(
      and(
        eq(pluginManagedResources.companyId, input.companyId),
        eq(pluginManagedResources.resourceKind, "agent"),
        eq(pluginManagedResources.resourceId, input.agentId),
        inArray(pluginManagedResources.lifecycleState, [
          "active",
          "triage_paused",
        ]),
      ),
    )
    .orderBy(desc(pluginManagedResources.updatedAt))
    .limit(2)
    .for("update");
  if (bindingRows.length > 1) {
    throw conflict(
      "Agent has multiple active plugin-managed lifecycle bindings",
    );
  }
  const previousAgent = graph.agents.find(
    (candidate) => candidate.id === input.agentId,
  );
  const termination = await terminateAgentToTombstoneInTransaction(
    tx,
    {
      companyId: input.companyId,
      agentId: input.agentId,
      sourceId: input.sourceId,
      actor: { kind: "user", userId: input.decidedByUserId },
      now: input.now,
    },
    cancellation,
  );
  const binding = bindingRows[0];
  if (termination && binding) {
    await recordPluginManagedAgentTerminationInTransaction(tx, {
      binding,
      previousAgentStatus: previousAgent?.status ?? "missing",
      actorUserId: input.decidedByUserId,
      event: "plugin_managed_agent_terminated_by_hire_rejection",
      sourceId: input.sourceId,
      now: input.now,
    });
  }
  return termination;
}

export async function terminatePluginManagedAgentFromBoard(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    actorUserId: string;
  },
  postCommit: AgentLifecyclePostCommit,
) {
  const committed = await db.transaction(async (tx) => {
    const now = new Date();
    const graph = await lockCompanyAgentGraph(tx, input.companyId);
    const binding = await tx
      .select()
      .from(pluginManagedResources)
      .where(
        and(
          eq(pluginManagedResources.companyId, input.companyId),
          eq(pluginManagedResources.resourceKind, "agent"),
          eq(pluginManagedResources.resourceId, input.agentId),
          inArray(pluginManagedResources.lifecycleState, [
            "active",
            "triage_paused",
          ]),
        ),
      )
      .orderBy(desc(pluginManagedResources.updatedAt))
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!binding) {
      return {
        terminatedBinding: null,
        dispatchRefIds: [] as string[],
        cancellationRequests: [] as RequestedAgentRunCancellations[],
        suspensionRequests: [] as RequestedAgentSuspensions[],
      };
    }

    const agent = graph.agents.find(
      (candidate) => candidate.id === input.agentId,
    );
    if (!agent) throw notFound("Agent not found");

    const sourceId =
      `plugin-managed-agent-board-termination:${binding.id}:${agent.id}`;
    const withdrawn = await withdrawOpenHireApprovalForAgentInTransaction(
      tx,
      {
        companyId: input.companyId,
        agentId: input.agentId,
        decidedByUserId: input.actorUserId,
        decisionNote:
          "Hire rejected because the board terminated the plugin-managed agent",
        sourceId,
        now,
      },
      postCommit.issueExecutionCancellation,
    );
    const termination =
      withdrawn ??
      (await terminateAgentToTombstoneInTransaction(
        tx,
        {
          companyId: input.companyId,
          agentId: input.agentId,
          sourceId,
          actor: { kind: "user", userId: input.actorUserId },
          now,
        },
        postCommit.issueExecutionCancellation,
      ));
    if (!termination) {
      throw conflict(
        "Plugin-managed agent termination lost its agent transition",
      );
    }

    const terminatedBinding =
      await recordPluginManagedAgentTerminationInTransaction(tx, {
        binding,
        previousAgentStatus: agent.status,
        actorUserId: input.actorUserId,
        event: "plugin_managed_agent_terminated_by_board",
        sourceId,
        now,
      });
    return {
      terminatedBinding,
      dispatchRefIds: termination.dispatchRefIds,
      cancellationRequests: termination.cancellationRequests
        ? [termination.cancellationRequests]
        : [],
      suspensionRequests: termination.suspensionRequests
        ? [termination.suspensionRequests]
        : [],
    };
  });
  for (const cancellationRequests of committed.cancellationRequests) {
    await postCommit.issueExecutionCancellation
      .reconcileRequestedAgentCancellations(cancellationRequests);
  }
  for (const suspensionRequests of committed.suspensionRequests) {
    await postCommit.issueExecutionCancellation
      .reconcileRequestedAgentSuspensions(suspensionRequests);
  }
  for (const refId of committed.dispatchRefIds) {
    await postCommit.dispatchRef(refId);
  }
  return committed.terminatedBinding;
}

/**
 * Transaction-capable form used by the plugin lifecycle owner so the plugin
 * tombstone, managed-agent triage, and creator-edge terminalization commit as
 * one database invariant. The caller must lock the plugin installation first.
 */
export async function pausePluginManagedAgentsIntoTriageInTransaction(
  tx: IssueSessionDbTransaction,
  input: PausePluginManagedAgentsIntoTriageInput,
  suspension: AgentSuspensionService,
  now = new Date(),
): Promise<PausePluginManagedAgentsIntoTriageResult> {
    if (input.actorType === "user" && !input.actorId) {
      throw conflict(
        "Board triage requires the exact authenticated user actor",
      );
    }
    const candidateCompanies = await tx
      .select({ companyId: pluginManagedResources.companyId })
      .from(pluginManagedResources)
      .where(
        and(
          eq(pluginManagedResources.pluginId, input.pluginId),
          eq(pluginManagedResources.resourceKind, "agent"),
          eq(pluginManagedResources.lifecycleState, "active"),
        ),
      )
      .orderBy(asc(pluginManagedResources.companyId));
    const lockedGraphs = new Map<
      string,
      Awaited<ReturnType<typeof lockCompanyAgentGraph>>
    >();
    for (const companyId of [
      ...new Set(candidateCompanies.map((row) => row.companyId)),
    ]) {
      lockedGraphs.set(
        companyId,
        await lockCompanyAgentGraph(tx, companyId),
      );
    }
    const bindings = await tx
      .select()
      .from(pluginManagedResources)
      .where(
        and(
          eq(pluginManagedResources.pluginId, input.pluginId),
          eq(pluginManagedResources.resourceKind, "agent"),
          eq(pluginManagedResources.lifecycleState, "active"),
        ),
      )
      .orderBy(
        asc(pluginManagedResources.companyId),
        asc(pluginManagedResources.resourceId),
        asc(pluginManagedResources.id),
      )
      .for("update");
    const triagePausedAgentIds: string[] = [];
    const suspensionRequests: RequestedAgentSuspensions[] = [];

    for (const binding of bindings) {
      if (binding.pluginKey !== input.pluginKey) {
        throw conflict(
          "Plugin-managed binding crossed its immutable plugin installation key",
        );
      }
      const lockedGraph = lockedGraphs.get(binding.companyId);
      if (!lockedGraph) {
        throw conflict(
          "Plugin-managed agent binding changed companies during lifecycle locking",
        );
      }
      const agent = lockedGraph.agents.find(
        (candidate) => candidate.id === binding.resourceId,
      );
      if (!agent || agent.status === "terminated") {
        throw conflict(
          "Active plugin-managed binding has no live agent target to move into board triage",
        );
      }
      const pairedEntity = await lockPairedManagedAgentEntity(tx, binding);
      const actorType = input.actorType ?? "system";
      const actorId = input.actorId ?? input.pluginId;
      const audit = {
        event: "plugin_managed_agent_moved_to_board_triage",
        pluginInstallationId: input.pluginId,
        pluginKey: input.pluginKey,
        resourceKey: binding.resourceKey,
        resourceId: binding.resourceId,
        previousAgentStatus: agent.status,
        previousPauseReason: agent.pauseReason,
        reason: input.reason,
        actorType,
        actorId,
        occurredAt: now.toISOString(),
      };

      const pausedAgent = await tx
        .update(agents)
        .set({
          status: "paused",
          pauseReason: "system",
          pausedAt: now,
          errorReason: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.id, agent.id),
            eq(agents.companyId, binding.companyId),
            ne(agents.status, "terminated"),
          ),
        )
        .returning({ id: agents.id })
        .then((rows) => rows[0] ?? null);
      if (!pausedAgent) {
        throw conflict(
          "Plugin-managed agent triage lost its locked agent transition",
        );
      }
      const pausedResource = await tx
        .update(pluginManagedResources)
        .set({
          lifecycleState: "triage_paused",
          lifecycleReason: input.reason,
          triagePausedAt: now,
          lifecycleActorType: actorType,
          lifecycleActorId: actorId,
          lifecycleAudit: audit,
          updatedAt: now,
        })
        .where(
          and(
            eq(pluginManagedResources.id, binding.id),
            eq(pluginManagedResources.lifecycleState, "active"),
          ),
        )
        .returning({ id: pluginManagedResources.id })
        .then((rows) => rows[0] ?? null);
      if (!pausedResource) {
        throw conflict(
          "Plugin-managed agent triage lost its locked binding transition",
        );
      }
      const pausedEntity = await tx
        .update(pluginEntities)
        .set({
          status: "triage_paused",
          updatedAt: now,
        })
        .where(
          and(
            eq(pluginEntities.id, pairedEntity.id),
            eq(pluginEntities.status, "active"),
          ),
        )
        .returning({ id: pluginEntities.id })
        .then((rows) => rows[0] ?? null);
      if (!pausedEntity) {
        throw conflict(
          "Plugin-managed agent triage lost its managed-entity transition",
        );
      }
      await logActivity(tx as unknown as Db, {
        companyId: binding.companyId,
        actorType,
        actorId,
        action: "plugin.managed_agent.moved_to_board_triage",
        entityType: "agent",
        entityId: agent.id,
        details: audit,
      });
      triagePausedAgentIds.push(agent.id);
    }

    const pausedByCompany = new Map<string, string[]>();
    for (const binding of bindings) {
      if (!triagePausedAgentIds.includes(binding.resourceId)) continue;
      const agentIds = pausedByCompany.get(binding.companyId) ?? [];
      agentIds.push(binding.resourceId);
      pausedByCompany.set(binding.companyId, agentIds);
    }
    for (const [companyId, agentIds] of pausedByCompany) {
      suspensionRequests.push(
        await suspension.requestAgentSuspensionsInTransaction(tx, {
          companyId,
          agentIds,
          reason: input.reason,
          actor: input.actorType === "user" && input.actorId
            ? { kind: "user", userId: input.actorId }
            : { kind: "system" },
          now,
        }),
      );
    }

    return {
      triagePausedAgentIds,
      suspensionRequests,
    };
}

interface PluginManagedAgentServiceOptions {
  pluginId: string;
  manifest: PaperclipPluginManifestV1;
}

function bindingExternalId(companyId: string, agentKey: string) {
  return `managed:agent:${companyId}:${agentKey}`;
}

function managedEntityAgentId(
  entity: typeof pluginEntities.$inferSelect,
): string | null {
  if (
    !entity.data ||
    typeof entity.data !== "object" ||
    Array.isArray(entity.data)
  ) {
    return null;
  }
  const agentId = (entity.data as Record<string, unknown>).agentId;
  return typeof agentId === "string" ? agentId : null;
}

function managedEntityPluginKey(
  entity: typeof pluginEntities.$inferSelect,
): string | null {
  if (
    !entity.data ||
    typeof entity.data !== "object" ||
    Array.isArray(entity.data)
  ) {
    return null;
  }
  const pluginKey = (entity.data as Record<string, unknown>).pluginKey;
  return typeof pluginKey === "string" ? pluginKey : null;
}

export function pluginManagedAgentService(
  db: Db,
  options: PluginManagedAgentServiceOptions,
) {
  const pluginKey = options.manifest.id;
  const agentSvc = agentService(db);
  const runtimeAgents = createRuntimeAgentConfigurationService(db, {
    assertPluginAuthority: async (_tx, input) => {
      if (
        input.actor.pluginInstallationId !== options.pluginId ||
        input.actor.actorId !== pluginKey ||
        !options.manifest.capabilities.includes("agents.managed")
      ) {
        throw new RuntimeAgentConfigurationDenied(
          "Plugin does not hold the exact managed-agent creation authority",
          "plugin_managed_agent_authority_missing",
        );
      }
    },
  });

  function declarationFor(agentKey: string) {
    const declaration = options.manifest.agents?.find((agent) => agent.agentKey === agentKey);
    if (!declaration) {
      throw notFound(`Managed agent declaration not found: ${agentKey}`);
    }
    return declaration;
  }

  async function getBinding(
    companyId: string,
    agentKey: string,
    database: Db = db,
  ) {
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

  async function getManagedResourceBinding(
    companyId: string,
    agentKey: string,
    database: Db = db,
  ) {
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
    const managedResource = await getManagedResourceBinding(
      companyId,
      declaration.agentKey,
      database,
    );
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
        throw conflict(
          `Managed agent binding '${declaration.agentKey}' cannot be relinked to another agent`,
        );
      }
      if (managedResource.pluginKey !== pluginKey) {
        throw conflict(
          `Managed agent binding '${declaration.agentKey}' crossed its immutable plugin key`,
        );
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
    const existing = await getBinding(
      companyId,
      declaration.agentKey,
      database,
    );
    if (managedResource && !existing) {
      throw conflict(
        `Managed agent binding '${declaration.agentKey}' lost its paired entity`,
      );
    }
    if (!managedResource && existing) {
      throw conflict(
        `Managed agent entity '${declaration.agentKey}' lost its paired resource binding`,
      );
    }
    if (existing) {
      if (existing.status !== "active") {
        throw conflict(
          `Managed agent entity '${declaration.agentKey}' is ${existing.status} and cannot be reacquired`,
        );
      }
      const existingAgentId = managedEntityAgentId(existing);
      if (existingAgentId !== agentId) {
        throw conflict(
          `Managed agent entity '${declaration.agentKey}' cannot be relinked to another agent`,
        );
      }
      if (managedEntityPluginKey(existing) !== pluginKey) {
        throw conflict(
          `Managed agent entity '${declaration.agentKey}' crossed its immutable plugin key`,
        );
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
        .where(
          and(
            eq(pluginEntities.id, existing.id),
            eq(pluginEntities.status, "active"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updatedEntity) {
        throw conflict(
          `Managed agent entity '${declaration.agentKey}' lost its active lifecycle transition`,
        );
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

  async function createManagedAgent(companyId: string, declaration: PluginManagedAgentDeclaration) {
    const committed = await db.transaction(async (tx) => {
      const company = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const createdResult = await runtimeAgents.createInTransaction({
        transaction: tx,
        companyId,
        actor: {
          kind: "plugin",
          actorId: pluginKey,
          pluginInstallationId: options.pluginId,
        },
        source: "plugin_control",
        idempotencyKey:
          `plugin_managed_agent:${options.pluginId}:${companyId}:${declaration.agentKey}`,
        configuration: {
          name: declaration.displayName,
          title: declaration.title ?? null,
          capabilities: declaration.capabilities ?? null,
          reportsTo: null,
          contextGrants: Object.fromEntries(
            AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false]),
          ),
          actionGrants: Object.fromEntries(
            PAPERCLIP_ACTION_KEYS.map((key) => [key, false]),
          ),
          mentionReachGrants: Object.fromEntries(
            AGENT_MENTION_REACH_GRANT_KEYS.map((key) => [key, false]),
          ),
          companyToolIds: [],
        },
      });
      const created = await tx
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.id, createdResult.agentId),
            eq(agents.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!created) {
        throw notFound("Managed agent was not persisted");
      }
      const existingBinding = await getManagedResourceBinding(
        companyId,
        declaration.agentKey,
        tx as unknown as Db,
      );
      if (createdResult.retried !== Boolean(existingBinding)) {
        throw conflict(
          "Managed-agent creation idempotency disagrees with its canonical binding",
        );
      }
      const approvalId = createdResult.approvalId;
      if (approvalId && !createdResult.retried) {
        await logActivity(tx as unknown as Db, {
          companyId,
          actorType: "plugin",
          actorId: options.pluginId,
          action: "approval.created",
          entityType: "approval",
          entityId: approvalId,
          details: {
            type: "hire_agent",
            linkedAgentId: created.id,
            runtimeAgentConfigurationAuditId: createdResult.auditId,
            sourcePluginKey: pluginKey,
            managedResourceKey: declaration.agentKey,
          },
        });
      }
      await upsertBinding(
        companyId,
        declaration,
        created.id,
        {
          approvalId,
          runtimeAgentConfigurationAuditId: createdResult.auditId,
        },
        tx as unknown as Db,
      );
      if (!createdResult.retried) {
        await logActivity(tx as unknown as Db, {
          companyId,
          actorType: "plugin",
          actorId: options.pluginId,
          action: "plugin.managed_agent.created",
          entityType: "agent",
          entityId: created.id,
          details: {
            sourcePluginKey: pluginKey,
            managedResourceKey: declaration.agentKey,
            runtimeAgentConfigurationAuditId: createdResult.auditId,
            requiresApproval: company.requireBoardApprovalForNewAgents,
            approvalId,
          },
        });
      }
      return {
        agentId: created.id,
        approvalId,
        status: createdResult.retried ? "resolved" as const : "created" as const,
      };
    });
    const created = await agentSvc.getById(committed.agentId);
    if (!created) {
      throw notFound("Managed agent was not persisted");
    }
    return resolution(
      companyId,
      declaration,
      created as Agent,
      committed.status,
      committed.approvalId,
    );
  }

  async function get(agentKey: string, companyId: string) {
    const declaration = declarationFor(agentKey);
    const [binding, entity] = await Promise.all([
      getManagedResourceBinding(companyId, agentKey),
      getBinding(companyId, agentKey),
    ]);
    if (!binding && !entity) {
      return resolution(companyId, declaration, null, "missing");
    }
    if (!binding || !entity) {
      throw conflict(
        "Plugin-managed agent provenance lost its canonical resource/entity pair",
      );
    }
    if (
      entity.status !== binding.lifecycleState ||
      entity.scopeKind !== "company" ||
      entity.scopeId !== companyId ||
      binding.pluginKey !== pluginKey ||
      managedEntityPluginKey(entity) !== pluginKey ||
      managedEntityAgentId(entity) !== binding.resourceId
    ) {
      throw conflict(
        "Plugin-managed agent resource/entity pair disagrees on lifecycle or identity",
      );
    }
    if (binding.lifecycleState !== "active") {
      return resolution(companyId, declaration, null, "missing");
    }
    const agent = await agentSvc.getById(binding.resourceId);
    if (
      !agent ||
      agent.companyId !== companyId ||
      agent.status === "terminated"
    ) {
      throw conflict(
        "Active plugin-managed binding does not resolve to its live canonical agent",
      );
    }
    return resolution(companyId, declaration, agent as Agent, "resolved");
  }

  async function reconcile(agentKey: string, companyId: string) {
    const declaration = declarationFor(agentKey);
    const lifecycleBinding = await getManagedResourceBinding(
      companyId,
      agentKey,
    );
    if (lifecycleBinding && lifecycleBinding.lifecycleState !== "active") {
      return resolution(companyId, declaration, null, "missing");
    }
    const current = await get(agentKey, companyId);
    if (current.agent) {
      await db.transaction((tx) =>
        upsertBinding(
          companyId,
          declaration,
          current.agent!.id,
          {},
          tx as unknown as Db,
        ));
      return current;
    }
    return createManagedAgent(companyId, declaration);
  }

  async function reset(agentKey: string, companyId: string) {
    // A managed declaration is provenance, not an authority source. The
    // retained reset RPC validates the active binding but cannot restore
    // declaration defaults over ordinary board-managed agent state.
    return reconcile(agentKey, companyId);
  }

  return {
    get,
    reconcile,
    reset,
  };
}
