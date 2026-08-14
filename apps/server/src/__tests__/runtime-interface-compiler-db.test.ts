import * as t from "./runtime-interface-compiler-db.test-support.js";
const { describe, it, capability, expect, resolveRuntimeToolTurn } = t;
const { readyPluginTools, buildRuntimeInterfaceCompileInput, snapshot } = t;
const { AGENT_CONTEXT_GRANT_KEYS, compileRuntimeInterface } = t;

describe("Postgres runtime-interface compile snapshot", () => {
  it("derives the bootstrap turn only from an exact ordered scope", async () => {
    const ref = (overrides: Record<string, unknown> = {}) =>
      ({
        id: "instruction",
        companyId: "company",
        taskId: "task",
        sessionId: "session",
        ownershipEpoch: 1,
        previousOwnershipEpoch: null,
        executionScopeId: "scope",
        executionLineageId: "lineage",
        mode: "owner",
        sourceKind: "system_nudge",
        sourceRecordId: "task",
        messageKind: "user",
        targetAgentId: "owner",
        laneOrdinal: 0,
        taskExecutionAuthorityId: "authority",
        consultExecutionId: null,
        adapterConfigRevisionId: "revision",
        contextEpoch: 0,
        counterpartTaskId: null,
        counterpartAuthorityId: null,
        counterpartOwnershipEpoch: null,
        consultCallerRefId: null,
        consultChainToken: null,
        ...overrides,
      }) as testSupport.TaskExecutionRefRow;
    const instruction = ref();
    const work = ref({ id: "work", messageKind: "user", laneOrdinal: 1 });
    const db = (responses: readonly (readonly unknown[])[]) => {
      let read = 0;
      return {
        select() {
          const rows = responses[read++] ?? [];
          const builder = {
            from() {
              return builder;
            },
            where() {
              return builder;
            },
            orderBy() {
              return builder;
            },
            limit() {
              return Promise.resolve(rows);
            },
          };
          return builder;
        },
      } as unknown as testSupport.Db;
    };
    const compileScope = capability({
      ownershipEpoch: 1,
      refId: instruction.id,
    });

    await expect(
      resolveRuntimeToolTurn(db([[instruction], [instruction, work]]), compileScope),
    ).resolves.toBe("bootstrap");
    await expect(resolveRuntimeToolTurn(db([[instruction], [instruction]]), compileScope)).resolves.toBe(
      "work",
    );
    const lateInstruction = ref({ laneOrdinal: 1 });
    const lateWork = ref({ id: "work", messageKind: "user", laneOrdinal: 3 });
    await expect(
      resolveRuntimeToolTurn(db([[lateInstruction], [lateInstruction, lateWork]]), compileScope),
    ).rejects.toThrow("lost its exact ordered pair");
  });

  it("admits only authorized tools from an exact ready-plugin manifest", () => {
    const manifest: testSupport.PaperclipPluginManifestV1 = {
      id: "acme.search",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Search",
      description: "External search tools",
      author: "Acme",
      categories: ["connector"],
      capabilities: ["agent.tools.register"],
      entrypoints: { worker: "./dist/worker.js" },
      tools: [
        {
          name: "query",
          displayName: "Query",
          description: "Query an external index",
          parametersSchema: { type: "object" },
        },
      ],
    };
    expect(
      readyPluginTools([
        {
          id: "installed",
          pluginKey: "acme.search",
          manifestJson: manifest,
        },
      ]),
    ).toEqual([
      {
        installationId: "installed",
        manifestIdentity: expect.stringMatching(/^[0-9a-f]{64}$/),
        name: "acme.search__query",
        toolName: "query",
        title: "Query",
        description: "Query an external index",
        inputSchema: { type: "object" },
        bootstrapEnabled: false,
      },
    ]);

    expect(() =>
      readyPluginTools([
        {
          id: "mismatched",
          pluginKey: "acme.other",
          manifestJson: manifest,
        },
      ]),
    ).toThrow("does not match installation key");

    expect(() =>
      readyPluginTools([
        {
          id: "missing-capability",
          pluginKey: "acme.search",
          manifestJson: { ...manifest, capabilities: [] },
        },
      ]),
    ).toThrow("declares agent tools without agent.tools.register");
  });

  it("gives the current owner current and sub-task context while preserving company grants", () => {
    const compiled = buildRuntimeInterfaceCompileInput(
      snapshot({
        contextGrantKeys: ["list_company_tasks", "read_company_task_agent_run"],
      }),
    );

    expect(compiled.contextDial).toEqual({
      carry_context: true,
      read_task_comments: true,
      read_task_agent_run: true,
      list_sub_tasks: true,
      read_sub_task_comments: true,
      read_sub_task_agent_run: true,
      list_company_tasks: true,
      read_company_task_comments: false,
      read_company_task_agent_run: true,
    });
    expect(compiled.taskCreateDirectChildren).toEqual([
      {
        kind: "agent",
        id: "child",
        name: "Child",
        capabilities: "Test",
      },
    ]);
    expect(compiled.taskAssignTargets).toEqual([
      {
        taskId: "eligible-child",
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
    expect(compiled.creatorUpdateTargets).toEqual([{ taskId: "eligible-child" }]);
    expect(compiled.mentionTargets.map((agent) => agent.id)).toEqual(["ancestor", "child", "grandchild"]);
    expect(compiled.configureTargets.map((agent) => agent.id)).toEqual(["owner", "peer"]);
    expect(compiled.configureTargets[0]).not.toHaveProperty("title");
    expect(compiled.configureTargets[0]).not.toHaveProperty("reportsTo");
  });

  it("does not inherit creator lifecycle catalogs through a consult", () => {
    const compiled = buildRuntimeInterfaceCompileInput(
      snapshot({
        capability: capability({
          executionMode: "consult",
          taskExecutionAuthorityId: null,
          consultExecutionId: "consult",
        }),
        contextGrantKeys: [],
      }),
    );
    expect(compiled.isCurrentOwner).toBe(false);
    expect(compiled.contextDial).toEqual(
      Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false])),
    );
    expect(compiled.taskAssignTargets).toEqual([]);
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
    expect(compiled.configureTargets.map((agent) => agent.id)).toEqual(["owner", "peer"]);
    expect(compiled.configureTargets.map((agent) => agent.id)).not.toContain("ancestor");
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
      task: {
        ...snapshot().task,
        ownerAgentId: "grandchild",
      },
      mentionReachGrantKeys: [],
    });
    const withoutDynamicReach = buildRuntimeInterfaceCompileInput(childless);
    expect(withoutDynamicReach.mentionTargets.map((agent) => agent.id)).toEqual([]);
    expect(compileRuntimeInterface(withoutDynamicReach).byName.has("mention_agent")).toBe(false);

    const withBoundedAncestorReach = buildRuntimeInterfaceCompileInput({
      ...childless,
      mentionReachGrantKeys: ["mention_any_ancestor"],
    });
    expect(withBoundedAncestorReach.mentionTargets.map((agent) => agent.id)).toEqual([
      "ancestor",
      "child",
      "owner",
    ]);
    expect(withBoundedAncestorReach.mentionTargets.map((agent) => agent.id)).not.toContain("above-root");
  });

  it("keeps a childless root owner's mention reach empty", () => {
    const rootOwner = snapshot({
      capability: capability({
        targetAgentId: "grandchild",
      }),
      task: {
        ...snapshot().task,
        ownerAgentId: "grandchild",
      },
      mentionReachGrantKeys: [],
      taskTree: [
        {
          id: "task",
          parentId: null,
          ownerKind: "agent",
          ownerAgentId: "grandchild",
        },
      ],
    });

    for (const mentionReachGrantKeys of [[], ["mention_any_ancestor"]] as const) {
      const compileInput = buildRuntimeInterfaceCompileInput({
        ...rootOwner,
        mentionReachGrantKeys: [...mentionReachGrantKeys],
      });
      expect(compileInput.mentionTargets.map((agent) => agent.id)).toEqual([]);
      expect(compileInput.mentionTargets.map((agent) => agent.id)).not.toContain("owner");
      expect(compileRuntimeInterface(compileInput).byName.has("mention_agent")).toBe(false);
    }
  });

  it("extends downward only to org descendants owning work in the active task tree", () => {
    const withoutGrandchildOwnership = buildRuntimeInterfaceCompileInput(
      snapshot({
        taskTree: snapshot().taskTree.map((task) =>
          task.id === "descendant-task" ? { ...task, ownerAgentId: "peer" } : task,
        ),
        mentionReachGrantKeys: ["mention_any_descendant"],
      }),
    );

    expect(withoutGrandchildOwnership.mentionTargets.map((agent) => agent.id)).toEqual(["child"]);
  });

  it("fails closed when task scope or target invokability changes", () => {
    expect(() =>
      buildRuntimeInterfaceCompileInput(
        snapshot({
          task: {
            ...snapshot().task,
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
          agent.id === "child" ? { ...agent, currentAdapterConfigRevisionId: null } : agent,
        ),
      }),
    );

    expect(compiled.taskCreateDirectChildren).toEqual([]);
    expect(compiled.mentionTargets.map((agent) => agent.id)).not.toContain("child");
  });

  it("omits owners whose current revision is dangling or belongs to another agent", () => {
    const base = snapshot();
    const dangling = buildRuntimeInterfaceCompileInput({
      ...base,
      agents: base.agents.map((agent) =>
        agent.id === "child" ? { ...agent, currentAdapterConfigRevisionId: "missing-revision" } : agent,
      ),
    });
    expect(dangling.taskCreateDirectChildren).toEqual([]);

    const crossAgent = buildRuntimeInterfaceCompileInput({
      ...base,
      agents: base.agents.map((agent) =>
        agent.id === "child" ? { ...agent, currentAdapterConfigRevisionId: "revision" } : agent,
      ),
    });
    expect(crossAgent.taskCreateDirectChildren).toEqual([]);
  });

  it("allows execution policy to deny an otherwise eligible task owner", () => {
    const compiled = buildRuntimeInterfaceCompileInput(
      snapshot({
        task: {
          ...snapshot().task,
          executionPolicy: {
            reviewPreset: {
              id: "low_trust_review",
              version: 1,
              rawOutputDisposition: "quarantine",
            },
            authorizationPolicy: {
              trustBoundary: {
                mode: "low_trust_review",
                taskIds: ["task"],
              },
            },
          },
        },
      }),
    );

    expect(Object.values(compiled.contextDial).every((value) => !value)).toBe(true);
  });

  it("does not give an owner-mode non-owner the task baseline", () => {
    const compiled = buildRuntimeInterfaceCompileInput(
      snapshot({
        capability: capability({ targetAgentId: "child" }),
        contextGrantKeys: [],
      }),
    );

    expect(compiled.isCurrentOwner).toBe(false);
    expect(compiled.contextDial).toEqual(
      Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false])),
    );
  });
});
