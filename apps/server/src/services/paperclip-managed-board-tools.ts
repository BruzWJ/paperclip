import { type OrdinaryTaskRuntime } from "./ordinary-task-runtime.js";
import { type PaperclipManagedToolCommandFor } from "./paperclip-managed-tool-registry.js";
import {
  type BoardUserToolAuthority,
  PaperclipManagedToolError,
  toolInvocationKey,
} from "./paperclip-managed-tool-routing-contracts.js";
import { type PaperclipManagedToolRouterContext } from "./paperclip-managed-tool-router.js";

export function buildPaperclipManagedToolRouterPaperclipManagedBoardTools(
  scope: PaperclipManagedToolRouterContext,
) {
  const { dependencies, tasks, agents } = scope;

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
    const comment = await tasks.getBoardComment(command.companyId, command.taskId, result.comment.id);
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
        ...(Object.hasOwn(command, "structuredResult") ? { structuredResult: command.structuredResult } : {}),
      };
    }
    return { message, status: command.status };
  }

  return {
    taskInBoardScope,
    agentInBoardScope,
    publishBoardComment,
    boardComment,
    boardLifecycleUpdate,
  };
}
