import { describe, expect, it } from "vitest";
import { AGENT_CONTEXT_GRANT_KEYS } from "@paperclipai/shared";
import {
  PAPERCLIP_CONTEXT_TOOL_NAMES,
  PAPERCLIP_MANAGED_TOOL_METADATA,
  BOARD_MANAGED_TOOLS,
  projectPaperclipManagedTools,
} from "../services/paperclip-managed-tool-registry.js";
import { compileRuntimeInterface } from "../services/runtime-interface-compiler.js";
import type { ContextDial } from "../services/context-dial-resolver.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const issueId = "00000000-0000-4000-8000-000000000003";

const fullContextDial = Object.fromEntries(
  AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, true]),
) as ContextDial;

describe("Paperclip managed-tool registry", () => {
  it("projects the same context tool identities through the ACPX compiler", () => {
    const descriptors = projectPaperclipManagedTools({
      mode: "owner",
      contextDial: fullContextDial,
      actionGrants: {},
      isCurrentOwner: false,
      issueCreateDirectChildren: [],
      issueAssignTargets: [],
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
    }
  });

  it("keeps Board MCP as the full-control projection without mention_board", () => {
    const names = BOARD_MANAGED_TOOLS.map((tool) => tool.name);

    expect(names).toEqual([
      "list_company_issues",
      "list_sub_issues",
      "read_issue_comments",
      "read_issue_agent_run",
      "issue_create",
      "issue_assign",
      "issue_update",
      "mention_agent",
      "agent_hire",
      "agent_configure",
      "list_agents",
      "agent_read",
    ]);
    expect(names).not.toContain("mention_board");
    expect(
      BOARD_MANAGED_TOOLS.find((tool) => tool.name === "issue_create")
        ?.inputSchema.safeParse({
          companyId,
          request: "Implement the board task",
          ownerAgentId: agentId,
        }).success,
    ).toBe(true);
  });

  it("uses canonical metadata for the ACPX action projection too", () => {
    const compiled = compileRuntimeInterface({
      mode: "owner",
      contextDial: fullContextDial,
      actionGrants: {
        issue_create: true,
        mention_board: true,
        agent_hire: true,
        agent_configure: true,
        list_all_agents: true,
      },
      isCurrentOwner: true,
      issueCreateDirectChildren: [{ id: agentId, name: "Agent", capabilities: null, kind: "agent" }],
      issueAssignTargets: [{
        issueId,
        identifier: "PC-1",
        owners: [{ kind: "self" }],
      }],
      creatorUpdateTargets: [],
      mentionTargets: [{ id: agentId, name: "Agent", capabilities: null }],
      configureTargets: [{ id: agentId }],
      pluginTools: [],
    });

    for (const name of [
      "issue_create",
      "issue_assign",
      "issue_update",
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
    }
  });
});
