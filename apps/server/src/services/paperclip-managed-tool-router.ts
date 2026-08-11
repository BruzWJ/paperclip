import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { AGENT_CONTEXT_GRANT_KEYS, validationDetails } from "@paperclipai/shared";
import { z } from "zod";
import type { BoardKeyActor } from "../http/request-actor.js";
import { logActivity } from "./activity-log.js";
import { listCompanyAgentGraphDescendants } from "./agent-org-graph-lock.js";
import { agentService } from "./agents.js";
import type { ContextDial } from "./context-dial-resolver.js";
import {
  ContextRetrievalDenied,
  ContextRetrievalInvalidCursor,
  type ContextRetrievalScope,
  type ContextRetrievalService,
} from "./context-retrieval.js";
import { taskService } from "./tasks.js";
import {
  OrdinaryTaskRuntimeRejected,
  type OrdinaryTaskRuntime,
} from "./ordinary-task-runtime.js";
import {
  isPaperclipContextToolName,
  type PaperclipManagedToolCommand,
  type PaperclipManagedToolCommandFor,
} from "./paperclip-managed-tool-registry.js";
import type { PluginDomainEventPublisher } from "./plugin-domain-event-publisher.js";
import type { PromptCapabilityBinding } from "./prompt-capability-gateway.js";
import {
  RuntimeAgentConfigurationConflict,
  RuntimeAgentConfigurationDenied,
  RuntimeAgentConfigurationInvalid,
  createRuntimeAgentConfigurationService,
} from "./runtime-agent-configuration.js";
import type { RuntimeToolCallTransaction } from "./runtime-tool-call-ledger.js";
import { canonicalTaskSessionJson } from "./task-session/store.js";

export interface AgentRunToolAuthority {
  kind: "agent_run";
  capability: PromptCapabilityBinding;
  invocation: {
    id: string;
    runInterfaceToolCallId: string;
    ingressOrdinal: number;
    commitMentionAction<T>(
      transaction: RuntimeToolCallTransaction,
      result: T,
    ): Promise<T>;
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

export type PaperclipToolAuthority =
  | AgentRunToolAuthority
  | BoardUserToolAuthority;

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

function assertCompanyScope(
  authority: PaperclipToolAuthority,
  companyId: string,
): void {
  const authorized = authority.kind === "board_user"
    ? authority.companyIds.includes(companyId)
    : authority.capability.companyId === companyId;
  if (!authorized) {
    throw new PaperclipManagedToolError(
      "company_not_found",
      "Company not found",
    );
  }
}

function toolInvocationKey(input: {
  authority: BoardUserToolAuthority;
  name: string;
  payload: unknown;
  suffix?: string;
}): string {
  const digest = createHash("sha256")
    .update(canonicalTaskSessionJson({
      principal: {
        credentialId: input.authority.credentialId,
        userId: input.authority.userId,
        requestId: input.authority.requestId,
      },
      name: input.name,
      payload: input.payload,
      suffix: input.suffix ?? null,
    }))
    .digest("hex");
  return `paperclip-tool:${input.name}:${digest}`;
}

class PaperclipManagedToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PaperclipManagedToolError";
  }
}

type AgentRunManagedActionName = Exclude<
  PaperclipManagedToolCommand["name"],
  | "list_company_tasks"
  | "list_sub_tasks"
  | "read_task_comments"
  | "read_task_agent_run"
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

export function agentRunManagedActionInvocation<
  Name extends AgentRunManagedActionName,
>(
  command: PaperclipManagedToolCommandFor<Name>,
  authority: AgentRunToolAuthority,
): AgentRunManagedActionInvocation<Name> {
  return { command, authority };
}

export interface PaperclipManagedToolRouteContext {
  authority: PaperclipToolAuthority;
  /** Needed only when a compiled ACPX context reader is invoked. */
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
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: "invalid_arguments",
      message: validationDetails(error).map((detail) =>
        `${detail.path.length ? `${detail.path.join(".")}: ` : ""}${detail.message}`
      ).join("; "),
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
    message: error instanceof Error
      ? error.message
      : "Paperclip managed tool failed",
  };
}

const FULL_BOARD_CONTEXT_DIAL = Object.freeze(Object.fromEntries(
  AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, true]),
)) as ContextDial;

function boardScope(companyId: string, activeTaskId: string) {
  return { companyId, activeTaskId, dial: FULL_BOARD_CONTEXT_DIAL };
}

/**
 * The one concrete managed-tool router. Board MCP supplies raw public input;
 * ACPX supplies a descriptor-normalized command. Both paths execute the same
 * command switch and share the same lower domain services.
 */
export function createPaperclipManagedToolRouter(
  dependencies: PaperclipManagedToolRouterDependencies,
): PaperclipManagedToolRouter {
  const tasks = taskService(dependencies.db);
  const agents = agentService(dependencies.db);
  const runtimeAgents = createRuntimeAgentConfigurationService(dependencies.db);

  async function taskInBoardScope(companyId: string, taskId: string) {
    const task = await tasks.getById(taskId);
    if (!task || task.companyId !== companyId) {
      throw new PaperclipManagedToolError("task_not_found", "Task not found");
    }
    return task;
  }

  async function agentInBoardScope(companyId: string, agentId: string) {
    const agent = await agents.getById(agentId);
    if (!agent || agent.companyId !== companyId) {
      throw new PaperclipManagedToolError("agent_not_found", "Agent not found");
    }
    return agent;
  }

  async function publishBoardComment(
    authority: BoardUserToolAuthority,
    input: { companyId: string; taskId: string; commentId: string },
  ) {
    await dependencies.pluginDomainEvents.publish({
      eventId: input.commentId,
      eventType: "task.board.comment.created",
      occurredAt: new Date().toISOString(),
      actorId: authority.userId,
      actorType: "user",
      entityId: input.commentId,
      entityType: "task_comment",
      companyId: input.companyId,
      payload: input,
    });
  }

  async function boardComment(
    command: PaperclipManagedToolCommandFor<"task_update">,
    authority: BoardUserToolAuthority,
    message: string,
  ) {
    const result = await dependencies.ordinaryTasks().userComment({
      companyId: command.companyId,
      taskId: command.taskId,
      actorUserId: authority.userId,
      message,
      replyToCommentId: command.replyToCommentId ?? null,
      idempotencyKey: toolInvocationKey({
        authority,
        name: command.name,
        payload: command,
        suffix: "comment",
      }),
    });
    const comment = await tasks.getBoardComment(
      command.companyId,
      command.taskId,
      result.comment.id,
    );
    if (!comment) {
      throw new PaperclipManagedToolError(
        "comment_projection_missing",
        "Board comment projection is missing after commit",
      );
    }
    if (!result.retried) {
      await publishBoardComment(authority, {
        companyId: command.companyId,
        taskId: command.taskId,
        commentId: comment.id,
      });
    }
    return {
      task: result.task,
      comment,
      executionRefId: result.ref?.id ?? null,
      retried: result.retried,
    };
  }

  function boardLifecycleUpdate(
    command: PaperclipManagedToolCommandFor<"task_update">,
  ): Parameters<OrdinaryTaskRuntime["commitOwnerFormUpdate"]>[1] | null {
    if (command.status === undefined) return null;
    const message = command.message!;
    if (command.status === "done" || command.status === "cancelled") {
      return {
        message,
        status: command.status,
        ...(Object.hasOwn(command, "structuredResult")
          ? { structuredResult: command.structuredResult }
          : {}),
      };
    }
    return { message, status: command.status };
  }

  function requireRuntimeScope(scope: ContextRetrievalScope | null) {
    if (!scope) {
      throw new PaperclipManagedToolError(
        "runtime_context_scope_unavailable",
        "The active execution has no context retrieval scope",
      );
    }
    return scope;
  }

  function executeAgentRun(
    command: PaperclipManagedToolCommand,
    authority: AgentRunToolAuthority,
  ): Promise<unknown> {
    switch (command.name) {
      case "task_create":
        return dependencies.agentRunActions.taskCreate(
          agentRunManagedActionInvocation(command, authority),
        );
      case "task_assign":
        return dependencies.agentRunActions.taskAssign(
          agentRunManagedActionInvocation(command, authority),
        );
      case "task_update":
        return dependencies.agentRunActions.taskUpdate(
          agentRunManagedActionInvocation(command, authority),
        );
      case "mention_agent":
        return dependencies.agentRunActions.mentionAgent(
          agentRunManagedActionInvocation(command, authority),
        );
      case "mention_board":
        return dependencies.agentRunActions.mentionBoard(
          agentRunManagedActionInvocation(command, authority),
        );
      case "agent_hire":
        return dependencies.agentRunActions.agentHire(
          agentRunManagedActionInvocation(command, authority),
        );
      case "agent_configure":
        return dependencies.agentRunActions.agentConfigure(
          agentRunManagedActionInvocation(command, authority),
        );
      case "list_agents":
        return dependencies.agentRunActions.listAgents(
          agentRunManagedActionInvocation(command, authority),
        );
      case "agent_read":
        return dependencies.agentRunActions.agentRead(
          agentRunManagedActionInvocation(command, authority),
        );
      default:
        throw new PaperclipManagedToolError(
          "tool_unavailable",
          `Paperclip managed tool is unavailable: ${command.name}`,
        );
    }
  }

  async function executeCommand(
    command: PaperclipManagedToolCommand,
    authority: PaperclipToolAuthority,
    runtimeScope: ContextRetrievalScope | null,
  ): Promise<unknown> {
    if (command.name === "list_company_tasks") {
      assertCompanyScope(authority, command.companyId);
      return dependencies.retrieval().listCompanyTasks(
        authority.kind === "board_user"
          ? boardScope(command.companyId, command.companyId)
          : requireRuntimeScope(runtimeScope),
        {
          filters: command.filters,
          cursor: command.cursor,
          limit: command.limit,
        },
      );
    }
    if (command.name === "list_sub_tasks") {
      assertCompanyScope(authority, command.companyId);
      if (authority.kind === "board_user") {
        await taskInBoardScope(command.companyId, command.taskId);
      }
      return dependencies.retrieval().listSubTasks(
        authority.kind === "board_user"
          ? boardScope(command.companyId, command.taskId)
          : requireRuntimeScope(runtimeScope),
        {
          taskId: command.taskId,
          cursor: command.cursor,
          limit: command.limit,
        },
      );
    }
    if (command.name === "read_task_comments") {
      assertCompanyScope(authority, command.companyId);
      if (authority.kind === "board_user") {
        await taskInBoardScope(command.companyId, command.taskId);
      }
      return dependencies.retrieval().readTaskComments(
        authority.kind === "board_user"
          ? boardScope(command.companyId, command.taskId)
          : requireRuntimeScope(runtimeScope),
        {
          taskId: command.taskId,
          cursor: command.cursor,
          limit: command.limit,
        },
      );
    }
    if (command.name === "read_task_agent_run") {
      assertCompanyScope(authority, command.companyId);
      return dependencies.retrieval().readTaskAgentRun(
        authority.kind === "board_user"
          ? boardScope(command.companyId, command.companyId)
          : requireRuntimeScope(runtimeScope),
        { runId: command.runId, cursor: command.cursor },
      );
    }
    if (authority.kind === "agent_run") {
      return executeAgentRun(command, authority);
    }

    assertCompanyScope(authority, command.companyId);
    switch (command.name) {
      case "task_create": {
        const result = await dependencies.ordinaryTasks().create({
          ...command,
          creator: { kind: "user/board", userId: authority.userId },
          idempotencyKey: toolInvocationKey({
            authority,
            name: command.name,
            payload: command,
          }),
          sourceKind: "task_request",
        });
        if (!result.retried) {
          await logActivity(dependencies.db, {
            companyId: command.companyId,
            actorType: "user",
            actorId: authority.userId,
            action: "task.created",
            entityType: "task",
            entityId: result.task.id,
            details: {
              source: "board_mcp",
              identifier: result.task.identifier,
              ownerAgentId: result.task.ownerAgentId,
              executionRefId: result.ref.id,
            },
          });
        }
        return {
          task: result.task,
          executionRefId: result.ref.id,
          retried: result.retried,
        };
      }
      case "task_assign": {
        const result = await dependencies.ordinaryTasks().boardReassign({
          companyId: command.companyId,
          taskId: command.taskId,
          ownerAgentId: command.ownerAgentId,
          actorUserId: authority.userId,
          idempotencyKey: toolInvocationKey({
            authority,
            name: command.name,
            payload: command,
          }),
        });
        return {
          task: result.task,
          executionRefId: result.ref.id,
          auditId: result.auditId,
          retried: result.retried,
        };
      }
      case "task_update": {
        const lifecycleUpdate = boardLifecycleUpdate(command);
        const existing = await taskInBoardScope(
          command.companyId,
          command.taskId,
        );
        const result: Record<string, unknown> = { taskId: existing.id };
        if (command.reopen) {
          result.reopen = await dependencies.ordinaryTasks().boardReopen({
            companyId: command.companyId,
            taskId: command.taskId,
            actorUserId: authority.userId,
            reason: command.message!,
            idempotencyKey: toolInvocationKey({
              authority,
              name: command.name,
              payload: command,
              suffix: "reopen",
            }),
          });
        } else if (lifecycleUpdate) {
          const lifecycle = await dependencies.ordinaryTasks()
            .commitOwnerFormUpdate(command.taskId, lifecycleUpdate, {
              kind: "board",
              companyId: command.companyId,
              actorUserId: authority.userId,
              gatewayInvocationId: toolInvocationKey({
                authority,
                name: command.name,
                payload: command,
                suffix: "lifecycle",
              }),
            });
          result.lifecycle = lifecycle;
          if (!lifecycle.retried) {
            await publishBoardComment(authority, {
              companyId: command.companyId,
              taskId: command.taskId,
              commentId: lifecycle.comment.id,
            });
          }
        } else if (command.message !== undefined) {
          result.comment = await boardComment(command, authority, command.message);
        }
        if (command.title !== undefined) {
          const task = await tasks.updateTitle(existing.id, command.title);
          if (!task) {
            throw new PaperclipManagedToolError(
              "task_not_found",
              "Task not found",
            );
          }
          await logActivity(dependencies.db, {
            companyId: command.companyId,
            actorType: "user",
            actorId: authority.userId,
            action: "task.title_updated",
            entityType: "task",
            entityId: task.id,
            details: {
              source: "board_mcp",
              identifier: task.identifier,
              title: task.title,
              _previous: { title: existing.title },
            },
          });
          result.task = task;
        }
        return result;
      }
      case "mention_agent": {
        const task = await taskInBoardScope(
          command.companyId,
          command.taskId,
        );
        const result = await dependencies.ordinaryTasks().userComment({
          companyId: command.companyId,
          taskId: command.taskId,
          actorUserId: authority.userId,
          message: command.message,
          mention: {
            targetAgentId: command.agentId,
            ownershipEpoch: task.ownershipEpoch,
          },
          idempotencyKey: toolInvocationKey({
            authority,
            name: command.name,
            payload: command,
          }),
        });
        const comment = await tasks.getBoardComment(
          command.companyId,
          command.taskId,
          result.comment.id,
        );
        if (!comment) {
          throw new PaperclipManagedToolError(
            "comment_projection_missing",
            "Board mention projection is missing after commit",
          );
        }
        if (!result.retried) {
          await publishBoardComment(authority, {
            companyId: command.companyId,
            taskId: command.taskId,
            commentId: comment.id,
          });
        }
        return {
          task: result.task,
          comment,
          executionRefId: result.ref?.id ?? null,
          retried: result.retried,
        };
      }
      case "agent_hire": {
        const result = await runtimeAgents.create({
          companyId: command.companyId,
          actor: {
            kind: "board",
            actorId: authority.userId,
            authorization: {
              type: "board",
              userId: authority.userId,
              source: "board_mcp",
            },
          },
          source: "board",
          configuration: command.configuration,
          idempotencyKey: toolInvocationKey({
            authority,
            name: command.name,
            payload: command,
          }),
        });
        const agent = await agentInBoardScope(
          command.companyId,
          result.agentId,
        );
        return {
          agent,
          configuration: result.configuration,
          auditId: result.auditId,
          retried: result.retried,
        };
      }
      case "agent_configure": {
        const result = await runtimeAgents.update({
          companyId: command.companyId,
          targetAgentId: command.agentId,
          actor: {
            kind: "board",
            actorId: authority.userId,
            authorization: {
              type: "board",
              userId: authority.userId,
              source: "board_mcp",
            },
          },
          source: "board",
          configuration: command.configuration,
          idempotencyKey: toolInvocationKey({
            authority,
            name: command.name,
            payload: command,
          }),
        });
        return {
          agentId: result.agentId,
          configuration: result.configuration,
          auditId: result.auditId,
          retried: result.retried,
        };
      }
      case "list_agents": {
        const companyAgents = await agents.list(command.companyId, {
          includeTerminated: command.includeTerminated ?? false,
        });
        if (!command.agentId) return { agents: companyAgents };
        const root = companyAgents.find((agent) => agent.id === command.agentId);
        if (!root) {
          throw new PaperclipManagedToolError(
            "agent_not_found",
            "Agent not found",
          );
        }
        return {
          agents: [
            root,
            ...listCompanyAgentGraphDescendants(root.id, companyAgents),
          ],
        };
      }
      case "agent_read": {
        const agent = await agentInBoardScope(
          command.companyId,
          command.agentId,
        );
        const configuration = await runtimeAgents.get({
          companyId: command.companyId,
          targetAgentId: command.agentId,
        });
        return { agent, configuration };
      }
      case "mention_board":
          throw new PaperclipManagedToolError(
            "tool_unavailable",
            `Paperclip managed tool is unavailable: ${command.name}`,
          );
    }
  }

  async function routeExecution(
    command: PaperclipManagedToolCommand,
    context: PaperclipManagedToolRouteContext,
  ): Promise<unknown> {
    const runtimeScope =
      context.authority.kind === "agent_run" &&
        isPaperclipContextToolName(command.name)
        ? await context.resolveRuntimeScope?.() ?? null
        : null;
    return executeCommand(command, context.authority, runtimeScope);
  }

  return { routeExecution };
}
