import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.agentmemory";

const querySchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      description: "What to recall from this memory partition.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const issueQuerySchema = {
  type: "object",
  properties: {
    issueId: {
      type: "string",
      minLength: 1,
      description: "Paperclip issue ID. Reach is enforced by the host from the current context-access matrix.",
    },
    ...querySchema.properties,
  },
  required: ["issueId", "query"],
  additionalProperties: false,
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "AgentMemory",
  description:
    "Automatically records canonical Paperclip work into scoped AgentMemory partitions and exposes read-only recall tools.",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "agent.tools.register",
    "runtime.context.read",
    "runtime.records.read",
    "http.outbound",
    "http.private-network",
    "secrets.read-ref",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      baseUrl: {
        type: "string",
        title: "AgentMemory URL",
        description: "Base URL of the company-dedicated AgentMemory REST service.",
        default: "http://127.0.0.1:3111",
      },
      apiSecret: {
        type: "string",
        format: "secret-ref",
        title: "AgentMemory API secret",
      },
    },
    required: ["baseUrl", "apiSecret"],
    additionalProperties: false,
  },
  tools: [
    {
      name: "read_issue_agent_memory",
      displayName: "Read issue agent memory",
      description:
        "Recall private memory for one agent on a visible issue. Use Paperclip issue listing tools to discover any non-current issue ID first.",
      parametersSchema: issueQuerySchema,
    },
    {
      name: "read_issue_shared_memory",
      displayName: "Read issue shared memory",
      description:
        "Recall shared memory for a visible issue across all agents and board comments.",
      parametersSchema: issueQuerySchema,
    },
    {
      name: "read_company_agent_memory",
      displayName: "Read company agent memory",
      description:
        "Recall this agent's private memory across company issues when company-issue context access is enabled.",
      parametersSchema: querySchema,
    },
    {
      name: "read_company_shared_memory",
      displayName: "Read company shared memory",
      description:
        "Recall company-wide shared memory when company-issue context access is enabled.",
      parametersSchema: querySchema,
    },
  ],
};

export default manifest;
