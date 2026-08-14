import * as t from "./company-portability.test-support.js";
const { describe, it, companyPortabilityService, projectSvc, taskSvc, companySvc } = t;
const { inlineSource, AGENTS_ONLY_INCLUDE } = t;
const { accessSvc, agentSvc, expect, ordinaryTaskRuntime, taskSessionProducers } = t;
const { preflightAdapterConfiguration, secretSvc, canonicalCompanyExtensionYaml } = t;
const { codexTargetAdapter, runtimeAgentConfigurationSvc, adapterConfigurationSvc } = t;
import { registerSuiteSetup } from "./company-portability.test-setup-01.js";

describe("company portability", () => {
  registerSuiteSetup();

  it("rejects task imports without a named board creator", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([]);
    taskSvc.list.mockResolvedValue([
      {
        id: "task-1",
        identifier: "PAP-1",
        title: "Private board note",
        request: "Need private follow-up.",
        projectId: null,
        ownerAgentId: "agent-1",
        boardPresentationStatus: "todo",
        lifecycleStatus: "open",
        priority: "medium",
        labelIds: [],
        billingCode: null,
        assigneeAdapterOverrides: null,
      },
    ]);
    taskSvc.listComments.mockResolvedValue([
      {
        id: "comment-1",
        taskId: "task-1",
        companyId: "company-1",
        authorType: "user",
        authorAgentId: null,
        authorUserId: "board-user",
        body: "Need private follow-up.",
        presentation: null,
        metadata: null,
        createdAt: new Date("2026-05-04T12:00:00.000Z"),
        updatedAt: new Date("2026-05-04T12:00:00.000Z"),
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: { company: true, agents: false, projects: false, tasks: true },
    });

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.list.mockResolvedValue([]);
    projectSvc.list.mockResolvedValue([]);
    await expect(
      portability.importBundle(
        {
          source: inlineSource(exported),
          include: {
            company: true,
            agents: false,
            projects: false,
            tasks: true,
          },
          target: { mode: "new_company", newCompanyName: "Imported" },
          agents: "all",
          collisionStrategy: "rename",
        },
        null,
      ),
    ).rejects.toThrow("requires a named importing board user");
    expect(ordinaryTaskRuntime.create).not.toHaveBeenCalled();
    expect(taskSessionProducers.appendCanonicalControlNotice).not.toHaveBeenCalled();
  });

  it("never normalizes a whitespace-variant adapter identity", async () => {
    const portability = companyPortabilityService({} as any);
    const exported = await portability.exportBundle("company-1", {
      include: AGENTS_ONLY_INCLUDE,
    });

    agentSvc.list.mockResolvedValue([]);

    await expect(
      portability.importBundle(
        {
          source: inlineSource(exported),
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
          agents: ["claudecoder"],
          collisionStrategy: "rename",
          adapterOverrides: {
            claudecoder: {
              adapterType: " codex ",
              adapterConfig: {
                model: "gpt-5.6",
              },
            },
          },
        },
        "user-1",
        {
          mode: "agent_safe",
          sourceCompanyId: "company-1",
        },
      ),
    ).rejects.toThrow("Adapter type must be an exact non-blank string");

    expect(preflightAdapterConfiguration).toHaveBeenCalledTimes(1);
    expect(preflightAdapterConfiguration).toHaveBeenCalledWith({
      adapterType: " codex ",
      adapterConfig: { model: "gpt-5.6" },
    });
    expect(agentSvc.create).not.toHaveBeenCalled();
  });

  it("reports invalid imported project env on agent-safe import preview", async () => {
    const portability = companyPortabilityService({} as any);
    secretSvc.normalizeEnvBindingsForPersistence.mockRejectedValueOnce(
      new Error("Secret must belong to same company"),
    );

    const preview = await portability.previewImport(
      {
        source: {
          type: "inline",
          files: {
            "COMPANY.md": "---\nname: Import\nincludes:\n  - projects/app/PROJECT.md\n---\n",
            "projects/app/PROJECT.md": "---\nname: App\nslug: app\n---\n\n# App\n",
            ".paperclip.yaml": [
              "schema: paperclip/v1",
              ...canonicalCompanyExtensionYaml(),
              "projects:",
              "  app:",
              "    inputs:",
              "      env:",
              "        API_KEY:",
              "          kind: secret",
              "          requirement: required",
              "    env:",
              "      API_KEY:",
              "        type: secret_ref",
              "        secretId: 22222222-2222-4222-8222-222222222222",
              "        version: latest",
              "",
            ].join("\n"),
          },
        },
        include: {
          company: false,
          agents: false,
          projects: true,
          tasks: false,
        },
        target: {
          mode: "existing_company",
          companyId: "company-1",
        },
        collisionStrategy: "rename",
      },
      {
        mode: "agent_safe",
        sourceCompanyId: "company-1",
      },
    );

    expect(preview.errors).toContain("Secret must belong to same company");
  });

  it("imports new agents with exact declarative ACP configuration while preserving future hire approval settings", async () => {
    const portability = companyPortabilityService({} as any);
    const exported = await portability.exportBundle("company-1", {
      include: AGENTS_ONLY_INCLUDE,
    });

    agentSvc.list.mockResolvedValue([]);
    agentSvc.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "agent-created",
      name: String(input.name),
      status: input.status,
    }));

    await portability.importBundle(
      {
        source: inlineSource(exported),
        include: AGENTS_ONLY_INCLUDE,
        target: {
          mode: "new_company",
          newCompanyName: "Imported Paperclip",
        },
        agents: ["claudecoder"],
        collisionStrategy: "rename",
        adapterOverrides: {
          claudecoder: codexTargetAdapter(),
        },
      },
      "user-1",
    );

    expect(runtimeAgentConfigurationSvc.create).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-imported",
        configuration: expect.objectContaining({
          name: "ClaudeCoder",
        }),
      }),
    );
    expect(adapterConfigurationSvc.createRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-imported",
        configuration: expect.objectContaining({
          adapterType: "codex",
          adapterConfig: { model: "gpt-5.6" },
        }),
      }),
    );
    expect(companySvc.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requireBoardApprovalForNewAgents: false,
      }),
      "user-1",
    );
  });

  it("passes exact declarative ACP configuration through replace imports", async () => {
    const portability = companyPortabilityService({} as any);
    const exported = await portability.exportBundle("company-1", {
      include: AGENTS_ONLY_INCLUDE,
    });

    agentSvc.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      id,
      name: "ClaudeCoder",
    }));

    await portability.importBundle(
      {
        source: inlineSource(exported),
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
        agents: ["claudecoder"],
        collisionStrategy: "replace",
        adapterOverrides: {
          claudecoder: codexTargetAdapter(),
        },
      },
      "user-1",
    );

    expect(runtimeAgentConfigurationSvc.update).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAgentId: "agent-1",
        configuration: expect.objectContaining({
          name: "ClaudeCoder",
        }),
      }),
    );
    expect(adapterConfigurationSvc.createRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        configuration: expect.objectContaining({
          adapterType: "codex",
          adapterConfig: { model: "gpt-5.6" },
        }),
      }),
    );
  });

  it("nameOverrides applied after collision detection do not re-validate uniqueness", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: false,
        agents: true,
        projects: false,
        tasks: false,
      },
    });

    // Simulate existing agents so collision detection triggers rename
    agentSvc.list.mockResolvedValue([
      {
        id: "existing-1",
        name: "ClaudeCoder",
        status: "idle",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
    ]);

    const preview = await portability.previewImport({
      source: inlineSource(exported),
      include: {
        company: false,
        agents: true,
        projects: false,
        tasks: false,
      },
      target: { mode: "existing_company", companyId: "company-1" },
      agents: ["claudecoder"],
      collisionStrategy: "rename",
      nameOverrides: { claudecoder: "ClaudeCoder" },
      adapterOverrides: {
        claudecoder: codexTargetAdapter(),
      },
    });

    // The override reverts the renamed agent back to its original collision name.
    // This is a known limitation: nameOverrides bypass collision checks.
    const plan = preview.plan.agentPlans.find((p) => p.slug === "claudecoder");
    expect(plan).toBeDefined();
    expect(plan!.action).toBe("create");
    expect(plan!.plannedName).toBe("ClaudeCoder");
  });
});
