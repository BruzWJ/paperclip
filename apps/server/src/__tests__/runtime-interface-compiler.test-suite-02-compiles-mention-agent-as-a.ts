import * as t from "./runtime-interface-compiler.test-support.js";
const { describe, it, compileRuntimeInterface, compileInput, expect } = t;
const { normalizeRuntimeCommand, RuntimeToolArgumentsInvalid } = t;
const { PAPERCLIP_MANAGED_TOOL_METADATA, AGENT_CONTEXT_GRANT_KEYS } = t;
const { PAPERCLIP_ACTION_KEYS, AGENT_MENTION_REACH_GRANT_KEYS, CANONICAL_UUID_RE } = t;

const otherConfigureTargetId = "00000000-0000-4000-8000-000000000002";

describe("runtime interface compiler", () => {
  it("compiles mention_agent as a canonical non-terminal comment", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        mentionTargets: [{ id: "agent-2", name: "Reviewer", capabilities: "Review" }],
      }),
    ).byName.get("mention_agent")!;

    expect(descriptor.description).toContain("asynchronous call is non-terminal");
    expect(descriptor.inputSchema.required).toEqual(["agentId", "message"]);
    expect(descriptor.inputSchema.properties).not.toHaveProperty("mentionRunId");
    expect(
      normalizeRuntimeCommand(descriptor, {
        agentId: "agent-2",
        message: "Please review",
      }),
    ).toEqual({
      command: {
        name: "mention_agent",
        companyId: "company-1",
        taskId: "task-1",
        agentId: "agent-2",
        message: "Please review",
      },
      ledger: {
        kind: "mention",
        toolName: "mention_agent",
        targetAgentId: "agent-2",
      },
    });
    expect(() =>
      normalizeRuntimeCommand(descriptor, {
        agentId: "agent-2",
        message: "Please review",
        mentionRunId: "8710c164-9694-42cf-9538-2f17fd665891",
      }),
    ).toThrow(RuntimeToolArgumentsInvalid);
  });

  it("compiles a collective Board mention without a target catalog", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        actionGrants: { mention_board: true },
      }),
    ).byName.get("mention_board");

    expect(descriptor).toMatchObject({
      name: "mention_board",
      title: "Mention Board",
      description: `${PAPERCLIP_MANAGED_TOOL_METADATA.mention_board.description} Post one canonical task comment mentioning the collective Board for information or direction. The asynchronous call is non-terminal and does not change task lifecycle, approvals, or review.`,
      inputSchema: {
        type: "object",
        required: ["message"],
        additionalProperties: false,
        properties: {
          message: { type: "string", minLength: 1 },
        },
      },
    });
    expect(() =>
      normalizeRuntimeCommand(descriptor, {
        message: "Need direction",
        reason: "clarification",
      }),
    ).toThrow(RuntimeToolArgumentsInvalid);
    expect(
      compileRuntimeInterface(
        compileInput({
          mode: "consult",
          actionGrants: { mention_board: true },
        }),
      ).byName.has("mention_board"),
    ).toBe(true);
  });

  it("exposes only the closed runtime-agent configuration cells", () => {
    const result = compileRuntimeInterface(
      compileInput({
        actionGrants: { agent_hire: true, agent_configure: true },
      }),
    );
    const hire = result.byName.get("agent_hire")!;
    const configure = result.byName.get("agent_configure")!;
    expect(Object.keys(hire.inputSchema.properties?.contextGrants.properties ?? {})).toHaveLength(9);
    expect(Object.keys(hire.inputSchema.properties?.actionGrants.properties ?? {})).toHaveLength(6);
    expect(Object.keys(configure.inputSchema.properties?.mentionReachGrants.properties ?? {})).toEqual([
      "mention_any_descendant",
      "mention_any_ancestor",
    ]);
    expect(hire.inputSchema.required).toEqual([
      "name",
      "title",
      "capabilities",
      "instruction",
      "contextGrants",
      "actionGrants",
      "mentionReachGrants",
    ]);
    expect(hire.inputSchema.properties).not.toHaveProperty("reportsTo");
    const completeHire = {
      name: "Child",
      title: null,
      capabilities: null,
      instruction: null,
      contextGrants: Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false])),
      actionGrants: Object.fromEntries(PAPERCLIP_ACTION_KEYS.map((key) => [key, false])),
      mentionReachGrants: Object.fromEntries(AGENT_MENTION_REACH_GRANT_KEYS.map((key) => [key, false])),
    };
    expect(() => normalizeRuntimeCommand(hire, completeHire)).not.toThrow();
    expect(configure.inputSchema.properties?.agentId).not.toHaveProperty("enum");
    expect(configure.inputSchema.minProperties).toBe(2);
    expect(configure.inputSchema.properties?.title).toEqual({
      anyOf: [{ type: "string", maxLength: 240 }, { type: "null" }],
    });
    expect(configure.inputSchema.properties?.reportsTo).toEqual({
      anyOf: [
        {
          type: "string",
          pattern: CANONICAL_UUID_RE.source,
        },
        { type: "null" },
      ],
    });
    expect(configure.inputSchema.properties).not.toHaveProperty("adapterConfig");
    expect(configure.inputSchema.properties).not.toHaveProperty("role");
  });

  it("accepts any canonical configure target and leaves authority to the operation", () => {
    const configure = compileRuntimeInterface(
      compileInput({
        actionGrants: { agent_configure: true },
      }),
    ).byName.get("agent_configure")!;

    expect(() =>
      normalizeRuntimeCommand(configure, {
        agentId: "agent-2",
        title: null,
      }),
    ).toThrow(/exact lowercase canonical UUID/);
    expect(() =>
      normalizeRuntimeCommand(configure, {
        agentId: otherConfigureTargetId,
      }),
    ).toThrow(/At least one runtime-agent configuration field/);
    expect(
      normalizeRuntimeCommand(configure, {
        agentId: otherConfigureTargetId,
        title: null,
      }),
    ).toMatchObject({
      command: {
        name: "agent_configure",
        companyId: "company-1",
        agentId: otherConfigureTargetId,
        configuration: { title: null },
      },
    });
  });

  it("compiles administrator-installed plugin tools with immutable installation identity", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        pluginTools: [
          {
            installationId: "plugin-installation-1",
            manifestIdentity: "manifest-1",
            name: "acme.search__lookup_task",
            toolName: "lookup_task",
            title: "Look up task",
            description: "Query the external task index",
            inputSchema: { type: "object" },
          },
        ],
      }),
    ).byName.get("acme.search__lookup_task");

    expect(descriptor).toMatchObject({
      source: "plugin",
      pluginInstallationId: "plugin-installation-1",
      pluginManifestIdentity: "manifest-1",
      pluginToolName: "lookup_task",
    });
    expect(descriptor?.validateArguments?.({})).toEqual({});
  });

  it("validates direct plugin arguments against the manifest schema", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        pluginTools: [
          {
            installationId: "plugin-installation-1",
            manifestIdentity: "manifest-1",
            name: "acme.search__query",
            toolName: "query",
            title: "Search",
            description: "Query an external index",
            inputSchema: {
              type: "object",
              required: ["query"],
              additionalProperties: false,
              properties: { query: { type: "string", minLength: 1 } },
            },
          },
        ],
      }),
    ).byName.get("acme.search__query");

    expect(() => descriptor?.validateArguments?.({ query: "" })).toThrow(RuntimeToolArgumentsInvalid);
    expect(() => descriptor?.validateArguments?.({ query: "memory", extra: true })).toThrow(
      RuntimeToolArgumentsInvalid,
    );
    expect(descriptor?.validateArguments?.({ query: "memory" })).toEqual({
      query: "memory",
    });
  });

  it("rejects provider-unsafe tool names before ACPX", () => {
    expect(() =>
      compileRuntimeInterface(
        compileInput({
          pluginTools: [
            {
              installationId: "plugin-installation-1",
              manifestIdentity: "manifest-1",
              name: "acme.search:query",
              toolName: "query",
              title: "Search",
              description: "Query an external index",
              inputSchema: { type: "object" },
            },
          ],
        }),
      ),
    ).toThrow("Compiled tool name is not provider-safe");
  });

  it("rejects a non-object tool schema before ACPX", () => {
    expect(() =>
      compileRuntimeInterface(
        compileInput({
          pluginTools: [
            {
              installationId: "plugin-installation-1",
              manifestIdentity: "manifest-1",
              name: "acme.search__query",
              toolName: "query",
              title: "Search",
              description: "Query an external index",
              inputSchema: { oneOf: [{ type: "object" }] },
            },
          ],
        }),
      ),
    ).toThrow("Compiled tool input schema is not an object");
  });

  it("rejects duplicate tool names across plugin installations", () => {
    expect(() =>
      compileRuntimeInterface(
        compileInput({
          pluginTools: [
            {
              installationId: "plugin-installation-1",
              manifestIdentity: "manifest-1",
              name: "paperclip.example__lookup",
              toolName: "lookup",
              title: "Lookup",
              description: "Lookup",
              inputSchema: { type: "object" },
            },
            {
              installationId: "plugin-installation-2",
              manifestIdentity: "manifest-2",
              name: "paperclip.example__lookup",
              toolName: "lookup",
              title: "Lookup",
              description: "Lookup",
              inputSchema: { type: "object" },
            },
          ],
        }),
      ),
    ).toThrow(/Duplicate compiled tool name/);
  });
});
