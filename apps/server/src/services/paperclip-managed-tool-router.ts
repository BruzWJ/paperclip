import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { AGENT_CONTEXT_GRANT_KEYS } from "@paperclipai/shared";
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
import { issueService } from "./issues.js";
import {
  OrdinaryIssueRuntimeRejected,
  type OrdinaryIssueRuntime,
} from "./ordinary-issue-runtime.js";
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
import { canonicalIssueSessionJson } from "./issue-session/store.js";

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
    .update(canonicalIssueSessionJson({
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
  | "list_company_issues"
  | "list_sub_issues"
  | "read_issue_comments"
  | "read_issue_agent_run"
>;

export interface AgentRunManagedActionInvocation<
  Name extends AgentRunManagedActionName = AgentRunManagedActionName,
> {
  command: PaperclipManagedToolCommandFor<Name>;
  authority: AgentRunToolAuthority;
}

export interface AgentRunManagedActionPort {
  issueCreate(input: AgentRunManagedActionInvocation<"issue_create">): Promise<unknown>;
  issueAssign(input: AgentRunManagedActionInvocation<"issue_assign">): Promise<unknown>;
  issueUpdate(input: AgentRunManagedActionInvocation<"issue_update">): Promise<unknown>;
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
  ordinaryIssues(): OrdinaryIssueRuntime;
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
      message: error.issues.map((issue) =>
        `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`
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
  if (error instanceof OrdinaryIssueRuntimeRejected) {
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

function boardScope(companyId: string, activeIssueId: string) {
  return { companyId, activeIssueId, dial: FULL_BOARD_CONTEXT_DIAL };
}

/**
 * The one concrete managed-tool router. Board MCP supplies raw public input;
 * ACPX supplies a descriptor-normalized command. Both paths execute the same
 * command switch and share the same lower domain services.
 */
export function createPaperclipManagedToolRouter(
  dependencies: PaperclipManagedToolRouterDependencies,
): PaperclipManagedToolRouter {
  const issues = issueService(dependencies.db);
  const agents = agentService(dependencies.db);
  const runtimeAgents = createRuntimeAgentConfigurationService(dependencies.db);

  async function issueInBoardScope(companyId: string, issueId: string) {
    const issue = await issues.getById(issueId);
    if (!issue || issue.companyId !== companyId) {
      throw new PaperclipManagedToolError("issue_not_found", "Issue not found");
    }
    return issue;
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
    input: { companyId: string; issueId: string; commentId: string },
  ) {
    await dependencies.pluginDomainEvents.publish({
      eventId: input.commentId,
      eventType: "issue.board.comment.created",
      occurredAt: new Date().toISOString(),
      actorId: authority.userId,
      actorType: "user",
      entityId: input.commentId,
      entityType: "issue_comment",
      companyId: input.companyId,
      payload: input,
    });
  }

  async function boardComment(
    command: PaperclipManagedToolCommandFor<"issue_update">,
    authority: BoardUserToolAuthority,
    message: string,
  ) {
    const result = await dependencies.ordinaryIssues().userComment({
      companyId: command.companyId,
      issueId: command.issueId,
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
    const comment = await issues.getBoardComment(
      command.companyId,
      command.issueId,
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
        issueId: command.issueId,
        commentId: comment.id,
      });
    }
    return {
      issue: result.issue,
      comment,
      executionRefId: result.ref?.id ?? null,
      retried: result.retried,
    };
  }

  function boardLifecycleUpdate(
    command: PaperclipManagedToolCommandFor<"issue_update">,
  ): Parameters<OrdinaryIssueRuntime["commitOwnerFormUpdate"]>[1] | null {
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
      case "issue_create":
        return dependencies.agentRunActions.issueCreate(
          agentRunManagedActionInvocation(command, authority),
        );
      case "issue_assign":
        return dependencies.agentRunActions.issueAssign(
          agentRunManagedActionInvocation(command, authority),
        );
      case "issue_update":
        return dependencies.agentRunActions.issueUpdate(
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
    if (command.name === "list_company_issues") {
      assertCompanyScope(authority, command.companyId);
      return dependencies.retrieval().listCompanyIssues(
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
    if (command.name === "list_sub_issues") {
      assertCompanyScope(authority, command.companyId);
      if (authority.kind === "board_user") {
        await issueInBoardScope(command.companyId, command.issueId);
      }
      return dependencies.retrieval().listSubIssues(
        authority.kind === "board_user"
          ? boardScope(command.companyId, command.issueId)
          : requireRuntimeScope(runtimeScope),
        {
          issueId: command.issueId,
          cursor: command.cursor,
          limit: command.limit,
        },
      );
    }
    if (command.name === "read_issue_comments") {
      assertCompanyScope(authority, command.companyId);
      if (authority.kind === "board_user") {
        await issueInBoardScope(command.companyId, command.issueId);
      }
      return dependencies.retrieval().readIssueComments(
        authority.kind === "board_user"
          ? boardScope(command.companyId, command.issueId)
          : requireRuntimeScope(runtimeScope),
        {
          issueId: command.issueId,
          cursor: command.cursor,
          limit: command.limit,
        },
      );
    }
    if (command.name === "read_issue_agent_run") {
      assertCompanyScope(authority, command.companyId);
      return dependencies.retrieval().readIssueAgentRun(
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
      case "issue_create": {
        const result = await dependencies.ordinaryIssues().create({
          ...command,
          creator: { kind: "user/board", userId: authority.userId },
          idempotencyKey: toolInvocationKey({
            authority,
            name: command.name,
            payload: command,
          }),
          sourceKind: "issue_request",
        });
        if (!result.retried) {
          await logActivity(dependencies.db, {
            companyId: command.companyId,
            actorType: "user",
            actorId: authority.userId,
            action: "issue.created",
            entityType: "issue",
            entityId: result.issue.id,
            details: {
              source: "board_mcp",
              identifier: result.issue.identifier,
              ownerAgentId: result.issue.ownerAgentId,
              executionRefId: result.ref.id,
            },
          });
        }
        return {
          issue: result.issue,
          executionRefId: result.ref.id,
          retried: result.retried,
        };
      }
      case "issue_assign": {
        const result = await dependencies.ordinaryIssues().boardReassign({
          companyId: command.companyId,
          issueId: command.issueId,
          ownerAgentId: command.ownerAgentId,
          actorUserId: authority.userId,
          idempotencyKey: toolInvocationKey({
            authority,
            name: command.name,
            payload: command,
          }),
        });
        return {
          issue: result.issue,
          executionRefId: result.ref.id,
          auditId: result.auditId,
          retried: result.retried,
        };
      }
      case "issue_update": {
        const lifecycleUpdate = boardLifecycleUpdate(command);
        const existing = await issueInBoardScope(
          command.companyId,
          command.issueId,
        );
        const result: Record<string, unknown> = { issueId: existing.id };
        if (command.reopen) {
          result.reopen = await dependencies.ordinaryIssues().boardReopen({
            companyId: command.companyId,
            issueId: command.issueId,
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
          const lifecycle = await dependencies.ordinaryIssues()
            .commitOwnerFormUpdate(command.issueId, lifecycleUpdate, {
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
              issueId: command.issueId,
              commentId: lifecycle.comment.id,
            });
          }
        } else if (command.message !== undefined) {
          result.comment = await boardComment(command, authority, command.message);
        }
        if (command.title !== undefined) {
          const issue = await issues.updateTitle(existing.id, command.title);
          if (!issue) {
            throw new PaperclipManagedToolError(
              "issue_not_found",
              "Issue not found",
            );
          }
          await logActivity(dependencies.db, {
            companyId: command.companyId,
            actorType: "user",
            actorId: authority.userId,
            action: "issue.title_updated",
            entityType: "issue",
            entityId: issue.id,
            details: {
              source: "board_mcp",
              identifier: issue.identifier,
              title: issue.title,
              _previous: { title: existing.title },
            },
          });
          result.issue = issue;
        }
        return result;
      }
      case "mention_agent": {
        const issue = await issueInBoardScope(
          command.companyId,
          command.issueId,
        );
        const result = await dependencies.ordinaryIssues().userComment({
          companyId: command.companyId,
          issueId: command.issueId,
          actorUserId: authority.userId,
          message: command.message,
          mention: {
            targetAgentId: command.agentId,
            ownershipEpoch: issue.ownershipEpoch,
          },
          idempotencyKey: toolInvocationKey({
            authority,
            name: command.name,
            payload: command,
          }),
        });
        const comment = await issues.getBoardComment(
          command.companyId,
          command.issueId,
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
            issueId: command.issueId,
            commentId: comment.id,
          });
        }
        return {
          issue: result.issue,
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
