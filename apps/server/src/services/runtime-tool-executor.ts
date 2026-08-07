import { createHash } from "node:crypto";
import {
  decodeToolResult,
  type ExecuteToolParams,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import type { ContextRetrievalScope } from "./context-retrieval.js";
import {
  buildRuntimeRetrievalAbi,
  RuntimeInterfaceConflict,
  RuntimeToolArgumentsInvalid,
  type CompiledRunToolDescriptor,
  type PaperclipRuntimeToolName,
  type RuntimeMentionArguments,
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
  type RuntimeToolCallTransaction,
} from "./runtime-tool-call-ledger.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

type ContextRetrievalService = ReturnType<
  typeof import("./context-retrieval.js").createContextRetrievalService
>;

export interface RuntimeActionInvocation {
  capability: PromptCapabilityBinding;
  invocationId: string;
  runInterfaceToolCallId: string;
  ingressOrdinal: number;
  arguments: Readonly<Record<string, unknown>>;
  commitMentionAction<T>(
    transaction: RuntimeToolCallTransaction,
    result: T,
  ): Promise<T>;
}

export interface RuntimeActionPort {
  issueCreate(input: RuntimeActionInvocation): Promise<unknown>;
  issueAssign(input: RuntimeActionInvocation): Promise<unknown>;
  issueUpdate(input: RuntimeActionInvocation): Promise<unknown>;
  mentionAgent(input: RuntimeActionInvocation): Promise<unknown>;
  mentionBoard(input: RuntimeActionInvocation): Promise<unknown>;
  agentHire(input: RuntimeActionInvocation): Promise<unknown>;
  agentConfigure(input: RuntimeActionInvocation): Promise<unknown>;
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

/**
 * Direct transport from the dynamically compiled run-tools interface to the
 * exact installed plugin worker. Discovery, namespacing, schema validation,
 * and installation binding remain owned by the per-call DB compiler; this
 * port deliberately has no manifest registry or lifecycle catalog.
 */
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
      const rpcParams: ExecuteToolParams = {
        toolName: input.toolName,
        parameters: input.arguments,
        runContextHandle,
      };
      const result = await worker.call(
        "executeTool",
        rpcParams,
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

export interface RuntimeRetrievalScopeResolver {
  resolve(
    capability: PromptCapabilityBinding,
  ): Promise<ContextRetrievalScope>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeToolArgumentsInvalid("Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function validatedMentionTarget(value: unknown): string {
  const targetAgentId = (value as RuntimeMentionArguments).agentId;
  if (typeof targetAgentId !== "string" || targetAgentId.length === 0) {
    throw new Error(
      "Compiled mention descriptor returned an invalid canonical target",
    );
  }
  return targetAgentId;
}

function invocationId(
  capability: PromptCapabilityBinding,
  callIdentity: PromptCapabilityCallIdentity,
): string {
  const identityType = typeof callIdentity.id;
  return `call_${createHash("sha256")
    .update(
      [
        capability.capabilityConnectionId,
        String(capability.capabilityGeneration),
        callIdentity.source,
        identityType,
        String(callIdentity.id),
      ].join("\0"),
    )
    .digest("hex")}`;
}

export function createRuntimeToolExecutor(options: {
  retrieval: ContextRetrievalService;
  retrievalScope: RuntimeRetrievalScopeResolver;
  actions: RuntimeActionPort;
  pluginTools: RuntimePluginToolPort;
  callLedger: RuntimeToolCallLedger;
}): PromptCapabilityToolExecutor {
  async function retrieval(
    capability: PromptCapabilityBinding,
    descriptor: CompiledRunToolDescriptor,
    value: unknown,
  ): Promise<unknown> {
    const scope = await options.retrievalScope.resolve(capability);
    const invocation = buildRuntimeRetrievalAbi(scope.dial).parse(
      descriptor.name as
        | "list_company_issues"
        | "list_sub_issues"
        | "read_issue_comments"
        | "read_issue_agent_run",
      value,
    );
    switch (invocation.name) {
      case "list_company_issues": {
        return options.retrieval.listCompanyIssues(scope, {
          filters: invocation.filters,
          cursor: invocation.cursor,
        });
      }
      case "list_sub_issues":
        return options.retrieval.listSubIssues(scope, {
          issueId: invocation.issueId,
          cursor: invocation.cursor,
        });
      case "read_issue_comments":
        return options.retrieval.readIssueComments(scope, {
          issueId: invocation.issueId,
          cursor: invocation.cursor,
        });
      case "read_issue_agent_run":
        return options.retrieval.readIssueAgentRun(scope, {
          runId: invocation.runId,
          cursor: invocation.cursor,
        });
    }
  }

  const action: Record<
    Exclude<
      PaperclipRuntimeToolName,
      | "list_company_issues"
      | "list_sub_issues"
      | "read_issue_comments"
      | "read_issue_agent_run"
    >,
    (input: RuntimeActionInvocation) => Promise<unknown>
  > = {
    issue_create: options.actions.issueCreate.bind(options.actions),
    issue_assign: options.actions.issueAssign.bind(options.actions),
    issue_update: options.actions.issueUpdate.bind(options.actions),
    mention_agent: options.actions.mentionAgent.bind(options.actions),
    mention_board: options.actions.mentionBoard.bind(options.actions),
    agent_hire: options.actions.agentHire.bind(options.actions),
    agent_configure: options.actions.agentConfigure.bind(options.actions),
  };

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
      if (claim.state === "executing") {
        throw new RuntimeToolCallInProgress();
      }
      if (claim.state === "failed") {
        const replayed = new Error(claim.error.message);
        replayed.name = claim.error.name;
        if (claim.error.code) {
          Object.defineProperty(replayed, "code", {
            configurable: true,
            enumerable: true,
            value: claim.error.code,
          });
        }
        for (const [key, value] of Object.entries({
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
        // A compiled descriptor is re-resolved for every call. Validate
        // against its server-only canonical parser before dispatch so a
        // provider cannot treat tools/list as advisory and submit a stale or
        // forged catalog target.
        const validatedArguments = descriptor.validateArguments
          ? descriptor.validateArguments(args)
          : args;
        const mentionTargetAgentId = descriptor.name === "mention_agent"
          ? validatedMentionTarget(validatedArguments)
          : null;
        await options.callLedger.classify(
          mentionTargetAgentId
            ? {
                capability,
                id: claim.id,
                ingressOrdinal,
                classification: "validated_mention",
                targetAgentId: mentionTargetAgentId,
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
        if (
          descriptor.name === "list_company_issues" ||
          descriptor.name === "list_sub_issues" ||
          descriptor.name === "read_issue_comments" ||
          descriptor.name === "read_issue_agent_run"
        ) {
          result = await retrieval(capability, descriptor, validatedArguments);
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
        } else {
          const handler = action[descriptor.name as keyof typeof action];
          if (!handler) {
            throw new RuntimeInterfaceConflict(
              `Unknown Paperclip action ${descriptor.name}`,
            );
          }
          result = await handler({
            capability,
            invocationId: invocationId(capability, callIdentity),
            runInterfaceToolCallId: claim.id,
            ingressOrdinal,
            arguments: record(validatedArguments),
            async commitMentionAction(transaction, result) {
              if (
                descriptor.name !== "mention_agent" &&
                descriptor.name !== "mention_board"
              ) {
                throw new RuntimeToolCallIdentityConflict(
                  "Only a canonical mention can commit through the mention action boundary",
                );
              }
              const committed = await options.callLedger.commitMentionAction({
                transaction,
                capability,
                id: claim.id,
                ingressOrdinal,
                toolName: descriptor.name,
                targetAgentId: mentionTargetAgentId,
                result,
              });
              mentionActionCommitted = true;
              return committed;
            },
          });
        }
        if (
          descriptor.name === "mention_agent" ||
          descriptor.name === "mention_board"
        ) {
          if (!mentionActionCommitted) {
            throw new RuntimeToolCallIdentityConflict(
              "Canonical mention returned without its atomic ledger commitment",
            );
          }
        } else {
          await options.callLedger.complete({
            capability,
            id: claim.id,
            result,
          });
        }
        return { source: descriptor.source, value: result };
      } catch (error) {
        await options.callLedger.fail({
          capability,
          id: claim.id,
          error,
        });
        throw error;
      }
    },
  };
}
