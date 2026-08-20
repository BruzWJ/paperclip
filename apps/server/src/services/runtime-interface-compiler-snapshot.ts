import {
  agentActionGrants,
  agentAdapterConfigRevisions,
  agentContextGrants,
  agentMentionReachGrants,
  agents,
  plugins,
  tasks,
  type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import type { MentionReachTask } from "./mention-reach-resolver.js";
import type { PromptCapabilityCompileScope } from "./prompt-capability-gateway.js";
import { readyPluginTools, resolveRuntimeToolTurn } from "./runtime-interface-compiler-load-helpers.js";
import type { RuntimeInterfaceCompilerSnapshot } from "./runtime-interface-compiler-db.js";

/** Loads the canonical rows used to compile one exact runtime interface. */
export async function loadRuntimeInterfaceCompilerSnapshot(
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
    childRows,
    taskTreeRows,
    readyPlugins,
  ] = await Promise.all([
    db
      .select({
        companyId: tasks.companyId,
        lifecycleStatus: tasks.lifecycleStatus,
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
        currentAdapterConfigRevisionId: agents.currentAdapterConfigRevisionId,
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
          eq(agentAdapterConfigRevisions.id, agents.currentAdapterConfigRevisionId),
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
        id: tasks.id,
        identifier: tasks.identifier,
        lifecycleStatus: tasks.lifecycleStatus,
        creatorKind: tasks.creatorKind,
        creatorAuthorityId: tasks.creatorAuthorityId,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, capability.companyId), eq(tasks.parentId, capability.taskId))),
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
        SELECT id FROM ancestors ORDER BY depth DESC LIMIT 1
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
    childTasks: childRows,
    taskTree: (Array.isArray(taskTreeRows)
      ? taskTreeRows
      : Array.from(taskTreeRows as Iterable<unknown>)) as unknown as MentionReachTask[],
    pluginTools: readyPluginTools(readyPlugins),
  };
}
