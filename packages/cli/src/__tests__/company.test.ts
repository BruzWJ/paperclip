import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prompts from "@clack/prompts";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  canonicalizeMoneyAmount,
  type CompanyPortabilityPreviewResult,
} from "@paperclipai/shared";
import {
  buildCompanyDashboardUrl,
  buildDefaultImportSelectionState,
  buildImportSelectionCatalog,
  buildSelectedFilesFromImportSelection,
  renderCompanyImportPreview,
  renderCompanyImportResult,
  registerCompanyCommands,
  resolveCompanyImportApplyConfirmationMode,
  resolveCompanyImportApiPath,
} from "../commands/client/company.js";

vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  multiselect: vi.fn(),
  note: vi.fn(),
  select: vi.fn(),
}));

const ORIGINAL_ENV = { ...process.env };
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function allFalse<const T extends string>(keys: readonly T[]): Record<T, boolean> {
  return Object.fromEntries(keys.map((key) => [key, false])) as Record<T, boolean>;
}

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerCompanyCommands(program);
  return program;
}

async function runCommand(args: string[]): Promise<void> {
  await makeProgram().parseAsync(args, { from: "user" });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function company(overrides: Record<string, unknown> = {}) {
  return {
    id: COMPANY_ID,
    name: "Paperclip",
    description: null,
    status: "active",
    issuePrefix: "PAP",
    issueCounter: 1,
    budgetCurrency: "USD",
    budgetMonthlyAmount: "0",
    knownSpendAmount: "0",
    attachmentMaxBytes: 1073741824,
    requireBoardApprovalForNewAgents: false,
    brandColor: "#5c5fff",
    logoAssetId: null,
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    logoUrl: null,
    ...overrides,
  };
}

function interactiveImportPreview(): CompanyPortabilityPreviewResult {
  return {
    include: {
      company: true,
      agents: true,
      projects: true,
      issues: true,
      skills: true,
    },
    targetCompanyId: COMPANY_ID,
    targetCompanyName: "Paperclip",
    collisionStrategy: "rename",
    selectedAgentSlugs: ["lead"],
    plan: {
      companyAction: "update",
      agentPlans: [
        {
          slug: "lead",
          action: "create",
          plannedName: "Lead",
          existingAgentId: null,
          reason: null,
        },
      ],
      projectPlans: [],
      issuePlans: [],
    },
    manifest: {
      schemaVersion: 1,
      generatedAt: "2026-07-26T00:00:00.000Z",
      source: {
        companyId: "source-company",
        companyName: "Source Company",
      },
      includes: {
        company: true,
        agents: true,
        projects: true,
        issues: true,
        skills: true,
      },
      company: {
        path: "COMPANY.md",
        name: "Source Company",
        description: null,
        budgetCurrency: "USD",
        budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
        attachmentMaxBytes: null,
        brandColor: null,
        logoPath: null,
        requireBoardApprovalForNewAgents: false,
      },
      sidebar: {
        agents: ["lead"],
        projects: [],
      },
      agents: [
        {
          slug: "lead",
          name: "Lead",
          path: "agents/lead/AGENTS.md",
          skills: [],
          title: null,
          icon: null,
          capabilities: null,
          reportsToSlug: null,
          reportsToExistingAgentId: null,
          reportsToExistingAgentSlug: null,
          adapterRevision: {
            sourceRevisionId: "revision-lead",
            adapterType: "codex",
            adapterConfig: { model: "gpt-5.6" },
            runtimeConfig: {},
            sourceEnvironmentId: "environment-lead",
            skillChannel: "operator_native",
          },
          contextGrants: allFalse(AGENT_CONTEXT_GRANT_KEYS),
          actionGrants: allFalse(PAPERCLIP_ACTION_KEYS),
          mentionReachGrants: allFalse(AGENT_MENTION_REACH_GRANT_KEYS),
          companyToolIds: [],
          governance: {},
          permissionGrants: [],
          budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
          metadata: null,
        },
      ],
      skills: [],
      projects: [],
      issues: [],
      envInputs: [],
    },
    files: {
      "COMPANY.md": "# Source Company",
      ".paperclip.yaml": "schema: paperclip/v1\n",
      "agents/lead/AGENTS.md": "# Lead",
    },
    envInputs: [],
    warnings: [],
    errors: [],
  };
}

describe("company CLI commands", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalStdinIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_BOARD_API_URL;
    delete process.env.PAPERCLIP_BOARD_API_KEY;
    delete process.env.PAPERCLIP_BOARD_COMPANY_ID;
    originalStdinIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    vi.mocked(prompts.isCancel).mockReturnValue(false);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("gets the current company from an explicit company context without board-wide listing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(company()));

    await runCommand([
      "company",
      "current",
      "--company-id",
      COMPANY_ID,
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "agent-token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://paperclip.test/api/companies/${COMPANY_ID}`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({ id: COMPANY_ID, name: "Paperclip" });
  });

  it("explains that company creation requires board instance-admin authentication under agent auth", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Board access required" }, 403));
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    await expect(runCommand([
      "company",
      "create",
      "--payload-json",
      "{\"name\":\"Disposable\"}",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "agent-token",
      "--json",
    ])).rejects.toThrow("exit:1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/companies",
      expect.objectContaining({ method: "POST" }),
    );
    const rendered = String(errorSpy.mock.calls[0]?.[0]);
    expect(rendered).toContain("Creating companies requires board/instance-admin authentication");
    expect(rendered).toContain("company list --json");
  });

  it("preserves exact adapter overrides through interactive preview, selected-files preview, and apply", async () => {
    const preview = interactiveImportPreview();
    const imported = {
      company: {
        id: COMPANY_ID,
        name: "Paperclip",
        action: "unchanged",
      },
      agents: [
        {
          slug: "lead",
          id: "agent-lead",
          action: "created",
          name: "Lead",
          reason: null,
        },
      ],
      projects: [],
      envInputs: [],
      warnings: [],
    };
    const expectedAdapterOverrides = {
      lead: {
        adapterType: "codex",
        adapterConfig: { model: "gpt-5.6" },
        defaultEnvironmentId:
          "11111111-1111-4111-8111-111111111111",
        skillChannel: "operator_native",
      },
    };

    vi.mocked(prompts.select).mockResolvedValue("confirm");
    vi.mocked(prompts.confirm).mockResolvedValue(true);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(preview))
      .mockResolvedValueOnce(jsonResponse(preview))
      .mockResolvedValueOnce(jsonResponse(imported, 201))
      .mockResolvedValueOnce(jsonResponse(company({ issuePrefix: "" })));

    await runCommand([
      "company",
      "import",
      "https://github.com/paperclipai/company-fixture",
      "--target",
      "existing",
      "--company-id",
      COMPANY_ID,
      "--adapter-override",
      "lead=codex",
      "--adapter-config",
      'lead={"model":"gpt-5.6"}',
      "--default-environment-id",
      "lead=11111111-1111-4111-8111-111111111111",
      "--skill-channel",
      "lead=operator_native",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "board-token",
    ]);

    const postCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(postCalls.map(([url]) => String(url))).toEqual([
      `http://paperclip.test/api/companies/${COMPANY_ID}/imports/preview`,
      `http://paperclip.test/api/companies/${COMPANY_ID}/imports/preview`,
      `http://paperclip.test/api/companies/${COMPANY_ID}/imports/apply`,
    ]);

    const [initialPreviewPayload, selectedFilesPreviewPayload, applyPayload] = postCalls.map(
      ([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>,
    );
    expect(initialPreviewPayload).not.toHaveProperty("selectedFiles");
    expect(selectedFilesPreviewPayload.selectedFiles).toEqual([
      ".paperclip.yaml",
      "agents/lead/AGENTS.md",
      "COMPANY.md",
    ]);
    expect(applyPayload.selectedFiles).toEqual(selectedFilesPreviewPayload.selectedFiles);
    expect(initialPreviewPayload.adapterOverrides).toEqual(expectedAdapterOverrides);
    expect(selectedFilesPreviewPayload.adapterOverrides).toEqual(expectedAdapterOverrides);
    expect(applyPayload.adapterOverrides).toEqual(expectedAdapterOverrides);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("resolveCompanyImportApiPath", () => {
  it("uses company-scoped preview route for existing-company dry runs", () => {
    expect(
      resolveCompanyImportApiPath({
        dryRun: true,
        targetMode: "existing_company",
        companyId: "company-123",
      }),
    ).toBe("/api/companies/company-123/imports/preview");
  });

  it("uses company-scoped apply route for existing-company imports", () => {
    expect(
      resolveCompanyImportApiPath({
        dryRun: false,
        targetMode: "existing_company",
        companyId: "company-123",
      }),
    ).toBe("/api/companies/company-123/imports/apply");
  });

  it("keeps global routes for new-company imports", () => {
    expect(
      resolveCompanyImportApiPath({
        dryRun: true,
        targetMode: "new_company",
      }),
    ).toBe("/api/companies/import/preview");

    expect(
      resolveCompanyImportApiPath({
        dryRun: false,
        targetMode: "new_company",
      }),
    ).toBe("/api/companies/import");
  });

  it("throws when an existing-company import is missing a company id", () => {
    expect(() =>
      resolveCompanyImportApiPath({
        dryRun: true,
        targetMode: "existing_company",
        companyId: " ",
      })
    ).toThrow(/require a companyId/i);
  });
});

describe("resolveCompanyImportApplyConfirmationMode", () => {
  it("skips confirmation when --yes is set", () => {
    expect(
      resolveCompanyImportApplyConfirmationMode({
        yes: true,
        interactive: false,
        json: false,
      }),
    ).toBe("skip");
  });

  it("prompts in interactive text mode when --yes is not set", () => {
    expect(
      resolveCompanyImportApplyConfirmationMode({
        yes: false,
        interactive: true,
        json: false,
      }),
    ).toBe("prompt");
  });

  it("requires --yes for non-interactive apply", () => {
    expect(() =>
      resolveCompanyImportApplyConfirmationMode({
        yes: false,
        interactive: false,
        json: false,
      })
    ).toThrow(/non-interactive terminal requires --yes/i);
  });

  it("requires --yes for json apply", () => {
    expect(() =>
      resolveCompanyImportApplyConfirmationMode({
        yes: false,
        interactive: false,
        json: true,
      })
    ).toThrow(/with --json requires --yes/i);
  });
});

describe("buildCompanyDashboardUrl", () => {
  it("preserves the configured base path when building a dashboard URL", () => {
    expect(buildCompanyDashboardUrl("https://paperclip.example/app/", "PAP")).toBe(
      "https://paperclip.example/app/PAP/dashboard",
    );
  });
});

describe("renderCompanyImportPreview", () => {
  it("summarizes the preview with counts, selection info, and truncated examples", () => {
    const preview: CompanyPortabilityPreviewResult = {
      include: {
        company: true,
        agents: true,
        projects: true,
        issues: true,
        skills: true,
      },
      targetCompanyId: "company-123",
      targetCompanyName: "Imported Co",
      collisionStrategy: "rename",
      selectedAgentSlugs: ["lead", "architect", "eng-1", "eng-2", "eng-3", "eng-4", "eng-5"],
      plan: {
        companyAction: "update",
        agentPlans: [
          { slug: "lead", action: "create", plannedName: "Lead", existingAgentId: null, reason: null },
          { slug: "architect", action: "update", plannedName: "Architect", existingAgentId: "agent-2", reason: "replace strategy" },
          { slug: "eng-1", action: "skip", plannedName: "Engineer 1", existingAgentId: "agent-3", reason: "skip strategy" },
          { slug: "eng-2", action: "create", plannedName: "Engineer 2", existingAgentId: null, reason: null },
          { slug: "eng-3", action: "create", plannedName: "Engineer 3", existingAgentId: null, reason: null },
          { slug: "eng-4", action: "create", plannedName: "Engineer 4", existingAgentId: null, reason: null },
          { slug: "eng-5", action: "create", plannedName: "Engineer 5", existingAgentId: null, reason: null },
        ],
        projectPlans: [
          { slug: "alpha", action: "create", plannedName: "Alpha", existingProjectId: null, reason: null },
        ],
        issuePlans: [
          { slug: "kickoff", action: "create", plannedTitle: "Kickoff", reason: null },
        ],
      },
      manifest: {
        schemaVersion: 1,
        generatedAt: "2026-03-23T17:00:00.000Z",
        source: {
          companyId: "company-src",
          companyName: "Source Co",
        },
        includes: {
          company: true,
          agents: true,
          projects: true,
          issues: true,
          skills: true,
        },
        company: {
          path: "COMPANY.md",
          name: "Source Co",
          description: null,
          budgetCurrency: "USD",
          budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
          attachmentMaxBytes: null,
          brandColor: null,
          logoPath: null,
          requireBoardApprovalForNewAgents: false,
        },
        sidebar: {
          agents: ["lead"],
          projects: ["alpha"],
        },
        agents: [
          {
            slug: "lead",
            name: "Lead",
            path: "agents/lead/AGENT.md",
            skills: [],
            title: null,
            icon: null,
            capabilities: null,
            reportsToSlug: null,
            reportsToExistingAgentId: null,
            reportsToExistingAgentSlug: null,
            adapterRevision: {
              sourceRevisionId: "revision-lead",
              adapterType: "codex",
              adapterConfig: { model: "gpt-5.6" },
              runtimeConfig: {},
              sourceEnvironmentId: "environment-lead",
              skillChannel: "operator_native",
            },
            contextGrants: allFalse(AGENT_CONTEXT_GRANT_KEYS),
            actionGrants: allFalse(PAPERCLIP_ACTION_KEYS),
            mentionReachGrants: allFalse(AGENT_MENTION_REACH_GRANT_KEYS),
            companyToolIds: [],
            governance: {},
            permissionGrants: [],
            budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
            metadata: null,
          },
        ],
        skills: [
          {
            key: "skill-a",
            slug: "skill-a",
            name: "Skill A",
            path: "skills/skill-a/SKILL.md",
            description: null,
            sourceType: "inline",
            sourceLocator: null,
            sourceRef: null,
            trustLevel: null,
            compatibility: null,
            metadata: null,
            fileInventory: [],
          },
        ],
        projects: [
          {
            slug: "alpha",
            name: "Alpha",
            path: "projects/alpha/PROJECT.md",
            description: null,
            ownerAgentSlug: null,
            leadAgentSlug: null,
            targetDate: null,
            color: null,
            icon: null,
            status: null,
            executionWorkspacePolicy: null,
            workspaces: [],
            env: null,
            metadata: null,
          },
        ],
        issues: [
          {
            slug: "kickoff",
            identifier: null,
            title: "Kickoff",
            path: "issues/kickoff/ISSUE.md",
            projectSlug: "alpha",
            projectWorkspaceKey: null,
            ownerAgentSlug: "lead",
            request: "# Kickoff",
            recurring: false,
            routine: null,
            lifecycleStatus: "open",
            disposition: null,
            contextAccessMask: null,
            boardPresentationStatus: "todo",
            priority: null,
            labelIds: [],
            billingCode: null,
            executionWorkspaceSettings: null,
            comments: [],
            metadata: null,
          },
        ],
        envInputs: [
          {
            key: "OPENAI_API_KEY",
            description: null,
            projectSlug: "alpha",
            kind: "secret",
            requirement: "required",
            defaultValue: null,
            portability: "portable",
          },
        ],
      },
      files: {
        "COMPANY.md": "# Source Co",
      },
      envInputs: [
        {
          key: "OPENAI_API_KEY",
          description: null,
          projectSlug: "alpha",
          kind: "secret",
          requirement: "required",
          defaultValue: null,
          portability: "portable",
        },
      ],
      warnings: ["One warning"],
      errors: ["One error"],
    };

    const rendered = renderCompanyImportPreview(preview, {
      sourceLabel: "GitHub: https://github.com/paperclipai/companies/demo",
      targetLabel: "Imported Co (company-123)",
      infoMessages: ["Using external adapter"],
    });

    expect(rendered).toContain("Include");
    expect(rendered).toContain("company, projects, issues, agents, skills");
    expect(rendered).toContain("7 agents total");
    expect(rendered).toContain("1 project total");
    expect(rendered).toContain("1 issue total");
    expect(rendered).toContain("skills: 1 skill packaged");
    expect(rendered).toContain("+1 more");
    expect(rendered).toContain("Using external adapter");
    expect(rendered).toContain("Warnings");
    expect(rendered).toContain("Errors");
  });
});

describe("renderCompanyImportResult", () => {
  it("summarizes import results with created, updated, and skipped counts", () => {
    const rendered = renderCompanyImportResult(
      {
        company: {
          id: "company-123",
          name: "Imported Co",
          action: "updated",
        },
        agents: [
          { slug: "lead", id: "agent-1", action: "created", name: "Lead", reason: null },
          { slug: "architect", id: "agent-2", action: "updated", name: "Architect", reason: "replace strategy" },
          { slug: "ops", id: null, action: "skipped", name: "Ops", reason: "skip strategy" },
        ],
        projects: [
          { slug: "app", id: "project-1", action: "created", name: "App", reason: null },
          { slug: "ops", id: "project-2", action: "updated", name: "Operations", reason: "replace strategy" },
          { slug: "archive", id: null, action: "skipped", name: "Archive", reason: "skip strategy" },
        ],
        envInputs: [],
        warnings: ["Review API keys"],
      },
      {
        targetLabel: "Imported Co (company-123)",
        companyUrl: "https://paperclip.example/PAP/dashboard",
        infoMessages: ["Using external adapter"],
      },
    );

    expect(rendered).toContain("Company");
    expect(rendered).toContain("https://paperclip.example/PAP/dashboard");
    expect(rendered).toContain("3 agents total (1 created, 1 updated, 1 skipped)");
    expect(rendered).toContain("3 projects total (1 created, 1 updated, 1 skipped)");
    expect(rendered).toContain("Agent results");
    expect(rendered).toContain("Project results");
    expect(rendered).toContain("Using external adapter");
    expect(rendered).toContain("Review API keys");
  });
});

describe("import selection catalog", () => {
  it("defaults to everything and keeps project selection separate from issue selection", () => {
    const preview: CompanyPortabilityPreviewResult = {
      include: {
        company: true,
        agents: true,
        projects: true,
        issues: true,
        skills: true,
      },
      targetCompanyId: "company-123",
      targetCompanyName: "Imported Co",
      collisionStrategy: "rename",
      selectedAgentSlugs: ["lead"],
      plan: {
        companyAction: "create",
        agentPlans: [],
        projectPlans: [],
        issuePlans: [],
      },
      manifest: {
        schemaVersion: 1,
        generatedAt: "2026-03-23T18:00:00.000Z",
        source: {
          companyId: "company-src",
          companyName: "Source Co",
        },
        includes: {
          company: true,
          agents: true,
          projects: true,
          issues: true,
          skills: true,
        },
        company: {
          path: "COMPANY.md",
          name: "Source Co",
          description: null,
          budgetCurrency: "USD",
          budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
          attachmentMaxBytes: null,
          brandColor: null,
          logoPath: "images/company-logo.png",
          requireBoardApprovalForNewAgents: false,
        },
        sidebar: {
          agents: ["lead"],
          projects: ["alpha"],
        },
        agents: [
          {
            slug: "lead",
            name: "Lead",
            path: "agents/lead/AGENT.md",
            skills: [],
            title: null,
            icon: null,
            capabilities: null,
            reportsToSlug: null,
            reportsToExistingAgentId: null,
            reportsToExistingAgentSlug: null,
            adapterRevision: {
              sourceRevisionId: "revision-lead",
              adapterType: "codex",
              adapterConfig: { model: "gpt-5.6" },
              runtimeConfig: {},
              sourceEnvironmentId: "environment-lead",
              skillChannel: "operator_native",
            },
            contextGrants: allFalse(AGENT_CONTEXT_GRANT_KEYS),
            actionGrants: allFalse(PAPERCLIP_ACTION_KEYS),
            mentionReachGrants: allFalse(AGENT_MENTION_REACH_GRANT_KEYS),
            companyToolIds: [],
            governance: {},
            permissionGrants: [],
            budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
            metadata: null,
          },
        ],
        skills: [
          {
            key: "skill-a",
            slug: "skill-a",
            name: "Skill A",
            path: "skills/skill-a/SKILL.md",
            description: null,
            sourceType: "inline",
            sourceLocator: null,
            sourceRef: null,
            trustLevel: null,
            compatibility: null,
            metadata: null,
            fileInventory: [{ path: "skills/skill-a/helper.md", kind: "doc" }],
          },
        ],
        projects: [
          {
            slug: "alpha",
            name: "Alpha",
            path: "projects/alpha/PROJECT.md",
            description: null,
            ownerAgentSlug: null,
            leadAgentSlug: null,
            targetDate: null,
            color: null,
            icon: null,
            status: null,
            executionWorkspacePolicy: null,
            workspaces: [],
            env: null,
            metadata: null,
          },
        ],
        issues: [
          {
            slug: "kickoff",
            identifier: null,
            title: "Kickoff",
            path: "issues/kickoff/ISSUE.md",
            projectSlug: "alpha",
            projectWorkspaceKey: null,
            ownerAgentSlug: "lead",
            request: "# Kickoff",
            recurring: false,
            routine: null,
            lifecycleStatus: "open",
            disposition: null,
            contextAccessMask: null,
            boardPresentationStatus: "todo",
            priority: null,
            labelIds: [],
            billingCode: null,
            executionWorkspaceSettings: null,
            comments: [],
            metadata: null,
          },
        ],
        envInputs: [],
      },
      files: {
        "COMPANY.md": "# Source Co",
        "README.md": "# Readme",
        ".paperclip.yaml": "schema: paperclip/v1\n",
        "images/company-logo.png": {
          encoding: "base64",
          data: "",
          contentType: "image/png",
        },
        "projects/alpha/PROJECT.md": "# Alpha",
        "projects/alpha/notes.md": "project notes",
        "issues/kickoff/ISSUE.md": "# Kickoff",
        "issues/kickoff/details.md": "issue details",
        "agents/lead/AGENT.md": "# Lead",
        "agents/lead/prompt.md": "prompt",
        "skills/skill-a/SKILL.md": "# Skill A",
        "skills/skill-a/helper.md": "helper",
      },
      envInputs: [],
      warnings: [],
      errors: [],
    };

    const catalog = buildImportSelectionCatalog(preview);
    const state = buildDefaultImportSelectionState(catalog);

    expect(state.company).toBe(true);
    expect(state.projects.has("alpha")).toBe(true);
    expect(state.issues.has("kickoff")).toBe(true);
    expect(state.agents.has("lead")).toBe(true);
    expect(state.skills.has("skill-a")).toBe(true);

    state.company = false;
    state.issues.clear();
    state.agents.clear();
    state.skills.clear();

    const selectedFiles = buildSelectedFilesFromImportSelection(catalog, state);

    expect(selectedFiles).toContain(".paperclip.yaml");
    expect(selectedFiles).toContain("projects/alpha/PROJECT.md");
    expect(selectedFiles).toContain("projects/alpha/notes.md");
    expect(selectedFiles).not.toContain("issues/kickoff/ISSUE.md");
    expect(selectedFiles).not.toContain("issues/kickoff/details.md");
  });

  it("includes extension file even when all entities are deselected", () => {
    const preview: CompanyPortabilityPreviewResult = {
      include: {
        company: true,
        agents: true,
        projects: true,
        issues: true,
        skills: true,
      },
      targetCompanyId: "company-123",
      targetCompanyName: "Imported Co",
      collisionStrategy: "rename",
      selectedAgentSlugs: [],
      plan: {
        companyAction: "create",
        agentPlans: [],
        projectPlans: [],
        issuePlans: [],
      },
      manifest: {
        schemaVersion: 1,
        generatedAt: "2026-03-23T18:00:00.000Z",
        source: {
          companyId: "company-src",
          companyName: "Source Co",
        },
        includes: {
          company: true,
          agents: true,
          projects: true,
          issues: true,
          skills: true,
        },
        company: {
          path: "COMPANY.md",
          name: "Source Co",
          description: null,
          budgetCurrency: "USD",
          budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
          attachmentMaxBytes: null,
          brandColor: null,
          logoPath: null,
          requireBoardApprovalForNewAgents: false,
        },
        sidebar: {
          agents: [],
          projects: [],
        },
        agents: [],
        skills: [],
        projects: [],
        issues: [],
        envInputs: [],
      },
      files: {
        ".paperclip.yaml": "schema: paperclip/v1\n",
      },
      envInputs: [],
      warnings: [],
      errors: [],
    };

    const catalog = buildImportSelectionCatalog(preview);
    const state = buildDefaultImportSelectionState(catalog);

    state.company = false;
    state.projects.clear();
    state.issues.clear();
    state.agents.clear();
    state.skills.clear();

    const selectedFiles = buildSelectedFilesFromImportSelection(catalog, state);

    expect(selectedFiles).toContain(".paperclip.yaml");
    expect(selectedFiles).toHaveLength(1);
  });
});
