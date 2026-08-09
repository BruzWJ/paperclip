import {
  agentActionGrants,
  agentAdapterConfigRevisions,
  agentContextGrants,
  agentMentionReachGrants,
  agents,
  issues,
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
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  evaluateAgentInvokability,
  resolveInvokableIssueOwnerCatalog,
  type InvokableIssueOwnerRevision,
  type AgentOrgRow,
} from "./agent-invokability.js";
import { resolveContextDial } from "./context-dial-resolver.js";
import type {
  PromptCapabilityCompileScope,
} from "./prompt-capability-gateway.js";
import type {
  AgentCatalogEntry,
  IssueAssignOwnerCatalog,
  IssueCreateOwnerCatalogEntry,
  RuntimeAgentConfigureTarget,
} from "./paperclip-managed-tool-registry.js";
import type {
  RuntimeInterfaceCompileInput,
  RuntimePluginTool,
} from "./runtime-interface-compiler.js";
import type { RuntimeRetrievalScopeResolver } from "./runtime-tool-gateway.js";
import {
  createPostgresRecoverySessionHistoryRepository,
  isTargetNotFoundReplacement,
  type RecoverySessionScope,
} from "./recovery-session-history.js";
import { listAuthorizedPluginAgentTools } from "./plugin-agent-tool-authority.js";
import { pluginManifestIdentity } from "./plugin-manifest-identity.js";
import { resolveExecutionModeContextMask } from "./execution-mode-context-mask.js";
import {
  resolveMentionReach,
  type MentionReachIssue,
} from "./mention-reach-resolver.js";
import {
  isServerAdapterImplementationAvailable,
} from "../adapters/registry.js";

type AgentRow = AgentOrgRow & {
  title: string | null;
  capabilities: string | null;
  instruction?: string | null;
  currentAdapterConfigRevisionId: string | null;
};

type ConfigureGrant = {
  permissionKey: string;
  scope: Record<string, unknown> | null;
};

function recoveryScopeForCapability(
  capability: PromptCapabilityCompileScope,
): RecoverySessionScope | undefined {
  // Generic compiler callers omit these exact prompt fields and therefore
  // cannot gain the recovery descriptor.
  if (
    typeof capability.sessionId !== "string" ||
    typeof capability.runId !== "string" ||
    typeof capability.attemptId !== "string" ||
    typeof capability.refId !== "string" ||
    typeof capability.refOrdinal !== "number" ||
    typeof capability.segmentOrdinal !== "number" ||
    !Number.isSafeInteger(capability.refOrdinal) ||
    !Number.isSafeInteger(capability.segmentOrdinal)
  ) {
    return undefined;
  }
  return {
    companyId: capability.companyId,
    issueId: capability.issueId,
    sessionId: capability.sessionId,
    targetAgentId: capability.targetAgentId,
    runId: capability.runId,
    attemptId: capability.attemptId,
    refId: capability.refId,
    refOrdinal: capability.refOrdinal,
    segmentOrdinal: capability.segmentOrdinal,
  };
}

export interface RuntimeInterfaceCompilerSnapshot {
  capability: PromptCapabilityCompileScope;
  /** Derived from prior canonical attempts; never a persisted runtime mode. */
  restoreSession?: boolean;
  issue: {
    companyId: string;
    ownerKind: string | null;
    ownerAgentId: string | null;
    ownershipEpoch: number | null;
    workMode: string;
    harnessKind: string | null;
    originKind: string;
    executionPolicy: Record<string, unknown> | null;
  };
  agents: readonly AgentRow[];
  adapterRevisions: readonly InvokableIssueOwnerRevision[];
  contextGrantKeys: readonly AgentContextGrantKey[];
  actionGrantKeys: readonly PaperclipActionKey[];
  mentionReachGrantKeys: readonly AgentMentionReachGrantKey[];
  configureGrants: readonly ConfigureGrant[];
  childIssues: readonly {
    id: string;
    identifier: string | null;
    lifecycleStatus: string | null;
    creatorKind: string | null;
    creatorAuthorityId: string | null;
  }[];
  issueTree: readonly MentionReachIssue[];
  pluginTools: readonly RuntimePluginTool[];
}

export interface PostgresPromptCapabilityCompiler {
  resolve(
    capability: PromptCapabilityCompileScope,
  ): Promise<RuntimeInterfaceCompileInput>;
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
  const { capability, issue } = snapshot;
  if (
    issue.companyId !== capability.companyId ||
    issue.ownershipEpoch !== capability.ownershipEpoch
  ) {
    throw new Error("Prompt-capability issue scope changed during compilation");
  }
  const companyAgents = snapshot.agents.filter(
    (agent) => agent.companyId === capability.companyId,
  );
  const invokableOwners = resolveInvokableIssueOwnerCatalog({
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

  const contextGrants = booleanRecord(
    AGENT_CONTEXT_GRANT_KEYS,
    snapshot.contextGrantKeys,
  );
  const actionGrants = booleanRecord(
    PAPERCLIP_ACTION_KEYS,
    snapshot.actionGrantKeys,
  );
  const mentionReachGrants = booleanRecord(
    AGENT_MENTION_REACH_GRANT_KEYS,
    snapshot.mentionReachGrantKeys,
  );
  const isCurrentOwner =
    capability.executionMode === "owner" &&
    issue.ownerKind === "agent" &&
    issue.ownerAgentId === sourceAgent.id;
  const contextDial = resolveContextDial({
    agent: contextGrants,
    issueOwner: isCurrentOwner,
    executionMode: resolveExecutionModeContextMask({
      workMode: issue.workMode,
      harnessKind: issue.harnessKind,
      originKind: issue.originKind,
      issueExecutionPolicy: issue.executionPolicy,
    }),
  }).effective;

  const directChildren = companyAgents
    .filter(
      (candidate) =>
        candidate.reportsTo === sourceAgent.id &&
        invokableOwners.has(candidate.id),
    )
    .sort((left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
  const issueCreateDirectChildren: IssueCreateOwnerCatalogEntry[] =
    directChildren.map((agent) => ({
      ...agentCatalogEntry(agent),
      kind: "agent",
    }));

  const authorityId =
    capability.executionMode === "owner"
      ? capability.issueExecutionAuthorityId
      : null;
  const eligibleCreatedIssues = authorityId
    ? snapshot.childIssues
        .filter(
          (child) =>
            (child.lifecycleStatus === "open" ||
              child.lifecycleStatus === "blocked") &&
            child.creatorKind === "agent-execution" &&
            child.creatorAuthorityId === authorityId,
        )
        .sort((left, right) =>
          (left.identifier ?? left.id).localeCompare(
            right.identifier ?? right.id,
          ),
        )
    : [];
  const owners = [
    { kind: "self" as const },
    ...issueCreateDirectChildren,
  ];
  const issueAssignTargets: IssueAssignOwnerCatalog[] =
    eligibleCreatedIssues.map((child) => ({
      issueId: child.id,
      identifier: child.identifier,
      owners,
    }));
  const creatorUpdateTargets = eligibleCreatedIssues.map((child) => ({
    issueId: child.id,
  }));

  const reachableMentionIds = resolveMentionReach({
    sourceAgentId: sourceAgent.id,
    companyAgents,
    issueTree: snapshot.issueTree,
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
    contextDial,
    actionGrants,
    mentionReachGrants,
    isCurrentOwner,
    issueCreateDirectChildren,
    issueAssignTargets,
    creatorUpdateTargets,
    mentionTargets,
    configureTargets,
    pluginTools: snapshot.pluginTools,
    restoreSession:
      snapshot.restoreSession === true &&
      typeof sourceAgent.instruction === "string" &&
      sourceAgent.instruction.trim().length > 0,
  };
}

async function loadSnapshot(
  db: Db,
  capability: PromptCapabilityCompileScope,
): Promise<RuntimeInterfaceCompilerSnapshot> {
  const [
    issueRows,
    agentRows,
    adapterRevisionRows,
    contextRows,
    actionRows,
    mentionRows,
    configureRows,
    childRows,
    issueTreeRows,
    readyPlugins,
  ] = await Promise.all([
    db
      .select({
        companyId: issues.companyId,
        ownerKind: issues.ownerKind,
        ownerAgentId: issues.ownerAgentId,
        ownershipEpoch: issues.ownershipEpoch,
        workMode: issues.workMode,
        harnessKind: issues.harnessKind,
        originKind: issues.originKind,
        executionPolicy: issues.executionPolicy,
      })
      .from(issues)
      .where(eq(issues.id, capability.issueId))
      .limit(1),
    db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        title: agents.title,
        capabilities: agents.capabilities,
        instruction: agents.instruction,
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
        adapterType: agentAdapterConfigRevisions.adapterType,
        implementationIdentity:
          agentAdapterConfigRevisions.implementationIdentity,
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
        id: issues.id,
        identifier: issues.identifier,
        lifecycleStatus: issues.lifecycleStatus,
        creatorKind: issues.creatorKind,
        creatorAuthorityId: issues.creatorAuthorityId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, capability.companyId),
          eq(issues.parentId, capability.issueId),
        ),
      ),
    db.execute(sql<MentionReachIssue>`
      WITH RECURSIVE ancestors(id, parent_id, depth, visited) AS (
        SELECT issue.id, issue.parent_id, 0, ARRAY[issue.id]
        FROM issues issue
        WHERE issue.company_id = ${capability.companyId}
          AND issue.id = ${capability.issueId}
          AND issue.hidden_at IS NULL
        UNION ALL
        SELECT parent.id, parent.parent_id, ancestors.depth + 1, ancestors.visited || parent.id
        FROM issues parent
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
      issue_tree(id, parent_id, owner_kind, owner_agent_id, visited) AS (
        SELECT issue.id, issue.parent_id, issue.owner_kind, issue.owner_agent_id, ARRAY[issue.id]
        FROM issues issue
        JOIN tree_root ON tree_root.id = issue.id
        UNION ALL
        SELECT child.id, child.parent_id, child.owner_kind, child.owner_agent_id, issue_tree.visited || child.id
        FROM issues child
        JOIN issue_tree ON child.parent_id = issue_tree.id
        WHERE child.company_id = ${capability.companyId}
          AND child.hidden_at IS NULL
          AND NOT child.id = ANY(issue_tree.visited)
      )
      SELECT
        id::text AS "id",
        parent_id::text AS "parentId",
        owner_kind AS "ownerKind",
        owner_agent_id::text AS "ownerAgentId"
      FROM issue_tree
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
  const issue = issueRows[0];
  if (!issue) throw new Error("Prompt-capability issue no longer exists");
  return {
    capability,
    issue,
    agents: agentRows,
    adapterRevisions: adapterRevisionRows.map((revision) => ({
      ...revision,
      implementationAvailable:
        isServerAdapterImplementationAvailable(
          revision.adapterType,
          revision.implementationIdentity,
        ),
    })),
    contextGrantKeys: contextRows.map((row) => row.key),
    actionGrantKeys: actionRows.map((row) => row.key),
    mentionReachGrantKeys: mentionRows.map((row) => row.key),
    configureGrants: configureRows,
    childIssues: childRows,
    issueTree: (
      Array.isArray(issueTreeRows)
        ? issueTreeRows
        : Array.from(issueTreeRows as Iterable<unknown>)
    ) as unknown as MentionReachIssue[],
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
  const recoveryHistory = createPostgresRecoverySessionHistoryRepository(db);
  return {
    async resolve(capability) {
      const snapshot = await loadSnapshot(db, capability);
      return buildRuntimeInterfaceCompileInput({
        ...snapshot,
        restoreSession: await isTargetNotFoundReplacement(
          recoveryHistory,
          recoveryScopeForCapability(capability),
        ),
      });
    },

  };
}

export function createRuntimeRetrievalScopeResolver(
  compiler: PostgresPromptCapabilityCompiler,
): RuntimeRetrievalScopeResolver {
  return {
    async resolve(capability) {
      const input = await compiler.resolve(capability);
      return {
        companyId: capability.companyId,
        activeIssueId: capability.issueId,
        dial: input.contextDial,
      };
    },
  };
}
