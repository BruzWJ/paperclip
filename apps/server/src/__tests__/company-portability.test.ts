import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  type CompanyPortabilityFileEntry,
} from "@paperclipai/shared";
import { testBoardSessionActor } from "./helpers/request-actor.js";
import { testSecretsRuntimeConfig } from "./helpers/secrets-runtime.js";

const companySvc = {
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const agentSvc = {
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const runtimeAgentConfigurationSvc = {
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const adapterConfigurationSvc = {
  createRevision: vi.fn(),
};

const operationalConfigurationSvc = {
  update: vi.fn(),
};

const preflightAdapterConfiguration = vi.fn();

const accessSvc = {
  ensureMembership: vi.fn(),
  stampRoleGrants: vi.fn(),
  listActiveUserMemberships: vi.fn(),
  copyActiveUserMemberships: vi.fn(),
  setPrincipalPermission: vi.fn(),
};

const projectSvc = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const taskSvc = {
  list: vi.fn(),
  listComments: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
};

const ordinaryTaskRuntime = {
  create: vi.fn(),
};

const taskSessionProducers = {
  appendCanonicalControlNotice: vi.fn(),
  appendCanonicalUserComment: vi.fn(),
};

const routineSvc = {
  list: vi.fn(),
  getDetail: vi.fn(),
  create: vi.fn(),
  createTrigger: vi.fn(),
};

const assetSvc = {
  getById: vi.fn(),
  create: vi.fn(),
};

const secretSvc = {
  create: vi.fn(async () => ({ id: "secret-created" })),
  remove: vi.fn(async () => true),
  normalizeEnvBindingsForPersistence: vi.fn(
    async (_companyId: string, env: Record<string, unknown>) => env,
  ),
  syncEnvBindingsForTarget: vi.fn(async () => []),
};

vi.mock("../services/companies.js", () => ({
  companyService: () => companySvc,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => agentSvc,
}));

vi.mock("../services/runtime-agent-configuration.js", () => ({
  createRuntimeAgentConfigurationService: () => runtimeAgentConfigurationSvc,
}));

vi.mock("../services/agent-adapter-config-revisions.js", () => ({
  createAgentAdapterConfigurationService: () => adapterConfigurationSvc,
  validateRegisteredAdapterRuntimeConfiguration: preflightAdapterConfiguration,
}));

vi.mock("../services/agent-operational-configuration.js", () => ({
  createAgentOperationalConfigurationService: () => operationalConfigurationSvc,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => accessSvc,
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => projectSvc,
}));

vi.mock("../services/tasks.js", () => ({
  taskService: () => taskSvc,
}));

vi.mock("../services/ordinary-task-runtime.js", () => ({
  createOrdinaryTaskRuntime: () => ordinaryTaskRuntime,
}));

vi.mock("../services/task-session-producers.js", () => taskSessionProducers);

vi.mock("../services/routines.js", () => ({
  routineService: () => routineSvc,
}));

vi.mock("../services/assets.js", () => ({
  assetService: () => assetSvc,
}));

vi.mock("../services/secrets.js", async () => {
  const actual = await vi.importActual<typeof import("../services/secrets.js")>(
    "../services/secrets.js",
  );
  return {
    ...actual,
    secretService: () => secretSvc,
  };
});

vi.mock("../routes/org-chart-svg.js", () => ({
  renderOrgChartPng: vi.fn(async () => Buffer.from("png")),
}));

const { companyPortabilityService: createCompanyPortabilityService } =
  await import("../services/company-portability.js");

const testBoardAuthorization = testBoardSessionActor({
  userId: "user-1",
  companyIds: ["company-1"],
});

const SOURCE_ADAPTER_REVISION_ID = "11111111-1111-4111-8111-111111111111";
const FALLBACK_SELECTED_ID = "31111111-1111-4111-8111-111111111111";

function sourceAcpConfiguration() {
  const model = "gpt-5.6";
  return {
    contractVersion: "acpx-runtime/v1" as const,
    launchProfile: {
      registryName: "codex",
    },
    sessionConfigSelections: [{ configId: "model", value: model }],
    model: {
      value: model,
      label: model,
    },
  };
}

async function sourceAdapterRevisionRows() {
  const listedAgents = await agentSvc.list();
  return listedAgents
    .filter(
      (agent: Record<string, any>) =>
        typeof agent.currentAdapterConfigRevisionId === "string",
    )
    .map((agent: Record<string, any>) => ({
      id: agent.currentAdapterConfigRevisionId,
      companyId: agent.companyId ?? "company-1",
      agentId: agent.id,
      acpConfiguration: sourceAcpConfiguration(),
    }));
}

function canonicalAgentExtensionYaml(indent = "    ", adapterType = "codex") {
  return [
    `${indent}adapterRevision:`,
    `${indent}  sourceRevisionId: "${SOURCE_ADAPTER_REVISION_ID}"`,
    `${indent}  acpConfiguration:`,
    `${indent}    contractVersion: "acpx-runtime/v1"`,
    `${indent}    launchProfile:`,
    `${indent}      registryName: "${adapterType}"`,
    `${indent}    sessionConfigSelections:`,
    `${indent}      - configId: "model"`,
    `${indent}        value: "gpt-5.6"`,
    `${indent}    model:`,
    `${indent}      value: "gpt-5.6"`,
    `${indent}      label: "GPT-5.6"`,
    `${indent}contextGrants:`,
    ...AGENT_CONTEXT_GRANT_KEYS.map((key) => `${indent}  ${key}: false`),
    `${indent}actionGrants:`,
    ...PAPERCLIP_ACTION_KEYS.map((key) => `${indent}  ${key}: false`),
    `${indent}mentionReachGrants:`,
    ...AGENT_MENTION_REACH_GRANT_KEYS.map((key) => `${indent}  ${key}: false`),
    `${indent}budgetMonthlyAmount: "0"`,
  ];
}

function canonicalCompanyExtensionYaml(indent = "") {
  return [
    `${indent}company:`,
    `${indent}  budgetCurrency: "USD"`,
    `${indent}  budgetMonthlyAmount: "0"`,
  ];
}

function companyPortabilityService(
  db: Parameters<typeof createCompanyPortabilityService>[0],
  storage?: Parameters<typeof createCompanyPortabilityService>[1],
) {
  const effectiveDb =
    typeof (db as { select?: unknown })?.select === "function"
      ? db
      : ({
          select: (selection?: Record<string, unknown>) => ({
            from: () => ({
              where: async () => {
                if (selection && "principalId" in selection) return [];
                if (selection === undefined) {
                  return sourceAdapterRevisionRows();
                }
                return [{ id: FALLBACK_SELECTED_ID }];
              },
            }),
          }),
        } as unknown as Parameters<typeof createCompanyPortabilityService>[0]);
  const portability = createCompanyPortabilityService(
    effectiveDb,
    storage,
    ordinaryTaskRuntime as Parameters<
      typeof createCompanyPortabilityService
    >[2],
    testSecretsRuntimeConfig(),
  );
  return {
    ...portability,
    importBundle(
      input: Parameters<typeof portability.importBundle>[0],
      actorUserId: Parameters<typeof portability.importBundle>[1],
      options?: Parameters<typeof portability.importBundle>[2],
    ) {
      return portability.importBundle(input, actorUserId, {
        authorizationActor: testBoardAuthorization,
        secretMutationActor: actorUserId
          ? { type: "user", userId: actorUserId }
          : { type: "system" },
        ...options,
      });
    },
  };
}

function asTextFile(entry: CompanyPortabilityFileEntry | undefined) {
  expect(typeof entry).toBe("string");
  return typeof entry === "string" ? entry : "";
}

function fullFalseGrantMap(keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, false]));
}

function codexTargetAdapter() {
  return {
    adapterType: "codex",
    adapterConfig: {
      model: "gpt-5.6",
    },
  };
}

describe("company portability", () => {
  const importedAgents = new Map<string, Record<string, any>>();

  beforeEach(() => {
    vi.clearAllMocks();
    importedAgents.clear();
    runtimeAgentConfigurationSvc.get.mockResolvedValue({
      contextGrants: fullFalseGrantMap(AGENT_CONTEXT_GRANT_KEYS),
      actionGrants: fullFalseGrantMap(PAPERCLIP_ACTION_KEYS),
      mentionReachGrants: fullFalseGrantMap(AGENT_MENTION_REACH_GRANT_KEYS),
    });
    runtimeAgentConfigurationSvc.create.mockImplementation(
      async (input: any) => {
        const created = await agentSvc.create(input.companyId, {
          ...input.configuration,
          status: "idle",
        });
        const agentId =
          created?.id ??
          `agent-${String(input.configuration.name)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")}`;
        importedAgents.set(agentId, {
          companyId: input.companyId,
          status: "idle",
          ...input.configuration,
          ...created,
          id: agentId,
        });
        return {
          agentId,
          companyId: input.companyId,
          configuration: input.configuration,
          auditId: `audit-${agentId}`,
          retried: false,
        };
      },
    );
    runtimeAgentConfigurationSvc.update.mockImplementation(
      async (input: any) => {
        const updated = await agentSvc.update(
          input.targetAgentId,
          input.configuration,
        );
        const previous = importedAgents.get(input.targetAgentId) ?? {};
        const row = {
          ...previous,
          companyId: input.companyId,
          status: "idle",
          ...input.configuration,
          ...updated,
          id: input.targetAgentId,
        };
        importedAgents.set(input.targetAgentId, row);
        return {
          agentId: input.targetAgentId,
          companyId: input.companyId,
          configuration: input.configuration,
          auditId: `audit-${input.targetAgentId}`,
          retried: false,
        };
      },
    );
    operationalConfigurationSvc.update.mockImplementation(
      async (input: any) => {
        const row = {
          ...(importedAgents.get(input.agentId) ?? {}),
          ...input.configuration,
          id: input.agentId,
          companyId: input.companyId,
        };
        importedAgents.set(input.agentId, row);
        return { agent: row };
      },
    );
    adapterConfigurationSvc.createRevision.mockImplementation(
      async (input: any) => {
        const row = {
          ...(importedAgents.get(input.agentId) ?? {}),
          ...input.configuration,
          id: input.agentId,
          companyId: input.companyId,
        };
        importedAgents.set(input.agentId, row);
        return { agent: row };
      },
    );
    agentSvc.getById.mockImplementation(async (agentId: string) => {
      const imported = importedAgents.get(agentId);
      if (imported) return imported;
      const createCall =
        runtimeAgentConfigurationSvc.create.mock.calls.at(-1)?.[0];
      if (createCall) {
        return {
          id: agentId,
          companyId: createCall.companyId,
          name: createCall.configuration.name,
          status: "idle",
        };
      }
      const listed = await agentSvc.list();
      return (
        listed.find((agent: { id: string }) => agent.id === agentId) ?? null
      );
    });
    preflightAdapterConfiguration.mockReset();
    preflightAdapterConfiguration.mockResolvedValue(undefined);
    secretSvc.create.mockResolvedValue({ id: "secret-created" });
    secretSvc.remove.mockResolvedValue(true);
    secretSvc.normalizeEnvBindingsForPersistence.mockImplementation(
      async (_companyId, env) => env,
    );
    secretSvc.syncEnvBindingsForTarget.mockResolvedValue([]);
    taskSvc.listComments.mockResolvedValue([]);
    ordinaryTaskRuntime.create.mockResolvedValue({
      task: {
        id: "task-imported",
        title: "Imported task",
      },
      executionRef: {
        id: "ref-imported",
      },
    });
    taskSessionProducers.appendCanonicalControlNotice.mockResolvedValue({
      commentId: "comment-imported",
    });
    taskSessionProducers.appendCanonicalUserComment.mockResolvedValue({
      commentId: "comment-imported",
    });
    companySvc.getById.mockResolvedValue({
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
      requireBoardApprovalForNewAgents: false,
    });
    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
      budgetCurrency: "USD",
      budgetMonthlyAmount: "0",
      knownSpendAmount: "0",
      requireBoardApprovalForNewAgents: false,
    });
    agentSvc.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "ClaudeCoder",
        status: "idle",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        currentAdapterConfigRevisionId: "11111111-1111-4111-8111-111111111111",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction:
          "Review implementation work carefully before reporting completion.",
      },
      {
        id: "agent-2",
        name: "Reviewer",
        status: "idle",
        title: "Review Lead",
        icon: "globe",
        reportsTo: null,
        capabilities: "Owns marketing",
        currentAdapterConfigRevisionId: "11111111-1111-4111-8111-111111111112",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
    ]);
    projectSvc.list.mockResolvedValue([]);
    taskSvc.list.mockResolvedValue([]);
    taskSvc.getById.mockResolvedValue(null);
    taskSvc.getByIdentifier.mockResolvedValue(null);
    routineSvc.list.mockResolvedValue([]);
    routineSvc.getDetail.mockImplementation(async (id: string) => {
      const rows = await routineSvc.list();
      return rows.find((row: { id: string }) => row.id === id) ?? null;
    });
    routineSvc.create.mockImplementation(
      async (_companyId: string, input: Record<string, unknown>) => ({
        id: "routine-created",
        companyId: "company-1",
        projectId: input.projectId,
        goalId: null,
        parentTaskId: null,
        title: input.title,
        description: input.description ?? null,
        assigneeAgentId: input.assigneeAgentId,
        priority: input.priority ?? "medium",
        status: input.status ?? "active",
        concurrencyPolicy: input.concurrencyPolicy ?? "coalesce_if_active",
        catchUpPolicy: input.catchUpPolicy ?? "skip_missed",
        createdByAgentId: null,
        createdByUserId: null,
        updatedByAgentId: null,
        updatedByUserId: null,
        lastTriggeredAt: null,
        lastEnqueuedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    routineSvc.createTrigger.mockImplementation(
      async (_routineId: string, input: Record<string, unknown>) => ({
        id: "trigger-created",
        companyId: "company-1",
        routineId: "routine-created",
        kind: input.kind,
        label: input.label ?? null,
        enabled: input.enabled ?? true,
        cronExpression:
          input.kind === "schedule" ? (input.cronExpression ?? null) : null,
        timezone: input.kind === "schedule" ? (input.timezone ?? null) : null,
        nextRunAt: null,
        lastFiredAt: null,
        publicId: null,
        secretId: null,
        signingMode:
          input.kind === "webhook" ? (input.signingMode ?? "bearer") : null,
        replayWindowSec:
          input.kind === "webhook" ? (input.replayWindowSec ?? 300) : null,
        lastRotatedAt: null,
        lastResult: null,
        createdByAgentId: null,
        createdByUserId: null,
        updatedByAgentId: null,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    assetSvc.getById.mockReset();
    assetSvc.getById.mockResolvedValue(null);
    assetSvc.create.mockReset();
    accessSvc.setPrincipalPermission.mockResolvedValue(undefined);
    assetSvc.create.mockResolvedValue({
      id: "asset-created",
    });
    accessSvc.listActiveUserMemberships.mockResolvedValue([
      {
        id: "membership-1",
        companyId: "company-1",
        principalType: "user",
        principalId: "user-1",
        membershipRole: "owner",
        status: "active",
      },
    ]);
    accessSvc.copyActiveUserMemberships.mockResolvedValue([]);
  });

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
    ).rejects.toThrow(
      'Agent ID "11111111-1111-4111-8111-111111111111" was not found',
    );

    await expect(
      portability.exportBundle("company-1", {
        projects: ["22222222-2222-4222-8222-222222222222"],
      }),
    ).rejects.toThrow(
      'Project ID "22222222-2222-4222-8222-222222222222" was not found',
    );

    await expect(
      portability.exportBundle("company-1", {
        tasks: ["33333333-3333-4333-8333-333333333333"],
      }),
    ).rejects.toThrow(
      'Task or routine ID "33333333-3333-4333-8333-333333333333" was not found',
    );

    await expect(
      portability.exportBundle("company-1", {
        projectTasks: ["44444444-4444-4444-8444-444444444444"],
      }),
    ).rejects.toThrow(
      'Project ID "44444444-4444-4444-8444-444444444444" was not found',
    );
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
    expect(
      exported.manifest.agents.find((agent) => agent.slug === "claudecoder")
        ?.permissionGrants,
    ).toEqual([
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

    expect(asTextFile(exported.files[".paperclip.yaml"])).toContain(
      "requireBoardApprovalForNewAgents: true",
    );
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

    expect(storage.getObject).toHaveBeenCalledWith(
      "company-1",
      "assets/companies/logo-1",
    );
    expect(exported.files["images/company-logo.png"]).toEqual({
      encoding: "base64",
      data: Buffer.from("png-bytes").toString("base64"),
      contentType: "image/png",
    });
    expect(exported.files[".paperclip.yaml"]).toContain(
      'logoPath: "images/company-logo.png"',
    );
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
    expect(
      preview.fileInventory.some((entry) => entry.path.startsWith("tasks/")),
    ).toBe(false);
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
      "COMPANY.md": [
        "---",
        'schema: "agentcompanies/v1"',
        'name: "Imported Paperclip"',
        "---",
        "",
      ].join("\n"),
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
          target: { mode: "new_company", newCompanyName: "Imported Paperclip" },
          collisionStrategy: "rename",
        },
        "user-1",
      ),
    ).rejects.toThrow(
      "Project launch icon must be an exact canonical project icon name or null",
    );

    expect(projectSvc.create).not.toHaveBeenCalled();
  });

  it("imports agent permission grants from package metadata", async () => {
    const portability = companyPortabilityService({} as any);
    agentSvc.list.mockResolvedValue([]);
    agentSvc.create.mockImplementation(
      async (_companyId: string, input: Record<string, unknown>) => ({
        id: "agent-imported",
        name: input.name,
        status: input.status,
      }),
    );

    await portability.importBundle(
      {
        source: {
          type: "inline",
          files: {
            "COMPANY.md": [
              "---",
              "name: Import",
              "includes:",
              "  - agents/coder/AGENTS.md",
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
              "projects/app/PROJECT.md": [
                "---",
                "name: App",
                "slug: app",
                "kind: project",
                "---",
                "",
              ].join("\n"),
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

    expect(secretSvc.remove).toHaveBeenCalledWith(
      "secret-created-for-failed-import",
      { type: "user", userId: "user-1" },
    );
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
    agentSvc.create.mockImplementation(
      async (_companyId: string, input: Record<string, unknown>) => ({
        id: `${String(input.name).toLowerCase()}-created`,
        name: input.name,
        status: input.status,
      }),
    );

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
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
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

  it("exports routines as recurring task packages with Paperclip routine extensions", async () => {
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
    routineSvc.list.mockResolvedValue([
      {
        id: "routine-1",
        companyId: "company-1",
        projectId: "project-1",
        goalId: null,
        parentTaskId: null,
        title: "Monday Review",
        description: "Review pipeline health",
        assigneeAgentId: "agent-1",
        priority: "high",
        status: "paused",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "enqueue_missed_with_cap",
        createdByAgentId: null,
        createdByUserId: null,
        updatedByAgentId: null,
        updatedByUserId: null,
        lastTriggeredAt: null,
        lastEnqueuedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        triggers: [
          {
            id: "trigger-1",
            companyId: "company-1",
            routineId: "routine-1",
            kind: "schedule",
            label: "Weekly cadence",
            enabled: true,
            cronExpression: "0 9 * * 1",
            timezone: "America/Chicago",
            nextRunAt: null,
            lastFiredAt: null,
            publicId: "public-1",
            secretId: "secret-1",
            signingMode: null,
            replayWindowSec: null,
            lastRotatedAt: null,
            lastResult: null,
            createdByAgentId: null,
            createdByUserId: null,
            updatedByAgentId: null,
            updatedByUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: "trigger-2",
            companyId: "company-1",
            routineId: "routine-1",
            kind: "webhook",
            label: "External nudge",
            enabled: false,
            cronExpression: null,
            timezone: null,
            nextRunAt: null,
            lastFiredAt: null,
            publicId: "public-2",
            secretId: "secret-2",
            signingMode: "hmac_sha256",
            replayWindowSec: 120,
            lastRotatedAt: null,
            lastResult: null,
            createdByAgentId: null,
            createdByUserId: null,
            updatedByAgentId: null,
            updatedByUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        lastRun: null,
        activeTask: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: true,
        tasks: true,
      },
    });

    expect(asTextFile(exported.files["tasks/monday-review/TASK.md"])).toContain(
      "recurring: true",
    );
    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain("routines:");
    expect(extension).toContain("monday-review:");
    expect(extension).toContain('cronExpression: "0 9 * * 1"');
    expect(extension).toContain('signingMode: "hmac_sha256"');
    expect(extension).not.toContain("contextAccessMask");
    expect(extension).not.toContain("secretId");
    expect(extension).not.toContain("publicId");
    expect(exported.manifest.tasks).toEqual([
      expect.objectContaining({
        slug: "monday-review",
        recurring: true,
        boardPresentationStatus: "paused",
        priority: "high",
        routine: expect.objectContaining({
          concurrencyPolicy: "always_enqueue",
          catchUpPolicy: "enqueue_missed_with_cap",
          triggers: expect.arrayContaining([
            expect.objectContaining({
              kind: "schedule",
              cronExpression: "0 9 * * 1",
              timezone: "America/Chicago",
            }),
            expect.objectContaining({
              kind: "webhook",
              enabled: false,
              signingMode: "hmac_sha256",
              replayWindowSec: 120,
            }),
          ]),
        }),
      }),
    ]);
  });

  it("exports formerly built-in records as ordinary agents and routines", async () => {
    const portability = companyPortabilityService({} as any);

    agentSvc.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "ClaudeCoder",
        status: "idle",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        currentAdapterConfigRevisionId: SOURCE_ADAPTER_REVISION_ID,
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
      {
        id: "agent-built-in",
        name: "Reflection Coach",
        status: "paused",
        title: "Reflection Coach",
        icon: "sparkles",
        reportsTo: null,
        capabilities: "Reviews trajectories",
        currentAdapterConfigRevisionId: "11111111-1111-4111-8111-111111111112",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
    ]);
    routineSvc.list.mockResolvedValue([
      {
        id: "routine-built-in",
        companyId: "company-1",
        projectId: null,
        goalId: null,
        parentTaskId: null,
        title: "Review recent agent trajectories for coaching proposals",
        description:
          "Review recent agent work and propose coaching follow-ups.",
        assigneeAgentId: "agent-built-in",
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        createdByAgentId: null,
        createdByUserId: null,
        updatedByAgentId: null,
        updatedByUserId: null,
        lastTriggeredAt: null,
        lastEnqueuedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        originKind: "built_in_agent_bundle",
        originId: "reflection-coach:recent-agent-reflection",
        originFingerprint: null,
        triggers: [
          {
            id: "trigger-built-in",
            companyId: "company-1",
            routineId: "routine-built-in",
            kind: "schedule",
            label: "Weekly review",
            enabled: false,
            cronExpression: "0 9 * * 1",
            timezone: "UTC",
            nextRunAt: null,
            lastFiredAt: null,
            publicId: "public-built-in",
            secretId: "secret-built-in",
            signingMode: null,
            replayWindowSec: null,
            lastRotatedAt: null,
            lastResult: null,
            createdByAgentId: null,
            createdByUserId: null,
            updatedByAgentId: null,
            updatedByUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        lastRun: null,
        activeTask: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: true,
        tasks: true,
      },
    });

    expect(exported.files["agents/claudecoder/AGENTS.md"]).toBeDefined();
    expect(exported.files["agents/reflection-coach/AGENTS.md"]).toBeDefined();
    expect(
      exported.files[
        "tasks/review-recent-agent-trajectories-for-coaching-proposals/TASK.md"
      ],
    ).toBeDefined();
    expect(exported.manifest.agents.map((agent) => agent.slug)).toEqual([
      "claudecoder",
      "reflection-coach",
    ]);
    expect(exported.manifest.tasks).toEqual([
      expect.objectContaining({
        slug: "review-recent-agent-trajectories-for-coaching-proposals",
        recurring: true,
      }),
    ]);
    expect(exported.warnings).not.toContainEqual(
      expect.stringContaining("built-in managed"),
    );
  });

  it("imports recurring task packages as routines instead of one-time tasks", async () => {
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
    projectSvc.create.mockResolvedValue({
      id: "project-created",
      name: "Launch",
    });
    agentSvc.list.mockResolvedValue([]);
    projectSvc.list.mockResolvedValue([]);

    const files = {
      "COMPANY.md": [
        "---",
        'schema: "agentcompanies/v1"',
        'name: "Imported Paperclip"',
        "---",
        "",
      ].join("\n"),
      "agents/claudecoder/AGENTS.md": [
        "---",
        'kind: "agent"',
        'slug: "claudecoder"',
        'name: "ClaudeCoder"',
        "reportsTo: null",
        "---",
        "",
      ].join("\n"),
      "projects/launch/PROJECT.md": [
        "---",
        'kind: "project"',
        'slug: "launch"',
        'name: "Launch"',
        "---",
        "",
      ].join("\n"),
      "tasks/monday-review/TASK.md": [
        "---",
        'kind: "task"',
        'slug: "monday-review"',
        'name: "Monday Review"',
        'project: "launch"',
        'owner: "claudecoder"',
        "recurring: true",
        "---",
        "",
        "Review pipeline health.",
        "",
      ].join("\n"),
      ".paperclip.yaml": [
        'schema: "paperclip/v1"',
        ...canonicalCompanyExtensionYaml(),
        "agents:",
        "  claudecoder:",
        ...canonicalAgentExtensionYaml(),
        "tasks:",
        "  monday-review:",
        '    lifecycleStatus: "open"',
        '    boardPresentationStatus: "paused"',
        '    priority: "high"',
        "routines:",
        "  monday-review:",
        '    concurrencyPolicy: "always_enqueue"',
        '    catchUpPolicy: "enqueue_missed_with_cap"',
        "    triggers:",
        "      - kind: schedule",
        '        cronExpression: "0 9 * * 1"',
        '        timezone: "America/Chicago"',
        "      - kind: webhook",
        "        enabled: false",
        '        signingMode: "hmac_sha256"',
        "        replayWindowSec: 120",
        "",
      ].join("\n"),
    };

    const preview = await portability.previewImport({
      source: { type: "inline", rootPath: "paperclip-demo", files },
      include: {
        company: true,
        agents: true,
        projects: true,
        tasks: true,
      },
      target: { mode: "new_company", newCompanyName: "Imported Paperclip" },
      agents: "all",
      collisionStrategy: "rename",
      adapterOverrides: {
        claudecoder: codexTargetAdapter(),
      },
    });

    expect(preview.errors).toEqual([]);
    expect(preview.plan.taskPlans).toEqual([
      expect.objectContaining({
        slug: "monday-review",
        reason: "Recurring task will be imported as a routine.",
      }),
    ]);

    const result = await portability.importBundle(
      {
        source: { type: "inline", rootPath: "paperclip-demo", files },
        include: {
          company: true,
          agents: true,
          projects: true,
          tasks: true,
        },
        target: { mode: "new_company", newCompanyName: "Imported Paperclip" },
        agents: "all",
        collisionStrategy: "rename",
        adapterOverrides: {
          claudecoder: codexTargetAdapter(),
        },
      },
      "user-1",
    );

    expect(routineSvc.create).toHaveBeenCalledWith(
      "company-imported",
      expect.objectContaining({
        projectId: "project-created",
        title: "Monday Review",
        assigneeAgentId: "agent-created",
        priority: "high",
        status: "paused",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "enqueue_missed_with_cap",
      }),
      expect.any(Object),
    );
    expect(result.warnings).not.toContain(
      "Task monday-review assignee claudecoder is pending_approval; imported work was left unassigned.",
    );
    expect(routineSvc.createTrigger).toHaveBeenCalledTimes(2);
    expect(routineSvc.createTrigger).toHaveBeenCalledWith(
      "routine-created",
      expect.objectContaining({
        kind: "schedule",
        cronExpression: "0 9 * * 1",
        timezone: "America/Chicago",
      }),
      expect.any(Object),
    );
    expect(routineSvc.createTrigger).toHaveBeenCalledWith(
      "routine-created",
      expect.objectContaining({
        kind: "webhook",
        enabled: false,
        signingMode: "hmac_sha256",
        replayWindowSec: 120,
      }),
      expect.any(Object),
    );
    expect(ordinaryTaskRuntime.create).not.toHaveBeenCalled();
  });

  it("rejects legacy schedule.recurrence packages without the canonical manifest", async () => {
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
    projectSvc.create.mockResolvedValue({
      id: "project-created",
      name: "Launch",
    });
    agentSvc.list.mockResolvedValue([]);
    projectSvc.list.mockResolvedValue([]);

    const files = {
      "COMPANY.md": [
        "---",
        'schema: "agentcompanies/v1"',
        'name: "Imported Paperclip"',
        "---",
        "",
      ].join("\n"),
      "agents/claudecoder/AGENTS.md": [
        "---",
        'name: "ClaudeCoder"',
        "---",
        "",
        "You write code.",
        "",
      ].join("\n"),
      "projects/launch/PROJECT.md": ["---", 'name: "Launch"', "---", ""].join(
        "\n",
      ),
      "tasks/monday-review/TASK.md": [
        "---",
        'name: "Monday Review"',
        'project: "launch"',
        'owner: "claudecoder"',
        "schedule:",
        '  timezone: "America/Chicago"',
        '  startsAt: "2026-03-16T09:00:00-05:00"',
        "  recurrence:",
        '    frequency: "weekly"',
        "    interval: 1",
        "    weekdays:",
        '      - "monday"',
        "---",
        "",
        "Review pipeline health.",
        "",
      ].join("\n"),
    };

    await expect(
      portability.previewImport({
        source: {
          type: "inline",
          rootPath: "paperclip-demo",
          files,
        },
        include: {
          company: true,
          agents: true,
          projects: true,
          tasks: true,
        },
        target: {
          mode: "new_company",
          newCompanyName: "Imported Paperclip",
        },
        agents: "all",
        collisionStrategy: "rename",
        adapterOverrides: {
          claudecoder: codexTargetAdapter(),
        },
      }),
    ).rejects.toThrow("missing the canonical .paperclip.yaml manifest");
    expect(ordinaryTaskRuntime.create).not.toHaveBeenCalled();
  });

  it("rejects a canonical recurring task without an explicit owner", async () => {
    const portability = companyPortabilityService({} as any);

    await expect(
      portability.previewImport({
        source: {
          type: "inline",
          rootPath: "paperclip-demo",
          files: {
            "COMPANY.md": [
              "---",
              'schema: "agentcompanies/v1"',
              'name: "Imported Paperclip"',
              "---",
              "",
            ].join("\n"),
            "tasks/monday-review/TASK.md": [
              "---",
              'name: "Monday Review"',
              "slug: monday-review",
              "recurring: true",
              "---",
              "",
              "Review pipeline health.",
              "",
            ].join("\n"),
            ".paperclip.yaml": [
              'schema: "paperclip/v1"',
              ...canonicalCompanyExtensionYaml(),
              "tasks:",
              "  monday-review:",
              '    lifecycleStatus: "open"',
              '    boardPresentationStatus: "active"',
              "routines:",
              "  monday-review:",
              "    triggers: []",
              "",
            ].join("\n"),
          },
        },
        include: {
          company: true,
          agents: false,
          projects: false,
          tasks: true,
        },
        target: { mode: "new_company", newCompanyName: "Imported Paperclip" },
        collisionStrategy: "rename",
      }),
    ).rejects.toThrow("Task monday-review requires an explicit owner");
  });

  it("rejects a package without the canonical .paperclip.yaml manifest", async () => {
    const portability = companyPortabilityService({} as any);

    await expect(
      portability.previewImport({
        source: {
          type: "inline",
          rootPath: "paperclip-demo",
          files: {
            "COMPANY.md": [
              "---",
              'schema: "agentcompanies/v1"',
              'name: "Imported Paperclip"',
              "---",
              "",
            ].join("\n"),
          },
        },
        include: {
          company: true,
          agents: false,
          projects: false,
          tasks: false,
        },
        target: {
          mode: "new_company",
          newCompanyName: "Imported Paperclip",
        },
      }),
    ).rejects.toThrow("missing the canonical .paperclip.yaml manifest");
  });

  it("rejects noncanonical inline file, root, selection, and include paths", async () => {
    const portability = companyPortabilityService({} as any);
    const canonicalManifest = [
      'schema: "paperclip/v1"',
      ...canonicalCompanyExtensionYaml(),
      "",
    ].join("\n");
    const request = (
      files: Record<string, CompanyPortabilityFileEntry>,
      rootPath = "portable-company",
      selectedFiles?: string[],
    ) =>
      portability.previewImport({
        source: { type: "inline", rootPath, files },
        include: {
          company: true,
          agents: false,
          projects: false,
          tasks: false,
        },
        target: {
          mode: "new_company",
          newCompanyName: "Portable company",
        },
        selectedFiles,
      });
    const canonicalFiles = {
      "COMPANY.md": "---\nname: Portable company\n---\n",
      ".paperclip.yaml": canonicalManifest,
    };

    await expect(
      request({ ...canonicalFiles, "./agents/lead/AGENTS.md": "" }),
    ).rejects.toThrow(
      "Package file path is not an exact portable relative path",
    );
    await expect(request(canonicalFiles, " portable-company")).rejects.toThrow(
      "Inline source root path is not an exact portable relative path",
    );
    await expect(
      request({
        "portable-company/COMPANY.md": canonicalFiles["COMPANY.md"],
        "portable-company/.paperclip.yaml": canonicalManifest,
      }),
    ).rejects.toThrow(
      "must be relative to inline source root portable-company",
    );
    await expect(
      request(canonicalFiles, "portable-company", []),
    ).rejects.toThrow("Selected files must contain at least one path");
    await expect(
      request(canonicalFiles, "portable-company", ["./COMPANY.md"]),
    ).rejects.toThrow(
      "Selected file path is not an exact portable relative path",
    );
    await expect(
      request({
        ...canonicalFiles,
        "COMPANY.md": [
          "---",
          "name: Portable company",
          "includes:",
          "  - ../agents/lead/AGENTS.md",
          "---",
          "",
        ].join("\n"),
      }),
    ).rejects.toThrow(
      "Company include path is not an exact portable relative path",
    );
    await expect(
      request({
        ...canonicalFiles,
        "COMPANY.md": [
          "---",
          "name: Portable company",
          "includes:",
          "  - path: agents/lead/AGENTS.md",
          "---",
          "",
        ].join("\n"),
      }),
    ).rejects.toThrow("Company include 1 must be a path string");
    await expect(
      request({
        ...canonicalFiles,
        "COMPANY.md": [
          "---",
          "name: Portable company",
          "includes:",
          "  - agents/lead/AGENTS.md",
          "  - agents/lead/AGENTS.md",
          "---",
          "",
        ].join("\n"),
      }),
    ).rejects.toThrow(
      "Company include path is duplicated: agents/lead/AGENTS.md",
    );
    await expect(
      request({
        ...canonicalFiles,
        ".paperclip.yaml": [
          'schema: "paperclip/v1"',
          "company:",
          '  budgetCurrency: "USD"',
          '  budgetMonthlyAmount: "0"',
          '  logo: "images/company-logo.png"',
          "",
        ].join("\n"),
      }),
    ).rejects.toThrow("Company manifest contains unsupported fields: logo");
  });

  it("rejects retired agent role frontmatter", async () => {
    const portability = companyPortabilityService({} as any);

    await expect(
      portability.previewImport({
        source: {
          type: "inline",
          rootPath: "legacy-role-package",
          files: {
            "COMPANY.md": [
              "---",
              'schema: "agentcompanies/v1"',
              'name: "Legacy Role Test"',
              "---",
              "",
            ].join("\n"),
            "agents/legacy-agent/AGENTS.md": [
              "---",
              'name: "Legacy Agent"',
              'role: "retired-value"',
              "reportsTo: null",
              "---",
              "",
              "# Legacy Agent",
              "",
              "You run the company.",
              "",
            ].join("\n"),
            ".paperclip.yaml": [
              'schema: "paperclip/v1"',
              ...canonicalCompanyExtensionYaml(),
              "agents:",
              "  legacy-agent:",
              ...canonicalAgentExtensionYaml(),
              "",
            ].join("\n"),
          },
        },
        include: { company: true, agents: true, projects: false, tasks: false },
        target: { mode: "new_company", newCompanyName: "Legacy Role Test" },
        agents: "all",
        collisionStrategy: "rename",
        adapterOverrides: {
          "legacy-agent": codexTargetAdapter(),
        },
      }),
    ).rejects.toThrow("contains unsupported fields: role");
  });

  it("treats no-separator auth and api key env names as secrets during export", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Launch",
        description: "Ship it",
        leadAgentId: null,
        targetDate: null,
        color: null,
        status: "planned",
        env: {
          APIKEY: {
            type: "plain",
            value: "sk-plain-api",
          },
          GITHUBAUTH: {
            type: "plain",
            value: "gh-auth-token",
          },
          PRIVATEKEY: {
            type: "plain",
            value: "private-key-value",
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
    expect(extension).toContain("APIKEY:");
    expect(extension).toContain("GITHUBAUTH:");
    expect(extension).toContain("PRIVATEKEY:");
    expect(extension).not.toContain("sk-plain-api");
    expect(extension).not.toContain("gh-auth-token");
    expect(extension).not.toContain("private-key-value");
    expect(extension).toContain('kind: "secret"');
  });

  it("imports a packaged company logo and attaches it to the target company", async () => {
    const storage = {
      putFile: vi.fn().mockResolvedValue({
        provider: "local_disk",
        objectKey: "assets/companies/imported-logo",
        contentType: "image/png",
        byteSize: 9,
        sha256: "logo-sha",
        originalFilename: "company-logo.png",
      }),
    };
    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
      logoAssetId: null,
    });
    companySvc.update.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
      logoAssetId: "asset-created",
    });
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const portability = companyPortabilityService({} as any, storage as any);
    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        tasks: false,
      },
    });

    exported.files["images/company-logo.png"] = {
      encoding: "base64",
      data: Buffer.from("png-bytes").toString("base64"),
      contentType: "image/png",
    };
    exported.files[".paperclip.yaml"] =
      `${exported.files[".paperclip.yaml"]}`.replace(
        'brandColor: "#5c5fff"\n',
        'brandColor: "#5c5fff"\n  logoPath: "images/company-logo.png"\n',
      );

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle(
      {
        source: {
          type: "inline",
          rootPath: exported.rootPath,
          files: exported.files,
        },
        include: {
          company: true,
          agents: true,
          projects: false,
          tasks: false,
        },
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

    expect(storage.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-imported",
        namespace: "assets/companies",
        originalFilename: "company-logo.png",
        contentType: "image/png",
        body: Buffer.from("png-bytes"),
      }),
    );
    expect(assetSvc.create).toHaveBeenCalledWith(
      "company-imported",
      expect.objectContaining({
        objectKey: "assets/companies/imported-logo",
        contentType: "image/png",
        createdByUserId: "user-1",
      }),
    );
    expect(companySvc.update).toHaveBeenCalledWith("company-imported", {
      logoAssetId: "asset-created",
    });
  });

  it("copies source company memberships for safe new-company imports", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        tasks: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle(
      {
        source: {
          type: "inline",
          rootPath: exported.rootPath,
          files: exported.files,
        },
        include: {
          company: true,
          agents: true,
          projects: false,
          tasks: false,
        },
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
      null,
      {
        mode: "agent_safe",
        sourceCompanyId: "company-1",
      },
    );

    expect(accessSvc.listActiveUserMemberships).toHaveBeenCalledWith(
      "company-1",
    );
    expect(accessSvc.copyActiveUserMemberships).toHaveBeenCalledWith(
      "company-1",
      "company-imported",
    );
    expect(accessSvc.ensureMembership).not.toHaveBeenCalledWith(
      "company-imported",
      "user",
      expect.anything(),
      "owner",
      "active",
    );
  });

  it("imports the exact immutable adapter-revision runtime configuration", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    agentSvc.create.mockImplementation(
      async (_companyId: string, input: Record<string, unknown>) => ({
        id: `agent-${String(input.name).toLowerCase()}`,
        name: input.name,
      }),
    );

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        tasks: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle(
      {
        source: {
          type: "inline",
          rootPath: exported.rootPath,
          files: exported.files,
        },
        include: {
          company: true,
          agents: true,
          projects: false,
          tasks: false,
        },
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
      include: {
        company: true,
        agents: true,
        projects: false,
        tasks: false,
      },
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
        source: {
          type: "inline",
          rootPath: exported.rootPath,
          files: exported.files,
        },
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
      include: {
        company: true,
        agents: true,
        projects: false,
        tasks: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle(
      {
        source: {
          type: "inline",
          rootPath: exported.rootPath,
          files: exported.files,
        },
        include: {
          company: true,
          agents: true,
          projects: false,
          tasks: false,
        },
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
    agentSvc.create.mockImplementation(
      async (_companyId: string, input: Record<string, unknown>) => ({
        id: "agent-created",
        name: String(input.name),
      }),
    );

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        tasks: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle(
      {
        source: {
          type: "inline",
          rootPath: exported.rootPath,
          files: exported.files,
        },
        include: {
          company: true,
          agents: true,
          projects: false,
          tasks: false,
        },
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

    const firstRevisionInput = adapterConfigurationSvc.createRevision.mock
      .calls[0]?.[0] as Record<string, any>;
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
        source: {
          type: "inline",
          rootPath: exported.rootPath,
          files: exported.files,
        },
        include: { company: true, agents: false, projects: true, tasks: true },
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
    expect(ordinaryTaskRuntime.create.mock.calls[0]?.[0]).not.toHaveProperty(
      "contextAccessMask",
    );
  });

  it("round-trips terminal lifecycle and strict disposition in preview", async () => {
    const portability = companyPortabilityService({} as any);
    projectSvc.list.mockResolvedValue([]);
    taskSvc.list.mockResolvedValue([
      {
        id: "task-terminal",
        identifier: "PAP-9",
        title: "Completed portable task",
        request: "Preserve this completed request.",
        projectId: null,
        ownerAgentId: "agent-1",
        boardPresentationStatus: "done",
        lifecycleStatus: "done",
        disposition: {
          message: "Completed exactly.",
          structuredResult: null,
        },
        priority: "medium",
        labelIds: [],
        billingCode: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: false,
        projects: false,
        tasks: true,
      },
    });
    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain('lifecycleStatus: "done"');
    expect(extension).toContain('message: "Completed exactly."');
    expect(extension).toContain("structuredResult: null");
    expect(extension).not.toContain("contextAccessMask");
    expect(exported.manifest.tasks[0]).toMatchObject({
      lifecycleStatus: "done",
      disposition: {
        message: "Completed exactly.",
        structuredResult: null,
      },
    });

    const preview = await portability.previewImport({
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
      include: {
        company: true,
        agents: false,
        projects: false,
        tasks: true,
      },
      target: {
        mode: "existing_company",
        companyId: "company-1",
      },
      agents: "all",
      collisionStrategy: "rename",
    });
    expect(preview.errors).toEqual([]);
    expect(preview.manifest.tasks[0]).toMatchObject({
      lifecycleStatus: "done",
      disposition: {
        message: "Completed exactly.",
        structuredResult: null,
      },
    });
  });

  it("rejects retired context access masks in portable task and routine manifests", async () => {
    const portability = companyPortabilityService({} as any);
    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.list.mockResolvedValue([
      {
        id: "agent-imported",
        name: "Owner",
        status: "idle",
      },
    ]);
    projectSvc.list.mockResolvedValue([]);
    const files = {
      "COMPANY.md": "---\nname: Imported\n---\n",
      "tasks/narrowed/TASK.md": [
        "---",
        "name: Narrowed",
        "slug: narrowed",
        "owner: owner",
        "---",
        "",
        "Use only narrowed context.",
      ].join("\n"),
      ".paperclip.yaml": [
        "schema: paperclip/v1",
        ...canonicalCompanyExtensionYaml(),
        "tasks:",
        "  narrowed:",
        "    lifecycleStatus: open",
        "    boardPresentationStatus: todo",
        "    contextAccessMask:",
        "      carry_context: true",
        "      read_task_comments: false",
        "",
      ].join("\n"),
    };

    await expect(
      portability.previewImport({
        source: {
          type: "inline",
          rootPath: "imported",
          files,
        },
        include: {
          company: true,
          agents: false,
          projects: false,
          tasks: true,
        },
        target: {
          mode: "new_company",
          newCompanyName: "Imported",
        },
        agents: "all",
        collisionStrategy: "rename",
      }),
    ).rejects.toThrow(
      "Task narrowed manifest contains unsupported fields: contextAccessMask",
    );

    await expect(
      portability.previewImport({
        source: {
          type: "inline",
          rootPath: "imported",
          files: {
            ...files,
            ".paperclip.yaml": asTextFile(files[".paperclip.yaml"])
              .replace(
                "    contextAccessMask:\n      carry_context: true\n      read_task_comments: false\n",
                "",
              )
              .concat(
                [
                  "routines:",
                  "  narrowed:",
                  "    contextAccessMask:",
                  "      read_task_comments: false",
                  "",
                ].join("\n"),
              ),
          },
        },
        include: {
          company: true,
          agents: false,
          projects: false,
          tasks: true,
        },
        target: {
          mode: "new_company",
          newCompanyName: "Imported",
        },
        agents: "all",
        collisionStrategy: "rename",
      }),
    ).rejects.toThrow(
      "Routine manifest contains unsupported fields: contextAccessMask",
    );
  });

  it("preserves task comment presentation fields on export and imports through the canonical Session producer", async () => {
    const portability = companyPortabilityService({} as any);
    const presentation = {
      kind: "system_notice",
      tone: "warning",
      detailsDefaultOpen: false,
    };
    const metadata = {
      version: 1,
      sections: [
        {
          rows: [
            {
              type: "key_value",
              label: "Cause",
              value: "successful_run_missing_state",
            },
          ],
        },
      ],
    };

    projectSvc.list.mockResolvedValue([]);
    taskSvc.list.mockResolvedValue([
      {
        id: "task-1",
        identifier: "PAP-1",
        title: "Needs disposition",
        request: "System notice source",
        projectId: null,
        ownerAgentId: "agent-1",
        boardPresentationStatus: "todo",
        lifecycleStatus: "open",
        priority: "high",
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
        authorType: "system",
        authorAgentId: null,
        authorUserId: null,
        body: "Paperclip needs a disposition before this task can continue.",
        presentation,
        metadata,
        createdAt: new Date("2026-05-04T12:00:00.000Z"),
        updatedAt: new Date("2026-05-04T12:00:00.000Z"),
      },
      {
        id: "comment-2",
        taskId: "task-1",
        companyId: "company-1",
        authorType: "agent",
        authorAgentId: "agent-1",
        authorUserId: null,
        body: "Historical agent output.",
        presentation: null,
        metadata: null,
        createdAt: new Date("2026-05-04T12:05:00.000Z"),
        updatedAt: new Date("2026-05-04T12:05:00.000Z"),
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: { company: true, agents: false, projects: false, tasks: true },
    });

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain("comments:");
    expect(extension).toContain("system_notice");
    expect(extension).toContain("successful_run_missing_state");

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
    const imported = await portability.importBundle(
      {
        source: {
          type: "inline",
          rootPath: exported.rootPath,
          files: exported.files,
        },
        include: { company: true, agents: false, projects: false, tasks: true },
        target: { mode: "new_company", newCompanyName: "Imported" },
        agents: "all",
        collisionStrategy: "rename",
      },
      "user-1",
    );

    expect(
      taskSessionProducers.appendCanonicalControlNotice,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-imported",
        taskId: "task-imported",
        exactText:
          "Paperclip needs a disposition before this task can continue.",
        comment: {
          author: { kind: "system", source: "control" },
          producingRun: null,
        },
        occurredAt: "2026-05-04T12:00:00.000Z",
      }),
    );
    expect(
      taskSessionProducers.appendCanonicalControlNotice,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-imported",
        taskId: "task-imported",
        exactText: "Historical agent output.",
        comment: {
          author: { kind: "system", source: "control" },
          producingRun: null,
        },
        occurredAt: "2026-05-04T12:05:00.000Z",
      }),
    );
    expect(imported.warnings).toContain(
      "Comment on task needs-disposition from agent claudecoder was imported with system provenance because the portable comment does not include the producing run and adapter revision required for canonical agent attribution.",
    );
  });

  it("does not export raw comment author user ids", async () => {
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

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain('authorType: "user"');
    expect(extension).not.toContain("authorUserId: board-user");
  });

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
          source: {
            type: "inline",
            rootPath: exported.rootPath,
            files: exported.files,
          },
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
    expect(
      taskSessionProducers.appendCanonicalControlNotice,
    ).not.toHaveBeenCalled();
  });

  it("never normalizes a whitespace-variant adapter identity", async () => {
    const portability = companyPortabilityService({} as any);
    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        tasks: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);

    await expect(
      portability.importBundle(
        {
          source: {
            type: "inline",
            rootPath: exported.rootPath,
            files: exported.files,
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
            "COMPANY.md":
              "---\nname: Import\nincludes:\n  - projects/app/PROJECT.md\n---\n",
            "projects/app/PROJECT.md":
              "---\nname: App\nslug: app\n---\n\n# App\n",
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
      include: {
        company: true,
        agents: true,
        projects: false,
        tasks: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);
    agentSvc.create.mockImplementation(
      async (_companyId: string, input: Record<string, unknown>) => ({
        id: "agent-created",
        name: String(input.name),
        status: input.status,
      }),
    );

    await portability.importBundle(
      {
        source: {
          type: "inline",
          rootPath: exported.rootPath,
          files: exported.files,
        },
        include: {
          company: true,
          agents: true,
          projects: false,
          tasks: false,
        },
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
      include: {
        company: true,
        agents: true,
        projects: false,
        tasks: false,
      },
    });

    agentSvc.update.mockImplementation(
      async (id: string, patch: Record<string, unknown>) => ({
        id,
        name: "ClaudeCoder",
      }),
    );

    await portability.importBundle(
      {
        source: {
          type: "inline",
          rootPath: exported.rootPath,
          files: exported.files,
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
      include: { company: false, agents: true, projects: false, tasks: false },
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
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
      include: { company: false, agents: true, projects: false, tasks: false },
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

  it("handles circular reportsTo chains without infinite recursion during export", async () => {
    const portability = companyPortabilityService({} as any);

    agentSvc.list.mockResolvedValue([
      {
        id: "agent-a",
        name: "AgentA",
        status: "idle",
        title: null,
        icon: null,
        reportsTo: "agent-b",
        capabilities: null,
        currentAdapterConfigRevisionId: SOURCE_ADAPTER_REVISION_ID,
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
      {
        id: "agent-b",
        name: "AgentB",
        status: "idle",
        title: null,
        icon: null,
        reportsTo: "agent-a",
        capabilities: null,
        currentAdapterConfigRevisionId: "11111111-1111-4111-8111-111111111112",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
    ]);
    // Export should complete without infinite recursion in org chart building
    const exported = await portability.exportBundle("company-1", {
      include: { company: true, agents: true, projects: false, tasks: false },
    });

    expect(exported.manifest.agents).toHaveLength(2);
    // Both agents should appear in the export
    const slugs = exported.manifest.agents.map((a) => a.slug);
    expect(slugs).toContain("agenta");
    expect(slugs).toContain("agentb");
  });

  it("resolves task owner to an existing agent when the agent import is skipped", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        companyId: "company-1",
        name: "TestProject",
        description: null,
        leadAgentId: null,
        targetDate: null,
        color: null,
        status: "planned",
        archivedAt: null,
      },
    ]);
    taskSvc.list.mockResolvedValue([
      {
        id: "task-1",
        companyId: "company-1",
        title: "Test task",
        identifier: "PAP-1",
        request: "A test task",
        boardPresentationStatus: "todo",
        lifecycleStatus: "open",
        priority: "medium",
        ownerAgentId: "agent-1",
        projectId: "project-1",
        goalId: null,
        parentId: null,
        billingCode: null,
        labelIds: [],
        assigneeAdapterOverrides: null,
        metadata: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: { company: false, agents: true, projects: true, tasks: true },
    });

    // Re-import into same company with skip collision strategy
    // Both agents exist so both will be skipped; the existing agent should resolve as task owner.
    agentSvc.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "ClaudeCoder",
        status: "idle",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
      {
        id: "agent-2",
        name: "Reviewer",
        status: "idle",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
    ]);
    projectSvc.list.mockResolvedValue([]);
    taskSvc.list.mockResolvedValue([]);
    projectSvc.create.mockResolvedValue({
      id: "project-new",
      companyId: "company-1",
    });
    const result = await portability.importBundle(
      {
        source: {
          type: "inline",
          rootPath: exported.rootPath,
          files: exported.files,
        },
        include: { company: false, agents: true, projects: true, tasks: true },
        target: { mode: "existing_company", companyId: "company-1" },
        agents: "all",
        collisionStrategy: "skip",
        adapterOverrides: {
          claudecoder: codexTargetAdapter(),
          reviewer: codexTargetAdapter(),
        },
      },
      "user-1",
    );

    // Both agents should be skipped (already exist)
    const agentResult = result.agents.find((a) => a.slug === "claudecoder");
    expect(agentResult).toBeDefined();
    expect(agentResult!.action).toBe("skipped");

    // Task should still be created and reference the existing agent
    expect(ordinaryTaskRuntime.create).toHaveBeenCalled();
    const taskCreateCall = ordinaryTaskRuntime.create.mock.calls[0];
    // The canonical owner resolves to the existing agent via existingSlugToAgentId.
    expect(taskCreateCall[0]).toEqual(
      expect.objectContaining({
        ownerAgentId: "agent-1",
      }),
    );
  });

  it("preview import detects no agents to import when agents are excluded", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: { company: true, agents: true, projects: false, tasks: false },
    });

    agentSvc.list.mockResolvedValue([]);

    const preview = await portability.previewImport({
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
      include: { company: false, agents: false, projects: false, tasks: false },
      target: { mode: "existing_company", companyId: "company-1" },
      agents: "all",
      collisionStrategy: "rename",
    });

    expect(preview.plan.agentPlans).toHaveLength(0);
    expect(preview.plan.projectPlans).toHaveLength(0);
    expect(preview.plan.taskPlans).toHaveLength(0);
  });
});
