import { describe, expect, it } from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "../issue-runtime.js";
import {
  portabilityAdapterOverrideSchema,
  portabilityAgentManifestEntrySchema,
  portabilityCompanyManifestEntrySchema,
  portabilityEnvInputSchema,
  portabilityIssueManifestEntrySchema,
} from "./company-portability.js";

function ordinaryIssue(overrides: Record<string, unknown> = {}) {
  return {
    slug: "portable-issue",
    identifier: "PAP-1",
    title: "Portable issue",
    path: "issues/portable-issue/ISSUE.md",
    projectSlug: null,
    projectWorkspaceKey: null,
    ownerAgentSlug: "owner",
    request: "Do the portable work.",
    recurring: false,
    routine: null,
    lifecycleStatus: "open",
    disposition: null,
    attentionMask: null,
    boardPresentationStatus: "todo",
    priority: "medium",
    labelIds: [],
    billingCode: null,
    executionWorkspaceSettings: null,
    comments: [],
    metadata: null,
    ...overrides,
  };
}

describe("company portability issue manifests", () => {
  it("normalizes raw true away and retains only false mask cells", () => {
    const parsed = portabilityIssueManifestEntrySchema.parse(
      ordinaryIssue({
        attentionMask: {
          carry_context: true,
          read_issue_comments: false,
        },
      }),
    );

    expect(parsed.attentionMask).toEqual({
      read_issue_comments: false,
    });

    const recurring = portabilityIssueManifestEntrySchema.parse(
      ordinaryIssue({
        recurring: true,
        boardPresentationStatus: "active",
        routine: {
          concurrencyPolicy: null,
          catchUpPolicy: null,
          attentionMask: {
            list_sub_issues: true,
            read_sub_issue_comments: false,
          },
          variables: null,
          triggers: [],
        },
      }),
    );
    expect(recurring.routine?.attentionMask).toEqual({
      read_sub_issue_comments: false,
    });
  });

  it("rejects unknown and non-boolean mask cells", () => {
    expect(() =>
      portabilityIssueManifestEntrySchema.parse(
        ordinaryIssue({
          attentionMask: { unknown_context: false },
        }),
      ),
    ).toThrow();
    expect(() =>
      portabilityIssueManifestEntrySchema.parse(
        ordinaryIssue({
          attentionMask: { carry_context: "false" },
        }),
      ),
    ).toThrow();
  });

  it("requires strict terminal disposition and preserves structured-result presence", () => {
    expect(() =>
      portabilityIssueManifestEntrySchema.parse(
        ordinaryIssue({
          lifecycleStatus: "done",
          boardPresentationStatus: "done",
          disposition: null,
        }),
      ),
    ).toThrow();
    expect(() =>
      portabilityIssueManifestEntrySchema.parse(
        ordinaryIssue({
          disposition: { message: "Not terminal." },
        }),
      ),
    ).toThrow();
    expect(() =>
      portabilityIssueManifestEntrySchema.parse(
        ordinaryIssue({
          lifecycleStatus: "cancelled",
          boardPresentationStatus: "cancelled",
          disposition: {
            message: "Cancelled.",
            unexpected: true,
          },
        }),
      ),
    ).toThrow();

    const terminal = portabilityIssueManifestEntrySchema.parse(
      ordinaryIssue({
        lifecycleStatus: "done",
        boardPresentationStatus: "done",
        disposition: {
          message: "Completed.",
          structuredResult: null,
        },
      }),
    );
    expect(terminal.disposition).toEqual({
      message: "Completed.",
      structuredResult: null,
    });
  });
});

describe("company portability money contract", () => {
  const portableCompany = {
    path: "COMPANY.md",
    name: "Portable company",
    description: null,
    brandColor: null,
    logoPath: null,
    budgetCurrency: "USD",
    budgetMonthlyAmount: "900719925474099312345678.000000001",
    attachmentMaxBytes: null,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
  };

  it("preserves exact currency and canonical decimal-string amounts", () => {
    const parsed = portabilityCompanyManifestEntrySchema.parse(portableCompany);
    expect(parsed.budgetCurrency).toBe("USD");
    expect(parsed.budgetMonthlyAmount).toBe(
      "900719925474099312345678.000000001",
    );
  });

  it("rejects normalized currencies and noncanonical or numeric amounts", () => {
    for (const budgetCurrency of ["usd", " USD", "USD "]) {
      expect(
        portabilityCompanyManifestEntrySchema.safeParse({
          ...portableCompany,
          budgetCurrency,
        }).success,
      ).toBe(false);
    }
    for (const budgetMonthlyAmount of ["01", "1.0", "1e3", 1]) {
      expect(
        portabilityCompanyManifestEntrySchema.safeParse({
          ...portableCompany,
          budgetMonthlyAmount,
        }).success,
      ).toBe(false);
    }
  });
});

describe("company portability declarative ACP configuration", () => {
  const falseMap = (keys: readonly string[]) =>
    Object.fromEntries(keys.map((key) => [key, false]));

  function portableAgent(
    adapterConfig: Record<string, unknown>,
    runtimeConfig: Record<string, unknown>,
  ) {
    return {
      slug: "portable-agent",
      name: "Portable agent",
      path: "agents/portable-agent/AGENTS.md",
      skills: [],
      title: null,
      icon: null,
      capabilities: null,
      reportsToSlug: null,
      adapterRevision: {
        sourceRevisionId: "11111111-1111-4111-8111-111111111111",
        adapterType: "codex",
        adapterConfig: { model: "gpt-5.6", ...adapterConfig },
        runtimeConfig,
        sourceEnvironmentId: "22222222-2222-4222-8222-222222222222",
        skillChannel: "operator_native",
      },
      contextGrants: falseMap(AGENT_CONTEXT_GRANT_KEYS),
      actionGrants: falseMap(PAPERCLIP_ACTION_KEYS),
      mentionReachGrants: falseMap(AGENT_MENTION_REACH_GRANT_KEYS),
      companyToolIds: [],
      governance: {},
      permissionGrants: [],
      budgetMonthlyAmount: "0",
      metadata: null,
    };
  }

  it("accepts only explicit non-secret ACP configuration values", () => {
    expect(
      portabilityAgentManifestEntrySchema.parse(
        portableAgent({}, {}),
      ).adapterRevision.adapterConfig,
    ).toEqual({ model: "gpt-5.6" });

    expect(
      portabilityAdapterOverrideSchema.parse({
        adapterType: "codex",
        adapterConfig: { model: "gpt-5.6" },
        defaultEnvironmentId: "22222222-2222-4222-8222-222222222222",
        skillChannel: "operator_native",
      }).adapterConfig,
    ).toEqual({ model: "gpt-5.6" });
  });

  it("rejects retired provider execution, inline environment, and auth fields", () => {
    for (const adapterConfig of [
      { command: "codex" },
      { args: ["--model", "gpt-5.6"] },
      { extraArgs: [] },
      { env: { OPENAI_API_KEY: "secret" } },
      { envVars: { OPENAI_API_KEY: "secret" } },
      { envBindings: {} },
      { provider: "openai" },
      { url: "https://provider.invalid" },
      { password: "secret" },
      { nested: { token: "secret" } },
      {
        nested: {
          binding: {
            type: "secret_ref",
            secretId: "33333333-3333-4333-8333-333333333333",
            version: "latest",
          },
        },
      },
    ]) {
      expect(
        portabilityAgentManifestEntrySchema.safeParse(
          portableAgent(adapterConfig, {}),
        ).success,
      ).toBe(false);
      expect(
        portabilityAdapterOverrideSchema.safeParse({
          adapterType: "codex",
          adapterConfig,
          defaultEnvironmentId: "22222222-2222-4222-8222-222222222222",
          skillChannel: "operator_native",
        }).success,
      ).toBe(false);
    }
  });

  it("rejects the retired agent-scoped environment-input shape", () => {
    expect(
      portabilityEnvInputSchema.safeParse({
        key: "OPENAI_API_KEY",
        description: null,
        agentSlug: "portable-agent",
        projectSlug: null,
        kind: "secret",
        requirement: "required",
        defaultValue: null,
        portability: "portable",
      }).success,
    ).toBe(false);
  });
});
