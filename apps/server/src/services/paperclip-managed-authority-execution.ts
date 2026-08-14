import { logActivity } from "./activity-log.js";
import { listCompanyAgentGraphDescendants } from "./agent-org-graph-lock.js";
import { type PaperclipManagedToolCommand } from "./paperclip-managed-tool-registry.js";
import { RuntimeToolUnavailable } from "./runtime-tool-errors.js";
import {
  PaperclipManagedToolError,
  agentRunManagedActionInvocation,
  assertCompanyScope,
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
  const {
    dependencies,
    tasks,
    agents,
    runtimeAgents,
    taskInBoardScope,
    agentInBoardScope,
    publishBoardComment,
    boardComment,
    boardLifecycleUpdate,
  } = scope;

  function executeAgentRun(
    command: PaperclipManagedToolCommand,
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
    command: PaperclipManagedToolCommand,
    authority: BoardUserToolAuthority,
  ): Promise<unknown> {
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
        const existing = await taskInBoardScope(command.companyId, command.taskId);
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
          const lifecycle = await dependencies
            .ordinaryTasks()
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
            throw new PaperclipManagedToolError("task_not_found", "Task not found");
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
      case "mention_board":
        throw new PaperclipManagedToolError(
          "tool_unavailable",
          `Paperclip managed tool is unavailable: ${command.name}`,
        );
      default:
        throw new PaperclipManagedToolError("tool_unavailable", "Paperclip managed tool is unavailable");
    }
  }

  return { executeAgentRun, executeBoardUser };
}
