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

const issueQuerySchema: PluginToolDeclaration["parametersSchema"] = {
  type: "object",
  properties: {
    issueId: {
      type: "string",
      minLength: 1,
      description:
        "Paperclip issue ID. Reach is enforced by the host from the current context-access matrix.",
    },
    query: queryProperty,
  },
  required: ["issueId", "query"],
  additionalProperties: false,
};

interface MemoryToolDefinition {
  partitionKind: MemoryPartitionKind;
  declaration: PluginToolDeclaration;
}

export const MEMORY_TOOL_DEFINITIONS = [
  {
    partitionKind: "issue_agent",
    declaration: {
      name: "read_issue_agent_memory",
      displayName: "Read issue agent memory",
      description:
        "Recall private memory for this agent on an issue allowed by the matching current, sub-issue, or company run-detail context grant.",
      parametersSchema: issueQuerySchema,
    },
  },
  {
    partitionKind: "issue_shared",
    declaration: {
      name: "read_issue_shared_memory",
      displayName: "Read issue shared memory",
      description:
        "Recall shared memory for an issue allowed by the matching current, sub-issue, or company comment-detail context grant.",
      parametersSchema: issueQuerySchema,
    },
  },
  {
    partitionKind: "company_agent",
    declaration: {
      name: "read_company_agent_memory",
      displayName: "Read company agent memory",
      description:
        "Recall this agent's private memory across company issues when company run-detail context access is enabled.",
      parametersSchema: querySchema,
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
    },
  },
] as const satisfies readonly MemoryToolDefinition[];
