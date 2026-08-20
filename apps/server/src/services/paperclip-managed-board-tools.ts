import { PaperclipManagedToolError } from "./paperclip-managed-tool-routing-contracts.js";
import { type PaperclipManagedToolRouterContext } from "./paperclip-managed-tool-router.js";

export function buildPaperclipManagedToolRouterPaperclipManagedBoardTools(
  scope: PaperclipManagedToolRouterContext,
) {
  const { tasks, agents } = scope;

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

  return {
    taskInBoardScope,
    agentInBoardScope,
  };
}
