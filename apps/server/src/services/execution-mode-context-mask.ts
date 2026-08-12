import {
  AGENT_CONTEXT_GRANT_KEYS,
  lowTrustReviewPresetPolicySchema,
  type AgentContextGrantKey,
} from "@paperclipai/shared";
import type { ContextAttenuationMask } from "./context-dial-resolver.js";

export const DENY_ALL_EXECUTION_CONTEXT_MASK = Object.freeze(
  Object.fromEntries(
    AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false]),
  ) as Record<AgentContextGrantKey, false>,
);

export interface ExecutionModeContextInput {
  taskExecutionPolicy?: unknown;
}

function impliesLowTrust(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return lowTrustReviewPresetPolicySchema.safeParse(record.reviewPreset).success;
}

/**
 * Maps retained restricted execution modes to false-only context masks.
 * These modes receive their exact immutable request, but cannot pull prior or
 * neighboring Paperclip task context through any launch, retry, consult, or
 * native-session path.
 */
export function resolveExecutionModeContextMask(
  input: ExecutionModeContextInput,
): ContextAttenuationMask | null {
  if (impliesLowTrust(input.taskExecutionPolicy)) {
    return DENY_ALL_EXECUTION_CONTEXT_MASK;
  }
  return null;
}
