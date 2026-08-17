import {
  type PaperclipManagedToolRouter,
  type PaperclipManagedToolRouterDependencies,
  assertCommandScope,
  assertCompanyScope,
  boardScope,
  type PaperclipManagedToolRouteContext,
  requireRuntimeScope,
} from "./paperclip-managed-tool-routing-contracts.js";

import { buildPaperclipManagedToolRouterPaperclipManagedBoardTools } from "./paperclip-managed-board-tools.js";
import { buildPaperclipManagedToolRouterPaperclipManagedAuthorityExecution } from "./paperclip-managed-authority-execution.js";

import {
  isPaperclipContextToolName,
  type PaperclipManagedToolCommand,
} from "./paperclip-managed-tool-registry.js";

import { agentService } from "./agents.js";
import { createRuntimeAgentConfigurationService } from "./runtime-agent-configuration.js";
import { lockRuntimeToolAuthority } from "./runtime-task-action-port-shared-part-3.js";
import { taskService } from "./tasks.js";

export function createPaperclipManagedToolRouterContext(
  dependencies: PaperclipManagedToolRouterDependencies,
) {
  const tasks = taskService(dependencies.db);

  const agents = agentService(dependencies.db);

  const runtimeAgents = createRuntimeAgentConfigurationService(dependencies.db);

  return { dependencies, tasks, agents, runtimeAgents };
}

export type PaperclipManagedToolRouterContext = ReturnType<typeof createPaperclipManagedToolRouterContext>;

export function buildPaperclipManagedToolRouterPaperclipManagedRouteExecution(
  scope: PaperclipManagedToolRouterContext &
    ReturnType<typeof buildPaperclipManagedToolRouterPaperclipManagedBoardTools> &
    ReturnType<typeof buildPaperclipManagedToolRouterPaperclipManagedAuthorityExecution>,
) {
  const { dependencies, taskInBoardScope, executeAgentRun, executeBoardUser } = scope;

  async function routeExecution(
    command: PaperclipManagedToolCommand,
    context: PaperclipManagedToolRouteContext,
  ): Promise<unknown> {
    if (context.authority.kind === "agent_run") {
      assertCommandScope(command, context.authority);
    } else {
      assertCompanyScope(context.authority, command.companyId);
    }
    const agentAuthority = context.authority.kind === "agent_run" ? context.authority : null;
    const runtimeScope =
      agentAuthority && isPaperclipContextToolName(command.name)
        ? await dependencies.db.transaction(async (tx) => {
            const authorized = await lockRuntimeToolAuthority(
              tx,
              agentAuthority.capability,
              command.name,
              new Date(),
            );
            return {
              companyId: agentAuthority.capability.companyId,
              activeTaskId: agentAuthority.capability.taskId,
              dial: authorized.catalog.contextDial,
            };
          })
        : null;

    if (command.name === "list_company_tasks") {
      return dependencies
        .retrieval()
        .listCompanyTasks(
          context.authority.kind === "board_user"
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
      if (context.authority.kind === "board_user") {
        await taskInBoardScope(command.companyId, command.taskId);
      }
      return dependencies
        .retrieval()
        .listSubTasks(
          context.authority.kind === "board_user"
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
      if (context.authority.kind === "board_user") {
        await taskInBoardScope(command.companyId, command.taskId);
      }
      return dependencies
        .retrieval()
        .readTaskComments(
          context.authority.kind === "board_user"
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
      return dependencies
        .retrieval()
        .readTaskAgentRun(
          context.authority.kind === "board_user"
            ? boardScope(command.companyId, command.companyId)
            : requireRuntimeScope(runtimeScope),
          { runId: command.runId, cursor: command.cursor },
        );
    }
    return context.authority.kind === "board_user"
      ? executeBoardUser(command, context.authority)
      : executeAgentRun(command, context.authority);
  }

  return { routeExecution };
}

export function createPaperclipManagedToolRouterMethods1(
  scope: PaperclipManagedToolRouterContext &
    ReturnType<typeof buildPaperclipManagedToolRouterPaperclipManagedBoardTools> &
    ReturnType<typeof buildPaperclipManagedToolRouterPaperclipManagedAuthorityExecution> &
    ReturnType<typeof buildPaperclipManagedToolRouterPaperclipManagedRouteExecution>,
) {
  const { routeExecution } = scope;

  return {
    routeExecution,
  } satisfies Pick<PaperclipManagedToolRouter, "routeExecution">;
}

export {
  type AgentRunToolAuthority,
  type BoardUserToolAuthority,
  type PaperclipToolAuthority,
  type AgentRunManagedActionInvocation,
  type AgentRunManagedActionPort,
  type PaperclipManagedToolRouteContext,
  type PaperclipManagedToolRouter,
  type PaperclipManagedToolRouterDependencies,
  boardToolAuthority,
  agentRunManagedActionInvocation,
  paperclipManagedToolPublicError,
} from "./paperclip-managed-tool-routing-contracts.js";

export function createPaperclipManagedToolRouter(
  dependencies: PaperclipManagedToolRouterDependencies,
): PaperclipManagedToolRouter {
  const context = createPaperclipManagedToolRouterContext(dependencies);
  const helpers1 = buildPaperclipManagedToolRouterPaperclipManagedBoardTools(context);
  const scope1 = { ...context, ...helpers1 };
  const helpers2 = buildPaperclipManagedToolRouterPaperclipManagedAuthorityExecution(scope1);
  const scope2 = { ...scope1, ...helpers2 };
  const helpers3 = buildPaperclipManagedToolRouterPaperclipManagedRouteExecution(scope2);
  const scope3 = { ...scope2, ...helpers3 };
  const scope = scope3;
  const methods1 = createPaperclipManagedToolRouterMethods1(scope);
  return { ...methods1 };
}
