import {
  AGENT_CONTEXT_GRANT_KEYS,
  type AgentContextGrantKey,
} from "@paperclipai/shared";
import type { ContextAttenuationMask } from "./context-dial-resolver.js";

export const DENY_ALL_EXECUTION_CONTEXT_MASK = Object.freeze(
  Object.fromEntries(
    AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false]),
  ) as Record<AgentContextGrantKey, false>,
);

export interface ExecutionModeContextInput {
  workMode?: string | null;
  harnessKind?: string | null;
  originKind?: string | null;
  agentGovernance?: unknown;
  issueExecutionPolicy?: unknown;
}

function impliesLowTrust(value: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.trustPreset === "low_trust_review") return true;
  if (
    record.reviewPreset &&
    typeof record.reviewPreset === "object" &&
    !Array.isArray(record.reviewPreset) &&
    (record.reviewPreset as Record<string, unknown>).id ===
      "low_trust_review"
  ) {
    return true;
  }
  if (
    record.trustBoundary &&
    typeof record.trustBoundary === "object" &&
    !Array.isArray(record.trustBoundary)
  ) {
    return true;
  }
  return impliesLowTrust(record.authorizationPolicy, depth + 1);
}

/**
 * Maps retained restricted execution modes to false-only context masks.
 * These modes receive their exact immutable request, but cannot pull prior or
 * neighboring Paperclip issue context through any launch, retry, consult, or
 * native-session path.
 */
export function resolveExecutionModeContextMask(
  input: ExecutionModeContextInput,
): ContextAttenuationMask | null {
  if (
    input.workMode === "skill_test" ||
    input.harnessKind === "skill_test" ||
    input.originKind === "task_bridge" ||
    impliesLowTrust(input.agentGovernance) ||
    impliesLowTrust(input.issueExecutionPolicy)
  ) {
    return DENY_ALL_EXECUTION_CONTEXT_MASK;
  }
  return null;
}
