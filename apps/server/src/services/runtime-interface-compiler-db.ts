import {
  agentActionGrants,
  agentAdapterConfigRevisions,
  agentContextGrants,
  agentMentionReachGrants,
  agents,
  taskExecutionRefs,
  tasks,
  plugins,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  pluginAgentToolName,
  type AgentContextGrantKey,
  type AgentMentionReachGrantKey,
  type JsonSchema,
  type PaperclipPluginManifestV1,
  type PaperclipActionKey,
} from "@paperclipai/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  evaluateAgentInvokability,
  resolveInvokableTaskOwnerCatalog,
  type InvokableTaskOwnerRevision,
  type AgentOrgRow,
} from "./agent-invokability.js";
import { resolveContextDial } from "./context-dial-resolver.js";
import type {
  PromptCapabilityCompileScope,
} from "./prompt-capability-gateway.js";
import type {
  AgentCatalogEntry,
  TaskAssignOwnerCatalog,
  TaskCreateOwnerCatalogEntry,
  RuntimeAgentConfigureTarget,
} from "./paperclip-managed-tool-registry.js";
import type {
  RuntimeInterfaceCompileInput,
  RuntimePluginTool,
  RuntimeToolTurn,
} from "./runtime-interface-compiler.js";
import { listAuthorizedPluginAgentTools } from "./plugin-agent-tool-authority.js";
import { pluginManifestIdentity } from "./plugin-manifest-identity.js";
import { resolveExecutionModeContextMask } from "./execution-mode-context-mask.js";
import { classifyOrderedExecutionScopePair } from "./task-execution-initial-request-pair.js";
import {
  resolveMentionReach,
  type MentionReachTask,
} from "./mention-reach-resolver.js";

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
  resolve(
    capability: PromptCapabilityCompileScope,
  ): Promise<RuntimeInterfaceCompileInput>;
}

type RuntimeContextTask = RuntimeInterfaceCompilerSnapshot["task"];

/** Resolves the context identity shared by admission and prompt compilation. */
export function resolveRuntimeContextDial(input: {
  readonly capability: Pick<
    PromptCapabilityCompileScope,
    "targetAgentId" | "executionMode"
  >;
  readonly task: RuntimeContextTask;
  readonly contextGrantKeys: readonly AgentContextGrantKey[];
}) {
  return resolveContextDial({
    agent: booleanRecord(
      AGENT_CONTEXT_GRANT_KEYS,
      input.contextGrantKeys,
    ),
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
  return Object.fromEntries(
    keys.map((key) => [key, enabledSet.has(key)]),
  ) as Partial<Record<Key, boolean>>;
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
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.length > 0,
  );
}

function prefixedScopeValues(
  scope: Record<string, unknown>,
  prefix: string,
): string[] {
  return Object.entries(scope)
    .filter(
      ([key, value]) =>
        key.startsWith(prefix) && value === true && key.length > prefix.length,
    )
    .map(([key]) => key.slice(prefix.length));
}

function explicitConfigureTargets(
  sourceAgent: AgentRow,
  companyAgents: readonly AgentRow[],
  grants: readonly ConfigureGrant[],
): Set<string> {
  const targets = new Set<string>([sourceAgent.id]);
  for (const grant of grants) {
    if (
      grant.permissionKey !== "agents:configure" &&
      grant.permissionKey !== "agents:suggest-changes"
    ) {
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

export function readyPluginTools(
  rows: readonly {
    id: string;
    pluginKey: string;
    manifestJson: PaperclipPluginManifestV1;
  }[],
): RuntimePluginTool[] {
  return rows.flatMap((row) =>
    listAuthorizedPluginAgentTools({
      pluginKey: row.pluginKey,
      manifest: row.manifestJson,
    }).map((tool) => ({
      installationId: row.id,
      manifestIdentity: pluginManifestIdentity(row.manifestJson),
      name: pluginAgentToolName(row.pluginKey, tool.name),
      toolName: tool.name,
      title: tool.displayName,
      description: tool.description,
      inputSchema: tool.parametersSchema as JsonSchema,
      bootstrapEnabled: tool.bootstrapEnabled === true,
    })),
  ).sort((left, right) =>
    left.name.localeCompare(right.name) ||
    left.installationId.localeCompare(right.installationId),
  );
}

export function buildRuntimeInterfaceCompileInput(
  snapshot: RuntimeInterfaceCompilerSnapshot,
): RuntimeInterfaceCompileInput {
  const { capability, task } = snapshot;
  if (
    task.companyId !== capability.companyId ||
    task.ownershipEpoch !== capability.ownershipEpoch
  ) {
    throw new Error("Prompt-capability task scope changed during compilation");
  }
  const companyAgents = snapshot.agents.filter(
    (agent) => agent.companyId === capability.companyId,
  );
  const invokableOwners = resolveInvokableTaskOwnerCatalog({
    companyId: capability.companyId,
    companyAgents,
    adapterRevisions: snapshot.adapterRevisions,
  });
  const byId = new Map(companyAgents.map((agent) => [agent.id, agent]));
  const sourceAgent = byId.get(capability.targetAgentId);
  if (
    !sourceAgent ||
    !evaluateAgentInvokability(sourceAgent, companyAgents).invokable
  ) {
    throw new Error("Prompt-capability target agent is not invokable");
  }

  const actionGrants = booleanRecord(
    PAPERCLIP_ACTION_KEYS,
    snapshot.actionGrantKeys,
  );
  const mentionReachGrants = booleanRecord(
    AGENT_MENTION_REACH_GRANT_KEYS,
    snapshot.mentionReachGrantKeys,
  );
  const isCurrentOwner = capability.executionMode === "owner" &&
    task.ownerKind === "agent" &&
    task.ownerAgentId === sourceAgent.id;
  const contextDial = resolveRuntimeContextDial({
    capability,
    task,
    contextGrantKeys: snapshot.contextGrantKeys,
  });

  const directChildren = companyAgents
    .filter(
      (candidate) =>
        candidate.reportsTo === sourceAgent.id &&
        invokableOwners.has(candidate.id),
    )
    .sort((left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
  const taskCreateDirectChildren: TaskCreateOwnerCatalogEntry[] =
    directChildren.map((agent) => ({
      ...agentCatalogEntry(agent),
      kind: "agent",
    }));

  const authorityId =
    capability.executionMode === "owner"
      ? capability.taskExecutionAuthorityId
      : null;
  const eligibleCreatedTasks = authorityId
    ? snapshot.childTasks
        .filter(
          (child) =>
            (child.lifecycleStatus === "open" ||
              child.lifecycleStatus === "blocked") &&
            child.creatorKind === "agent-execution" &&
            child.creatorAuthorityId === authorityId,
        )
        .sort((left, right) =>
          left.identifier.localeCompare(right.identifier),
        )
    : [];
  const owners = [
    { kind: "self" as const },
    ...taskCreateDirectChildren,
  ];
  const taskAssignTargets: TaskAssignOwnerCatalog[] =
    eligibleCreatedTasks.map((child) => ({
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
    .filter(
      (candidate) =>
        reachableMentionIds.has(candidate.id) &&
        invokableOwners.has(candidate.id),
    )
    .sort((left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    )
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
            .filter(
              (candidate) =>
                configureTargetIds.has(candidate.id) &&
                candidate.status !== "terminated",
            )
            .sort((left, right) =>
              left.name.localeCompare(right.name) ||
              left.id.localeCompare(right.id),
            )
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

/** @internal Resolves the exact ref's structural role without source aliases. */
export async function resolveRuntimeToolTurn(
  db: Db,
  capability: PromptCapabilityCompileScope,
): Promise<RuntimeToolTurn> {
  if (capability.refId === undefined) return "work";
  const rows = await db
    .select()
    .from(taskExecutionRefs)
    .where(
      and(
        eq(taskExecutionRefs.id, capability.refId),
        eq(taskExecutionRefs.companyId, capability.companyId),
        eq(taskExecutionRefs.taskId, capability.taskId),
        eq(taskExecutionRefs.ownershipEpoch, capability.ownershipEpoch),
        eq(taskExecutionRefs.targetAgentId, capability.targetAgentId),
        eq(taskExecutionRefs.mode, capability.executionMode),
      ),
    )
    .limit(2);
  if (rows.length !== 1) {
    throw new Error("Prompt-capability execution ref no longer exists");
  }
  const current = rows[0]!;
  const grouped = await db
    .select()
    .from(taskExecutionRefs)
    .where(
      and(
        eq(taskExecutionRefs.companyId, current.companyId),
        eq(taskExecutionRefs.taskId, current.taskId),
        eq(taskExecutionRefs.sessionId, current.sessionId),
        eq(taskExecutionRefs.executionScopeId, current.executionScopeId),
        eq(taskExecutionRefs.executionLineageId, current.executionLineageId),
      ),
    )
    .orderBy(asc(taskExecutionRefs.laneOrdinal))
    .limit(3);
  const pair = classifyOrderedExecutionScopePair(grouped);
  if (!pair) {
    if (grouped.length > 1) {
      throw new Error("Execution scope lost its exact ordered pair");
    }
    return "work";
  }
  if (pair.instruction.id === current.id) return "bootstrap";
  if (pair.work.id === current.id) return "work";
  throw new Error("Execution ref is not a member of its ordered scope");
}

async function loadSnapshot(
  db: Db,
  capability: PromptCapabilityCompileScope,
): Promise<RuntimeInterfaceCompilerSnapshot> {
  const [
    taskRows,
    turn,
    agentRows,
    adapterRevisionRows,
    contextRows,
    actionRows,
    mentionRows,
    configureRows,
    childRows,
    taskTreeRows,
    readyPlugins,
  ] = await Promise.all([
    db
      .select({
        companyId: tasks.companyId,
        ownerKind: tasks.ownerKind,
        ownerAgentId: tasks.ownerAgentId,
        ownershipEpoch: tasks.ownershipEpoch,
        executionPolicy: tasks.executionPolicy,
      })
      .from(tasks)
      .where(eq(tasks.id, capability.taskId))
      .limit(1),
    resolveRuntimeToolTurn(db, capability),
    db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        title: agents.title,
        capabilities: agents.capabilities,
        reportsTo: agents.reportsTo,
        status: agents.status,
        currentAdapterConfigRevisionId:
          agents.currentAdapterConfigRevisionId,
      })
      .from(agents)
      .where(eq(agents.companyId, capability.companyId)),
    db
      .select({
        id: agentAdapterConfigRevisions.id,
        companyId: agentAdapterConfigRevisions.companyId,
        agentId: agentAdapterConfigRevisions.agentId,
      })
      .from(agentAdapterConfigRevisions)
      .innerJoin(
        agents,
        and(
          eq(agentAdapterConfigRevisions.companyId, agents.companyId),
          eq(agentAdapterConfigRevisions.agentId, agents.id),
          eq(
            agentAdapterConfigRevisions.id,
            agents.currentAdapterConfigRevisionId,
          ),
        ),
      )
      .where(eq(agents.companyId, capability.companyId)),
    db
      .select({ key: agentContextGrants.key })
      .from(agentContextGrants)
      .where(
        and(
          eq(agentContextGrants.companyId, capability.companyId),
          eq(agentContextGrants.agentId, capability.targetAgentId),
        ),
      ),
    db
      .select({ key: agentActionGrants.key })
      .from(agentActionGrants)
      .where(
        and(
          eq(agentActionGrants.companyId, capability.companyId),
          eq(agentActionGrants.agentId, capability.targetAgentId),
        ),
      ),
    db
      .select({ key: agentMentionReachGrants.key })
      .from(agentMentionReachGrants)
      .where(
        and(
          eq(agentMentionReachGrants.companyId, capability.companyId),
          eq(agentMentionReachGrants.agentId, capability.targetAgentId),
        ),
      ),
    db
      .select({
        permissionKey: principalPermissionGrants.permissionKey,
        scope: principalPermissionGrants.scope,
      })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, capability.companyId),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(
            principalPermissionGrants.principalAgentId,
            capability.targetAgentId,
          ),
          inArray(principalPermissionGrants.permissionKey, [
            "agents:configure",
            "agents:suggest-changes",
          ]),
        ),
      ),
    db
      .select({
        id: tasks.id,
        identifier: tasks.identifier,
        lifecycleStatus: tasks.lifecycleStatus,
        creatorKind: tasks.creatorKind,
        creatorAuthorityId: tasks.creatorAuthorityId,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, capability.companyId),
          eq(tasks.parentId, capability.taskId),
        ),
      ),
    db.execute(sql<MentionReachTask>`
      WITH RECURSIVE ancestors(id, parent_id, depth, visited) AS (
        SELECT task.id, task.parent_id, 0, ARRAY[task.id]
        FROM tasks task
        WHERE task.company_id = ${capability.companyId}
          AND task.id = ${capability.taskId}
          AND task.hidden_at IS NULL
        UNION ALL
        SELECT parent.id, parent.parent_id, ancestors.depth + 1, ancestors.visited || parent.id
        FROM tasks parent
        JOIN ancestors ON parent.id = ancestors.parent_id
        WHERE parent.company_id = ${capability.companyId}
          AND parent.hidden_at IS NULL
          AND NOT parent.id = ANY(ancestors.visited)
      ),
      tree_root AS (
        SELECT id
        FROM ancestors
        ORDER BY depth DESC
        LIMIT 1
      ),
      task_tree(id, parent_id, owner_kind, owner_agent_id, visited) AS (
        SELECT task.id, task.parent_id, task.owner_kind, task.owner_agent_id, ARRAY[task.id]
        FROM tasks task
        JOIN tree_root ON tree_root.id = task.id
        UNION ALL
        SELECT child.id, child.parent_id, child.owner_kind, child.owner_agent_id, task_tree.visited || child.id
        FROM tasks child
        JOIN task_tree ON child.parent_id = task_tree.id
        WHERE child.company_id = ${capability.companyId}
          AND child.hidden_at IS NULL
          AND NOT child.id = ANY(task_tree.visited)
      )
      SELECT
        id::text AS "id",
        parent_id::text AS "parentId",
        owner_kind AS "ownerKind",
        owner_agent_id::text AS "ownerAgentId"
      FROM task_tree
    `),
    db
      .select({
        id: plugins.id,
        pluginKey: plugins.pluginKey,
        manifestJson: plugins.manifestJson,
      })
      .from(plugins)
      .where(eq(plugins.status, "ready")),
  ]);
  const task = taskRows[0];
  if (!task) throw new Error("Prompt-capability task no longer exists");
  return {
    capability,
    turn,
    task,
    agents: agentRows,
    adapterRevisions: adapterRevisionRows,
    contextGrantKeys: contextRows.map((row) => row.key),
    actionGrantKeys: actionRows.map((row) => row.key),
    mentionReachGrantKeys: mentionRows.map((row) => row.key),
    configureGrants: configureRows,
    childTasks: childRows,
    taskTree: (
      Array.isArray(taskTreeRows)
        ? taskTreeRows
        : Array.from(taskTreeRows as Iterable<unknown>)
    ) as unknown as MentionReachTask[],
    pluginTools: readyPluginTools(readyPlugins),
  };
}

/**
 * Resolves the provider-visible interface from current canonical rows. No
 * descriptor or catalog is cached on the bearer: each list/call reloads this
 * snapshot through the exact prompt-capability generation.
 */
export function createPostgresRuntimeInterfaceCompiler(
  db: Db,
): PostgresPromptCapabilityCompiler {
  return {
    async resolve(capability) {
      const snapshot = await loadSnapshot(db, capability);
      return buildRuntimeInterfaceCompileInput(snapshot);
    },

  };
}

export function createRuntimeRetrievalScopeResolver(
  compiler: PostgresPromptCapabilityCompiler,
) {
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
