import { createHash } from "node:crypto";
import { AGENT_CONTEXT_GRANT_KEYS, type AgentContextGrantKey } from "@paperclipai/shared";

export type ContextDial = Readonly<Record<AgentContextGrantKey, boolean>>;
export type ContextAttenuationMask = Readonly<Partial<Record<AgentContextGrantKey, boolean>>>;

export interface ResolveContextDialInput {
  /**
   * Sparse persisted grants. Absence is false and no company/org/default
   * breadth is inferred.
   */
  agent: ContextAttenuationMask;
  /**
   * The active owner of a task always receives the current-task and
   * sub-task retrieval cells. Company-level cells remain the agent's grants.
   */
  taskOwner?: boolean;
  /**
   * Execution-mode policy is false-only. Missing keys preserve the prior tier.
   */
  executionMode?: ContextAttenuationMask | null;
}

export interface ResolvedContextDial {
  agent: ContextDial;
  executionMode: ContextDial;
  effective: ContextDial;
  digest: string;
}

export interface ContextRetrievalReachPolicy {
  active: boolean;
  descendant: boolean;
  company: boolean;
}

export interface ContextRetrievalPolicy {
  listCompanyTasks: boolean;
  listSubTasks: {
    enabled: boolean;
    omittedActive: boolean;
    explicit: ContextRetrievalReachPolicy;
  };
  comments: ContextRetrievalReachPolicy & {
    enabled: boolean;
    taskIdRequired: boolean;
  };
  runs: ContextRetrievalReachPolicy & {
    enabled: boolean;
  };
}

const ALL_FALSE = Object.freeze(
  Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false])),
) as ContextDial;

const ALL_TRUE = Object.freeze(
  Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, true])),
) as ContextDial;

const TASK_OWNER_CONTEXT_GRANT_KEYS = new Set<AgentContextGrantKey>([
  "carry_context",
  "read_task_comments",
  "read_task_agent_run",
  "list_sub_tasks",
  "read_sub_task_comments",
  "read_sub_task_agent_run",
]);

function normalizeAgentGrants(input: ContextAttenuationMask): ContextDial {
  return Object.freeze(
    Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, input[key] === true])),
  ) as ContextDial;
}

function normalizeFalseOnlyMask(input: ContextAttenuationMask | null | undefined): ContextDial {
  if (!input) return ALL_TRUE;
  return Object.freeze(
    Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, input[key] !== false])),
  ) as ContextDial;
}

function withTaskOwnerBaseline(agent: ContextDial): ContextDial {
  return Object.freeze(
    Object.fromEntries(
      AGENT_CONTEXT_GRANT_KEYS.map((key) => [
        key,
        TASK_OWNER_CONTEXT_GRANT_KEYS.has(key) ? true : agent[key],
      ]),
    ),
  ) as ContextDial;
}

function andDials(...dials: readonly ContextDial[]): ContextDial {
  return Object.freeze(
    Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, dials.every((dial) => dial[key])])),
  ) as ContextDial;
}

export function contextDialDigest(dial: ContextDial): string {
  const canonical = AGENT_CONTEXT_GRANT_KEYS.map((key) => `${key}=${dial[key] ? "1" : "0"}`).join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Resolves the only model-context authorization matrix.
 *
 * Each cell is independent:
 *   effective = (agent ∪ task-owner current/sub-task baseline) ∧ executionMode
 */
export function resolveContextDial(input: ResolveContextDialInput): ResolvedContextDial {
  const agent = normalizeAgentGrants(input.agent);
  const ownerBaseline = input.taskOwner === true ? withTaskOwnerBaseline(agent) : agent;
  const executionMode = normalizeFalseOnlyMask(input.executionMode);
  const effective = andDials(ownerBaseline, executionMode);

  return {
    agent,
    executionMode,
    effective,
    digest: contextDialDigest(effective),
  };
}

export function resolveContextRetrievalPolicy(dial: ContextDial): ContextRetrievalPolicy {
  const listSubTasksEnabled = dial.list_sub_tasks || dial.list_company_tasks;
  const comments = {
    active: dial.read_task_comments,
    descendant: dial.read_sub_task_comments,
    company: dial.read_company_task_comments,
  };
  const runs = {
    active: dial.read_task_agent_run,
    descendant: dial.read_sub_task_agent_run,
    company: dial.read_company_task_agent_run,
  };

  return {
    listCompanyTasks: dial.list_company_tasks,
    listSubTasks: {
      enabled: listSubTasksEnabled,
      omittedActive: listSubTasksEnabled,
      explicit: {
        // Sub-task reach is proper-descendant-only. The active task becomes
        // a valid explicit target only through the company-wide tier.
        active: dial.list_company_tasks,
        descendant: dial.list_sub_tasks,
        company: dial.list_company_tasks,
      },
    },
    comments: {
      ...comments,
      enabled: comments.active || comments.descendant || comments.company,
      taskIdRequired: !comments.active,
    },
    runs: {
      ...runs,
      enabled: runs.active || runs.descendant || runs.company,
    },
  };
}
