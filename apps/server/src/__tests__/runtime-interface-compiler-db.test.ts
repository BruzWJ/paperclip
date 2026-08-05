import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PromptCapabilityCompileScope } from "../services/prompt-capability-gateway.ts";
import {
  buildRuntimeInterfaceCompileInput,
  readyPluginTools,
  type RuntimeInterfaceCompilerSnapshot,
} from "../services/runtime-interface-compiler-db.ts";
import { compileRuntimeInterface } from "../services/runtime-interface-compiler.ts";
import type { InvokableIssueOwnerRevision } from "../services/agent-invokability.ts";
import {
  CANONICAL_TEST_ADAPTER_IMPLEMENTATION_IDENTITY,
  CANONICAL_TEST_ADAPTER_TYPE,
} from "./helpers/adapter-implementation.js";

function revision(
  id: string,
  agentId: string,
): InvokableIssueOwnerRevision {
  return {
    id,
    companyId: "company",
    agentId,
    adapterType: CANONICAL_TEST_ADAPTER_TYPE,
    implementationIdentity:
      CANONICAL_TEST_ADAPTER_IMPLEMENTATION_IDENTITY,
    implementationAvailable: true,
  };
}

function capability(
  overrides: Partial<PromptCapabilityCompileScope> = {},
): PromptCapabilityCompileScope {
  return {
    companyId: "company",
    issueId: "issue",
    issueExecutionAuthorityId: "authority",
    consultExecutionId: null,
    executionMode: "owner",
    ownershipEpoch: 4,
    targetAgentId: "owner",
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<RuntimeInterfaceCompilerSnapshot> = {},
): RuntimeInterfaceCompilerSnapshot {
  return {
    capability: capability(),
    issue: {
      companyId: "company",
      ownerKind: "agent",
      ownerAgentId: "owner",
      ownershipEpoch: 4,
      contextAccessMask: { list_company_issues: false },
      workMode: "standard",
      harnessKind: null,
      originKind: "manual",
      executionPolicy: null,
      projectExecutionPolicy: null,
    },
    agents: [
      {
        id: "above-root",
        companyId: "company",
        name: "Above root",
        title: null,
        capabilities: null,
        reportsTo: null,
        status: "idle",
        currentAdapterConfigRevisionId: "above-root-revision",
        governance: {},
      },
      {
        id: "ancestor",
        companyId: "company",
        name: "Ancestor",
        title: "Secret title",
        capabilities: "Review",
        reportsTo: "above-root",
        status: "idle",
        currentAdapterConfigRevisionId: "ancestor-revision",
        governance: {},
      },
      {
        id: "owner",
        companyId: "company",
        name: "Owner",
        title: "Secret title",
        capabilities: "Build",
        reportsTo: "ancestor",
        status: "running",
        currentAdapterConfigRevisionId: "revision",
        governance: {},
      },
      {
        id: "child",
        companyId: "company",
        name: "Child",
        title: "Secret title",
        capabilities: "Test",
        reportsTo: "owner",
        status: "idle",
        currentAdapterConfigRevisionId: "child-revision",
        governance: {},
      },
      {
        id: "grandchild",
        companyId: "company",
        name: "Grandchild",
        title: null,
        capabilities: null,
        reportsTo: "child",
        status: "idle",
        currentAdapterConfigRevisionId: "grandchild-revision",
        governance: {},
      },
      {
        id: "paused-child",
        companyId: "company",
        name: "Paused",
        title: null,
        capabilities: null,
        reportsTo: "owner",
        status: "paused",
        currentAdapterConfigRevisionId: "paused-revision",
        governance: {},
      },
      {
        id: "peer",
        companyId: "company",
        name: "Peer",
        title: null,
        capabilities: null,
        reportsTo: "ancestor",
        status: "idle",
        currentAdapterConfigRevisionId: "peer-revision",
        governance: {},
      },
    ],
    adapterRevisions: [
      revision("above-root-revision", "above-root"),
      revision("ancestor-revision", "ancestor"),
      revision("revision", "owner"),
      revision("child-revision", "child"),
      revision("grandchild-revision", "grandchild"),
      revision("paused-revision", "paused-child"),
      revision("peer-revision", "peer"),
    ],
    contextGrantKeys: [
      "read_issue_comments",
      "list_company_issues",
    ],
    actionGrantKeys: [
      "issue_create",
      "issue_assign",
      "issue_update",
      "mention_agent",
      "agent_configure",
    ],
    mentionReachGrantKeys: [
      "mention_any_descendant",
      "mention_any_ancestor",
    ],
    configureGrants: [{
      permissionKey: "agents:configure",
      scope: { targetAgentIds: ["peer"] },
    }],
    childIssues: [
      {
        id: "eligible-child",
        identifier: "PAP-2",
        lifecycleStatus: "open",
        creatorKind: "agent-execution",
        creatorAuthorityId: "authority",
      },
      {
        id: "other-authority",
        identifier: "PAP-3",
        lifecycleStatus: "open",
        creatorKind: "agent-execution",
        creatorAuthorityId: "different",
      },
      {
        id: "terminal-child",
        identifier: "PAP-4",
        lifecycleStatus: "done",
        creatorKind: "agent-execution",
        creatorAuthorityId: "authority",
      },
    ],
    issueTree: [
      {
        id: "root-issue",
        parentId: null,
        ownerKind: "agent",
        ownerAgentId: "ancestor",
      },
      {
        id: "issue",
        parentId: "root-issue",
        ownerKind: "agent",
        ownerAgentId: "owner",
      },
      {
        id: "descendant-issue",
        parentId: "issue",
        ownerKind: "agent",
        ownerAgentId: "grandchild",
      },
    ],
    agentHireCompanyToolOptions: [
      {
        catalogEntryId: "00000000-0000-4000-8000-000000000021",
        connectionId: "00000000-0000-4000-8000-000000000022",
        connectionName: "Records",
        title: "Lookup record",
        description: "Look up a record",
        catalogVersionHash: "catalog-v1",
      },
    ],
    pluginTools: [],
    selectedTools: [
      {
        id: "selection",
        connectionId: "connection",
        connectionInstallId: "install",
        catalogEntryId: "catalog",
        catalogVersionHash: "v1",
        selectionStatus: "selected",
        installTargetType: "agent",
        installTargetAgentId: "owner",
        entryKind: "tool",
        entryName: "Lookup",
        toolName: "company_lookup",
        title: "Company lookup",
        description: "Look up a record",
        inputSchema: { type: "object" },
        entryStatus: "active",
        entryVersionHash: "v1",
        connectionStatus: "active",
        connectionEnabled: true,
        applicationStatus: "active",
      },
      {
        id: "stale-selection",
        connectionId: "connection",
        connectionInstallId: "install",
        catalogEntryId: "stale-catalog",
        catalogVersionHash: "v0",
        selectionStatus: "selected",
        installTargetType: "agent",
        installTargetAgentId: "owner",
        entryKind: "tool",
        entryName: "Stale",
        toolName: "stale_tool",
        title: null,
        description: null,
        inputSchema: {},
        entryStatus: "active",
        entryVersionHash: "v1",
        connectionStatus: "active",
        connectionEnabled: true,
        applicationStatus: "active",
      },
    ],
    ...overrides,
  };
}

describe("Postgres runtime-interface compile snapshot", () => {
  it("admits only enabled tools from an exact agent-tool manifest", () => {
    const manifest: PaperclipPluginManifestV1 = {
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
    };
    const rows = [
      { id: "enabled", pluginKey: "acme.memory", manifestJson: manifest },
      { id: "disabled", pluginKey: "acme.memory", manifestJson: manifest },
      {
        id: "mismatched",
        pluginKey: "acme.other",
        manifestJson: manifest,
      },
      {
        id: "missing-capability",
        pluginKey: "acme.memory",
        manifestJson: { ...manifest, capabilities: [] },
      },
    ];

    expect(readyPluginTools(rows, new Set(["disabled"]))).toEqual([{
      installationId: "enabled",
      name: "acme.memory:recall",
      title: "Recall",
      description: "Recall memory",
      inputSchema: { type: "object" },
    }]);
  });

  it("derives exact attenuated catalogs without identity or legacy defaults", () => {
    const compiled = buildRuntimeInterfaceCompileInput(snapshot());

    expect(compiled.contextDial.read_issue_comments).toBe(true);
    expect(compiled.contextDial.list_company_issues).toBe(false);
    expect(compiled.contextDial.carry_context).toBe(false);
    expect(compiled.issueCreateDirectChildren).toEqual([
      {
        kind: "agent",
        id: "child",
        name: "Child",
        capabilities: "Test",
      },
    ]);
    expect(compiled.issueAssignTargets).toEqual([
      {
        issueId: "eligible-child",
        identifier: "PAP-2",
        owners: [
          { kind: "self" },
          {
            kind: "agent",
            id: "child",
            name: "Child",
            capabilities: "Test",
          },
        ],
      },
    ]);
    expect(compiled.creatorUpdateTargets).toEqual([
      { issueId: "eligible-child" },
    ]);
    expect(compiled.mentionTargets.map((agent) => agent.id)).toEqual([
      "ancestor",
      "child",
      "grandchild",
    ]);
    expect(compiled.configureTargets.map((agent) => agent.id)).toEqual([
      "owner",
      "peer",
    ]);
    expect(compiled.configureTargets[0]).not.toHaveProperty("title");
    expect(compiled.configureTargets[0]).not.toHaveProperty("reportsTo");
    expect(compiled.agentHireCompanyToolOptions).toEqual(
      snapshot().agentHireCompanyToolOptions,
    );
    expect(compiled.selectedCompanyTools).toEqual([
      expect.objectContaining({
        selectionId: "selection",
        catalogEntryId: "catalog",
        name: "company_lookup",
      }),
    ]);
  });

  it("does not inherit creator lifecycle catalogs through a consult", () => {
    const compiled = buildRuntimeInterfaceCompileInput(
      snapshot({
        capability: capability({
          executionMode: "consult",
          issueExecutionAuthorityId: null,
          consultExecutionId: "consult",
        }),
      }),
    );
    expect(compiled.isCurrentOwner).toBe(false);
    expect(compiled.issueAssignTargets).toEqual([]);
    expect(compiled.creatorUpdateTargets).toEqual([]);
  });

  it("describes an exact suggestion-grant target without widening authority", () => {
    const compiled = buildRuntimeInterfaceCompileInput(
      snapshot({
        configureGrants: [
          {
            permissionKey: "agents:suggest-changes",
            scope: { targetAgentId: "peer" },
          },
        ],
      }),
    );
    expect(compiled.configureTargets.map((agent) => agent.id)).toEqual([
      "owner",
      "peer",
    ]);
    expect(compiled.configureTargets.map((agent) => agent.id)).not.toContain(
      "ancestor",
    );
  });

  it("includes direct children without implicit parent reach", () => {
    const compiled = buildRuntimeInterfaceCompileInput(
      snapshot({
        mentionReachGrantKeys: [],
      }),
    );
    expect(compiled.mentionTargets.map((agent) => agent.id)).toEqual(["child"]);
  });

  it("omits mention_agent for a childless agent until bounded ancestor reach is granted", () => {
    const childless = snapshot({
      capability: capability({
        targetAgentId: "grandchild",
      }),
      issue: {
        ...snapshot().issue,
        ownerAgentId: "grandchild",
      },
      actionGrantKeys: ["mention_agent"],
      mentionReachGrantKeys: [],
    });
    const withoutDynamicReach =
      buildRuntimeInterfaceCompileInput(childless);
    expect(
      withoutDynamicReach.mentionTargets.map((agent) => agent.id),
    ).toEqual([]);
    expect(
      compileRuntimeInterface(withoutDynamicReach).byName.has("mention_agent"),
    ).toBe(false);

    const withBoundedAncestorReach = buildRuntimeInterfaceCompileInput({
      ...childless,
      mentionReachGrantKeys: ["mention_any_ancestor"],
    });
    expect(
      withBoundedAncestorReach.mentionTargets.map((agent) => agent.id),
    ).toEqual(["ancestor", "child", "owner"]);
    expect(
      withBoundedAncestorReach.mentionTargets.map((agent) => agent.id),
    ).not.toContain("above-root");
  });

  it("keeps a childless root owner's mention reach empty", () => {
    const rootOwner = snapshot({
      capability: capability({
        targetAgentId: "grandchild",
      }),
      issue: {
        ...snapshot().issue,
        ownerAgentId: "grandchild",
      },
      actionGrantKeys: ["mention_agent"],
      mentionReachGrantKeys: [],
      issueTree: [
        {
          id: "issue",
          parentId: null,
          ownerKind: "agent",
          ownerAgentId: "grandchild",
        },
      ],
    });

    for (const mentionReachGrantKeys of [
      [],
      ["mention_any_ancestor"],
    ] as const) {
      const compileInput = buildRuntimeInterfaceCompileInput({
        ...rootOwner,
        mentionReachGrantKeys: [...mentionReachGrantKeys],
      });
      expect(compileInput.mentionTargets.map((agent) => agent.id)).toEqual([]);
      expect(compileInput.mentionTargets.map((agent) => agent.id)).not.toContain(
        "owner",
      );
      expect(
        compileRuntimeInterface(compileInput).byName.has("mention_agent"),
      ).toBe(false);
    }
  });

  it("extends downward only to org descendants owning work in the active issue tree", () => {
    const withoutGrandchildOwnership =
      buildRuntimeInterfaceCompileInput(
        snapshot({
          issueTree: snapshot().issueTree.map((issue) =>
            issue.id === "descendant-issue"
              ? { ...issue, ownerAgentId: "peer" }
              : issue,
          ),
          mentionReachGrantKeys: ["mention_any_descendant"],
        }),
      );

    expect(
      withoutGrandchildOwnership.mentionTargets.map((agent) => agent.id),
    ).toEqual(["child"]);
  });

  it("fails closed when issue scope or target invokability changes", () => {
    expect(() =>
      buildRuntimeInterfaceCompileInput(
        snapshot({
          issue: {
            ...snapshot().issue,
            ownershipEpoch: 5,
          },
        }),
      ),
    ).toThrow(/scope changed/);

    expect(() =>
      buildRuntimeInterfaceCompileInput(
        snapshot({
          agents: snapshot().agents.map((agent) =>
            agent.id === "owner" ? { ...agent, status: "paused" } : agent,
          ),
        }),
      ),
    ).toThrow(/not invokable/);
  });

  it("omits status-eligible agents that have no adapter revision", () => {
    const compiled = buildRuntimeInterfaceCompileInput(
      snapshot({
        agents: snapshot().agents.map((agent) =>
          agent.id === "child"
            ? { ...agent, currentAdapterConfigRevisionId: null }
            : agent,
        ),
      }),
    );

    expect(compiled.issueCreateDirectChildren).toEqual([]);
    expect(compiled.mentionTargets.map((agent) => agent.id)).not.toContain(
      "child",
    );
  });

  it("omits owners whose current revision is dangling or belongs to another agent", () => {
    const base = snapshot();
    const dangling = buildRuntimeInterfaceCompileInput({
      ...base,
      agents: base.agents.map((agent) =>
        agent.id === "child"
          ? { ...agent, currentAdapterConfigRevisionId: "missing-revision" }
          : agent,
      ),
    });
    expect(dangling.issueCreateDirectChildren).toEqual([]);

    const crossAgent = buildRuntimeInterfaceCompileInput({
      ...base,
      agents: base.agents.map((agent) =>
        agent.id === "child"
          ? { ...agent, currentAdapterConfigRevisionId: "revision" }
          : agent,
      ),
    });
    expect(crossAgent.issueCreateDirectChildren).toEqual([]);
  });

  it("applies execution-mode attenuation on every dynamic compilation", () => {
    const compiled = buildRuntimeInterfaceCompileInput(
      snapshot({
        issue: {
          ...snapshot().issue,
          workMode: "skill_test",
        },
      }),
    );

    expect(Object.values(compiled.contextDial).every((value) => !value)).toBe(
      true,
    );
  });
});
