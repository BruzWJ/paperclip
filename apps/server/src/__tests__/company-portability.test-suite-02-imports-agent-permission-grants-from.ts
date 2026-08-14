import * as t from "./company-portability.test-support.js";
const { describe, it, companyPortabilityService, agentSvc } = t;
const { inlineSource } = t;
const { canonicalCompanyExtensionYaml, canonicalAgentExtensionYaml } = t;
const { codexTargetAdapter, expect, accessSvc, secretSvc, projectSvc, asTextFile } = t;
import { registerSuiteSetup } from "./company-portability.test-setup-01.js";

describe("company portability", () => {
  registerSuiteSetup();

  it("imports agent permission grants from package metadata", async () => {
    const portability = companyPortabilityService({} as any);
    agentSvc.list.mockResolvedValue([]);
    agentSvc.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "agent-imported",
      name: input.name,
      status: input.status,
    }));

    await portability.importBundle(
      {
        source: {
          type: "inline",
          files: {
            "COMPANY.md": ["---", "name: Import", "includes:", "  - agents/coder/AGENTS.md", "---", ""].join(
              "\n",
            ),
            "agents/coder/AGENTS.md": [
              "---",
              "name: Coder",
              "slug: coder",
              "kind: agent",
              "reportsTo: null",
              "---",
              "",
            ].join("\n"),
            ".paperclip.yaml": [
              "schema: paperclip/v1",
              ...canonicalCompanyExtensionYaml(),
              "agents:",
              "  coder:",
              ...canonicalAgentExtensionYaml(),
              "    permissionGrants:",
              "      - permissionKey: agents:suggest-changes",
              "      - permissionKey: agents:configure",
              "        scope:",
              "          targetAgentIds:",
              "            - agent-imported",
              "",
            ].join("\n"),
          },
        },
        include: {
          company: false,
          agents: true,
          projects: false,
          tasks: false,
        },
        target: {
          mode: "existing_company",
          companyId: "company-1",
        },
        collisionStrategy: "rename",
        adapterOverrides: {
          coder: codexTargetAdapter(),
        },
      },
      "user-1",
    );

    expect(accessSvc.setPrincipalPermission).toHaveBeenCalledWith(
      "company-1",
      "agent",
      "agent-imported",
      "agents:suggest-changes",
      true,
      "user-1",
      null,
    );
    expect(accessSvc.setPrincipalPermission).toHaveBeenCalledWith(
      "company-1",
      "agent",
      "agent-imported",
      "agents:configure",
      true,
      "user-1",
      { targetAgentIds: ["agent-imported"] },
    );
  });

  it("removes import secrets created before a later import failure", async () => {
    const portability = companyPortabilityService({} as any);
    agentSvc.list.mockResolvedValue([]);
    secretSvc.create.mockResolvedValueOnce({
      id: "secret-created-for-failed-import",
    });
    agentSvc.create.mockRejectedValueOnce(new Error("agent create failed"));

    await expect(
      portability.importBundle(
        {
          source: {
            type: "inline",
            files: {
              "COMPANY.md": [
                "---",
                "name: Import",
                "includes:",
                "  - agents/coder/AGENTS.md",
                "  - projects/app/PROJECT.md",
                "---",
                "",
              ].join("\n"),
              "agents/coder/AGENTS.md": [
                "---",
                "name: Coder",
                "slug: coder",
                "kind: agent",
                "reportsTo: null",
                "---",
                "",
              ].join("\n"),
              "projects/app/PROJECT.md": ["---", "name: App", "slug: app", "kind: project", "---", ""].join(
                "\n",
              ),
              ".paperclip.yaml": [
                "schema: paperclip/v1",
                ...canonicalCompanyExtensionYaml(),
                "agents:",
                "  coder:",
                ...canonicalAgentExtensionYaml(),
                "projects:",
                "  app:",
                "    inputs:",
                "      env:",
                "        OPENAI_API_KEY:",
                "          kind: secret",
                "          requirement: required",
                "",
              ].join("\n"),
            },
          },
          include: {
            company: false,
            agents: true,
            projects: true,
            tasks: false,
          },
          target: {
            mode: "existing_company",
            companyId: "company-1",
          },
          collisionStrategy: "rename",
          adapterOverrides: {
            coder: codexTargetAdapter(),
          },
          secretValues: {
            "project:app:OPENAI_API_KEY": "sk-imported",
          },
        },
        "user-1",
      ),
    ).rejects.toThrow("agent create failed");

    expect(secretSvc.remove).toHaveBeenCalledWith("secret-created-for-failed-import", {
      type: "user",
      userId: "user-1",
    });
  });

  it("reparents imported roots to pre-existing target managers before resolving imported hierarchy", async () => {
    const portability = companyPortabilityService({} as any);
    agentSvc.list.mockResolvedValue([
      {
        id: "existing-manager",
        name: "Existing manager",
        status: "idle",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
    ]);
    agentSvc.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: `${String(input.name).toLowerCase()}-created`,
      name: input.name,
      status: input.status,
    }));

    await portability.importBundle(
      {
        source: {
          type: "inline",
          rootPath: "paperclip-demo",
          files: {
            "COMPANY.md": [
              "---",
              'schema: "agentcompanies/v1"',
              'name: "Imported Paperclip"',
              "includes:",
              "  - agents/team-lead/AGENTS.md",
              "  - agents/qa/AGENTS.md",
              "---",
              "",
            ].join("\n"),
            "agents/team-lead/AGENTS.md": [
              "---",
              'name: "Team Lead"',
              'slug: "team-lead"',
              'kind: "agent"',
              "reportsTo: null",
              "---",
              "",
            ].join("\n"),
            "agents/qa/AGENTS.md": [
              "---",
              'name: "QA"',
              'slug: "qa"',
              'kind: "agent"',
              'reportsTo: "team-lead"',
              "---",
              "",
            ].join("\n"),
            ".paperclip.yaml": [
              'schema: "paperclip/v1"',
              ...canonicalCompanyExtensionYaml(),
              "agents:",
              "  team-lead:",
              '    reportsToExistingAgentId: "existing-manager"',
              '    reportsToExistingAgentSlug: "existing-manager"',
              ...canonicalAgentExtensionYaml(),
              "  qa:",
              ...canonicalAgentExtensionYaml(),
              "",
            ].join("\n"),
          },
        },
        include: {
          company: false,
          agents: true,
          projects: false,
          tasks: false,
        },
        target: { mode: "existing_company", companyId: "company-1" },
        collisionStrategy: "rename",
        adapterOverrides: {
          "team-lead": codexTargetAdapter(),
          qa: codexTargetAdapter(),
        },
      },
      "user-1",
    );

    expect(agentSvc.update).toHaveBeenCalledWith("team lead-created", {
      reportsTo: "existing-manager",
    });
    expect(agentSvc.update).toHaveBeenCalledWith("qa-created", {
      reportsTo: "team lead-created",
    });
  });

  it("exports project env as portable inputs without concrete values", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Launch",
        description: "Ship it",
        leadAgentId: "agent-1",
        targetDate: null,
        color: null,
        status: "planned",
        env: {
          OPENAI_API_KEY: {
            type: "plain",
            value: "sk-project-secret",
          },
          DOCS_MODE: {
            type: "plain",
            value: "strict",
          },
          GITHUB_TOKEN: {
            type: "secret_ref",
            secretId: "11111111-1111-1111-1111-111111111111",
            version: "latest",
          },
        },
        metadata: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: false,
        agents: false,
        projects: true,
        tasks: false,
      },
    });

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain("OPENAI_API_KEY:");
    expect(extension).toContain("DOCS_MODE:");
    expect(extension).toContain("GITHUB_TOKEN:");
    expect(extension).not.toContain("sk-project-secret");
    expect(extension).not.toContain('type: "secret_ref"');
    expect(extension).not.toContain("11111111-1111-1111-1111-111111111111");
    expect(extension).toContain('default: "strict"');
    expect(extension).toContain('kind: "secret"');
    expect(extension).toContain('kind: "plain"');
  });

  it("reads project env inputs back from .paperclip.yaml during preview import", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Launch",
        description: "Ship it",
        leadAgentId: "agent-1",
        targetDate: null,
        color: null,
        status: "planned",
        env: {
          OPENAI_API_KEY: {
            type: "plain",
            value: "sk-project-secret",
          },
        },
        metadata: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: false,
        agents: false,
        projects: true,
        tasks: false,
      },
    });

    const preview = await portability.previewImport({
      source: inlineSource(exported),
      include: {
        company: false,
        agents: false,
        projects: true,
        tasks: false,
      },
      target: {
        mode: "new_company",
        newCompanyName: "Imported Paperclip",
      },
      agents: "all",
      collisionStrategy: "rename",
    });

    expect(preview.errors).toEqual([]);
    expect(preview.envInputs).toContainEqual({
      key: "OPENAI_API_KEY",
      description: "Optional default for OPENAI_API_KEY on project launch",
      projectSlug: "launch",
      kind: "secret",
      requirement: "optional",
      defaultValue: "",
      portability: "portable",
    });
  });
});
