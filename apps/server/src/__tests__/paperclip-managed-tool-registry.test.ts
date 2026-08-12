import { describe, expect, it } from "vitest";
import { AGENT_CONTEXT_GRANT_KEYS } from "@paperclipai/shared";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  BOARD_MANAGED_TOOLS,
  PAPERCLIP_CONTEXT_TOOL_NAMES,
  PAPERCLIP_MANAGED_TOOL_METADATA,
  parseBoardManagedTool,
  projectPaperclipManagedTools,
} from "../services/paperclip-managed-tool-registry.js";
import { compileRuntimeInterface } from "../services/runtime-interface-compiler.js";
import type { ContextDial } from "../services/context-dial-resolver.js";

const agentId = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000003";

const fullContextDial = Object.fromEntries(
  AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, true]),
) as ContextDial;

describe("Paperclip managed-tool registry", () => {
  it("publishes a distinct Board catalog without mention_board", () => {
    const names = BOARD_MANAGED_TOOLS.map((tool) => tool.name);
    expect(names).toContain("mention_agent");
    expect(names).not.toContain("mention_board");
  });

  it("rejects noncanonical Board UUIDs and unknown fields", () => {
    expect(() => parseBoardManagedTool("list_agents", {
      companyId: "AAAAAAAA-0000-4000-8000-000000000001",
    })).toThrow("Expected an exact lowercase canonical UUID");
    expect(() => parseBoardManagedTool("list_agents", {
      companyId: "aaaaaaaa-0000-4000-8000-000000000001",
      company_id: "aaaaaaaa-0000-4000-8000-000000000001",
    })).toThrow("Unrecognized key");
  });

  it("projects the same context tool identities through the ACPX compiler", () => {
    const descriptors = projectPaperclipManagedTools({
      mode: "owner",
      contextDial: fullContextDial,
      actionGrants: {},
      isCurrentOwner: false,
      taskCreateDirectChildren: [],
      taskAssignTargets: [],
      creatorUpdateTargets: [],
      mentionTargets: [],
      configureTargets: [],
    });

    expect(descriptors.map((descriptor) => descriptor.name)).toEqual(
      PAPERCLIP_CONTEXT_TOOL_NAMES,
    );
    for (const descriptor of descriptors) {
      const name = descriptor.name as keyof typeof PAPERCLIP_MANAGED_TOOL_METADATA;
      expect(descriptor.title).toBe(PAPERCLIP_MANAGED_TOOL_METADATA[name].title);
      expect(descriptor.description.startsWith(
        PAPERCLIP_MANAGED_TOOL_METADATA[name].description,
      )).toBe(true);
      expect(descriptor.availability).toBe("work");
    }
  });

  it("uses canonical metadata for the ACPX action projection too", () => {
    const compiled = compileRuntimeInterface({
      mode: "owner",
      turn: "work",
      contextDial: fullContextDial,
      actionGrants: {
        task_create: true,
        mention_board: true,
        agent_hire: true,
        agent_configure: true,
        list_all_agents: true,
      },
      isCurrentOwner: true,
      taskCreateDirectChildren: [{ id: agentId, name: "Agent", capabilities: null, kind: "agent" }],
      taskAssignTargets: [{
        taskId,
        identifier: "PC-1",
        owners: [{ kind: "self" }],
      }],
      creatorUpdateTargets: [],
      mentionTargets: [{ id: agentId, name: "Agent", capabilities: null }],
      configureTargets: [{ id: agentId }],
      pluginTools: [],
    });

    for (const name of [
      "task_create",
      "task_assign",
      "task_update",
      "mention_agent",
      "mention_board",
      "agent_hire",
      "agent_configure",
      "list_agents",
      "agent_read",
    ] as const) {
      expect(compiled.byName.get(name)?.title).toBe(
        PAPERCLIP_MANAGED_TOOL_METADATA[name].title,
      );
      expect(compiled.byName.get(name)?.description?.startsWith(
        PAPERCLIP_MANAGED_TOOL_METADATA[name].description,
      )).toBe(true);
      expect(compiled.byName.get(name)?.availability).toBe(
        name === "list_agents" || name === "agent_read" ? "both" : "work",
      );
    }
    expect(ListToolsResultSchema.safeParse({
      tools: compiled.descriptors.map((descriptor) => ({
        name: descriptor.name,
        title: descriptor.title,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
      })),
    }).success).toBe(true);
  });
});
