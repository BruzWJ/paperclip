import type { PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import type { MemoryPartitionKind } from "./memory-partitions.js";

export const PLUGIN_ID = "paperclip.agentmemory";

const queryProperty = {
  type: "string",
  minLength: 1,
  description: "What to recall from this memory partition.",
} as const;

const querySchema: PluginToolDeclaration["parametersSchema"] = {
  type: "object",
  properties: {
    query: queryProperty,
  },
  required: ["query"],
  additionalProperties: false,
};

const taskQuerySchema: PluginToolDeclaration["parametersSchema"] = {
  type: "object",
  properties: {
    taskId: {
      type: "string",
      minLength: 1,
      description:
        "Paperclip task ID. Reach is enforced by the host from the current context-access matrix.",
    },
    query: queryProperty,
  },
  required: ["taskId", "query"],
  additionalProperties: false,
};

interface MemoryToolDefinition {
  partitionKind: MemoryPartitionKind;
  declaration: PluginToolDeclaration;
}

export const MEMORY_TOOL_DEFINITIONS = [
  {
    partitionKind: "task_agent",
    declaration: {
      name: "read_task_agent_memory",
      displayName: "Read task agent memory",
      description:
        "Recall private memory for this agent on a task allowed by the matching current, sub-task, or company run-detail context grant.",
      parametersSchema: taskQuerySchema,
    },
  },
  {
    partitionKind: "task_shared",
    declaration: {
      name: "read_task_shared_memory",
      displayName: "Read task shared memory",
      description:
        "Recall shared memory for a task allowed by the matching current, sub-task, or company comment-detail context grant.",
      parametersSchema: taskQuerySchema,
    },
  },
  {
    partitionKind: "company_agent",
    declaration: {
      name: "read_company_agent_memory",
      displayName: "Read company agent memory",
      description:
        "Recall this agent's private memory across company tasks when company run-detail context access is enabled.",
      parametersSchema: querySchema,
      bootstrapEnabled: true,
    },
  },
  {
    partitionKind: "company_shared",
    declaration: {
      name: "read_company_shared_memory",
      displayName: "Read company shared memory",
      description:
        "Recall company-wide shared memory when company comment-detail context access is enabled.",
      parametersSchema: querySchema,
      bootstrapEnabled: true,
    },
  },
] as const satisfies readonly MemoryToolDefinition[];
