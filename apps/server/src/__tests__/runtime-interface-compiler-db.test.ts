import { describe, expect, it } from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  type PaperclipPluginManifestV1,
} from "@paperclipai/shared";
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
      workMode: "standard",
      harnessKind: null,
      originKind: "manual",
      executionPolicy: null,
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
    pluginTools: [],
    ...overrides,
  };
}

describe("Postgres runtime-interface compile snapshot", () => {
  it("admits only authorized tools from an exact ready-plugin manifest", () => {
    const manifest: PaperclipPluginManifestV1 = {
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
    };
    expect(readyPluginTools([
      { id: "installed", pluginKey: "acme.search", manifestJson: manifest },
    ])).toEqual([{
      installationId: "installed",
      manifestIdentity: expect.stringMatching(/^[0-9a-f]{64}$/),
      name: "acme.search__query",
      toolName: "query",
      title: "Query",
      description: "Query an external index",
      inputSchema: { type: "object" },
      bootstrapEnabled: false,
    }]);

    expect(() => readyPluginTools([{
      id: "mismatched",
      pluginKey: "acme.other",
      manifestJson: manifest,
    }])).toThrow("does not match installation key");

    expect(() => readyPluginTools([{
      id: "missing-capability",
      pluginKey: "acme.search",
      manifestJson: { ...manifest, capabilities: [] },
    }])).toThrow("declares agent tools without agent.tools.register");
  });

  it("gives the current owner current and sub-issue context while preserving company grants", () => {
    const compiled = buildRuntimeInterfaceCompileInput(snapshot({
      contextGrantKeys: ["list_company_issues", "read_company_issue_agent_run"],
    }));

    expect(compiled.contextDial).toEqual({
      carry_context: true,
      read_issue_comments: true,
      read_issue_agent_run: true,
      list_sub_issues: true,
      read_sub_issue_comments: true,
      read_sub_issue_agent_run: true,
      list_company_issues: true,
      read_company_issue_comments: false,
      read_company_issue_agent_run: true,
    });
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
  });

  it("exposes recovery restoration only when the target has an instruction bootstrap", () => {
    const base = snapshot({ restoreSession: true });
    expect(buildRuntimeInterfaceCompileInput(base).restoreSession).toBe(false);

    const instructed = {
      ...base,
      agents: base.agents.map((agent) =>
        agent.id === "owner"
          ? { ...agent, instruction: "Restore the role context." }
          : agent,
      ),
    } satisfies RuntimeInterfaceCompilerSnapshot;
    expect(buildRuntimeInterfaceCompileInput(instructed).restoreSession).toBe(true);
  });

  it("does not inherit creator lifecycle catalogs through a consult", () => {
    const compiled = buildRuntimeInterfaceCompileInput(
      snapshot({
        capability: capability({
          executionMode: "consult",
          issueExecutionAuthorityId: null,
          consultExecutionId: "consult",
        }),
        contextGrantKeys: [],
      }),
    );
    expect(compiled.isCurrentOwner).toBe(false);
    expect(compiled.contextDial).toEqual(
      Object.fromEntries(
        AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false]),
      ),
    );
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

  it("allows execution-mode policy to deny an otherwise eligible issue owner", () => {
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

  it("does not give an owner-mode non-owner the issue baseline", () => {
    const compiled = buildRuntimeInterfaceCompileInput(snapshot({
      capability: capability({ targetAgentId: "child" }),
      contextGrantKeys: [],
    }));

    expect(compiled.isCurrentOwner).toBe(false);
    expect(compiled.contextDial).toEqual(
      Object.fromEntries(
        AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false]),
      ),
    );
  });
});
