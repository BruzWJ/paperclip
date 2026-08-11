import { describe, expect, it } from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "../task-runtime.js";
import {
  portabilityAdapterOverrideSchema,
  portabilityAgentManifestEntrySchema,
  portabilityCompanyManifestEntrySchema,
  portabilityEnvInputSchema,
  portabilityTaskManifestEntrySchema,
} from "./company-portability.js";

function ordinaryTask(overrides: Record<string, unknown> = {}) {
  return {
    slug: "portable-task",
    identifier: "PAP-1",
    title: "Portable task",
    path: "tasks/portable-task/TASK.md",
    projectSlug: null,
    ownerAgentSlug: "owner",
    request: "Do the portable work.",
    recurring: false,
    routine: null,
    lifecycleStatus: "open",
    disposition: null,
    boardPresentationStatus: "todo",
    priority: "medium",
    labelIds: [],
    billingCode: null,
    comments: [],
    metadata: null,
    ...overrides,
  };
}

describe("company portability task manifests", () => {
  it("rejects retired context-access masks", () => {
    expect(() =>
      portabilityTaskManifestEntrySchema.parse(
        ordinaryTask({
          contextAccessMask: { read_task_comments: false },
        }),
      ),
    ).toThrow();
    expect(() =>
      portabilityTaskManifestEntrySchema.parse(
        ordinaryTask({
          recurring: true,
          boardPresentationStatus: "active",
          routine: {
            concurrencyPolicy: null,
            catchUpPolicy: null,
            contextAccessMask: { read_sub_task_comments: false },
            variables: null,
            triggers: [],
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      portabilityTaskManifestEntrySchema.parse(
        ordinaryTask({
          attentionMask: { carry_context: false },
        }),
      ),
    ).toThrow();
  });

  it("requires strict terminal disposition and preserves structured-result presence", () => {
    expect(() =>
      portabilityTaskManifestEntrySchema.parse(
        ordinaryTask({
          lifecycleStatus: "done",
          boardPresentationStatus: "done",
          disposition: null,
        }),
      ),
    ).toThrow();
    expect(() =>
      portabilityTaskManifestEntrySchema.parse(
        ordinaryTask({
          disposition: { message: "Not terminal." },
        }),
      ),
    ).toThrow();
    expect(() =>
      portabilityTaskManifestEntrySchema.parse(
        ordinaryTask({
          lifecycleStatus: "cancelled",
          boardPresentationStatus: "cancelled",
          disposition: {
            message: "Cancelled.",
            unexpected: true,
          },
        }),
      ),
    ).toThrow();

    const terminal = portabilityTaskManifestEntrySchema.parse(
      ordinaryTask({
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
  };

  it("preserves exact currency and canonical decimal-string amounts", () => {
    const parsed = portabilityCompanyManifestEntrySchema.parse(portableCompany);
    expect(parsed.budgetCurrency).toBe("USD");
    expect(parsed.budgetMonthlyAmount).toBe(
      "900719925474099312345678.000000001",
    );
  });

  it("accepts and strips retired feedback-sharing fields from older bundles", () => {
    const parsed = portabilityCompanyManifestEntrySchema.parse({
      ...portableCompany,
      feedbackDataSharingEnabled: true,
      feedbackDataSharingConsentAt: "2026-08-06T12:00:00.000Z",
      feedbackDataSharingConsentByUserId: "user-1",
      feedbackDataSharingTermsVersion: "v1",
    });

    expect(parsed).not.toHaveProperty("feedbackDataSharingEnabled");
    expect(parsed).not.toHaveProperty("feedbackDataSharingConsentAt");
    expect(parsed).not.toHaveProperty("feedbackDataSharingConsentByUserId");
    expect(parsed).not.toHaveProperty("feedbackDataSharingTermsVersion");
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
      },
      contextGrants: falseMap(AGENT_CONTEXT_GRANT_KEYS),
      actionGrants: falseMap(PAPERCLIP_ACTION_KEYS),
      mentionReachGrants: falseMap(AGENT_MENTION_REACH_GRANT_KEYS),
      permissionGrants: [],
      budgetMonthlyAmount: "0",
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
      }).adapterConfig,
    ).toEqual({ model: "gpt-5.6" });
  });

  it("rejects runtime-only task actions in portable grant maps", () => {
    const agent = portableAgent({}, {});

    expect(
      portabilityAgentManifestEntrySchema.safeParse({
        ...agent,
        actionGrants: {
          ...agent.actionGrants,
          task_assign: false,
        },
      }).success,
    ).toBe(false);
    expect(
      portabilityAgentManifestEntrySchema.safeParse({
        ...agent,
        actionGrants: {
          ...agent.actionGrants,
          task_update: false,
        },
      }).success,
    ).toBe(false);
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
