import {
  runtimeAgentConfigureActionSchema,
  runtimeAgentHireConfigurationSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import {
  RuntimeAgentConfigurationConsentRequired,
  RuntimeAgentConfigurationInvalid,
  type RuntimeAgentConfigurationService,
} from "./runtime-agent-configuration.js";
import {
  RuntimeToolArgumentsInvalid,
  type RuntimeActionInvocation,
  type RuntimeActionPort,
} from "./runtime-tool-executor.js";

export type RuntimeAgentActionPort = Pick<
  RuntimeActionPort,
  "agentHire" | "agentConfigure"
>;

export type RuntimeNonAgentActionPort = Omit<
  RuntimeActionPort,
  "agentHire" | "agentConfigure"
>;

function parseCanonicalActionArguments<T>(
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new RuntimeToolArgumentsInvalid(
    parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
      .join("; "),
  );
}

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
 * this execution boundary. No provider/adapter/role/skill/icon/environment/
 * budget/lifecycle field has a place in either accepted object.
 */
export function createRuntimeAgentActionPort(
  service: RuntimeAgentConfigurationService,
  options: {
    requestChangeConsent?: (input: {
      capability: RuntimeActionInvocation["capability"];
      targetAgentId: string;
      displayedDiff: string;
    }) => Promise<void>;
  } = {},
): RuntimeAgentActionPort {
  return {
    async agentHire(input: RuntimeActionInvocation) {
      const configuration = parseCanonicalActionArguments(
        runtimeAgentHireConfigurationSchema,
        input.arguments,
      );
      return mapInvalidArguments(async () => {
        await service.hireFromRun({
          capability: input.capability,
          invocationId: input.invocationId,
          configuration,
        });
        return { status: "created" as const };
      });
    },

    async agentConfigure(input: RuntimeActionInvocation) {
      const { agentId: targetAgentId, ...configuration } =
        parseCanonicalActionArguments(
          runtimeAgentConfigureActionSchema,
          input.arguments,
        );
      return mapInvalidArguments(async () => {
        try {
          await service.configureFromRun({
            capability: input.capability,
            invocationId: input.invocationId,
            targetAgentId,
            configuration,
          });
          return { status: "configured" as const };
        } catch (error) {
          if (
            !(error instanceof RuntimeAgentConfigurationConsentRequired)
            || !options.requestChangeConsent
          ) {
            throw error;
          }
          await options.requestChangeConsent({
            capability: input.capability,
            targetAgentId: error.targetAgentId,
            displayedDiff: error.displayedDiff,
          });
          return { status: "change_consent_requested" as const };
        }
      });
    },
  };
}

/**
 * Keeps integration explicit while the issue-action implementation remains a
 * separate concern. There is still exactly one RuntimeActionPort at the
 * gateway boundary.
 */
export function composeRuntimeActionPort(
  otherActions: RuntimeNonAgentActionPort,
  agentActions: RuntimeAgentActionPort,
): RuntimeActionPort {
  return {
    ...otherActions,
    ...agentActions,
  };
}
