import { describe, expect, it } from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  CANONICAL_UUID_RE,
  PAPERCLIP_ACTION_KEYS,
} from "@paperclipai/shared";
import {
  compileRuntimeInterface,
} from "../services/runtime-interface-compiler.ts";
import { RuntimeToolArgumentsInvalid } from "../services/runtime-tool-errors.ts";
import { resolveContextDial } from "../services/context-dial-resolver.ts";
import { PAPERCLIP_MANAGED_TOOL_METADATA } from "../services/paperclip-managed-tool-registry.ts";

function compileInput(
  overrides: Partial<Parameters<typeof compileRuntimeInterface>[0]> = {},
): Parameters<typeof compileRuntimeInterface>[0] {
  return {
    mode: "owner",
    turn: "work",
    contextDial: resolveContextDial({ agent: {} }).effective,
    actionGrants: {},
    isCurrentOwner: true,
    taskCreateDirectChildren: [],
    taskAssignTargets: [],
    creatorUpdateTargets: [],
    mentionTargets: [],
    configureTargets: [],
    pluginTools: [],
    ...overrides,
  };
}

const runtimeScope = {
  companyId: "company-1",
  taskId: "task-1",
  targetAgentId: "agent-1",
};

function normalizeRuntimeCommand(
  descriptor: NonNullable<ReturnType<typeof compileRuntimeInterface>["descriptors"][number]> | undefined,
  payload: unknown,
) {
  if (!descriptor?.normalizeRuntimeCommand) {
    throw new Error(`Expected a canonical runtime projection for ${descriptor?.name}`);
  }
  return descriptor.normalizeRuntimeCommand(payload, runtimeScope);
}

describe("runtime interface compiler", () => {
  const COMMENT_PREFIX =
    "Reads one chronological bounded page of first-class Session comments. Authorized target tiers: ";
  const RUN_PREFIX =
    "Reads the delivered source message(s) and bounded provider-safe detailed turns for exactly one run selected by required runId. Authorized target tiers: ";
  const reachCases = [
    {
      current: false,
      descendant: false,
      company: false,
      commentTiers: "",
      runTiers: "",
    },
    {
      current: false,
      descendant: false,
      company: true,
      commentTiers:
        "any task in this run's company through an explicit taskId",
      runTiers: "a run on any task in this run's company",
    },
    {
      current: false,
      descendant: true,
      company: false,
      commentTiers:
        "a proper descendant of the active task through an explicit taskId",
      runTiers: "a run on a proper descendant of the active task",
    },
    {
      current: false,
      descendant: true,
      company: true,
      commentTiers:
        "a proper descendant of the active task through an explicit taskId; any task in this run's company through an explicit taskId",
      runTiers:
        "a run on a proper descendant of the active task; a run on any task in this run's company",
    },
    {
      current: true,
      descendant: false,
      company: false,
      commentTiers:
        "the active task (omit taskId or pass it explicitly)",
      runTiers: "a run on the active task",
    },
    {
      current: true,
      descendant: false,
      company: true,
      commentTiers:
        "the active task (omit taskId or pass it explicitly); any task in this run's company through an explicit taskId",
      runTiers:
        "a run on the active task; a run on any task in this run's company",
    },
    {
      current: true,
      descendant: true,
      company: false,
      commentTiers:
        "the active task (omit taskId or pass it explicitly); a proper descendant of the active task through an explicit taskId",
      runTiers:
        "a run on the active task; a run on a proper descendant of the active task",
    },
    {
      current: true,
      descendant: true,
      company: true,
      commentTiers:
        "the active task (omit taskId or pass it explicitly); a proper descendant of the active task through an explicit taskId; any task in this run's company through an explicit taskId",
      runTiers:
        "a run on the active task; a run on a proper descendant of the active task; a run on any task in this run's company",
    },
  ] as const;

  it("exposes only granted organizational reads during bootstrap", () => {
    const result = compileRuntimeInterface(compileInput({
      turn: "bootstrap",
      contextDial: resolveContextDial({
        agent: Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, true])),
      }).effective,
      actionGrants: {
        list_all_agents: true,
        agent_configure: true,
        agent_hire: true,
      },
      configureTargets: [{ id: "agent-2" }],
    }));
    expect(result.descriptors.map((tool) => tool.name)).toEqual([
      "list_agents",
      "agent_read",
    ]);
  });

  it.each(reachCases)(
    "describes and parses the exact comment union current=$current descendant=$descendant company=$company",
    ({ current, descendant, company, commentTiers }) => {
      const descriptor = compileRuntimeInterface(compileInput({
        contextDial: resolveContextDial({
          agent: {
            read_task_comments: current,
            read_sub_task_comments: descendant,
            read_company_task_comments: company,
          },
        }).effective,
      })).byName.get("read_task_comments");
      if (!commentTiers) {
        expect(descriptor).toBeUndefined();
        return;
      }
      expect(descriptor?.description).toBe(
        `${PAPERCLIP_MANAGED_TOOL_METADATA.read_task_comments.description} ${COMMENT_PREFIX}${commentTiers}.`,
      );
      expect(descriptor?.inputSchema.required).toEqual(
        current ? [] : ["taskId"],
      );
      if (current) {
        expect(normalizeRuntimeCommand(descriptor, {})).toEqual({
          command: {
            name: "read_task_comments",
            companyId: "company-1",
            taskId: "task-1",
            cursor: undefined,
          },
          ledger: { kind: "non_mention" },
        });
      } else {
        expect(() =>
          normalizeRuntimeCommand(descriptor, {}),
        ).toThrow(RuntimeToolArgumentsInvalid);
      }
    },
  );

  it.each(reachCases)(
    "describes the exact run union current=$current descendant=$descendant company=$company",
    ({ current, descendant, company, runTiers }) => {
      const descriptor = compileRuntimeInterface(compileInput({
        contextDial: resolveContextDial({
          agent: {
            read_task_agent_run: current,
            read_sub_task_agent_run: descendant,
            read_company_task_agent_run: company,
          },
        }).effective,
      })).byName.get("read_task_agent_run");
      if (!runTiers) {
        expect(descriptor).toBeUndefined();
        return;
      }
      expect(descriptor?.description).toBe(
        `${PAPERCLIP_MANAGED_TOOL_METADATA.read_task_agent_run.description} ${RUN_PREFIX}${runTiers}.`,
      );
      expect(descriptor?.inputSchema.required).toEqual(["runId"]);
      expect(
        normalizeRuntimeCommand(descriptor, {
          runId: "run-1",
          cursor: "opaque-page-2",
        }),
      ).toEqual({
        command: {
          name: "read_task_agent_run",
          companyId: "company-1",
          runId: "run-1",
          cursor: "opaque-page-2",
        },
        ledger: { kind: "non_mention" },
      });
      expect(() =>
        normalizeRuntimeCommand(descriptor, {}),
      ).toThrow(RuntimeToolArgumentsInvalid);
    },
  );

  it.each([
    {
      sub: false,
      company: false,
      description: null,
    },
    {
      sub: true,
      company: false,
      description:
        "Lists one bounded page of direct children. Omit taskId to list the active task's direct children. With taskId, only a proper descendant of the active task is accepted; the active task itself is rejected.",
    },
    {
      sub: false,
      company: true,
      description:
        "Lists one bounded page of direct children. Omit taskId to list the active task's direct children. With taskId, any task in this run's company is accepted, including the active task.",
    },
    {
      sub: true,
      company: true,
      description:
        "Lists one bounded page of direct children. Omit taskId to list the active task's direct children. With taskId, any task in this run's company is accepted, including the active task.",
    },
  ] as const)(
    "describes the exact sub-list union sub=$sub company=$company",
    ({ sub, company, description }) => {
      const descriptor = compileRuntimeInterface(compileInput({
        contextDial: resolveContextDial({
          agent: {
            list_sub_tasks: sub,
            list_company_tasks: company,
          },
        }).effective,
      })).byName.get("list_sub_tasks");
      if (description === null) {
        expect(descriptor).toBeUndefined();
        return;
      }
      expect(descriptor?.description).toBe(
        `${PAPERCLIP_MANAGED_TOOL_METADATA.list_sub_tasks.description} ${description}`,
      );
      expect(descriptor?.inputSchema.required).toEqual([]);
      expect(normalizeRuntimeCommand(descriptor, {})).toEqual({
        command: {
          name: "list_sub_tasks",
          companyId: "company-1",
          taskId: "task-1",
          cursor: undefined,
        },
        ledger: { kind: "non_mention" },
      });
    },
  );

  it("compiles only effective retrieval unions and granted actions", () => {
    const result = compileRuntimeInterface(
      compileInput({
        contextDial: resolveContextDial({
          agent: {
            list_company_tasks: true,
            read_sub_task_comments: true,
          },
        }).effective,
        actionGrants: {
          task_create: true,
          mention_board: true,
        },
        creatorUpdateTargets: [{ taskId: "child-1", identifier: "PAP-1" }],
        mentionTargets: [
          { id: "agent-2", name: "Reviewer", capabilities: "Review" },
        ],
      }),
    );

    expect(result.descriptors.map((tool) => tool.name)).toEqual([
      "list_company_tasks",
      "list_sub_tasks",
      "read_task_comments",
      "task_create",
      "task_update",
      "mention_agent",
      "mention_board",
    ]);
  });

  it("compiles one canonical owner-or-creator update ABI with automatic counterpart mention", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        isCurrentOwner: true,
        creatorUpdateTargets: [{ taskId: "child-1" }],
      }),
    ).byName.get("task_update");

    expect(descriptor).toMatchObject({
      name: "task_update",
      description:
        `${PAPERCLIP_MANAGED_TOOL_METADATA.task_update.description} Publish one canonical task comment, optionally update lifecycle, and automatically mention the creator/owner counterpart in that counterpart's task context. Omit taskId to update the active task as its current owner, including terminal done or cancelled disposition; provide an eligible direct-child taskId to update it as its exact creator with a message, open, or blocked status.`,
      source: "paperclip",
    });
    expect(descriptor?.inputSchema).toEqual({
      type: "object",
      oneOf: [
        {
          type: "object",
          properties: {
            message: { type: "string", minLength: 1 },
          },
          required: ["message"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            status: { type: "string", enum: ["open", "blocked"] },
            message: { type: "string", minLength: 1 },
          },
          required: ["status", "message"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            status: { type: "string", enum: ["done", "cancelled"] },
            message: { type: "string", minLength: 1 },
            structuredResult: {},
          },
          required: ["status", "message"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              enum: ["child-1"],
            },
            message: { type: "string", minLength: 1 },
          },
          required: ["taskId", "message"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              enum: ["child-1"],
            },
            status: { type: "string", enum: ["open", "blocked"] },
            message: { type: "string", minLength: 1 },
          },
          required: ["taskId", "status", "message"],
          additionalProperties: false,
        },
      ],
    });
  });

  it("requires an exact child taskId when only creator authority is available", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        isCurrentOwner: false,
        creatorUpdateTargets: [{ taskId: "child-1" }],
      }),
    ).byName.get("task_update");

    expect(descriptor?.inputSchema).toEqual({
      type: "object",
      oneOf: [
        {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              enum: ["child-1"],
            },
            message: { type: "string", minLength: 1 },
          },
          required: ["taskId", "message"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              enum: ["child-1"],
            },
            status: { type: "string", enum: ["open", "blocked"] },
            message: { type: "string", minLength: 1 },
          },
          required: ["taskId", "status", "message"],
          additionalProperties: false,
        },
      ],
    });
  });

  it("removes owner/creator mutation tools in consult mode", () => {
    const result = compileRuntimeInterface(
      compileInput({
        mode: "consult",
        actionGrants: {
          task_create: true,
          mention_board: true,
          agent_hire: true,
          agent_configure: true,
        },
        taskAssignTargets: [
          {
            taskId: "child",
            identifier: "PAP-2",
            owners: [{ kind: "self" }],
          },
        ],
        creatorUpdateTargets: [{ taskId: "child", identifier: "PAP-2" }],
        mentionTargets: [
          { id: "agent-2", name: "Reviewer", capabilities: null },
        ],
        configureTargets: [{ id: "agent-2" }],
      }),
    );

    expect(result.descriptors.map((tool) => tool.name)).toEqual([
      "mention_agent",
      "mention_board",
      "agent_hire",
      "agent_configure",
      "agent_read",
    ]);
  });

  it("uses task_create as the sole create-and-assign grant", () => {
    const taskAssignTargets = [
      {
        taskId: "child",
        identifier: "PAP-2",
        owners: [{ kind: "self" as const }],
      },
    ];

    expect(
      compileRuntimeInterface(
        compileInput({
          isCurrentOwner: false,
          taskAssignTargets,
        }),
      ).descriptors,
    ).toEqual([]);

    expect(
      compileRuntimeInterface(
        compileInput({
          isCurrentOwner: false,
          actionGrants: { task_create: true },
          taskAssignTargets,
        }),
      ).descriptors.map((tool) => tool.name),
    ).toEqual(["task_create", "task_assign"]);
  });

  it("omits mention and assignment when their call-time catalogs are empty", () => {
    const result = compileRuntimeInterface(
      compileInput({
        actionGrants: {
          task_create: true,
        },
        isCurrentOwner: false,
      }),
    );
    expect(result.descriptors.map((tool) => tool.name)).toEqual([
      "task_create",
    ]);
  });

  it("compiles mention_agent as a canonical non-terminal comment", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        mentionTargets: [
          { id: "agent-2", name: "Reviewer", capabilities: "Review" },
        ],
      }),
    ).byName.get("mention_agent")!;

    expect(descriptor.description).toContain(
      "asynchronous call is non-terminal",
    );
    expect(descriptor.inputSchema.required).toEqual(["agentId", "message"]);
    expect(descriptor.inputSchema.properties).not.toHaveProperty(
      "mentionRunId",
    );
    expect(normalizeRuntimeCommand(descriptor, {
      agentId: "agent-2",
      message: "Please review",
    })).toEqual({
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
    expect(() => normalizeRuntimeCommand(descriptor, {
      agentId: "agent-2",
      message: "Please review",
      mentionRunId: "8710c164-9694-42cf-9538-2f17fd665891",
    })).toThrow(RuntimeToolArgumentsInvalid);
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
      description:
        `${PAPERCLIP_MANAGED_TOOL_METADATA.mention_board.description} Post one canonical task comment mentioning the collective Board for information or direction. The asynchronous call is non-terminal and does not change task lifecycle, approvals, or review.`,
      inputSchema: {
        type: "object",
        required: ["message"],
        additionalProperties: false,
        properties: {
          message: { type: "string", minLength: 1 },
        },
      },
    });
    expect(() => normalizeRuntimeCommand(descriptor, {
      message: "Need direction",
      reason: "clarification",
    })).toThrow(RuntimeToolArgumentsInvalid);
    expect(
      compileRuntimeInterface(
        compileInput({ mode: "consult", actionGrants: { mention_board: true } }),
      ).byName.has("mention_board"),
    ).toBe(true);
  });

  it("exposes only the closed runtime-agent configuration cells", () => {
    const result = compileRuntimeInterface(
      compileInput({
        actionGrants: { agent_hire: true, agent_configure: true },
        configureTargets: [{ id: "agent-1" }],
      }),
    );
    const hire = result.byName.get("agent_hire")!;
    const configure = result.byName.get("agent_configure")!;
    expect(
      Object.keys(
        hire.inputSchema.properties?.contextGrants.properties ?? {},
      ),
    ).toHaveLength(9);
    expect(
      Object.keys(
        hire.inputSchema.properties?.actionGrants.properties ?? {},
      ),
    ).toHaveLength(6);
    expect(
      Object.keys(
        configure.inputSchema.properties?.mentionReachGrants.properties ?? {},
      ),
    ).toEqual([
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
      contextGrants: Object.fromEntries(
        AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false]),
      ),
      actionGrants: Object.fromEntries(
        PAPERCLIP_ACTION_KEYS.map((key) => [key, false]),
      ),
      mentionReachGrants: Object.fromEntries(
        AGENT_MENTION_REACH_GRANT_KEYS.map((key) => [key, false]),
      ),
    };
    expect(() => normalizeRuntimeCommand(hire, completeHire)).not.toThrow();
    expect(configure.inputSchema.properties?.agentId).toEqual({
      type: "string",
      enum: ["agent-1"],
    });
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
    expect(configure.inputSchema.properties).not.toHaveProperty(
      "adapterConfig",
    );
    expect(configure.inputSchema.properties).not.toHaveProperty("role");
  });

  it("validates a configure call against its current id-only catalog", () => {
    const configure = compileRuntimeInterface(
      compileInput({
        actionGrants: { agent_configure: true },
        configureTargets: [{ id: "agent-1" }],
      }),
    ).byName.get("agent_configure")!;

    expect(() =>
      normalizeRuntimeCommand(configure, { agentId: "agent-2", title: null }),
    ).toThrow(/Invalid enum value/);
    expect(() =>
      normalizeRuntimeCommand(configure, { agentId: "agent-1" }),
    ).toThrow(/At least one runtime-agent configuration field/);
    expect(
      normalizeRuntimeCommand(configure, { agentId: "agent-1", title: null }),
    ).toMatchObject({
      command: {
        name: "agent_configure",
        companyId: "company-1",
        agentId: "agent-1",
        configuration: { title: null },
      },
    });
  });

  it("compiles administrator-installed plugin tools with immutable installation identity", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        pluginTools: [{
          installationId: "plugin-installation-1",
          manifestIdentity: "manifest-1",
          name: "acme.search__lookup_task",
          toolName: "lookup_task",
          title: "Look up task",
          description: "Query the external task index",
          inputSchema: { type: "object" },
        }],
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
    const descriptor = compileRuntimeInterface(compileInput({
      pluginTools: [{
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
      }],
    })).byName.get("acme.search__query");

    expect(() => descriptor?.validateArguments?.({ query: "" }))
      .toThrow(RuntimeToolArgumentsInvalid);
    expect(() => descriptor?.validateArguments?.({ query: "memory", extra: true }))
      .toThrow(RuntimeToolArgumentsInvalid);
    expect(descriptor?.validateArguments?.({ query: "memory" }))
      .toEqual({ query: "memory" });
  });

  it("rejects provider-unsafe tool names before ACPX", () => {
    expect(() => compileRuntimeInterface(compileInput({
      pluginTools: [{
        installationId: "plugin-installation-1",
        manifestIdentity: "manifest-1",
        name: "acme.search:query",
        toolName: "query",
        title: "Search",
        description: "Query an external index",
        inputSchema: { type: "object" },
      }],
    }))).toThrow("Compiled tool name is not provider-safe");
  });

  it("rejects a non-object tool schema before ACPX", () => {
    expect(() => compileRuntimeInterface(compileInput({
      pluginTools: [{
        installationId: "plugin-installation-1",
        manifestIdentity: "manifest-1",
        name: "acme.search__query",
        toolName: "query",
        title: "Search",
        description: "Query an external index",
        inputSchema: { oneOf: [{ type: "object" }] },
      }],
    }))).toThrow("Compiled tool input schema is not an object");
  });

  it("rejects duplicate tool names across plugin installations", () => {
    expect(() => compileRuntimeInterface(compileInput({
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
    }))).toThrow(/Duplicate compiled tool name/);
  });
});
