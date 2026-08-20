import "./runtime-interface-compiler.test-suite-02-compiles-mention-agent-as-a.js";
import * as t from "./runtime-interface-compiler.test-support.js";
const { describe, it, compileRuntimeInterface, compileInput, resolveContextDial } = t;
const { AGENT_CONTEXT_GRANT_KEYS, expect, reachCases } = t;
const { PAPERCLIP_MANAGED_TOOL_METADATA, COMMENT_PREFIX, normalizeRuntimeCommand } = t;
const { RuntimeToolArgumentsInvalid, RUN_PREFIX } = t;

describe("runtime interface compiler", () => {
  it("exposes only granted organizational reads during bootstrap", () => {
    const result = compileRuntimeInterface(
      compileInput({
        turn: "bootstrap",
        contextDial: resolveContextDial({
          agent: Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, true])),
        }).effective,
        actionGrants: {
          list_all_agents: true,
          agent_configure: true,
          agent_hire: true,
        },
      }),
    );
    expect(result.descriptors.map((tool) => tool.name)).toEqual(["list_agents", "agent_read"]);
  });

  it.each(reachCases)(
    "describes and parses the exact comment union current=$current descendant=$descendant company=$company",
    ({ current, descendant, company, commentTiers }) => {
      const descriptor = compileRuntimeInterface(
        compileInput({
          contextDial: resolveContextDial({
            agent: {
              read_task_comments: current,
              read_sub_task_comments: descendant,
              read_company_task_comments: company,
            },
          }).effective,
        }),
      ).byName.get("read_task_comments");
      if (!commentTiers) {
        expect(descriptor).toBeUndefined();
        return;
      }
      expect(descriptor?.description).toBe(
        `${PAPERCLIP_MANAGED_TOOL_METADATA.read_task_comments.description} ${COMMENT_PREFIX}${commentTiers}.`,
      );
      expect(descriptor?.inputSchema.required).toEqual(current ? [] : ["taskId"]);
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
        expect(() => normalizeRuntimeCommand(descriptor, {})).toThrow(RuntimeToolArgumentsInvalid);
      }
    },
  );

  it.each(reachCases)(
    "describes the exact run union current=$current descendant=$descendant company=$company",
    ({ current, descendant, company, runTiers }) => {
      const descriptor = compileRuntimeInterface(
        compileInput({
          contextDial: resolveContextDial({
            agent: {
              read_task_agent_run: current,
              read_sub_task_agent_run: descendant,
              read_company_task_agent_run: company,
            },
          }).effective,
        }),
      ).byName.get("read_task_agent_run");
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
      expect(() => normalizeRuntimeCommand(descriptor, {})).toThrow(RuntimeToolArgumentsInvalid);
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
      const descriptor = compileRuntimeInterface(
        compileInput({
          contextDial: resolveContextDial({
            agent: {
              list_sub_tasks: sub,
              list_company_tasks: company,
            },
          }).effective,
        }),
      ).byName.get("list_sub_tasks");
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
        mentionTargets: [{ id: "agent-2", name: "Reviewer", capabilities: "Review" }],
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

  it("exposes only read-only Paperclip tools and no plugin tools for a response-only turn", () => {
    const result = compileRuntimeInterface(
      compileInput({
        readOnly: true,
        contextDial: resolveContextDial({
          agent: Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, true])),
        }).effective,
        actionGrants: { task_create: true },
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
    );

    expect(result.descriptors).not.toHaveLength(0);
    expect(
      result.descriptors.every(
        (tool) =>
          tool.source === "paperclip" &&
          PAPERCLIP_MANAGED_TOOL_METADATA[tool.name as keyof typeof PAPERCLIP_MANAGED_TOOL_METADATA].readOnly,
      ),
    ).toBe(true);
    expect(result.byName.has("task_update")).toBe(false);
    expect(result.byName.has("acme.search__lookup_task")).toBe(false);
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
      description: `${PAPERCLIP_MANAGED_TOOL_METADATA.task_update.description} Publish one canonical task comment, optionally update lifecycle, and automatically mention the creator/owner counterpart in that counterpart's task context. Omit taskId to update the active task as its current owner, including terminal done or cancelled disposition; provide an eligible direct-child taskId to update it as its exact creator with a message, open, or blocked status.`,
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
        mentionTargets: [{ id: "agent-2", name: "Reviewer", capabilities: null }],
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
    expect(result.descriptors.map((tool) => tool.name)).toEqual(["task_create"]);
  });
});
