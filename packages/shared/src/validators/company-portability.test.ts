import { describe, expect, it } from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "../task-runtime.js";
import {
  companyPortabilityExportSchema,
  companyPortabilityPreviewSchema,
  portabilityAdapterOverrideSchema,
  portabilityAgentManifestEntrySchema,
  portabilityCompanyManifestEntrySchema,
  portabilityEnvInputSchema,
  portabilityManifestSchema,
  portabilityProjectManifestEntrySchema,
  portabilitySourceSchema,
  portabilityTaskManifestEntrySchema,
} from "./company-portability.js";

describe("company portability manifest version", () => {
  const manifest = {
    schemaVersion: 5,
    generatedAt: "2026-08-11T00:00:00.000Z",
    source: null,
    includes: { company: false, agents: false, projects: false, tasks: false },
    company: null,
    sidebar: null,
    agents: [],
    projects: [],
    tasks: [],
    envInputs: [],
  };

  it("accepts only the canonical schema version", () => {
    expect(portabilityManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      portabilityManifestSchema.safeParse({ ...manifest, schemaVersion: 4 })
        .success,
    ).toBe(false);
    expect(
      portabilityManifestSchema.safeParse({ ...manifest, schemaVersion: 6 })
        .success,
    ).toBe(false);
  });
});

describe("company portability export selectors", () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const projectId = "123e4567-e89b-42d3-a456-426614174000";
  const taskId = "33333333-3333-4333-8333-333333333333";

  it("accepts canonical UUID selectors for live resources", () => {
    expect(
      companyPortabilityExportSchema.parse({
        agents: [agentId],
        projects: [projectId],
        tasks: [taskId],
        projectTasks: [projectId],
        sidebarOrder: { agents: [agentId], projects: [projectId] },
      }),
    ).toMatchObject({
      agents: [agentId],
      projects: [projectId],
      tasks: [taskId],
      projectTasks: [projectId],
      sidebarOrder: { agents: [agentId], projects: [projectId] },
    });

    for (const input of [
      { agents: [] },
      { agents: ["release-captain"] },
      { projects: [projectId, projectId] },
      { tasks: ["PAP-42"] },
      { projectTasks: [projectId.toUpperCase()] },
      { sidebarOrder: { agents: ["release-captain"] } },
    ]) {
      expect(companyPortabilityExportSchema.safeParse(input).success).toBe(
        false,
      );
    }
  });
});

describe("company portability import selectors", () => {
  const base = {
    source: { type: "inline" as const, files: {} },
    target: { mode: "new_company" as const, newCompanyName: "Imported" },
  };

  it("accepts exact package agent slugs or the explicit all mode", () => {
    expect(
      companyPortabilityPreviewSchema.safeParse({ ...base, agents: "all" })
        .success,
    ).toBe(true);
    expect(
      companyPortabilityPreviewSchema.safeParse({
        ...base,
        agents: ["release-captain"],
      }).success,
    ).toBe(true);

    for (const agents of [
      [],
      [" release-captain"],
      ["release-captain", "release-captain"],
    ]) {
      expect(
        companyPortabilityPreviewSchema.safeParse({ ...base, agents }).success,
      ).toBe(false);
    }
  });

  it("requires an exact canonical UUID for an existing company target", () => {
    const companyId = "123e4567-e89b-42d3-a456-426614174000";
    expect(
      companyPortabilityPreviewSchema.safeParse({
        ...base,
        target: { mode: "existing_company", companyId },
      }).success,
    ).toBe(true);
    expect(
      companyPortabilityPreviewSchema.safeParse({
        ...base,
        target: {
          mode: "existing_company",
          companyId: companyId.toUpperCase(),
        },
      }).success,
    ).toBe(false);
    expect(
      companyPortabilityPreviewSchema.safeParse({
        ...base,
        target: { mode: "existing_company", companyId: ` ${companyId}` },
      }).success,
    ).toBe(false);
  });
});

describe("company portability remote source", () => {
  it("accepts only the canonical GitHub URL identity", () => {
    expect(
      portabilitySourceSchema.safeParse({
        type: "github",
        url: "https://github.com/paperclipai/companies?ref=main&path=gstack",
      }).success,
    ).toBe(true);

    for (const url of [
      "https://github.com/paperclipai/companies",
      "https://github.com/paperclipai/companies/tree/main/gstack",
      " https://github.com/paperclipai/companies?ref=main",
    ]) {
      expect(
        portabilitySourceSchema.safeParse({ type: "github", url }).success,
      ).toBe(false);
    }

    expect(
      portabilitySourceSchema.safeParse({
        type: "github",
        url: "https://github.com/paperclipai/companies?ref=main",
        ref: "release",
      }).success,
    ).toBe(false);
    expect(
      companyPortabilityPreviewSchema.safeParse({
        source: {
          type: "github",
          url: "https://github.com/paperclipai/companies?ref=main",
        },
        target: { mode: "new_company", newCompanyName: "Imported" },
        ref: "release",
      }).success,
    ).toBe(false);
  });
});

describe("company portability package paths", () => {
  const sourceFiles = {
    "COMPANY.md": "---\nname: Portable\n---\n",
    ".paperclip.yaml": "schema: paperclip/v1\n",
  };

  it("preserves exact inline source path identities", () => {
    expect(
      portabilitySourceSchema.parse({
        type: "inline",
        rootPath: "portable-company",
        files: sourceFiles,
      }),
    ).toEqual({
      type: "inline",
      rootPath: "portable-company",
      files: sourceFiles,
    });
  });

  it("rejects inline roots and file keys that would need normalization", () => {
    for (const source of [
      { type: "inline", rootPath: " portable-company", files: sourceFiles },
      { type: "inline", rootPath: "portable-company/", files: sourceFiles },
      {
        type: "inline",
        files: { ...sourceFiles, "./agents/lead/AGENTS.md": "" },
      },
      {
        type: "inline",
        files: { ...sourceFiles, "agents\\lead\\AGENTS.md": "" },
      },
      {
        type: "inline",
        files: { ...sourceFiles, "agents/../lead/AGENTS.md": "" },
      },
    ]) {
      expect(portabilitySourceSchema.safeParse(source).success).toBe(false);
    }
  });

  it("requires nonempty, unique, exact selected file paths", () => {
    const previewBase = {
      source: { type: "inline" as const, files: sourceFiles },
      target: { mode: "new_company" as const, newCompanyName: "Portable" },
    };
    expect(
      companyPortabilityExportSchema.parse({
        selectedFiles: ["COMPANY.md", ".paperclip.yaml"],
      }).selectedFiles,
    ).toEqual(["COMPANY.md", ".paperclip.yaml"]);
    expect(
      companyPortabilityPreviewSchema.parse({
        ...previewBase,
        selectedFiles: ["COMPANY.md"],
      }).selectedFiles,
    ).toEqual(["COMPANY.md"]);

    for (const selectedFiles of [
      [],
      ["COMPANY.md", "COMPANY.md"],
      ["./COMPANY.md"],
      ["/COMPANY.md"],
    ]) {
      expect(
        companyPortabilityExportSchema.safeParse({ selectedFiles }).success,
      ).toBe(false);
      expect(
        companyPortabilityPreviewSchema.safeParse({
          ...previewBase,
          selectedFiles,
        }).success,
      ).toBe(false);
    }
  });
});

function ordinaryTask(overrides: Record<string, unknown> = {}) {
  return {
    slug: "portable-task",
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

  it("rejects retired feedback-sharing fields", () => {
    const parsed = portabilityCompanyManifestEntrySchema.safeParse({
      ...portableCompany,
      feedbackDataSharingEnabled: true,
      feedbackDataSharingConsentAt: "2026-08-06T12:00:00.000Z",
      feedbackDataSharingConsentByUserId: "user-1",
      feedbackDataSharingTermsVersion: "v1",
    });
    expect(parsed.success).toBe(false);
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

describe("company portability project contract", () => {
  const project = {
    slug: "control-plane",
    name: "Control Plane",
    path: "projects/control-plane/PROJECT.md",
    description: null,
    ownerAgentSlug: "release-captain",
    leadAgentSlug: "release-captain",
    targetDate: null,
    color: null,
    icon: "folder",
    status: "in_progress",
    env: null,
    metadata: null,
  };

  it("preserves opaque package slugs and requires a canonical icon", () => {
    expect(
      portabilityProjectManifestEntrySchema.safeParse(project).success,
    ).toBe(true);
    expect(
      portabilityProjectManifestEntrySchema.safeParse({
        ...project,
        slug: "Control-Plane",
      }).success,
    ).toBe(true);
    expect(
      portabilityProjectManifestEntrySchema.safeParse({
        ...project,
        icon: "not-an-icon",
      }).success,
    ).toBe(false);
  });
});

describe("company portability declarative ACP configuration", () => {
  const falseMap = (keys: readonly string[]) =>
    Object.fromEntries(keys.map((key) => [key, false]));

  function portableAgent() {
    return {
      slug: "portable-agent",
      name: "Portable agent",
      path: "agents/portable-agent/AGENTS.md",
      title: null,
      icon: null,
      capabilities: null,
      reportsToSlug: null,
      adapterRevision: {
        sourceRevisionId: "11111111-1111-4111-8111-111111111111",
        acpConfiguration: {
          contractVersion: "acpx-runtime/v1",
          launchProfile: { registryName: "codex" },
          sessionConfigSelections: [{ configId: "model", value: "gpt-5.6" }],
          model: { value: "gpt-5.6", label: "GPT-5.6" },
        },
      },
      contextGrants: falseMap(AGENT_CONTEXT_GRANT_KEYS),
      actionGrants: falseMap(PAPERCLIP_ACTION_KEYS),
      mentionReachGrants: falseMap(AGENT_MENTION_REACH_GRANT_KEYS),
      permissionGrants: [],
      budgetMonthlyAmount: "0",
    };
  }

  it("carries one exact immutable ACPX configuration", () => {
    expect(
      portabilityAgentManifestEntrySchema.parse(portableAgent()).adapterRevision
        .acpConfiguration.launchProfile.registryName,
    ).toBe("codex");

    expect(
      portabilityAdapterOverrideSchema.parse({
        adapterType: "codex",
        adapterConfig: { model: "gpt-5.6" },
      }).adapterConfig,
    ).toEqual({ model: "gpt-5.6" });
  });

  it("preserves opaque package agent slugs", () => {
    const agent = portableAgent();
    expect(portabilityAgentManifestEntrySchema.safeParse(agent).success).toBe(
      true,
    );
    expect(
      portabilityAgentManifestEntrySchema.safeParse({
        ...agent,
        slug: "Portable-Agent",
      }).success,
    ).toBe(true);
    expect(
      portabilityAgentManifestEntrySchema.safeParse({
        ...agent,
        reportsToSlug: " Parent-Agent ",
      }).success,
    ).toBe(false);
  });

  it("rejects runtime-only task actions in portable grant maps", () => {
    const agent = portableAgent();

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

  it("rejects non-native ACPX option values in target overrides", () => {
    for (const adapterConfig of [
      { args: ["--model", "gpt-5.6"] },
      { env: { OPENAI_API_KEY: "secret" } },
      { nested: { token: "secret" } },
    ]) {
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
