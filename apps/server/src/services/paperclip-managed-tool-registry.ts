import { runtimeAgentConfigureActionSchema, runtimeAgentHireConfigurationSchema } from "@paperclipai/shared";
import { z } from "zod";
import {
  isPaperclipContextToolName,
  PAPERCLIP_MANAGED_TOOL_METADATA,
  PAPERCLIP_MANAGED_TOOL_NAMES,
  type PaperclipManagedToolName,
} from "./paperclip-managed-tool-definitions.js";
import {
  type PaperclipManagedToolRuntimeProjectionInput,
  type ProjectedPaperclipManagedToolDescriptor,
  projection,
  type RuntimeProjection,
} from "./paperclip-managed-tool-runtime.js";
import {
  projectRuntimeListCompanyTasks,
  projectRuntimeListSubTasks,
  projectRuntimeMentionAgent,
  projectRuntimeReadTaskAgentRun,
  projectRuntimeReadTaskComments,
  projectRuntimeTaskAssign,
  projectRuntimeTaskCreate,
  projectRuntimeTaskUpdate,
} from "./paperclip-managed-task-tools.js";

export function projectRuntimeMentionBoard(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"mention_board"> | null {
  if (input.actionGrants.mention_board !== true) return null;
  return projection({
    schema: z.object({ message: z.string().min(1) }).strict(),
    details:
      "Post one canonical task comment mentioning the collective Board for information or direction. The asynchronous call is non-terminal and does not change task lifecycle, approvals, or review.",
    normalize: (payload, scope) => ({
      name: "mention_board",
      companyId: scope.companyId,
      taskId: scope.taskId,
      ...payload,
    }),
  });
}

export function projectRuntimeListAgents(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"list_agents"> | null {
  if (input.actionGrants.list_all_agents !== true && input.actionGrants.list_parent_agents !== true) {
    return null;
  }
  return projection({
    schema: z.object({ agentId: z.string().min(1).optional() }).strict(),
    details:
      "List agents in this run's company with their name, title, id, capabilities, reporting parent, and status. Terminated agents are excluded. Omit agentId to list all agents. Provide an agentId to list only that agent and its entire reporting subtree (children, grandchildren, etc.).",
    normalize: (payload, scope) => ({
      name: "list_agents",
      companyId: scope.companyId,
      ...payload,
    }),
  });
}

export function projectRuntimeAgentRead(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"agent_read"> | null {
  if (input.actionGrants.agent_configure !== true) return null;
  return projection({
    schema: z.object({ agentId: z.string().min(1) }).strict(),
    details:
      "Read one agent's runtime identity, grants, and status by agentId. Requires the agent_configure action grant but performs no mutation. The target agent must be in the same company and not terminated.",
    normalize: (payload, scope) => ({
      name: "agent_read",
      companyId: scope.companyId,
      ...payload,
    }),
  });
}

export function projectRuntimeAgentHire(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"agent_hire"> | null {
  if (input.actionGrants.agent_hire !== true) return null;
  return projection({
    schema: runtimeAgentHireConfigurationSchema,
    details:
      "Create one ordinary direct-report agent. Provider, adapter, budget, lifecycle, and operational fields are not accepted.",
    normalize: (configuration, scope) => ({
      name: "agent_hire",
      companyId: scope.companyId,
      configuration: { ...configuration, reportsTo: scope.targetAgentId },
    }),
  });
}

export function projectRuntimeAgentConfigure(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"agent_configure"> | null {
  if (input.actionGrants.agent_configure !== true) return null;
  const result = projection({
    schema: runtimeAgentConfigureActionSchema,
    details:
      "Update runtime-agent identity, reporting, context cells, and grants. A live agent_configure grant authorizes any non-terminated agent in the same company; reporting changes must remain acyclic.",
    normalize(parsed, scope) {
      const { agentId, ...configuration } = parsed;
      return {
        name: "agent_configure",
        companyId: scope.companyId,
        agentId,
        configuration,
      };
    },
  });
  result.inputSchema.minProperties = 2;
  return result;
}

export function projectRuntimeTool(
  name: PaperclipManagedToolName,
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<PaperclipManagedToolName> | null {
  switch (name) {
    case "list_company_tasks":
      return projectRuntimeListCompanyTasks(input);
    case "list_sub_tasks":
      return projectRuntimeListSubTasks(input);
    case "read_task_comments":
      return projectRuntimeReadTaskComments(input);
    case "read_task_agent_run":
      return projectRuntimeReadTaskAgentRun(input);
    case "task_create":
      return projectRuntimeTaskCreate(input);
    case "task_assign":
      return projectRuntimeTaskAssign(input);
    case "task_update":
      return projectRuntimeTaskUpdate(input);
    case "mention_agent":
      return projectRuntimeMentionAgent(input);
    case "mention_board":
      return projectRuntimeMentionBoard(input);
    case "agent_hire":
      return projectRuntimeAgentHire(input);
    case "agent_configure":
      return projectRuntimeAgentConfigure(input);
    case "list_agents":
      return projectRuntimeListAgents(input);
    case "agent_read":
      return projectRuntimeAgentRead(input);
  }
}

export function projectPaperclipManagedTools(
  input: PaperclipManagedToolRuntimeProjectionInput,
): readonly ProjectedPaperclipManagedToolDescriptor[] {
  return PAPERCLIP_MANAGED_TOOL_NAMES.flatMap((name) => {
    const projected = projectRuntimeTool(name, input);
    if (!projected) return [];
    const metadata = PAPERCLIP_MANAGED_TOOL_METADATA[name];
    return [
      {
        name,
        title: metadata.title,
        description: projected.details
          ? `${metadata.description} ${projected.details}`
          : metadata.description,
        inputSchema: projected.inputSchema,
        source: "paperclip" as const,
        availability:
          metadata.readOnly && !isPaperclipContextToolName(name) ? ("both" as const) : ("work" as const),
        normalizeRuntimeCommand(payload, scope) {
          const command = projected.normalize(payload, scope);
          return {
            command,
            ledger:
              command.name === "mention_agent"
                ? {
                    kind: "mention" as const,
                    toolName: "mention_agent" as const,
                    targetAgentId: command.agentId,
                  }
                : command.name === "mention_board"
                  ? {
                      kind: "mention" as const,
                      toolName: "mention_board" as const,
                      targetAgentId: null,
                    }
                  : { kind: "non_mention" as const },
          };
        },
      },
    ];
  });
}
export * from "./paperclip-managed-tool-definitions.js";
export * from "./paperclip-managed-tool-runtime.js";
export * from "./paperclip-managed-task-tools.js";
