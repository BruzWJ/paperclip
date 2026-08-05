import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  listAuthorizedPluginAgentTools,
  pluginManifestDeclaresAgentTool,
} from "./plugin-agent-tool-authority.js";

function manifest(
  overrides: Partial<PaperclipPluginManifestV1> = {},
): PaperclipPluginManifestV1 {
  return {
    id: "acme.memory",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Memory",
    description: "Memory tools",
    author: "Acme",
    categories: ["connector"],
    capabilities: ["agent.tools.register"],
    entrypoints: { worker: "./dist/worker.js" },
    tools: [{
      name: "recall",
      displayName: "Recall",
      description: "Recall memory",
      parametersSchema: { type: "object" },
    }],
    ...overrides,
  };
}

describe("plugin agent-tool authority", () => {
  it("accepts only an exact registered manifest tool", () => {
    const input = { pluginKey: "acme.memory", manifest: manifest() };
    expect(listAuthorizedPluginAgentTools(input)).toHaveLength(1);
    expect(pluginManifestDeclaresAgentTool(input, "acme.memory:recall")).toBe(true);
    expect(pluginManifestDeclaresAgentTool(input, "acme.memory:other")).toBe(false);
  });

  it("rejects a manifest identity mismatch", () => {
    const input = {
      pluginKey: "acme.memory",
      manifest: manifest({ id: "acme.other" }),
    };
    expect(listAuthorizedPluginAgentTools(input)).toEqual([]);
    expect(pluginManifestDeclaresAgentTool(input, "acme.memory:recall")).toBe(false);
  });

  it("rejects a manifest without agent.tools.register", () => {
    const input = {
      pluginKey: "acme.memory",
      manifest: manifest({ capabilities: [] }),
    };
    expect(listAuthorizedPluginAgentTools(input)).toEqual([]);
    expect(pluginManifestDeclaresAgentTool(input, "acme.memory:recall")).toBe(false);
  });
});
