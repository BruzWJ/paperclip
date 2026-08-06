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
    id: "acme.search",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Search",
    description: "External search tools",
    author: "Acme",
    categories: ["connector"],
    capabilities: ["agent.tools.register"],
    entrypoints: { worker: "./dist/worker.js" },
    tools: [{
      name: "query",
      displayName: "Query",
      description: "Query an external index",
      parametersSchema: { type: "object" },
    }],
    ...overrides,
  };
}

describe("plugin agent-tool authority", () => {
  it("accepts only an exact registered manifest tool", () => {
    const input = { pluginKey: "acme.search", manifest: manifest() };
    expect(listAuthorizedPluginAgentTools(input)).toHaveLength(1);
    expect(pluginManifestDeclaresAgentTool(input, "acme.search__query")).toBe(true);
    expect(pluginManifestDeclaresAgentTool(input, "acme.search__other")).toBe(false);
  });

  it("fails on a persisted manifest identity mismatch", () => {
    const input = {
      pluginKey: "acme.search",
      manifest: manifest({ id: "acme.other" }),
    };
    expect(() => listAuthorizedPluginAgentTools(input)).toThrow(
      "does not match installation key",
    );
    expect(() => pluginManifestDeclaresAgentTool(input, "acme.search__query")).toThrow(
      "does not match installation key",
    );
  });

  it("fails when persisted tools lack agent.tools.register", () => {
    const input = {
      pluginKey: "acme.search",
      manifest: manifest({ capabilities: [] }),
    };
    expect(() => listAuthorizedPluginAgentTools(input)).toThrow(
      "declares agent tools without agent.tools.register",
    );
    expect(() => pluginManifestDeclaresAgentTool(input, "acme.search__query")).toThrow(
      "declares agent tools without agent.tools.register",
    );
  });
});
