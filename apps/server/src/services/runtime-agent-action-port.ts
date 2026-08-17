import {
  RuntimeAgentConfigurationInvalid,
  type RuntimeAgentConfigurationService,
} from "./runtime-agent-configuration.js";
import { type AgentRunManagedActionPort } from "./paperclip-managed-tool-router.js";
import { RuntimeToolArgumentsInvalid } from "./runtime-tool-errors.js";

export type AgentRunAgentActionPort = Pick<AgentRunManagedActionPort, "agentHire" | "agentConfigure">;

export type AgentRunNonAgentActionPort = Omit<AgentRunManagedActionPort, "agentHire" | "agentConfigure">;

async function mapInvalidArguments<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RuntimeAgentConfigurationInvalid) {
      throw new RuntimeToolArgumentsInvalid(error.message);
    }
    throw error;
  }
}

/**
 * Production adapters for the two runtime-agent action descriptors. The
 * same shared Zod contracts back descriptor generation, call validation, and
 * this execution boundary. No provider/adapter/role/icon/environment/
 * budget/lifecycle field has a place in either accepted object.
 */
export function createRuntimeAgentActionPort(
  service: RuntimeAgentConfigurationService,
): AgentRunAgentActionPort {
  return {
    async agentHire(input) {
      const { reportsTo: _reportsTo, ...configuration } = input.command.configuration;
      return mapInvalidArguments(async () => {
        await service.hireFromRun({
          capability: input.authority.capability,
          invocationId: input.authority.invocation.id,
          configuration,
        });
        return { status: "created" as const };
      });
    },

    async agentConfigure(input) {
      const { agentId: targetAgentId, configuration } = input.command;
      return mapInvalidArguments(async () => {
        await service.configureFromRun({
          capability: input.authority.capability,
          invocationId: input.authority.invocation.id,
          targetAgentId,
          configuration,
        });
        return { status: "configured" as const };
      });
    },
  };
}

/**
 * Keeps integration explicit while the task-action implementation remains a
 * separate concern. The shared action contract lives in
 * the managed-tool router, never at the ACPX gateway boundary.
 */
export function composeAgentRunManagedActionPort(
  otherActions: AgentRunNonAgentActionPort,
  agentActions: AgentRunAgentActionPort,
): AgentRunManagedActionPort {
  return {
    ...otherActions,
    ...agentActions,
  };
}
