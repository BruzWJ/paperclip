import { describe, expect, it } from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "@paperclipai/shared";
import {
  RuntimeToolArgumentsInvalid,
  buildRuntimeRetrievalAbi,
  compileRuntimeInterface,
} from "../services/runtime-interface-compiler.ts";
import { resolveContextDial } from "../services/context-dial-resolver.ts";

function compileInput(
  overrides: Partial<Parameters<typeof compileRuntimeInterface>[0]> = {},
): Parameters<typeof compileRuntimeInterface>[0] {
  return {
    mode: "owner",
    contextDial: resolveContextDial({ agent: {} }).effective,
    actionGrants: {},
    isCurrentOwner: true,
    issueCreateDirectChildren: [],
    issueAssignTargets: [],
    creatorUpdateTargets: [],
    mentionTargets: [],
    configureTargets: [],
    pluginTools: [],
    ...overrides,
  };
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
        "any issue in this run's company through an explicit issueId",
      runTiers: "a run on any issue in this run's company",
    },
    {
      current: false,
      descendant: true,
      company: false,
      commentTiers:
        "a proper descendant of the active issue through an explicit issueId",
      runTiers: "a run on a proper descendant of the active issue",
    },
    {
      current: false,
      descendant: true,
      company: true,
      commentTiers:
        "a proper descendant of the active issue through an explicit issueId; any issue in this run's company through an explicit issueId",
      runTiers:
        "a run on a proper descendant of the active issue; a run on any issue in this run's company",
    },
    {
      current: true,
      descendant: false,
      company: false,
      commentTiers:
        "the active issue (omit issueId or pass it explicitly)",
      runTiers: "a run on the active issue",
    },
    {
      current: true,
      descendant: false,
      company: true,
      commentTiers:
        "the active issue (omit issueId or pass it explicitly); any issue in this run's company through an explicit issueId",
      runTiers:
        "a run on the active issue; a run on any issue in this run's company",
    },
    {
      current: true,
      descendant: true,
      company: false,
      commentTiers:
        "the active issue (omit issueId or pass it explicitly); a proper descendant of the active issue through an explicit issueId",
      runTiers:
        "a run on the active issue; a run on a proper descendant of the active issue",
    },
    {
      current: true,
      descendant: true,
      company: true,
      commentTiers:
        "the active issue (omit issueId or pass it explicitly); a proper descendant of the active issue through an explicit issueId; any issue in this run's company through an explicit issueId",
      runTiers:
        "a run on the active issue; a run on a proper descendant of the active issue; a run on any issue in this run's company",
    },
  ] as const;

  it.each(reachCases)(
    "describes and parses the exact comment union current=$current descendant=$descendant company=$company",
    ({ current, descendant, company, commentTiers }) => {
      const abi = buildRuntimeRetrievalAbi(
        resolveContextDial({
          agent: {
            read_issue_comments: current,
            read_sub_issue_comments: descendant,
            read_company_issue_comments: company,
          },
        }).effective,
      );
      const descriptor = abi.descriptors.find(
        (candidate) => candidate.name === "read_issue_comments",
      );
      if (!commentTiers) {
        expect(descriptor).toBeUndefined();
        return;
      }
      expect(descriptor?.description).toBe(
        `${COMMENT_PREFIX}${commentTiers}.`,
      );
      expect(descriptor?.inputSchema.required).toEqual(
        current ? [] : ["issueId"],
      );
      if (current) {
        expect(abi.parse("read_issue_comments", {})).toEqual({
          name: "read_issue_comments",
          issueId: undefined,
          cursor: undefined,
        });
      } else {
        expect(() =>
          abi.parse("read_issue_comments", {}),
        ).toThrow(RuntimeToolArgumentsInvalid);
      }
    },
  );

  it.each(reachCases)(
    "describes the exact run union current=$current descendant=$descendant company=$company",
    ({ current, descendant, company, runTiers }) => {
      const abi = buildRuntimeRetrievalAbi(
        resolveContextDial({
          agent: {
            read_issue_agent_run: current,
            read_sub_issue_agent_run: descendant,
            read_company_issue_agent_run: company,
          },
        }).effective,
      );
      const descriptor = abi.descriptors.find(
        (candidate) => candidate.name === "read_issue_agent_run",
      );
      if (!runTiers) {
        expect(descriptor).toBeUndefined();
        return;
      }
      expect(descriptor?.description).toBe(`${RUN_PREFIX}${runTiers}.`);
      expect(descriptor?.inputSchema.required).toEqual(["runId"]);
      expect(
        abi.parse("read_issue_agent_run", {
          runId: "run-1",
          cursor: "opaque-page-2",
        }),
      ).toEqual({
        name: "read_issue_agent_run",
        runId: "run-1",
        cursor: "opaque-page-2",
      });
      expect(() =>
        abi.parse("read_issue_agent_run", {}),
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
        "Lists one bounded page of direct children. Omit issueId to list the active issue's direct children. With issueId, only a proper descendant of the active issue is accepted; the active issue itself is rejected.",
    },
    {
      sub: false,
      company: true,
      description:
        "Lists one bounded page of direct children. Omit issueId to list the active issue's direct children. With issueId, any issue in this run's company is accepted, including the active issue.",
    },
    {
      sub: true,
      company: true,
      description:
        "Lists one bounded page of direct children. Omit issueId to list the active issue's direct children. With issueId, any issue in this run's company is accepted, including the active issue.",
    },
  ] as const)(
    "describes the exact sub-list union sub=$sub company=$company",
    ({ sub, company, description }) => {
      const abi = buildRuntimeRetrievalAbi(
        resolveContextDial({
          agent: {
            list_sub_issues: sub,
            list_company_issues: company,
          },
        }).effective,
      );
      const descriptor = abi.descriptors.find(
        (candidate) => candidate.name === "list_sub_issues",
      );
      if (description === null) {
        expect(descriptor).toBeUndefined();
        return;
      }
      expect(descriptor?.description).toBe(description);
      expect(descriptor?.inputSchema.required).toEqual([]);
      expect(abi.parse("list_sub_issues", {})).toEqual({
        name: "list_sub_issues",
        issueId: undefined,
        cursor: undefined,
      });
    },
  );

  it("compiles only effective retrieval unions and granted actions", () => {
    const result = compileRuntimeInterface(
      compileInput({
        contextDial: resolveContextDial({
          agent: {
            list_company_issues: true,
            read_sub_issue_comments: true,
          },
        }).effective,
        actionGrants: {
          issue_create: true,
          mention_agent: true,
          mention_board: true,
        },
        creatorUpdateTargets: [{ issueId: "child-1", identifier: "PAP-1" }],
        mentionTargets: [
          { id: "agent-2", name: "Reviewer", capabilities: "Review" },
        ],
      }),
    );

    expect(result.descriptors.map((tool) => tool.name)).toEqual([
      "list_company_issues",
      "list_sub_issues",
      "read_issue_comments",
      "issue_create",
      "issue_update",
      "mention_agent",
      "mention_board",
    ]);
  });

  it("compiles one canonical owner-or-creator update ABI with automatic counterpart mention", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        isCurrentOwner: true,
        creatorUpdateTargets: [{ issueId: "child-1" }],
      }),
    ).byName.get("issue_update");

    expect(descriptor).toMatchObject({
      name: "issue_update",
      description:
        "Publish one canonical issue comment, optionally update lifecycle, and automatically mention the creator/owner counterpart in that counterpart's issue context. Omit issueId to update the active issue as its current owner, including terminal done or cancelled disposition; provide an eligible direct-child issueId to update it as its exact creator with a message, open, or blocked status.",
      source: "paperclip",
    });
    expect(descriptor?.inputSchema).toEqual({
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
            issueId: {
              type: "string",
              enum: ["child-1"],
            },
            message: { type: "string", minLength: 1 },
          },
          required: ["issueId", "message"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            issueId: {
              type: "string",
              enum: ["child-1"],
            },
            status: { type: "string", enum: ["open", "blocked"] },
            message: { type: "string", minLength: 1 },
          },
          required: ["issueId", "status", "message"],
          additionalProperties: false,
        },
      ],
    });
  });

  it("requires an exact child issueId when only creator authority is available", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        isCurrentOwner: false,
        creatorUpdateTargets: [{ issueId: "child-1" }],
      }),
    ).byName.get("issue_update");

    expect(descriptor?.inputSchema).toEqual({
      oneOf: [
        {
          type: "object",
          properties: {
            issueId: {
              type: "string",
              enum: ["child-1"],
            },
            message: { type: "string", minLength: 1 },
          },
          required: ["issueId", "message"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            issueId: {
              type: "string",
              enum: ["child-1"],
            },
            status: { type: "string", enum: ["open", "blocked"] },
            message: { type: "string", minLength: 1 },
          },
          required: ["issueId", "status", "message"],
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
          issue_create: true,
          mention_agent: true,
          mention_board: true,
          agent_hire: true,
          agent_configure: true,
        },
        issueAssignTargets: [
          {
            issueId: "child",
            identifier: "PAP-2",
            owners: [{ kind: "self" }],
          },
        ],
        creatorUpdateTargets: [{ issueId: "child", identifier: "PAP-2" }],
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

  it("uses issue_create as the sole create-and-assign grant", () => {
    const issueAssignTargets = [
      {
        issueId: "child",
        identifier: "PAP-2",
        owners: [{ kind: "self" as const }],
      },
    ];

    expect(
      compileRuntimeInterface(
        compileInput({
          isCurrentOwner: false,
          issueAssignTargets,
        }),
      ).descriptors,
    ).toEqual([]);

    expect(
      compileRuntimeInterface(
        compileInput({
          isCurrentOwner: false,
          actionGrants: { issue_create: true },
          issueAssignTargets,
        }),
      ).descriptors.map((tool) => tool.name),
    ).toEqual(["issue_create", "issue_assign"]);
  });

  it("omits mention and assignment when their call-time catalogs are empty", () => {
    const result = compileRuntimeInterface(
      compileInput({
        actionGrants: {
          issue_create: true,
          mention_agent: true,
        },
        isCurrentOwner: false,
      }),
    );
    expect(result.descriptors.map((tool) => tool.name)).toEqual([
      "issue_create",
    ]);
  });

  it("compiles mention_agent as a canonical non-terminal comment", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        actionGrants: { mention_agent: true },
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
    expect(descriptor.validateArguments?.({
      agentId: "agent-2",
      message: "Please review",
    })).toEqual({
      agentId: "agent-2",
      message: "Please review",
    });
    expect(() => descriptor.validateArguments?.({
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
        "Post one canonical issue comment mentioning the collective Board for information or direction. The asynchronous call is non-terminal and does not change issue lifecycle, approvals, or review.",
      inputSchema: {
        type: "object",
        required: ["message"],
        additionalProperties: false,
        properties: {
          message: { type: "string", minLength: 1 },
        },
      },
    });
    expect(() => descriptor?.validateArguments?.({
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
    ).toHaveLength(7);
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
    expect(() => hire.validateArguments?.(completeHire)).not.toThrow();
    expect(configure.inputSchema.properties?.agentId).toEqual({
      type: "string",
      enum: ["agent-1"],
    });
    expect(configure.inputSchema.minProperties).toBe(2);
    expect(configure.inputSchema.properties?.title).toEqual({
      anyOf: [{ type: "string", maxLength: 240 }, { type: "null" }],
    });
    expect(configure.inputSchema.properties?.reportsTo).toEqual({
      anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
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
      configure.validateArguments?.({ agentId: "agent-2", title: null }),
    ).toThrow(/Invalid enum value/);
    expect(() =>
      configure.validateArguments?.({ agentId: "agent-1" }),
    ).toThrow(/At least one runtime-agent configuration field/);
    expect(
      configure.validateArguments?.({ agentId: "agent-1", title: null }),
    ).toEqual({ agentId: "agent-1", title: null });
  });

  it("compiles administrator-installed plugin tools with immutable installation identity", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        pluginTools: [{
          installationId: "plugin-installation-1",
          manifestIdentity: "manifest-1",
          name: "acme.search__lookup_issue",
          toolName: "lookup_issue",
          title: "Look up issue",
          description: "Query the external issue index",
          inputSchema: { type: "object" },
        }],
      }),
    ).byName.get("acme.search__lookup_issue");

    expect(descriptor).toMatchObject({
      source: "plugin",
      pluginInstallationId: "plugin-installation-1",
      pluginManifestIdentity: "manifest-1",
      pluginToolName: "lookup_issue",
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

  it("exposes restore_session only for a target-not-found recovery compilation", () => {
    const ordinary = compileRuntimeInterface(compileInput());
    expect(ordinary.byName.has("restore_session")).toBe(false);

    const descriptor = compileRuntimeInterface(compileInput({
      restoreSession: true,
    })).byName.get("restore_session");
    expect(descriptor).toMatchObject({
      source: "paperclip",
      bootstrapEnabled: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
    });
    expect(descriptor?.validateArguments?.({})).toEqual({});
    expect(descriptor?.validateArguments?.({
      runId: "prior-run",
      cursor: "next-page",
    })).toEqual({
      runId: "prior-run",
      cursor: "next-page",
    });
    expect(() => descriptor?.validateArguments?.({ cursor: "next-page" }))
      .toThrow(RuntimeToolArgumentsInvalid);
  });

  it("reserves restore_session from plugins even outside a recovery", () => {
    expect(() => compileRuntimeInterface(compileInput({
      pluginTools: [{
        installationId: "plugin-installation-1",
        manifestIdentity: "manifest-1",
        name: "restore_session",
        toolName: "restore_session",
        title: "Forged restore",
        description: "Forged core tool",
        inputSchema: { type: "object" },
      }],
    }))).toThrow(/External tool collides with Paperclip tool/);
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
