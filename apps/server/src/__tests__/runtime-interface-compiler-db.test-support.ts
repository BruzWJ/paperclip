import { describe, expect, it } from "vitest";
import { taskExecutionRefs, type Db } from "@paperclipai/db";
import { AGENT_CONTEXT_GRANT_KEYS, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PromptCapabilityCompileScope } from "../services/prompt-capability-gateway.ts";
import {
  buildRuntimeInterfaceCompileInput,
  readyPluginTools,
  resolveRuntimeToolTurn,
  type RuntimeInterfaceCompilerSnapshot,
} from "../services/runtime-interface-compiler-db.ts";
import { compileRuntimeInterface } from "../services/runtime-interface-compiler.ts";
import type { InvokableTaskOwnerRevision } from "../services/agent-invokability.ts";
export function revision(id: string, agentId: string): InvokableTaskOwnerRevision {
  return {
    id,
    companyId: "company",
    agentId,
  };
}

export function capability(
  overrides: Partial<PromptCapabilityCompileScope> = {},
): PromptCapabilityCompileScope {
  return {
    companyId: "company",
    taskId: "task",
    taskExecutionAuthorityId: "authority",
    consultExecutionId: null,
    executionMode: "owner",
    ownershipEpoch: 4,
    targetAgentId: "owner",
    ...overrides,
  };
}

export function snapshot(
  overrides: Partial<RuntimeInterfaceCompilerSnapshot> = {},
): RuntimeInterfaceCompilerSnapshot {
  return {
    capability: capability(),
    turn: "work",
    task: {
      companyId: "company",
      ownerKind: "agent",
      ownerAgentId: "owner",
      ownershipEpoch: 4,
      executionPolicy: null,
    },
    agents: [
      {
        id: "above-root",
        companyId: "company",
        name: "Above root",
        title: null,
        capabilities: null,
        reportsTo: null,
        status: "idle",
        currentAdapterConfigRevisionId: "above-root-revision",
      },
      {
        id: "ancestor",
        companyId: "company",
        name: "Ancestor",
        title: "Secret title",
        capabilities: "Review",
        reportsTo: "above-root",
        status: "idle",
        currentAdapterConfigRevisionId: "ancestor-revision",
      },
      {
        id: "owner",
        companyId: "company",
        name: "Owner",
        title: "Secret title",
        capabilities: "Build",
        reportsTo: "ancestor",
        status: "idle",
        currentAdapterConfigRevisionId: "revision",
      },
      {
        id: "child",
        companyId: "company",
        name: "Child",
        title: "Secret title",
        capabilities: "Test",
        reportsTo: "owner",
        status: "idle",
        currentAdapterConfigRevisionId: "child-revision",
      },
      {
        id: "grandchild",
        companyId: "company",
        name: "Grandchild",
        title: null,
        capabilities: null,
        reportsTo: "child",
        status: "idle",
        currentAdapterConfigRevisionId: "grandchild-revision",
      },
      {
        id: "paused-child",
        companyId: "company",
        name: "Paused",
        title: null,
        capabilities: null,
        reportsTo: "owner",
        status: "paused",
        currentAdapterConfigRevisionId: "paused-revision",
      },
      {
        id: "peer",
        companyId: "company",
        name: "Peer",
        title: null,
        capabilities: null,
        reportsTo: "ancestor",
        status: "idle",
        currentAdapterConfigRevisionId: "peer-revision",
      },
    ],
    adapterRevisions: [
      revision("above-root-revision", "above-root"),
      revision("ancestor-revision", "ancestor"),
      revision("revision", "owner"),
      revision("child-revision", "child"),
      revision("grandchild-revision", "grandchild"),
      revision("paused-revision", "paused-child"),
      revision("peer-revision", "peer"),
    ],
    contextGrantKeys: ["read_task_comments", "list_company_tasks"],
    actionGrantKeys: ["task_create", "mention_agent", "agent_configure"],
    mentionReachGrantKeys: ["mention_any_descendant", "mention_any_ancestor"],
    childTasks: [
      {
        id: "eligible-child",
        identifier: "PAP-2",
        lifecycleStatus: "open",
        creatorKind: "agent-execution",
        creatorAuthorityId: "authority",
      },
      {
        id: "other-authority",
        identifier: "PAP-3",
        lifecycleStatus: "open",
        creatorKind: "agent-execution",
        creatorAuthorityId: "different",
      },
      {
        id: "terminal-child",
        identifier: "PAP-4",
        lifecycleStatus: "done",
        creatorKind: "agent-execution",
        creatorAuthorityId: "authority",
      },
    ],
    taskTree: [
      {
        id: "root-task",
        parentId: null,
        ownerKind: "agent",
        ownerAgentId: "ancestor",
      },
      {
        id: "task",
        parentId: "root-task",
        ownerKind: "agent",
        ownerAgentId: "owner",
      },
      {
        id: "descendant-task",
        parentId: "task",
        ownerKind: "agent",
        ownerAgentId: "grandchild",
      },
    ],
    pluginTools: [],
    ...overrides,
  };
}
export type TaskExecutionRefRow = typeof taskExecutionRefs.$inferSelect;

export { describe, expect, it, AGENT_CONTEXT_GRANT_KEYS };
export { buildRuntimeInterfaceCompileInput, readyPluginTools, resolveRuntimeToolTurn };
export { compileRuntimeInterface };
export type { Db, PaperclipPluginManifestV1 };
