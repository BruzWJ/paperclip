import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { MEMORY_TOOL_DEFINITIONS, PLUGIN_ID } from "./memory-tools.js";

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
    "runtime.prompt.observe",
    "http.outbound",
    "http.private-network",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      baseUrl: {
        type: "string",
        format: "uri",
        pattern:
          "^(?:https://[^@/?#]+|http://(?:localhost\\.?|127(?:\\.[0-9]{1,3}){3}|\\[::1\\])(?::[0-9]+)?)(?:/[^?#]*)?$",
        title: "AgentMemory URL",
        description: "Base URL of the AgentMemory REST service for this Paperclip instance.",
        default: "http://127.0.0.1:3111",
      },
      apiSecret: {
        type: "string",
        minLength: 1,
        title: "AgentMemory API secret",
        description: "Bearer secret configured on the AgentMemory service.",
      },
    },
    required: ["baseUrl", "apiSecret"],
    additionalProperties: false,
  },
  tools: MEMORY_TOOL_DEFINITIONS.map(({ declaration }) => declaration),
};

export default manifest;
