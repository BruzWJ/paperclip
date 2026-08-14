import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { AGENT_CONTEXT_GRANT_KEYS, validationDetails } from "@paperclipai/shared";
import { z } from "zod";
import type { BoardKeyActor } from "../http/request-actor.js";
import type { ContextDial } from "./context-dial-resolver.js";
import {
  type ContextRetrievalScope,
  type ContextRetrievalService,
  ContextRetrievalDenied,
  ContextRetrievalInvalidCursor,
} from "./context-retrieval.js";
import { OrdinaryTaskRuntimeRejected, type OrdinaryTaskRuntime } from "./ordinary-task-runtime.js";
import {
  type PaperclipManagedToolCommand,
  type PaperclipManagedToolCommandFor,
} from "./paperclip-managed-tool-registry.js";
import type { PromptCapabilityBinding } from "./prompt-capability-gateway.js";
import type { PluginDomainEventPublisher } from "./plugin-domain-event-publisher.js";
import {
  RuntimeAgentConfigurationConflict,
  RuntimeAgentConfigurationDenied,
  RuntimeAgentConfigurationInvalid,
} from "./runtime-agent-configuration.js";
import type { RuntimeToolCallTransaction } from "./runtime-tool-call-ledger.js";
import { RuntimeInterfaceConflict } from "./runtime-tool-errors.js";
import { canonicalTaskSessionJson } from "./task-session/store.js";

export interface AgentRunToolAuthority {
  kind: "agent_run";
  capability: PromptCapabilityBinding;
  invocation: {
    id: string;
    runInterfaceToolCallId: string;
    ingressOrdinal: number;
    commitMentionAction<T>(transaction: RuntimeToolCallTransaction, result: T): Promise<T>;
  };
}

export interface BoardUserToolAuthority {
  kind: "board_user";
  userId: string;
  credentialId: string;
  companyIds: readonly string[];
  companies: readonly {
    id: string;
    name: string;
    membershipRole: string | null;
  }[];
  requestId: string | number | null;
}

export type PaperclipToolAuthority = AgentRunToolAuthority | BoardUserToolAuthority;

export function boardToolAuthority(input: {
  actor: BoardKeyActor;
  requestId: string | number | null;
  companies: BoardUserToolAuthority["companies"];
}): BoardUserToolAuthority {
  return {
    kind: "board_user",
    userId: input.actor.userId,
    credentialId: input.actor.keyId,
    companyIds: input.actor.companyIds,
    companies: input.companies,
    requestId: input.requestId,
  };
}

export class PaperclipManagedToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PaperclipManagedToolError";
  }
}

export function assertCompanyScope(authority: PaperclipToolAuthority, companyId: string): void {
  const authorized =
    authority.kind === "board_user"
      ? authority.companyIds.includes(companyId)
      : authority.capability.companyId === companyId;
  if (!authorized) {
    throw new PaperclipManagedToolError("company_not_found", "Company not found");
  }
}

export function toolInvocationKey(input: {
  authority: BoardUserToolAuthority;
  name: string;
  payload: unknown;
  suffix?: string;
}): string {
  const digest = createHash("sha256")
    .update(
      canonicalTaskSessionJson({
        principal: {
          credentialId: input.authority.credentialId,
          userId: input.authority.userId,
          requestId: input.authority.requestId,
        },
        name: input.name,
        payload: input.payload,
        suffix: input.suffix ?? null,
      }),
    )
    .digest("hex");
  return `paperclip-tool:${input.name}:${digest}`;
}

export type AgentRunManagedActionName = Exclude<
  PaperclipManagedToolCommand["name"],
  "list_company_tasks" | "list_sub_tasks" | "read_task_comments" | "read_task_agent_run"
>;

export interface AgentRunManagedActionInvocation<
  Name extends AgentRunManagedActionName = AgentRunManagedActionName,
> {
  command: PaperclipManagedToolCommandFor<Name>;
  authority: AgentRunToolAuthority;
}

export interface AgentRunManagedActionPort {
  taskCreate(input: AgentRunManagedActionInvocation<"task_create">): Promise<unknown>;
  taskAssign(input: AgentRunManagedActionInvocation<"task_assign">): Promise<unknown>;
  taskUpdate(input: AgentRunManagedActionInvocation<"task_update">): Promise<unknown>;
  mentionAgent(input: AgentRunManagedActionInvocation<"mention_agent">): Promise<unknown>;
  mentionBoard(input: AgentRunManagedActionInvocation<"mention_board">): Promise<unknown>;
  agentHire(input: AgentRunManagedActionInvocation<"agent_hire">): Promise<unknown>;
  agentConfigure(input: AgentRunManagedActionInvocation<"agent_configure">): Promise<unknown>;
  listAgents(input: AgentRunManagedActionInvocation<"list_agents">): Promise<unknown>;
  agentRead(input: AgentRunManagedActionInvocation<"agent_read">): Promise<unknown>;
}

export function agentRunManagedActionInvocation<Name extends AgentRunManagedActionName>(
  command: PaperclipManagedToolCommandFor<Name>,
  authority: AgentRunToolAuthority,
): AgentRunManagedActionInvocation<Name> {
  return { command, authority };
}

export interface PaperclipManagedToolRouteContext {
  authority: PaperclipToolAuthority;
  resolveRuntimeScope?: () => Promise<ContextRetrievalScope>;
}

export interface PaperclipManagedToolRouter {
  routeExecution(
    command: PaperclipManagedToolCommand,
    context: PaperclipManagedToolRouteContext,
  ): Promise<unknown>;
}

export interface PaperclipManagedToolRouterDependencies {
  db: Db;
  agentRunActions: AgentRunManagedActionPort;
  ordinaryTasks(): OrdinaryTaskRuntime;
  retrieval(): ContextRetrievalService;
  pluginDomainEvents: PluginDomainEventPublisher;
}

export function paperclipManagedToolPublicError(error: unknown) {
  if (error instanceof PaperclipManagedToolError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof z.ZodError) {
    return {
      code: "invalid_arguments",
      message: validationDetails(error)
        .map((detail) => `${detail.path.length ? `${detail.path.join(".")}: ` : ""}${detail.message}`)
        .join("; "),
    };
  }
  if (
    error instanceof ContextRetrievalDenied ||
    error instanceof ContextRetrievalInvalidCursor ||
    error instanceof RuntimeAgentConfigurationInvalid ||
    error instanceof RuntimeAgentConfigurationDenied ||
    error instanceof RuntimeAgentConfigurationConflict
  ) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof OrdinaryTaskRuntimeRejected) {
    return { code: error.reason, message: error.message };
  }
  return {
    code: "paperclip_managed_tool_failed",
    message: error instanceof Error ? error.message : "Paperclip managed tool failed",
  };
}

export const FULL_BOARD_CONTEXT_DIAL = Object.freeze(
  Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, true])),
) as ContextDial;

export function boardScope(companyId: string, activeTaskId: string) {
  return { companyId, activeTaskId, dial: FULL_BOARD_CONTEXT_DIAL };
}

export function requireRuntimeScope(scope: ContextRetrievalScope | null) {
  if (!scope) {
    throw new RuntimeInterfaceConflict("The active execution has no context retrieval scope");
  }
  return scope;
}

export function assertCommandScope(
  command: PaperclipManagedToolCommand,
  authority: AgentRunToolAuthority,
): void {
  if (command.companyId !== authority.capability.companyId) {
    throw new RuntimeInterfaceConflict("The normalized managed-tool command escaped its run company");
  }
}
