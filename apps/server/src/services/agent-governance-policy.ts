import {
  agentGovernancePolicySchema,
  type AgentGovernancePolicy,
} from "@paperclipai/shared";

/**
 * Validates the independent control-plane governance document stored on an
 * agent. Runtime authority is represented only by normalized grant tables.
 */
export function normalizeAgentGovernancePolicy(
  value: unknown,
): AgentGovernancePolicy {
  const parsed = agentGovernancePolicySchema.parse(value ?? {});
  if (parsed.authorizationPolicy === null) {
    const { authorizationPolicy: _cleared, ...rest } = parsed;
    return rest;
  }
  return parsed as AgentGovernancePolicy;
}
