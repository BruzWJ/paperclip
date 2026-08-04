import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogTeam } from "@paperclipai/shared";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  installFromCatalog: vi.fn(),
  importFromSource: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/company-portability.js", () => ({
  companyPortabilityService: () => mockCompanyPortabilityService,
}));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => mockCompanySkillService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../adapters/registry.js", () => {
  const catalogModel = (id: string) => ({
    id,
    label: id,
    value: id,
    limits: {
      contextTokenLimit: 200_000,
      outputTokenLimit: 16_000,
    },
  });
  const externalModels = [catalogModel("operator-selected")];
  const disabledModels = [catalogModel("model")];
  const declarativeAdapter = (
    type: string,
    models: readonly ReturnType<typeof catalogModel>[],
  ) => ({
    type,
    definition: {
      version: "acpx-runtime/v1",
      launchProfile: { registryName: type },
      environment: {
        cwd: "execution-workspace",
        additionalDirectories: "authorized-workspace-only",
        drivers: ["local", "ssh", "sandbox", "plugin"],
        environmentKeys: [],
      },
      runtime: {
        controls: ["session/status", "session/set_config_option"],
      },
      ui: {
        label: type,
        description: `${type} declarative ACP adapter`,
      },
      configSchema: {
        fields: [
          {
            key: "model",
            label: "Model",
            type: "select",
            required: true,
            options: models.map((model) => ({
              label: model.label,
              value: model.value,
            })),
          },
        ],
      },
      configOptions: [
        {
          id: "model",
          configKey: "model",
          label: "Model",
          required: true,
          values: models.map((model) => ({
            label: model.label,
            value: model.value,
          })),
        },
      ],
      modelConfigOptionId: "model",
      models,
      modelProfiles: [],
      configurationDoc: "Authenticate through the target CLI.",
    },
  });
  const findAdapter = vi.fn((type: string) => {
    if (type === "external_acp") {
      return declarativeAdapter(type, externalModels);
    }
    if (type === "disabled_external") {
      return declarativeAdapter(type, disabledModels);
    }
    return null;
  });
  const implementationIdentity = (type: string) => ({
    adapterType: type,
    definitionVersion: "acpx-runtime/v1" as const,
    protocolVersion: 1 as const,
    origin: "external" as const,
    packageName: `@paperclipai/test-${type}`,
    packageVersion: "1.0.0",
    buildIdentity: `teams-catalog-test-${type}`,
    artifactDigest:
      type === "external_acp" ? "a".repeat(64) : "b".repeat(64),
  });
  const implementationIdentityKey = (type: string) =>
    JSON.stringify([
      type,
      "acpx-runtime/v1",
      1,
      "external",
      `@paperclipai/test-${type}`,
      "1.0.0",
      `teams-catalog-test-${type}`,
      type === "external_acp" ? "a".repeat(64) : "b".repeat(64),
    ]);
  const findImplementation = vi.fn((type: string) => {
    if (type === "disabled_external") return null;
    const adapter = findAdapter(type);
    if (!adapter) return null;
    return {
      identity: implementationIdentity(type),
      identityKey: implementationIdentityKey(type),
      adapter,
    };
  });
  return {
    waitForExternalAdapters: vi.fn(async () => undefined),
    refreshAcpxAdapters: vi.fn(async () => undefined),
    findActiveServerAdapter: findAdapter,
    findSelectableServerAdapterImplementation: findImplementation,
    listAdapterModelsForImplementation: vi.fn(
      async (
        type: string,
        identity: {
          adapterType?: string;
          artifactDigest?: string;
        },
      ) => {
        const implementation = findImplementation(type);
        if (
          !implementation ||
          identity.adapterType !== implementation.identity.adapterType ||
          identity.artifactDigest !== implementation.identity.artifactDigest
        ) {
          return [];
        }
        return implementation.adapter.definition.models;
      },
    ),
  };
});

const {
  collectCatalogTeamSkillPreparations,
  readCatalogTeamProvenance,
  teamsCatalogService,
} = await import("../services/teams-catalog.js");

const CORE_EXEC_TEAM_ID = "paperclipai:bundled:company-defaults:core-exec-team";
const CORE_EXEC_TEAM_HASH = "sha256:e335c2456fcdefd5d27e0197c16f5a220bb927fc9ea49c0e4b6cacb805a09fe6";
const CORE_ADAPTER_OVERRIDES = {
  "company-lead": {
    adapterType: "external_acp",
    adapterConfig: {
      model: "operator-selected",
    },
  },
  "engineering-lead": {
    adapterType: "external_acp",
    adapterConfig: {
      model: "operator-selected",
    },
  },
  qa: {
    adapterType: "external_acp",
    adapterConfig: {
      model: "operator-selected",
    },
  },
};
const CORE_STANDALONE_OPTIONS = {
  targetManagerAgentId: null,
  adapterOverrides: CORE_ADAPTER_OVERRIDES,
  actor: { actorType: "system", actorId: "teams-catalog-test" } as const,
};
const CONTENT_STANDALONE_OPTIONS = {
  targetManagerAgentId: null,
  adapterOverrides: {
    "content-lead": {
      adapterType: "external_acp",
      adapterConfig: {
        model: "operator-selected",
      },
    },
  },
  actor: { actorType: "system", actorId: "teams-catalog-test" } as const,
};
const ENGINEERING_STANDALONE_OPTIONS = {
  targetManagerAgentId: null,
  adapterOverrides: {
    "engineering-lead": {
      adapterType: "external_acp",
      adapterConfig: {
        model: "operator-selected",
      },
    },
    qa: {
      adapterType: "external_acp",
      adapterConfig: {
        model: "operator-selected",
      },
    },
    "senior-coder": {
      adapterType: "external_acp",
      adapterConfig: {
        model: "operator-selected",
      },
    },
  },
  actor: { actorType: "system", actorId: "teams-catalog-test" } as const,
};

function agentWithCatalogTeam(originHash: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: `agent-${Math.random().toString(36).slice(2)}`,
    companyId: "company-1",
    metadata: {
      paperclip: {
        catalogTeam: {
          catalogId: CORE_EXEC_TEAM_ID,
          catalogKey: "paperclipai/bundled/company-defaults/core-exec-team",
          ...(originHash ? { originHash } : {}),
        },
      },
    },
    ...extra,
  };
}

describe("teamsCatalogService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue({
      id: "manager-1",
      companyId: "company-1",
      name: "Engineering Manager",
    });
    mockCompanyPortabilityService.previewImport.mockResolvedValue({
      include: { company: false, agents: true, projects: true, issues: true, skills: true },
      targetCompanyId: "company-1",
      targetCompanyName: "Paperclip",
      collisionStrategy: "rename",
      selectedAgentSlugs: ["company-lead", "engineering-lead"],
      plan: { companyAction: "none", agentPlans: [], projectPlans: [], issuePlans: [] },
      manifest: { agents: [], skills: [], projects: [], issues: [], envInputs: [], includes: { company: false, agents: true, projects: true, issues: true, skills: true }, company: null, schemaVersion: 1, generatedAt: new Date().toISOString(), source: null, sidebar: null },
      files: {},
      envInputs: [],
      warnings: [],
      errors: [],
    });
    mockCompanyPortabilityService.importBundle.mockResolvedValue({
      company: { id: "company-1", name: "Paperclip", action: "unchanged" },
      agents: [],
      projects: [],
      envInputs: [],
      warnings: [],
    });
    mockCompanySkillService.installFromCatalog.mockResolvedValue({
      action: "created",
      skill: { key: "paperclipai/bundled/software-development/github-pr-workflow" },
      catalogSkill: { id: "paperclipai:bundled:software-development:github-pr-workflow" },
      warnings: [],
    });
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [],
      warnings: [],
    });
  });

  it("builds an identity-only inline source with explicit adapters and target-manager reparenting", async () => {
    const svc = teamsCatalogService({} as any);

    const prepared = await svc.prepareCatalogTeamSource("company-1", "core-exec-team", {
      targetManagerAgentId: "manager-1",
      adapterOverrides: CORE_ADAPTER_OVERRIDES,
    });

    expect(prepared.errors).toEqual([]);
    expect(prepared.source.files["COMPANY.md"]).toEqual(expect.stringContaining("Core Team"));
    expect(prepared.source.files["agents/company-lead/AGENTS.md"]).toBe(
      "---\nname: Company Lead\nslug: company-lead\ntitle: Company Lead\nreportsTo: null\nskills: []\n---\n",
    );
    expect(prepared.source.files["agents/engineering-lead/AGENTS.md"]).toEqual(
      expect.stringContaining("skills: []"),
    );
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(
      expect.stringContaining("adapterRevision:"),
    );
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(
      expect.stringContaining('adapterType: "external_acp"'),
    );
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("reportsToExistingAgentId: \"manager-1\""));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("reportsToExistingAgentSlug: \"engineering-manager\""));
  });

  it("resolves target-manager slug against same-company agents before rendering reparent metadata", async () => {
    mockAgentService.list.mockResolvedValue([
      { id: "manager-1", companyId: "company-1", name: "Company Lead" },
    ]);
    const svc = teamsCatalogService({} as any);

    const prepared = await svc.prepareCatalogTeamSource("company-1", "core-exec-team", {
      targetManagerSlug: "company-lead",
      adapterOverrides: CORE_ADAPTER_OVERRIDES,
    });

    expect(mockAgentService.list).toHaveBeenCalledWith("company-1");
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("reportsToExistingAgentId: \"manager-1\""));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("reportsToExistingAgentSlug: \"company-lead\""));
  });

  it("generates catalog provenance without package-declared authority defaults", async () => {
    const svc = teamsCatalogService({} as any);

    const prepared = await svc.prepareCatalogTeamSource(
      "company-1",
      "product-engineering",
      ENGINEERING_STANDALONE_OPTIONS,
    );

    expect(prepared.source.files[".paperclip.yaml"]).not.toContain("permissions:");
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("catalogTeam:"));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("catalogSlug: \"product-engineering\""));
  });

  it("merges target-manager metadata without package authority defaults", async () => {
    const svc = teamsCatalogService({} as any);

    const prepared = await svc.prepareCatalogTeamSource("company-1", "product-engineering", {
      targetManagerAgentId: "manager-1",
      adapterOverrides: ENGINEERING_STANDALONE_OPTIONS.adapterOverrides,
    });

    expect(prepared.source.files[".paperclip.yaml"]).not.toContain("permissions:");
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("reportsToExistingAgentId: \"manager-1\""));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("reportsToExistingAgentSlug: \"engineering-manager\""));
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(expect.stringContaining("catalogSlug: \"product-engineering\""));
  });

  it("rejects missing target-manager slugs instead of emitting unresolved reparent metadata", async () => {
    mockAgentService.list.mockResolvedValue([]);
    const svc = teamsCatalogService({} as any);

    await expect(
      svc.prepareCatalogTeamSource("company-1", "core-exec-team", {
        targetManagerSlug: "missing-manager",
        adapterOverrides: CORE_ADAPTER_OVERRIDES,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("previews through company portability in agent-safe mode", async () => {
    const svc = teamsCatalogService({} as any);

    const preview = await svc.previewCatalogTeamImport(
      "company-1",
      "content-machine",
      CONTENT_STANDALONE_OPTIONS,
    );

    expect(preview.errors).toEqual([]);
    expect(mockCompanyPortabilityService.previewImport).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { mode: "existing_company", companyId: "company-1" },
        include: expect.objectContaining({
          company: false,
          agents: true,
          projects: true,
          issues: true,
          skills: true,
        }),
        source: expect.objectContaining({ type: "inline" }),
      }),
      { mode: "agent_safe", sourceCompanyId: "company-1" },
    );
  });

  it("forces catalog previews to exclude company metadata even when requested", async () => {
    const svc = teamsCatalogService({} as any);

    await svc.previewCatalogTeamImport("company-1", "content-machine", {
      include: { company: true, agents: false },
    });

    expect(mockCompanyPortabilityService.previewImport).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          company: false,
          agents: false,
        }),
      }),
      { mode: "agent_safe", sourceCompanyId: "company-1" },
    );
  });

  it("preflights imports before installing catalog skills", async () => {
    mockCompanyPortabilityService.previewImport.mockResolvedValueOnce({
      include: { company: false, agents: true, projects: true, issues: true, skills: true },
      targetCompanyId: "company-1",
      targetCompanyName: "Paperclip",
      collisionStrategy: "rename",
      selectedAgentSlugs: ["company-lead"],
      plan: { companyAction: "none", agentPlans: [], projectPlans: [], issuePlans: [] },
      manifest: { agents: [], skills: [], projects: [], issues: [], envInputs: [], includes: { company: false, agents: true, projects: true, issues: true, skills: true }, company: null, schemaVersion: 1, generatedAt: new Date().toISOString(), source: null, sidebar: null },
      files: {},
      envInputs: [],
      warnings: [],
      errors: ["Canonical adapter preflight failed."],
    });
    const svc = teamsCatalogService({} as any);

    await expect(
      svc.installCatalogTeam("company-1", "core-exec-team", CORE_STANDALONE_OPTIONS),
    ).rejects.toMatchObject({ status: 422 });

    expect(mockCompanySkillService.installFromCatalog).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it("does not install catalog skills when bundle import fails", async () => {
    mockCompanyPortabilityService.importBundle.mockRejectedValueOnce(new Error("import failed"));
    const svc = teamsCatalogService({} as any);

    await expect(
      svc.installCatalogTeam("company-1", "core-exec-team", CORE_STANDALONE_OPTIONS),
    ).rejects.toThrow("import failed");

    expect(mockCompanySkillService.installFromCatalog).not.toHaveBeenCalled();
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("surfaces post-import catalog skill install failures as warnings", async () => {
    mockCompanySkillService.installFromCatalog.mockRejectedValueOnce(new Error("catalog unavailable"));
    const svc = teamsCatalogService({} as any);

    const result = await svc.installCatalogTeam(
      "company-1",
      "core-exec-team",
      CORE_STANDALONE_OPTIONS,
    );

    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalled();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("catalog unavailable"),
      ]),
    );
  });

  it("fails visibly when selected catalog agents have no explicit adapter configuration", async () => {
    const svc = teamsCatalogService({} as any);

    await expect(
      svc.installCatalogTeam("company-1", "core-exec-team", {
        targetManagerAgentId: null,
       actor: { actorType: "system", actorId: "teams-catalog-test" }}),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("Explicit adapter configuration is required"),
    });
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it("rejects a declarative ACP adapter without an explicit model before portability", async () => {
    const svc = teamsCatalogService({} as any);

    await expect(
      svc.installCatalogTeam("company-1", "content-machine", {
        targetManagerAgentId: null,
        adapterOverrides: {
          "content-lead": {
            adapterType: "external_acp",
            adapterConfig: {},
          },
        },
       actor: { actorType: "system", actorId: "teams-catalog-test" }}),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining(
        'requires explicit configuration field "model"',
      ),
    });

    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it("preflights external declarative ACP adapters from registered metadata", async () => {
    const svc = teamsCatalogService({} as any);

    const prepared = await svc.prepareCatalogTeamSource(
      "company-1",
      "content-machine",
      {
        targetManagerAgentId: null,
        adapterOverrides: {
          "content-lead": {
            adapterType: "external_acp",
            adapterConfig: {
              model: "operator-selected",
            },
          },
        },
      },
    );

    expect(prepared.errors).toEqual([]);
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(
      expect.stringContaining('adapterType: "external_acp"'),
    );
    expect(prepared.source.files[".paperclip.yaml"]).toEqual(
      expect.stringContaining('model: "operator-selected"'),
    );
  });

  it("rejects server-disabled adapters during catalog preflight", async () => {
    const svc = teamsCatalogService({} as any);

    await expect(
      svc.installCatalogTeam("company-1", "content-machine", {
        targetManagerAgentId: null,
        adapterOverrides: {
          "content-lead": {
            adapterType: "disabled_external",
            adapterConfig: { model: "model" },
          },
        },
       actor: { actorType: "system", actorId: "teams-catalog-test" }}),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining(
        "not registered with an executable runtime module",
      ),
    });
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it("rejects undeclared external ACP model values during catalog preflight", async () => {
    const svc = teamsCatalogService({} as any);

    await expect(
      svc.installCatalogTeam("company-1", "content-machine", {
        targetManagerAgentId: null,
        adapterOverrides: {
          "content-lead": {
            adapterType: "external_acp",
            adapterConfig: {
              model: "missing-model",
            },
          },
        },
       actor: { actorType: "system", actorId: "teams-catalog-test" }}),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining(
        "must select one of the adapter-owned options",
      ),
    });
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });

  it("fails visibly when a root catalog target is omitted", async () => {
    const svc = teamsCatalogService({} as any);

    await expect(
      svc.installCatalogTeam("company-1", "core-exec-team", {
        adapterOverrides: CORE_ADAPTER_OVERRIDES,
       actor: { actorType: "system", actorId: "teams-catalog-test" }}),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("Catalog team target is required"),
    });
  });

  it("uses only the operator's explicit adapter configuration", async () => {
    const svc = teamsCatalogService({} as any);

    await svc.installCatalogTeam(
      "company-1",
      "product-engineering",
      ENGINEERING_STANDALONE_OPTIONS,
    );
    const [engineeringInput] = mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
    expect(engineeringInput.adapterOverrides).toEqual(
      ENGINEERING_STANDALONE_OPTIONS.adapterOverrides,
    );
    expect(engineeringInput.source.files[".paperclip.yaml"]).toEqual(
      expect.stringContaining('model: "operator-selected"'),
    );
  });

  it("preserves the synthetic override carrier when selected files narrow the import", async () => {
    const svc = teamsCatalogService({} as any);

    await svc.installCatalogTeam("company-1", "content-machine", {
      ...CONTENT_STANDALONE_OPTIONS,
      selectedFiles: ["agents/content-lead/AGENTS.md"],
     actor: { actorType: "system", actorId: "teams-catalog-test" }});

    const [importInput] =
      mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
    expect(importInput.selectedFiles).toEqual([
      "agents/content-lead/AGENTS.md",
      ".paperclip.yaml",
    ]);
    expect(importInput.adapterOverrides).toEqual(
      CONTENT_STANDALONE_OPTIONS.adapterOverrides,
    );
  });

  it("requires overrides only for agents retained by a multi-agent selected-file import", async () => {
    const svc = teamsCatalogService({} as any);
    const selectedOverride = {
      "engineering-lead": {
        adapterType: "external_acp",
        adapterConfig: {
          model: "operator-selected",
        },
      },
    };

    await svc.installCatalogTeam("company-1", "product-engineering", {
      targetManagerAgentId: null,
      selectedFiles: ["agents/engineering-lead/AGENTS.md"],
      adapterOverrides: selectedOverride,
     actor: { actorType: "system", actorId: "teams-catalog-test" }});

    const [importInput] =
      mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
    expect(importInput.adapterOverrides).toEqual(selectedOverride);
    expect(importInput.selectedFiles).toEqual([
      "agents/engineering-lead/AGENTS.md",
      ".paperclip.yaml",
    ]);
  });

  it("preserves explicit per-agent adapter configuration without filling gaps", async () => {
    const svc = teamsCatalogService({} as any);

    const callerOverrides = {
      "company-lead": {
        adapterType: "external_acp",
        adapterConfig: {
          model: "operator-selected",
        },
      },
      "engineering-lead": {
        adapterType: "external_acp",
        adapterConfig: {
          model: "operator-selected",
        },
      },
      qa: {
        adapterType: "external_acp",
        adapterConfig: {
          model: "operator-selected",
        },
      },
    };
    await svc.installCatalogTeam("company-1", "core-exec-team", {
      targetManagerAgentId: null,
      adapterOverrides: callerOverrides,
     actor: { actorType: "system", actorId: "teams-catalog-test" }});

    const [importInput] = mockCompanyPortabilityService.importBundle.mock.calls.at(-1)!;
    expect(importInput.adapterOverrides).toEqual(callerOverrides);
    expect(importInput.source.files[".paperclip.yaml"]).not.toEqual(
      expect.stringContaining("\n    adapter:"),
    );
    expect(importInput.source.files[".paperclip.yaml"]).toEqual(
      expect.stringContaining("adapterRevision:"),
    );
    // Caller-supplied object must not be mutated in place.
    expect(callerOverrides).toEqual({
      "company-lead": {
        adapterType: "external_acp",
        adapterConfig: {
          model: "operator-selected",
        },
      },
      "engineering-lead": {
        adapterType: "external_acp",
        adapterConfig: {
          model: "operator-selected",
        },
      },
      qa: {
        adapterType: "external_acp",
        adapterConfig: {
          model: "operator-selected",
        },
      },
    });
  });

  it("does not emit an inferred-adapter warning for explicit configuration", async () => {
    const svc = teamsCatalogService({} as any);

    const result = await svc.installCatalogTeam("company-1", "core-exec-team", {
      adapterOverrides: {
        "company-lead": {
          adapterType: "external_acp",
          adapterConfig: {
            model: "operator-selected",
          },
        },
        "engineering-lead": {
          adapterType: "external_acp",
          adapterConfig: {
            model: "operator-selected",
          },
        },
        qa: {
          adapterType: "external_acp",
          adapterConfig: {
            model: "operator-selected",
          },
        },
      },
      targetManagerAgentId: null,
     actor: { actorType: "system", actorId: "teams-catalog-test" }});

    expect(result.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("default")]),
    );
  });

  it("passes install secretValues through to company portability import", async () => {
    const svc = teamsCatalogService({} as any);

    await svc.installCatalogTeam("company-1", "core-exec-team", {
      ...CORE_STANDALONE_OPTIONS,
      secretValues: {
        "agent:company-lead:EXTERNAL_AGENT_API_KEY": "test-secret",
      },
     actor: { actorType: "system", actorId: "teams-catalog-test" }});

    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        secretValues: {
          "agent:company-lead:EXTERNAL_AGENT_API_KEY": "test-secret",
        },
      }),
      null,
      {
        authorizationActor: undefined,
        mode: "agent_safe",
        secretMutationActor: { type: "system" },
        sourceCompanyId: "company-1",
      },
    );
  });

  describe("readCatalogTeamProvenance", () => {
    it("reads catalogTeam provenance from agent metadata", () => {
      expect(
        readCatalogTeamProvenance({
          paperclip: { catalogTeam: { catalogId: "team-x", catalogKey: "k", originHash: "sha256:1" } },
        }),
      ).toEqual({ catalogId: "team-x", catalogKey: "k", originHash: "sha256:1" });
    });

    it("returns null when there is no catalogTeam provenance", () => {
      expect(readCatalogTeamProvenance(null)).toBeNull();
      expect(readCatalogTeamProvenance({})).toBeNull();
      expect(readCatalogTeamProvenance({ paperclip: { catalog: { skillKey: "s" } } })).toBeNull();
      expect(readCatalogTeamProvenance({ paperclip: { catalogTeam: { originHash: "h" } } })).toBeNull();
    });
  });

  describe("listInstalledCatalogTeams", () => {
    it("marks a team out of date when an installed originHash differs from the catalog hash", async () => {
      mockAgentService.list.mockResolvedValue([
        agentWithCatalogTeam("sha256:stale-hash"),
        agentWithCatalogTeam("sha256:stale-hash"),
        { id: "no-provenance", companyId: "company-1", metadata: null },
      ]);
      const svc = teamsCatalogService({} as any);

      const installed = await svc.listInstalledCatalogTeams("company-1");

      expect(mockAgentService.list).toHaveBeenCalledWith("company-1");
      expect(installed).toEqual([
        expect.objectContaining({
          catalogId: CORE_EXEC_TEAM_ID,
          present: true,
          currentContentHash: CORE_EXEC_TEAM_HASH,
          installedOriginHashes: ["sha256:stale-hash"],
          agentCount: 2,
          outOfDate: true,
        }),
      ]);
    });

    it("marks a team up to date when the installed originHash matches the catalog hash", async () => {
      mockAgentService.list.mockResolvedValue([agentWithCatalogTeam(CORE_EXEC_TEAM_HASH)]);
      const svc = teamsCatalogService({} as any);

      const installed = await svc.listInstalledCatalogTeams("company-1");

      expect(installed).toHaveLength(1);
      expect(installed[0]).toMatchObject({ present: true, outOfDate: false, agentCount: 1 });
    });

    it("does not flag teams that no longer resolve to a catalog entry", async () => {
      mockAgentService.list.mockResolvedValue([
        {
          id: "removed",
          companyId: "company-1",
          metadata: { paperclip: { catalogTeam: { catalogId: "paperclipai:bundled:gone:removed", originHash: "sha256:x" } } },
        },
      ]);
      const svc = teamsCatalogService({} as any);

      const installed = await svc.listInstalledCatalogTeams("company-1");

      expect(installed).toEqual([
        expect.objectContaining({ present: false, currentContentHash: null, outOfDate: false }),
      ]);
    });

    it("returns an empty list when no agents carry catalog-team provenance", async () => {
      mockAgentService.list.mockResolvedValue([{ id: "a", companyId: "company-1", metadata: {} }]);
      const svc = teamsCatalogService({} as any);

      expect(await svc.listInstalledCatalogTeams("company-1")).toEqual([]);
    });
  });

  it("classifies unresolved and unsafe external skill requirements as blocked", () => {
    const fakeTeam: CatalogTeam = {
      id: "paperclipai:optional:test:unsafe",
      key: "paperclipai/optional/test/unsafe",
      kind: "optional",
      category: "test",
      slug: "unsafe",
      name: "Unsafe",
      description: "Unsafe",
      path: "catalog/optional/test/unsafe",
      entrypoint: "TEAM.md",
      schema: "agentcompanies/v1",
      defaultInstall: false,
      recommendedForCompanyTypes: [],
      tags: [],
      counts: { agents: 0, projects: 0, issues: 0, routines: 0, localSkills: 0, catalogSkills: 0, externalSkillSources: 2 },
      rootAgentSlugs: [],
      agentSlugs: [],
      projectSlugs: [],
      requiredSkills: [
        { type: "github", ref: "https://github.com/acme/skill", agentSlugs: ["agent"], resolved: true, sourceLocator: "https://github.com/acme/skill" },
        { type: "catalog", ref: "missing", agentSlugs: ["agent"], resolved: false },
      ],
      envInputs: [],
      sourceRefs: [],
      files: [],
      trustLevel: "external_sources",
      compatibility: "compatible",
      contentHash: "sha256:test",
    };

    const result = collectCatalogTeamSkillPreparations(fakeTeam);

    expect(result.errors).toEqual([
      'External skill source "https://github.com/acme/skill" requires explicit source policy approval.',
      'Skill requirement "missing" is unresolved in catalog manifest.',
    ]);
    expect(result.preparations.map((entry) => entry.action)).toEqual(["blocked", "blocked"]);
  });
});
