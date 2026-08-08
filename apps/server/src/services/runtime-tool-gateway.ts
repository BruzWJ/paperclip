import { createHash } from "node:crypto";
import {
  decodeToolResult,
  type ExecuteToolParams,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import type { ContextRetrievalScope } from "./context-retrieval.js";
import {
  isPaperclipManagedToolName,
  type RuntimePaperclipManagedToolCall,
} from "./paperclip-managed-tool-registry.js";
import type {
  AgentRunToolAuthority,
  PaperclipManagedToolRouter,
} from "./paperclip-managed-tool-router.js";
import {
  RuntimeInterfaceConflict,
} from "./runtime-tool-errors.js";
import type {
  CompiledRunToolDescriptor,
  RestoreSessionArguments,
} from "./runtime-interface-compiler.js";
import type {
  PromptCapabilityBinding,
  PromptCapabilityCallIdentity,
  PromptCapabilityToolExecutor,
} from "./prompt-capability-gateway.js";
import {
  RuntimeToolCallIdentityConflict,
  RuntimeToolCallInProgress,
  type RuntimeToolCallLedger,
} from "./runtime-tool-call-ledger.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

type RecoverySessionHistoryReader = ReturnType<
  typeof import("./recovery-session-history.js").createRecoverySessionHistoryReader
>;

export interface RuntimeRetrievalScopeResolver {
  resolve(capability: PromptCapabilityBinding): Promise<ContextRetrievalScope>;
}

export interface RuntimePluginToolPort {
  execute(input: {
    capability: PromptCapabilityBinding;
    toolName: string;
    pluginInstallationId: string;
    pluginManifestIdentity: string;
    arguments: unknown;
    mintPluginRunContext(): Promise<string>;
  }): Promise<ToolResult>;
}

export function createRuntimePluginToolPort(
  workerManager: Pick<PluginWorkerManager, "getWorker">,
): RuntimePluginToolPort {
  return {
    async execute(input) {
      const worker = workerManager.getWorker(input.pluginInstallationId);
      if (
        worker?.status !== "running" ||
        worker.manifestIdentity !== input.pluginManifestIdentity
      ) {
        throw new Error(
          `Cannot execute plugin tool "${input.toolName}" — its exact compiled plugin runtime is not running.`,
        );
      }
      const runContextHandle = await input.mintPluginRunContext();
      const result = await worker.call(
        "executeTool",
        {
          toolName: input.toolName,
          parameters: input.arguments,
          runContextHandle,
        } satisfies ExecuteToolParams,
        undefined,
        {
          companyId: input.capability.companyId,
          pluginRunContextHandle: runContextHandle,
        },
      );
      return decodeToolResult(result);
    },
  };
}

/** Normalize one dynamically compiled Paperclip descriptor into one command. */
export function prepareRuntimePaperclipManagedToolCall(input: {
  descriptor: CompiledRunToolDescriptor;
  arguments: unknown;
  scope: Pick<
    AgentRunToolAuthority["capability"],
    "companyId" | "issueId" | "targetAgentId"
  >;
}): RuntimePaperclipManagedToolCall {
  if (
    input.descriptor.source !== "paperclip" ||
    !isPaperclipManagedToolName(input.descriptor.name) ||
    !input.descriptor.normalizeRuntimeCommand
  ) {
    throw new RuntimeInterfaceConflict(
      `Unknown Paperclip managed tool ${input.descriptor.name}`,
    );
  }
  return input.descriptor.normalizeRuntimeCommand(input.arguments, input.scope);
}

function invocationId(
  capability: PromptCapabilityBinding,
  callIdentity: PromptCapabilityCallIdentity,
): string {
  return `call_${createHash("sha256")
    .update([
      capability.capabilityConnectionId,
      String(capability.capabilityGeneration),
      callIdentity.source,
      typeof callIdentity.id,
      String(callIdentity.id),
    ].join("\0"))
    .digest("hex")}`;
}

function agentRunAuthority(input: {
  capability: PromptCapabilityBinding;
  callIdentity: PromptCapabilityCallIdentity;
  runInterfaceToolCallId: string;
  ingressOrdinal: number;
  commitMentionAction: AgentRunToolAuthority["invocation"]["commitMentionAction"];
}): AgentRunToolAuthority {
  return {
    kind: "agent_run",
    capability: input.capability,
    invocation: {
      id: invocationId(input.capability, input.callIdentity),
      runInterfaceToolCallId: input.runInterfaceToolCallId,
      ingressOrdinal: input.ingressOrdinal,
      commitMentionAction: input.commitMentionAction,
    },
  };
}

/**
 * ACPX ingress only: descriptor validation, idempotency/replay, plugin
 * dispatch, and atomic mention commitment. Every Paperclip-managed tool call
 * crosses the same router as Board MCP below this boundary.
 */
export function createRuntimeToolGateway(options: {
  retrievalScope: RuntimeRetrievalScopeResolver;
  restoreSession?: RecoverySessionHistoryReader;
  managedTools: PaperclipManagedToolRouter;
  pluginTools: RuntimePluginToolPort;
  callLedger: RuntimeToolCallLedger;
}): PromptCapabilityToolExecutor {
  return {
    async registerTerminalInvalid({
      capability,
      descriptor,
      arguments: args,
      callIdentity,
      ingressOrdinal,
      error,
    }) {
      await options.callLedger.registerTerminalInvalid({
        capability,
        descriptor,
        arguments: args,
        callIdentity,
        ingressOrdinal,
        error,
      });
    },

    async execute({
      capability,
      descriptor,
      arguments: args,
      callIdentity,
      ingressOrdinal,
      mintPluginRunContext,
    }) {
      const claim = await options.callLedger.claim({
        capability,
        descriptor,
        callIdentity,
        ingressOrdinal,
        arguments: args,
      });
      if (claim.state === "completed") {
        return {
          source: descriptor.source,
          value: descriptor.source === "plugin"
            ? decodeToolResult(claim.result)
            : claim.result,
        };
      }
      if (claim.state === "executing") throw new RuntimeToolCallInProgress();
      if (claim.state === "failed") {
        const replayed = new Error(claim.error.message);
        replayed.name = claim.error.name;
        for (const [key, value] of Object.entries({
          code: claim.error.code,
          status: claim.error.status,
          reasonCode: claim.error.reasonCode,
          details: claim.error.details,
        })) {
          if (value !== undefined) {
            Object.defineProperty(replayed, key, {
              configurable: true,
              enumerable: true,
              value,
            });
          }
        }
        throw replayed;
      }
      if (claim.state !== "claimed") {
        throw new RuntimeToolCallIdentityConflict(
          "Tool call identity could not be claimed",
        );
      }

      try {
        const prepared =
          descriptor.source === "paperclip" && descriptor.name !== "restore_session"
            ? prepareRuntimePaperclipManagedToolCall({
                descriptor,
                arguments: args,
                scope: capability,
              })
            : null;
        const validatedArguments = prepared === null
          ? descriptor.validateArguments
            ? descriptor.validateArguments(args)
            : args
          : undefined;
        const ledgerMetadata = prepared?.ledger ?? { kind: "non_mention" as const };
        await options.callLedger.classify(
          ledgerMetadata.kind === "mention" &&
            ledgerMetadata.targetAgentId !== null
            ? {
                capability,
                id: claim.id,
                ingressOrdinal,
                classification: "validated_mention",
                targetAgentId: ledgerMetadata.targetAgentId,
              }
            : {
                capability,
                id: claim.id,
                ingressOrdinal,
                classification: "non_mention",
              },
        );

        let result: unknown;
        let mentionActionCommitted = false;
        if (descriptor.name === "restore_session") {
          if (!options.restoreSession) {
            throw new RuntimeInterfaceConflict("restore_session reader is unavailable");
          }
          result = await options.restoreSession.restore({
            capability,
            ...(validatedArguments as RestoreSessionArguments),
          });
        } else if (descriptor.source === "plugin") {
          if (
            !descriptor.pluginInstallationId ||
            !descriptor.pluginManifestIdentity ||
            !descriptor.pluginToolName
          ) {
            throw new RuntimeInterfaceConflict(
              "Plugin tool is missing its immutable installation binding",
            );
          }
          result = await options.pluginTools.execute({
            capability,
            toolName: descriptor.pluginToolName,
            pluginInstallationId: descriptor.pluginInstallationId,
            pluginManifestIdentity: descriptor.pluginManifestIdentity,
            arguments: validatedArguments,
            mintPluginRunContext: () => mintPluginRunContext({
              runInterfaceToolCallId: claim.id,
              pluginInstallationId: descriptor.pluginInstallationId!,
              pluginManifestIdentity: descriptor.pluginManifestIdentity!,
            }),
          });
        } else if (prepared) {
          const authority = agentRunAuthority({
            capability,
            callIdentity,
            runInterfaceToolCallId: claim.id,
            ingressOrdinal,
            async commitMentionAction(transaction, committed) {
              if (ledgerMetadata.kind !== "mention") {
                throw new RuntimeToolCallIdentityConflict(
                  "Only a canonical mention can commit through the mention action boundary",
                );
              }
              const result = await options.callLedger.commitMentionAction({
                transaction,
                capability,
                id: claim.id,
                ingressOrdinal,
                toolName: ledgerMetadata.toolName,
                targetAgentId: ledgerMetadata.targetAgentId,
                result: committed,
              });
              mentionActionCommitted = true;
              return result;
            },
          });
          result = await options.managedTools.routeExecution(
            prepared.command,
            {
              authority,
              resolveRuntimeScope: () => options.retrievalScope.resolve(capability),
            },
          );
        } else {
          throw new RuntimeInterfaceConflict(
            `Unknown Paperclip action ${descriptor.name}`,
          );
        }

        if (ledgerMetadata.kind === "mention") {
          if (!mentionActionCommitted) {
            throw new RuntimeToolCallIdentityConflict(
              "Canonical mention returned without its atomic ledger commitment",
            );
          }
        } else {
          await options.callLedger.complete({ capability, id: claim.id, result });
        }
        return { source: descriptor.source, value: result };
      } catch (error) {
        await options.callLedger.fail({ capability, id: claim.id, error });
        throw error;
      }
    },
  };
}
