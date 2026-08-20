import { logActivity } from "./activity-log.js";
import { listCompanyAgentGraphDescendants } from "./agent-org-graph-lock.js";
import { publishBoardCommentCreated } from "./plugin-domain-event-publisher.js";
import {
  type AgentManagedToolCommand,
  type BoardManagedToolCommand,
} from "./paperclip-managed-tool-registry.js";
import { RuntimeToolUnavailable } from "./runtime-tool-errors.js";
import {
  PaperclipManagedToolError,
  agentRunManagedActionInvocation,
  toolInvocationKey,
} from "./paperclip-managed-tool-routing-contracts.js";
import type {
  PaperclipManagedToolRouterContext,
  AgentRunToolAuthority,
  BoardUserToolAuthority,
} from "./paperclip-managed-tool-router.js";
import { buildPaperclipManagedToolRouterPaperclipManagedBoardTools } from "./paperclip-managed-board-tools.js";

export function buildPaperclipManagedToolRouterPaperclipManagedAuthorityExecution(
  scope: PaperclipManagedToolRouterContext &
    ReturnType<typeof buildPaperclipManagedToolRouterPaperclipManagedBoardTools>,
) {
  const { dependencies, tasks, agents, runtimeAgents, taskInBoardScope, agentInBoardScope } = scope;

  function executeAgentRun(
    command: AgentManagedToolCommand,
    authority: AgentRunToolAuthority,
  ): Promise<unknown> {
    switch (command.name) {
      case "task_create":
        return dependencies.agentRunActions.taskCreate(agentRunManagedActionInvocation(command, authority));
      case "task_assign":
        return dependencies.agentRunActions.taskAssign(agentRunManagedActionInvocation(command, authority));
      case "task_update":
        return dependencies.agentRunActions.taskUpdate(agentRunManagedActionInvocation(command, authority));
      case "mention_agent":
        return dependencies.agentRunActions.mentionAgent(agentRunManagedActionInvocation(command, authority));
      case "mention_board":
        return dependencies.agentRunActions.mentionBoard(agentRunManagedActionInvocation(command, authority));
      case "agent_hire":
        return dependencies.agentRunActions.agentHire(agentRunManagedActionInvocation(command, authority));
      case "agent_configure":
        return dependencies.agentRunActions.agentConfigure(
          agentRunManagedActionInvocation(command, authority),
        );
      case "list_agents":
        return dependencies.agentRunActions.listAgents(agentRunManagedActionInvocation(command, authority));
      case "agent_read":
        return dependencies.agentRunActions.agentRead(agentRunManagedActionInvocation(command, authority));
      default:
        throw new RuntimeToolUnavailable(command.name);
    }
  }

  async function executeBoardUser(
    command: BoardManagedToolCommand,
    authority: BoardUserToolAuthority,
  ): Promise<unknown> {
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
          executionRefId: result.ref?.id ?? null,
          auditId: result.auditId,
          retried: result.retried,
        };
      }
      case "task_update": {
        const existing = await taskInBoardScope(command.companyId, command.taskId);
        const lifecycle = await dependencies.ordinaryTasks().commitOwnerFormUpdate(
          existing.id,
          { message: command.message, status: command.status },
          {
            kind: "board",
            companyId: command.companyId,
            actorUserId: authority.userId,
            recipient: command.recipient,
            gatewayInvocationId: toolInvocationKey({
              authority,
              name: command.name,
              payload: command,
            }),
          },
        );
        if (!lifecycle.retried) {
          await publishBoardCommentCreated(dependencies.pluginDomainEvents, {
            companyId: command.companyId,
            taskId: existing.id,
            commentId: lifecycle.comment.id,
            actorUserId: authority.userId,
          });
        }
        return lifecycle;
      }
      case "mention_agent": {
        const task = await taskInBoardScope(command.companyId, command.taskId);
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
        const comment = await tasks.getBoardComment(command.companyId, command.taskId, result.comment.id);
        if (!comment) {
          throw new PaperclipManagedToolError(
            "comment_projection_missing",
            "Board mention projection is missing after commit",
          );
        }
        if (!result.retried) {
          await publishBoardCommentCreated(dependencies.pluginDomainEvents, {
            companyId: command.companyId,
            taskId: command.taskId,
            commentId: comment.id,
            actorUserId: authority.userId,
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
        const agent = await agentInBoardScope(command.companyId, result.agentId);
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
          throw new PaperclipManagedToolError("agent_not_found", "Agent not found");
        }
        return {
          agents: [root, ...listCompanyAgentGraphDescendants(root.id, companyAgents)],
        };
      }
      case "agent_read": {
        const agent = await agentInBoardScope(command.companyId, command.agentId);
        const configuration = await runtimeAgents.get({
          companyId: command.companyId,
          targetAgentId: command.agentId,
        });
        return { agent, configuration };
      }
      default:
        throw new PaperclipManagedToolError("tool_unavailable", "Paperclip managed tool is unavailable");
    }
  }

  return { executeAgentRun, executeBoardUser };
}
