import * as t from "./company-portability.test-support.js";
const { describe, it, companyPortabilityService, projectSvc, taskSvc, expect } = t;
const { agentSvc, vi, sourceAdapterRevisionRows, asTextFile, companySvc, Readable } = t;
const { assetSvc, accessSvc, canonicalCompanyExtensionYaml } = t;
import { registerSuiteSetup } from "./company-portability.test-setup-01.js";

describe("company portability", () => {
  registerSuiteSetup();

  it("fails closed for unresolved explicit resource selectors", async () => {
    const portability = companyPortabilityService({} as any);
    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        companyId: "company-1",
        name: "Launch",
        archivedAt: null,
      },
    ]);
    taskSvc.list.mockResolvedValue([
      {
        id: "task-1",
        companyId: "company-1",
        identifier: "PAP-1",
        projectId: "project-1",
      },
    ]);

    await expect(
      portability.exportBundle("company-1", {
        agents: ["11111111-1111-4111-8111-111111111111"],
      }),
    ).rejects.toThrow('Agent ID "11111111-1111-4111-8111-111111111111" was not found');

    await expect(
      portability.exportBundle("company-1", {
        projects: ["22222222-2222-4222-8222-222222222222"],
      }),
    ).rejects.toThrow('Project ID "22222222-2222-4222-8222-222222222222" was not found');

    await expect(
      portability.exportBundle("company-1", {
        tasks: ["33333333-3333-4333-8333-333333333333"],
      }),
    ).rejects.toThrow('Task or routine ID "33333333-3333-4333-8333-333333333333" was not found');

    await expect(
      portability.exportBundle("company-1", {
        projectTasks: ["44444444-4444-4444-8444-444444444444"],
      }),
    ).rejects.toThrow('Project ID "44444444-4444-4444-8444-444444444444" was not found');
  });

  it("rejects export of an agent without a canonical adapter revision", async () => {
    const portability = companyPortabilityService({} as any);
    agentSvc.list.mockResolvedValue([
      {
        id: "agent-unconfigured",
        name: "Unconfigured Hire",
        status: "idle",
        title: "New teammate",
        icon: null,
        reportsTo: null,
        capabilities: "Awaits board configuration",
        currentAdapterConfigRevisionId: null,
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
    ]);

    await expect(
      portability.exportBundle("company-1", {
        include: {
          company: false,
          agents: true,
          projects: false,
          tasks: false,
        },
      }),
    ).rejects.toThrow("has no complete canonical adapter revision");
  });

  it("exports agent permission grants through the Paperclip extension and manifest", async () => {
    const db = {
      select: vi.fn((selection?: Record<string, unknown>) => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => {
            if (selection === undefined) {
              return sourceAdapterRevisionRows();
            }
            if (!selection.permissionKey) return [];
            return [
              {
                principalId: "agent-1",
                permissionKey: "agents:suggest-changes",
                scope: null,
              },
              {
                principalId: "agent-1",
                permissionKey: "agents:configure",
                scope: { targetAgentIds: ["agent-1"] },
              },
            ];
          }),
        })),
      })),
    };
    const portability = companyPortabilityService(db as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        tasks: false,
      },
    });

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain("permissionGrants:");
    expect(extension).toContain('permissionKey: "agents:suggest-changes"');
    expect(extension).toContain('permissionKey: "agents:configure"');
    expect(exported.manifest.agents.find((agent) => agent.slug === "claudecoder")?.permissionGrants).toEqual([
      {
        permissionKey: "agents:configure",
        scope: { targetAgentIds: ["agent-1"] },
      },
      {
        permissionKey: "agents:suggest-changes",
        scope: null,
      },
    ]);
  });

  it("exports hire approval policy only when approval is required", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.getById.mockResolvedValueOnce({
      id: "company-1",
      name: "Paperclip",
      budgetCurrency: "USD",
      budgetMonthlyAmount: "0",
      knownSpendAmount: "0",
      description: null,
      taskPrefix: "PAP",
      brandColor: "#5c5fff",
      logoAssetId: null,
      logoUrl: null,
      requireBoardApprovalForNewAgents: true,
    });

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: false,
        projects: false,
        tasks: false,
      },
    });

    expect(asTextFile(exported.files[".paperclip.yaml"])).toContain("requireBoardApprovalForNewAgents: true");
  });

  it("exports default sidebar order into the Paperclip extension and manifest", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-2",
        companyId: "company-1",
        name: "Zulu",
        description: null,
        leadAgentId: null,
        targetDate: null,
        color: null,
        status: "planned",
        archivedAt: null,
      },
      {
        id: "project-1",
        companyId: "company-1",
        name: "Alpha",
        description: null,
        leadAgentId: null,
        targetDate: null,
        color: null,
        status: "planned",
        archivedAt: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: true,
        tasks: false,
      },
    });

    expect(asTextFile(exported.files[".paperclip.yaml"])).toContain(
      [
        "sidebar:",
        "  agents:",
        '    - "claudecoder"',
        '    - "reviewer"',
        "  projects:",
        '    - "alpha"',
        '    - "zulu"',
      ].join("\n"),
    );
    expect(exported.manifest.sidebar).toEqual({
      agents: ["claudecoder", "reviewer"],
      projects: ["alpha", "zulu"],
    });
  });

  it("exports the company logo into images/ and references it from .paperclip.yaml", async () => {
    const storage = {
      getObject: vi.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from("png-bytes")]),
      }),
    };
    companySvc.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      budgetCurrency: "USD",
      budgetMonthlyAmount: "0",
      knownSpendAmount: "0",
      description: null,
      taskPrefix: "PAP",
      brandColor: "#5c5fff",
      logoAssetId: "logo-1",
      logoUrl: "/api/assets/logo-1/content",
      requireBoardApprovalForNewAgents: true,
    });
    assetSvc.getById.mockResolvedValue({
      id: "logo-1",
      companyId: "company-1",
      objectKey: "assets/companies/logo-1",
      contentType: "image/png",
      originalFilename: "logo.png",
    });

    const portability = companyPortabilityService({} as any, storage as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: false,
        projects: false,
        tasks: false,
      },
    });

    expect(storage.getObject).toHaveBeenCalledWith("company-1", "assets/companies/logo-1");
    expect(exported.files["images/company-logo.png"]).toEqual({
      encoding: "base64",
      data: Buffer.from("png-bytes").toString("base64"),
      contentType: "image/png",
    });
    expect(exported.files[".paperclip.yaml"]).toContain('logoPath: "images/company-logo.png"');
  });

  it("builds export previews without tasks by default", async () => {
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
        archivedAt: null,
      },
    ]);
    taskSvc.list.mockResolvedValue([
      {
        id: "task-1",
        identifier: "PAP-1",
        title: "Write launch task",
        request: "Task body",
        projectId: "project-1",
        ownerAgentId: "agent-1",
        boardPresentationStatus: "todo",
        lifecycleStatus: "open",
        priority: "medium",
        labelIds: [],
        billingCode: null,
        assigneeAdapterOverrides: null,
      },
    ]);

    const preview = await portability.previewExport("company-1", {
      include: {
        company: true,
        agents: true,
        projects: true,
      },
    });

    expect(preview.counts.tasks).toBe(0);
    expect(preview.fileInventory.some((entry) => entry.path.startsWith("tasks/"))).toBe(false);
  });

  it("rejects invalid imported project icon names", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.list.mockResolvedValue([]);
    projectSvc.list.mockResolvedValue([]);
    projectSvc.create.mockResolvedValue({
      id: "project-imported",
      name: "Launch",
    });

    const files = {
      "COMPANY.md": ["---", 'schema: "agentcompanies/v1"', 'name: "Imported Paperclip"', "---", ""].join(
        "\n",
      ),
      "projects/launch/PROJECT.md": [
        "---",
        'kind: "project"',
        'slug: "launch"',
        'name: "Launch"',
        "---",
        "",
      ].join("\n"),
      ".paperclip.yaml": [
        'schema: "paperclip/v1"',
        ...canonicalCompanyExtensionYaml(),
        "projects:",
        "  launch:",
        '    icon: "not-a-project-icon"',
        "",
      ].join("\n"),
    };

    await expect(
      portability.importBundle(
        {
          source: { type: "inline", rootPath: "paperclip-demo", files },
          include: {
            company: true,
            agents: false,
            projects: true,
            tasks: false,
          },
          target: {
            mode: "new_company",
            newCompanyName: "Imported Paperclip",
          },
          collisionStrategy: "rename",
        },
        "user-1",
      ),
    ).rejects.toThrow("Project launch icon must be an exact canonical project icon name or null");

    expect(projectSvc.create).not.toHaveBeenCalled();
  });
});
