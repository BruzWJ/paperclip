import { createHash } from "node:crypto";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  type AgentContextGrantKey,
} from "@paperclipai/shared";

export type ContextDial = Readonly<Record<AgentContextGrantKey, boolean>>;
export type ContextAttenuationMask = Readonly<
  Partial<Record<AgentContextGrantKey, boolean>>
>;

export interface ResolveContextDialInput {
  /**
   * Sparse persisted grants. Absence is false and no company/org/default
   * breadth is inferred.
   */
  agent: ContextAttenuationMask;
  /**
   * Assignment attention is false-only. Missing keys preserve the agent cell.
   */
  assignment?: ContextAttenuationMask | null;
  /**
   * Execution-mode policy is false-only. Missing keys preserve the prior tier.
   */
  executionMode?: ContextAttenuationMask | null;
}

export interface ResolvedContextDial {
  agent: ContextDial;
  assignment: ContextDial;
  executionMode: ContextDial;
  effective: ContextDial;
  digest: string;
}

export type AttentionPreset =
  | "heads_down"
  | "focused"
  | "supervisor"
  | "investigator"
  | "situational";

export type FreshCompositionDepth = "thread" | "turns" | null;

export interface ContextRetrievalReachPolicy {
  active: boolean;
  descendant: boolean;
  company: boolean;
}

export interface ContextRetrievalPolicy {
  listCompanyIssues: boolean;
  listSubIssues: {
    enabled: boolean;
    omittedActive: boolean;
    explicit: ContextRetrievalReachPolicy;
  };
  comments: ContextRetrievalReachPolicy & {
    enabled: boolean;
    issueIdRequired: boolean;
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

const PRESET_STAMPS: Readonly<Record<AttentionPreset, ContextDial>> =
  Object.freeze({
    heads_down: ALL_FALSE,
    focused: dialFromEnabled(["carry_context", "read_issue_comments"]),
    supervisor: dialFromEnabled([
      "carry_context",
      "read_issue_comments",
      "list_sub_issues",
      "read_sub_issue_comments",
    ]),
    investigator: dialFromEnabled([
      "carry_context",
      "read_issue_comments",
      "list_sub_issues",
      "read_sub_issue_comments",
      "read_issue_agent_run",
    ]),
    situational: dialFromEnabled([
      "carry_context",
      "read_issue_comments",
      "list_sub_issues",
      "read_sub_issue_comments",
      "read_issue_agent_run",
      "list_company_issues",
    ]),
  });

function dialFromEnabled(enabled: readonly AgentContextGrantKey[]): ContextDial {
  const enabledSet = new Set(enabled);
  return Object.freeze(
    Object.fromEntries(
      AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, enabledSet.has(key)]),
    ),
  ) as ContextDial;
}

function normalizeAgentGrants(input: ContextAttenuationMask): ContextDial {
  return Object.freeze(
    Object.fromEntries(
      AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, input[key] === true]),
    ),
  ) as ContextDial;
}

function normalizeFalseOnlyMask(
  input: ContextAttenuationMask | null | undefined,
): ContextDial {
  if (!input) return ALL_TRUE;
  return Object.freeze(
    Object.fromEntries(
      AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, input[key] !== false]),
    ),
  ) as ContextDial;
}

function andDials(...dials: readonly ContextDial[]): ContextDial {
  return Object.freeze(
    Object.fromEntries(
      AGENT_CONTEXT_GRANT_KEYS.map((key) => [
        key,
        dials.every((dial) => dial[key]),
      ]),
    ),
  ) as ContextDial;
}

export function contextDialDigest(dial: ContextDial): string {
  const canonical = AGENT_CONTEXT_GRANT_KEYS.map(
    (key) => `${key}=${dial[key] ? "1" : "0"}`,
  ).join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Resolves the only model-context authorization matrix.
 *
 * Each cell is independent:
 *   effective = agent ∧ assignment ∧ executionMode
 */
export function resolveContextDial(
  input: ResolveContextDialInput,
): ResolvedContextDial {
  const agent = normalizeAgentGrants(input.agent);
  const assignment = normalizeFalseOnlyMask(input.assignment);
  const executionMode = normalizeFalseOnlyMask(input.executionMode);
  const effective = andDials(agent, assignment, executionMode);

  return {
    agent,
    assignment,
    executionMode,
    effective,
    digest: contextDialDigest(effective),
  };
}

/**
 * Presets are UI conveniences only. This returns the concrete one-time stamp;
 * callers persist cells, never the preset name.
 */
export function stampAttentionPreset(preset: AttentionPreset): ContextDial {
  return { ...PRESET_STAMPS[preset] };
}

export function resolveFreshCompositionDepth(
  dial: ContextDial,
): FreshCompositionDepth {
  if (dial.read_issue_agent_run) return "turns";
  if (dial.read_issue_comments) return "thread";
  return null;
}

export function resolveContextRetrievalPolicy(
  dial: ContextDial,
): ContextRetrievalPolicy {
  const listSubIssuesEnabled =
    dial.list_sub_issues || dial.list_company_issues;
  const comments = {
    active: dial.read_issue_comments,
    descendant: dial.read_sub_issue_comments,
    company: dial.read_company_issue_comments,
  };
  const runs = {
    active: dial.read_issue_agent_run,
    descendant: dial.read_sub_issue_agent_run,
    company: dial.read_company_issue_agent_run,
  };

  return {
    listCompanyIssues: dial.list_company_issues,
    listSubIssues: {
      enabled: listSubIssuesEnabled,
      omittedActive: listSubIssuesEnabled,
      explicit: {
        // Sub-issue reach is proper-descendant-only. The active issue becomes
        // a valid explicit target only through the company-wide tier.
        active: dial.list_company_issues,
        descendant: dial.list_sub_issues,
        company: dial.list_company_issues,
      },
    },
    comments: {
      ...comments,
      enabled:
        comments.active || comments.descendant || comments.company,
      issueIdRequired: !comments.active,
    },
    runs: {
      ...runs,
      enabled: runs.active || runs.descendant || runs.company,
    },
  };
}

export function allContextCellsFalse(dial: ContextDial): boolean {
  return AGENT_CONTEXT_GRANT_KEYS.every((key) => !dial[key]);
}
