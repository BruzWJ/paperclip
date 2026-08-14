import * as t from "./company-portability.test-support.js";
const { describe, it, companyPortabilityService, companySvc, agentSvc } = t;
const { inlineSource, AGENTS_ONLY_INCLUDE } = t;
const { codexTargetAdapter, expect, adapterConfigurationSvc, projectSvc } = t;
const { runtimeAgentConfigurationSvc, accessSvc, taskSvc, asTextFile } = t;
const { ordinaryTaskRuntime } = t;
import { registerSuiteSetup } from "./company-portability.test-setup-01.js";

describe("company portability", () => {
  registerSuiteSetup();

  it("imports the exact immutable adapter-revision runtime configuration", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    agentSvc.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: `agent-${String(input.name).toLowerCase()}`,
      name: input.name,
    }));

    const exported = await portability.exportBundle("company-1", {
      include: AGENTS_ONLY_INCLUDE,
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle(
      {
        source: inlineSource(exported),
        include: AGENTS_ONLY_INCLUDE,
        target: {
          mode: "new_company",
          newCompanyName: "Imported Paperclip",
        },
        agents: "all",
        collisionStrategy: "rename",
        adapterOverrides: {
          claudecoder: codexTargetAdapter(),
          reviewer: codexTargetAdapter(),
        },
      },
      "user-1",
    );

    expect(adapterConfigurationSvc.createRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: {
          adapterType: "codex",
          adapterConfig: { model: "gpt-5.6" },
        },
      }),
    );
  });

  it("imports only selected files and leaves unchecked company metadata alone", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: AGENTS_ONLY_INCLUDE,
    });

    agentSvc.list.mockResolvedValue([]);
    projectSvc.list.mockResolvedValue([]);
    companySvc.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      budgetCurrency: "USD",
      budgetMonthlyAmount: "0",
      knownSpendAmount: "0",
      description: "Existing company",
      brandColor: "#123456",
      requireBoardApprovalForNewAgents: false,
    });
    agentSvc.create.mockResolvedValue({
      id: "agent-reviewer",
      name: "Reviewer",
    });

    const result = await portability.importBundle(
      {
        source: inlineSource(exported),
        include: {
          company: true,
          agents: true,
          projects: true,
          tasks: true,
        },
        selectedFiles: ["agents/reviewer/AGENTS.md"],
        target: {
          mode: "existing_company",
          companyId: "company-1",
        },
        agents: "all",
        collisionStrategy: "rename",
        adapterOverrides: {
          reviewer: codexTargetAdapter(),
        },
      },
      "user-1",
    );

    expect(companySvc.update).not.toHaveBeenCalled();
    expect(runtimeAgentConfigurationSvc.create).toHaveBeenCalledTimes(1);
    expect(runtimeAgentConfigurationSvc.create).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        configuration: expect.objectContaining({
          name: "Reviewer",
        }),
      }),
    );
    expect(adapterConfigurationSvc.createRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        configuration: {
          adapterType: "codex",
          adapterConfig: { model: "gpt-5.6" },
        },
      }),
    );
    expect(result.company.action).toBe("unchanged");
    expect(result.agents).toEqual([
      {
        slug: "reviewer",
        id: "agent-reviewer",
        action: "created",
        name: "Reviewer",
        reason: null,
      },
    ]);
  });

  it("applies exact adapter overrides without lowering portable AGENTS content into ACP config", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const exported = await portability.exportBundle("company-1", {
      include: AGENTS_ONLY_INCLUDE,
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle(
      {
        source: inlineSource(exported),
        include: AGENTS_ONLY_INCLUDE,
        target: {
          mode: "new_company",
          newCompanyName: "Imported Paperclip",
        },
        agents: "all",
        collisionStrategy: "rename",
        adapterOverrides: {
          claudecoder: codexTargetAdapter(),
          reviewer: codexTargetAdapter(),
        },
      },
      "user-1",
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
  });

  it("persists only the exact declarative ACP selection on import", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "agent-created",
      name: String(input.name),
    }));

    const exported = await portability.exportBundle("company-1", {
      include: AGENTS_ONLY_INCLUDE,
    });

    agentSvc.list.mockResolvedValue([]);

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

    const firstRevisionInput = adapterConfigurationSvc.createRevision.mock.calls[0]?.[0] as Record<
      string,
      any
    >;
    expect(firstRevisionInput?.configuration).toMatchObject({
      adapterType: "codex",
      adapterConfig: { model: "gpt-5.6" },
    });
  });

  it("preserves task labelIds through export and import round-trip", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Launch",
        description: null,
        status: "active",
        leadAgentId: null,
        metadata: null,
      },
    ]);
    taskSvc.list.mockResolvedValue([
      {
        id: "task-1",
        identifier: "PAP-1",
        title: "Labelled task",
        request: "Has labels",
        projectId: "project-1",
        ownerAgentId: "agent-1",
        boardPresentationStatus: "todo",
        lifecycleStatus: "open",
        disposition: null,
        priority: "high",
        labelIds: ["label-a", "label-b"],
        billingCode: null,
        assigneeAdapterOverrides: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: { company: true, agents: false, projects: true, tasks: true },
    });

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain("labelIds:");
    expect(extension).toContain("label-a");
    expect(extension).toContain("label-b");
    expect(extension).not.toContain("contextAccessMask");

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.list.mockResolvedValue([
      {
        id: "agent-imported",
        name: "ClaudeCoder",
        status: "idle",
      },
    ]);
    projectSvc.list.mockResolvedValue([]);
    projectSvc.create.mockResolvedValue({
      id: "project-imported",
      name: "Launch",
    });
    await portability.importBundle(
      {
        source: inlineSource(exported),
        include: {
          company: true,
          agents: false,
          projects: true,
          tasks: true,
        },
        target: { mode: "new_company", newCompanyName: "Imported" },
        agents: "all",
        collisionStrategy: "rename",
      },
      "user-1",
    );

    expect(ordinaryTaskRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-imported",
        labelIds: ["label-a", "label-b"],
      }),
    );
    expect(ordinaryTaskRuntime.create.mock.calls[0]?.[0]).not.toHaveProperty("contextAccessMask");
  });
});
