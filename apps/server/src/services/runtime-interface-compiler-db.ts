import type { Db } from "@paperclipai/db";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  type AgentContextGrantKey,
  type AgentMentionReachGrantKey,
  type PaperclipActionKey,
} from "@paperclipai/shared";
import {
  evaluateAgentInvokability,
  resolveInvokableTaskOwnerCatalog,
  type AgentOrgRow,
  type InvokableTaskOwnerRevision,
} from "./agent-invokability.js";
import { resolveContextDial } from "./context-dial-resolver.js";
import { resolveExecutionModeContextMask } from "./execution-mode-context-mask.js";
import { resolveMentionReach, type MentionReachTask } from "./mention-reach-resolver.js";
import type {
  AgentCatalogEntry,
  RuntimeAgentConfigureTarget,
  TaskAssignOwnerCatalog,
  TaskCreateOwnerCatalogEntry,
} from "./paperclip-managed-tool-registry.js";
import type { PromptCapabilityCompileScope } from "./prompt-capability-gateway.js";
import { loadRuntimeInterfaceCompilerSnapshot } from "./runtime-interface-compiler-snapshot.js";
import { readyPluginTools, resolveRuntimeToolTurn } from "./runtime-interface-compiler-load-helpers.js";
import type {
  RuntimeInterfaceCompileInput,
  RuntimePluginTool,
  RuntimeToolTurn,
} from "./runtime-interface-compiler.js";

export { readyPluginTools, resolveRuntimeToolTurn };

type AgentRow = AgentOrgRow & {
  title: string | null;
  capabilities: string | null;
  currentAdapterConfigRevisionId: string | null;
};

type ConfigureGrant = {
  permissionKey: string;
  scope: Record<string, unknown> | null;
};

export interface RuntimeInterfaceCompilerSnapshot {
  capability: PromptCapabilityCompileScope;
  /** Exact provider turn derived from the current execution ref. */
  turn: RuntimeToolTurn;
  task: {
    companyId: string;
    ownerKind: string | null;
    ownerAgentId: string | null;
    ownershipEpoch: number | null;
    executionPolicy: Record<string, unknown> | null;
  };
  agents: readonly AgentRow[];
  adapterRevisions: readonly InvokableTaskOwnerRevision[];
  contextGrantKeys: readonly AgentContextGrantKey[];
  actionGrantKeys: readonly PaperclipActionKey[];
  mentionReachGrantKeys: readonly AgentMentionReachGrantKey[];
  configureGrants: readonly ConfigureGrant[];
  childTasks: readonly {
    id: string;
    identifier: string;
    lifecycleStatus: string | null;
    creatorKind: string | null;
    creatorAuthorityId: string | null;
  }[];
  taskTree: readonly MentionReachTask[];
  pluginTools: readonly RuntimePluginTool[];
}

export interface PostgresPromptCapabilityCompiler {
  resolve(capability: PromptCapabilityCompileScope): Promise<RuntimeInterfaceCompileInput>;
}

type RuntimeContextTask = RuntimeInterfaceCompilerSnapshot["task"];

/** Resolves the context identity shared by admission and prompt compilation. */
export function resolveRuntimeContextDial(input: {
  readonly capability: Pick<PromptCapabilityCompileScope, "targetAgentId" | "executionMode">;
  readonly task: RuntimeContextTask;
  readonly contextGrantKeys: readonly AgentContextGrantKey[];
}) {
  return resolveContextDial({
    agent: booleanRecord(AGENT_CONTEXT_GRANT_KEYS, input.contextGrantKeys),
    taskOwner:
      input.capability.executionMode === "owner" &&
      input.task.ownerKind === "agent" &&
      input.task.ownerAgentId === input.capability.targetAgentId,
    executionMode: resolveExecutionModeContextMask({
      taskExecutionPolicy: input.task.executionPolicy,
    }),
  }).effective;
}

function booleanRecord<const Key extends string>(
  keys: readonly Key[],
  enabled: readonly Key[],
): Partial<Record<Key, boolean>> {
  const enabledSet = new Set(enabled);
  return Object.fromEntries(keys.map((key) => [key, enabledSet.has(key)])) as Partial<Record<Key, boolean>>;
}

function agentCatalogEntry(agent: AgentRow): AgentCatalogEntry {
  return {
    id: agent.id,
    name: agent.name,
    capabilities: agent.capabilities,
  };
}

function scopeValueList(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function prefixedScopeValues(scope: Record<string, unknown>, prefix: string): string[] {
  return Object.entries(scope)
    .filter(([key, value]) => key.startsWith(prefix) && value === true && key.length > prefix.length)
    .map(([key]) => key.slice(prefix.length));
}

function explicitConfigureTargets(
  sourceAgent: AgentRow,
  companyAgents: readonly AgentRow[],
  grants: readonly ConfigureGrant[],
): Set<string> {
  const targets = new Set<string>([sourceAgent.id]);
  for (const grant of grants) {
    if (grant.permissionKey !== "agents:configure" && grant.permissionKey !== "agents:suggest-changes") {
      continue;
    }
    const scope = grant.scope;
    if (!scope || Object.keys(scope).length === 0) {
      for (const agent of companyAgents) targets.add(agent.id);
      continue;
    }

    const exactIds = [
      ...scopeValueList(scope.agentId),
      ...scopeValueList(scope.agentIds),
      ...scopeValueList(scope.assigneeAgentId),
      ...scopeValueList(scope.assigneeAgentIds),
      ...scopeValueList(scope.targetAgentId),
      ...scopeValueList(scope.targetAgentIds),
      ...prefixedScopeValues(scope, "agent:"),
    ];
    for (const id of exactIds) targets.add(id);
  }
  return targets;
}

export function buildRuntimeInterfaceCompileInput(
  snapshot: RuntimeInterfaceCompilerSnapshot,
): RuntimeInterfaceCompileInput {
  const { capability, task } = snapshot;
  if (task.companyId !== capability.companyId || task.ownershipEpoch !== capability.ownershipEpoch) {
    throw new Error("Prompt-capability task scope changed during compilation");
  }
  const companyAgents = snapshot.agents.filter((agent) => agent.companyId === capability.companyId);
  const invokableOwners = resolveInvokableTaskOwnerCatalog({
    companyId: capability.companyId,
    companyAgents,
    adapterRevisions: snapshot.adapterRevisions,
  });
  const byId = new Map(companyAgents.map((agent) => [agent.id, agent]));
  const sourceAgent = byId.get(capability.targetAgentId);
  if (!sourceAgent || !evaluateAgentInvokability(sourceAgent, companyAgents).invokable) {
    throw new Error("Prompt-capability target agent is not invokable");
  }

  const actionGrants = booleanRecord(PAPERCLIP_ACTION_KEYS, snapshot.actionGrantKeys);
  const mentionReachGrants = booleanRecord(AGENT_MENTION_REACH_GRANT_KEYS, snapshot.mentionReachGrantKeys);
  const isCurrentOwner =
    capability.executionMode === "owner" &&
    task.ownerKind === "agent" &&
    task.ownerAgentId === sourceAgent.id;
  const contextDial = resolveRuntimeContextDial({
    capability,
    task,
    contextGrantKeys: snapshot.contextGrantKeys,
  });

  const directChildren = companyAgents
    .filter((candidate) => candidate.reportsTo === sourceAgent.id && invokableOwners.has(candidate.id))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const taskCreateDirectChildren: TaskCreateOwnerCatalogEntry[] = directChildren.map((agent) => ({
    ...agentCatalogEntry(agent),
    kind: "agent",
  }));

  const authorityId = capability.executionMode === "owner" ? capability.taskExecutionAuthorityId : null;
  const eligibleCreatedTasks = authorityId
    ? snapshot.childTasks
        .filter(
          (child) =>
            (child.lifecycleStatus === "open" || child.lifecycleStatus === "blocked") &&
            child.creatorKind === "agent-execution" &&
            child.creatorAuthorityId === authorityId,
        )
        .sort((left, right) => left.identifier.localeCompare(right.identifier))
    : [];
  const owners = [{ kind: "self" as const }, ...taskCreateDirectChildren];
  const taskAssignTargets: TaskAssignOwnerCatalog[] = eligibleCreatedTasks.map((child) => ({
    taskId: child.id,
    identifier: child.identifier,
    owners,
  }));
  const creatorUpdateTargets = eligibleCreatedTasks.map((child) => ({
    taskId: child.id,
  }));

  const reachableMentionIds = resolveMentionReach({
    sourceAgentId: sourceAgent.id,
    companyAgents,
    taskTree: snapshot.taskTree,
    mentionReach: mentionReachGrants,
  }).targetAgentIds;
  const mentionTargets = companyAgents
    .filter((candidate) => reachableMentionIds.has(candidate.id) && invokableOwners.has(candidate.id))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map(agentCatalogEntry);

  const configureTargets: RuntimeAgentConfigureTarget[] =
    actionGrants.agent_configure === true
      ? (() => {
          const configureTargetIds = explicitConfigureTargets(
            sourceAgent,
            companyAgents,
            snapshot.configureGrants,
          );
          return companyAgents
            .filter((candidate) => configureTargetIds.has(candidate.id) && candidate.status !== "terminated")
            .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
            .map((agent) => ({ id: agent.id }));
        })()
      : [];

  return {
    mode: capability.executionMode,
    turn: snapshot.turn,
    contextDial,
    actionGrants,
    mentionReachGrants,
    isCurrentOwner,
    taskCreateDirectChildren,
    taskAssignTargets,
    creatorUpdateTargets,
    mentionTargets,
    configureTargets,
    pluginTools: snapshot.pluginTools,
  };
}

/**
 * Resolves the provider-visible interface from current canonical rows. No
 * descriptor or catalog is cached on the bearer: each list/call reloads this
 * snapshot through the exact prompt-capability generation.
 */
export function createPostgresRuntimeInterfaceCompiler(db: Db): PostgresPromptCapabilityCompiler {
  return {
    async resolve(capability) {
      const snapshot = await loadRuntimeInterfaceCompilerSnapshot(db, capability);
      return buildRuntimeInterfaceCompileInput(snapshot);
    },
  };
}

export function createRuntimeRetrievalScopeResolver(compiler: PostgresPromptCapabilityCompiler) {
  return {
    async resolve(capability: PromptCapabilityCompileScope) {
      const input = await compiler.resolve(capability);
      return {
        companyId: capability.companyId,
        activeTaskId: capability.taskId,
        dial: input.contextDial,
      };
    },
  };
}
