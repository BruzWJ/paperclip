import { describe, expect, it } from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "@paperclipai/shared";
import {
  RuntimeRetrievalArgumentsInvalid,
  RuntimeToolUnavailable,
  buildRuntimeRetrievalAbi,
  compileRuntimeInterface,
  createDynamicRuntimeInterface,
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
    agentHireCompanyToolOptions: [],
    selectedCompanyTools: [],
    ...overrides,
  };
}

describe("runtime interface compiler", () => {
  const COMMENT_PREFIX =
    "Reads one chronological bounded page of first-class Session comments. Authorized target tiers: ";
  const RUN_PREFIX =
    "Reads one bounded provider-safe canonical trace page for exactly one run selected by required runId. Authorized target tiers: ";
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
        ).toThrow(RuntimeRetrievalArgumentsInvalid);
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
      ).toThrow(RuntimeRetrievalArgumentsInvalid);
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
          issue_update: true,
          mention_agent: true,
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
    ]);
  });

  it("compiles the exact message-required owner update variants with optional status", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        actionGrants: { issue_update: true },
        isCurrentOwner: true,
        creatorUpdateTargets: [{ issueId: "child-1" }],
      }),
    ).byName.get("issue_update");

    expect(descriptor).toMatchObject({
      name: "issue_update",
      description:
        "Publish an owner message, optionally with a lifecycle/disposition transition, or a creator message to an eligible direct child.",
      source: "paperclip",
    });
    expect(descriptor?.inputSchema).toEqual({
      oneOf: [
        {
          type: "object",
          properties: {
            form: { const: "owner" },
            message: { type: "string", minLength: 1 },
          },
          required: ["form", "message"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            form: { const: "owner" },
            status: { type: "string", enum: ["open", "blocked"] },
            message: { type: "string", minLength: 1 },
          },
          required: ["form", "status", "message"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            form: { const: "owner" },
            status: { type: "string", enum: ["done", "cancelled"] },
            message: { type: "string", minLength: 1 },
            structuredResult: {},
          },
          required: ["form", "status", "message"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            form: { const: "creator_message" },
            creatorTargetIssueId: {
              type: "string",
              enum: ["child-1"],
            },
            message: { type: "string", minLength: 1 },
          },
          required: ["form", "creatorTargetIssueId", "message"],
          additionalProperties: false,
        },
      ],
    });
  });

  it("omits the owner update variants when the run is not the current owner", () => {
    const descriptor = compileRuntimeInterface(
      compileInput({
        actionGrants: { issue_update: true },
        isCurrentOwner: false,
        creatorUpdateTargets: [{ issueId: "child-1" }],
      }),
    ).byName.get("issue_update");

    expect(descriptor?.inputSchema).toEqual({
      oneOf: [
        {
          type: "object",
          properties: {
            form: { const: "creator_message" },
            creatorTargetIssueId: {
              type: "string",
              enum: ["child-1"],
            },
            message: { type: "string", minLength: 1 },
          },
          required: ["form", "creatorTargetIssueId", "message"],
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
          issue_assign: true,
          issue_update: true,
          mention_agent: true,
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
      "agent_hire",
      "agent_configure",
    ]);
  });

  it("omits mention and assignment when their call-time catalogs are empty", () => {
    const result = compileRuntimeInterface(
      compileInput({
        actionGrants: {
          issue_assign: true,
          mention_agent: true,
        },
      }),
    );
    expect(result.descriptors).toEqual([]);
  });

  it("exposes only the closed runtime-agent configuration cells", () => {
    const companyToolId = "11111111-1111-4111-8111-111111111111";
    const result = compileRuntimeInterface(
      compileInput({
        actionGrants: { agent_hire: true, agent_configure: true },
        configureTargets: [{ id: "agent-1" }],
        agentHireCompanyToolOptions: [
          {
            catalogEntryId: companyToolId,
            connectionId: "22222222-2222-4222-8222-222222222222",
            connectionName: "Records",
            title: "Lookup record",
            description: "Look up a record",
            catalogVersionHash: "catalog-v1",
          },
        ],
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
      "contextGrants",
      "actionGrants",
      "mentionReachGrants",
      "companyToolIds",
    ]);
    expect(hire.inputSchema.properties).not.toHaveProperty("reportsTo");
    expect(
      hire.inputSchema.properties?.companyToolIds.items?.enum,
    ).toEqual([companyToolId]);
    const completeHire = {
      name: "Child",
      title: null,
      capabilities: null,
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
    expect(() =>
      hire.validateArguments?.({
        ...completeHire,
        companyToolIds: [companyToolId],
      }),
    ).not.toThrow();
    expect(() =>
      hire.validateArguments?.({
        ...completeHire,
        companyToolIds: [
          "33333333-3333-4333-8333-333333333333",
        ],
      }),
    ).toThrow(/companyToolIds/);
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

  it("accepts only an empty hire tool selection when no create option exists", () => {
    const hire = compileRuntimeInterface(
      compileInput({
        actionGrants: { agent_hire: true },
        agentHireCompanyToolOptions: [],
      }),
    ).byName.get("agent_hire")!;
    expect(hire.inputSchema.properties?.companyToolIds).toMatchObject({
      type: "array",
      minItems: 0,
      maxItems: 0,
    });
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

  it("rejects company tool collisions with the closed Paperclip catalog", () => {
    expect(() =>
      compileRuntimeInterface(
        compileInput({
          selectedCompanyTools: [
            {
              id: "tool-1",
              name: "issue_update",
              title: "Collision",
              description: "Bad",
              inputSchema: { type: "object" },
            },
          ],
        }),
      ),
    ).toThrow(/collides/);
  });

  it("re-resolves narrowing and widening before every list and call", async () => {
    let enabled = true;
    const dynamic = createDynamicRuntimeInterface({
      async resolve() {
        return compileInput({
          actionGrants: { issue_create: enabled },
        });
      },
    });

    expect((await dynamic.list()).map((tool) => tool.name)).toEqual([
      "issue_create",
    ]);
    enabled = false;
    await expect(dynamic.resolveCall("issue_create")).rejects.toBeInstanceOf(
      RuntimeToolUnavailable,
    );
    enabled = true;
    await expect(dynamic.resolveCall("issue_create")).resolves.toMatchObject({
      name: "issue_create",
    });
  });

  it("rebuilds the live agent-hire company-tool id catalog before a call", async () => {
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    let catalogEntryId = firstId;
    const dynamic = createDynamicRuntimeInterface({
      async resolve() {
        return compileInput({
          actionGrants: { agent_hire: true },
          agentHireCompanyToolOptions: [
            {
              catalogEntryId,
              connectionId:
                "33333333-3333-4333-8333-333333333333",
              connectionName: "Records",
              title: "Lookup record",
              description: "Look up a record",
              catalogVersionHash: "catalog-v1",
            },
          ],
        });
      },
    });
    const listed = (await dynamic.list()).find(
      (tool) => tool.name === "agent_hire",
    )!;
    expect(
      listed.inputSchema.properties?.companyToolIds.items?.enum,
    ).toEqual([firstId]);

    catalogEntryId = secondId;
    const call = await dynamic.resolveCall("agent_hire");
    expect(
      call.inputSchema.properties?.companyToolIds.items?.enum,
    ).toEqual([secondId]);
  });
});
