import express from "express";
import request from "supertest";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "@paperclipai/shared";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import {
  CANONICAL_TEST_ADAPTER_TYPE,
} from "./helpers/adapter-implementation.js";
import { canonicalTestAgentAdapterRevision } from "./helpers/agent-adapter-revision.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";

const mockRuntimeAgentConfiguration = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
}));
const mockAdapterConfigurations = vi.hoisted(() => ({
  listRevisions: vi.fn(),
  getCurrentRevision: vi.fn(),
  createRevision: vi.fn(),
}));
const mockOperationalConfigurations = vi.hoisted(() => ({
  update: vi.fn(),
}));
const mockAdapterConfigurationDraftTest = vi.hoisted(() => ({
  test: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  accessService: () => mockAccessService,
  approvalService: () => ({
    findOpenHireApprovalForAgent: vi.fn(),
    reject: vi.fn(),
  }),
  taskService: () => ({}),
  createRuntimeAgentConfigurationService: () =>
    mockRuntimeAgentConfiguration,
  logActivity: mockLogActivity,
}));

vi.mock(
  "../services/agent-adapter-config-revisions.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../services/agent-adapter-config-revisions.js")
    >()),
    createAgentAdapterConfigurationService: () =>
      mockAdapterConfigurations,
  }),
);

vi.mock("../services/agent-operational-configuration.js", () => ({
  createAgentOperationalConfigurationService: () =>
    mockOperationalConfigurations,
}));

vi.mock("../services/adapter-configuration-draft-test.js", () => ({
  createAdapterConfigurationDraftTestService: () =>
    mockAdapterConfigurationDraftTest,
}));

vi.mock("../services/plugin-managed-agents.js", () => ({
  getPluginManagedAgentBinding: vi.fn(async () => null),
  adoptPluginManagedAgentFromBoard: vi.fn(),
  terminatePluginManagedAgentFromBoard: vi.fn(),
  terminateAgentForHireRejectionInTransaction: vi.fn(),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

function fullGrantMap(keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, false]));
}

function runtimeConfiguration() {
  return {
    name: "Explicit agent",
    title: null,
    capabilities: null,
    reportsTo: null,
    instruction: null,
    contextGrants: fullGrantMap(AGENT_CONTEXT_GRANT_KEYS),
    actionGrants: fullGrantMap(PAPERCLIP_ACTION_KEYS),
    mentionReachGrants: fullGrantMap(
      AGENT_MENTION_REACH_GRANT_KEYS,
    ),
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    companyId: "company-1",
    name: "Explicit agent",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    currentAdapterConfigRevisionId: revisionId,
    budgetMonthlyAmount: "0",
    knownSpendAmount: "0",
    pauseReason: null,
    pausedAt: null,
    errorReason: null,
    instruction: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function revision(overrides: Record<string, unknown> = {}) {
  const canonicalConfiguration = canonicalTestAgentAdapterRevision();
  return {
    id: revisionId,
    companyId: "company-1",
    agentId,
    revisionNumber: 1,
    ...canonicalConfiguration,
    parentRevisionId: null,
    createdByAgentId: null,
    createdByUserId: "board-user",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = testBoardSessionActor({
      userId: "board-user",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });
    next();
  });
  app.use("/api", agentRoutes({} as never, {
    ordinaryTasks: {} as never,
  }));
  app.use(errorHandler);
  return app;
}

describe("agent control-plane routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(agent());
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockRuntimeAgentConfiguration.create.mockResolvedValue({
      agentId,
      companyId: "company-1",
      configuration: runtimeConfiguration(),
      auditId: "audit-1",
      retried: false,
    });
    mockRuntimeAgentConfiguration.get.mockResolvedValue(
      runtimeConfiguration(),
    );
    mockRuntimeAgentConfiguration.update.mockResolvedValue({
      agentId,
      companyId: "company-1",
      configuration: runtimeConfiguration(),
      auditId: "audit-2",
      retried: false,
    });
    mockAdapterConfigurations.createRevision.mockResolvedValue({
      revision: revision(),
      current: agent(),
      appended: true,
    });
    mockAdapterConfigurations.listRevisions.mockResolvedValue([
      revision({ revisionNumber: 2, id: revisionId }),
      revision({
        revisionNumber: 1,
        id: "33333333-3333-4333-8333-333333333333",
      }),
    ]);
    mockAdapterConfigurations.getCurrentRevision.mockResolvedValue(
      revision(),
    );
    mockOperationalConfigurations.update.mockResolvedValue({
      agent: agent({ budgetMonthlyAmount: "25" }),
    });
    mockAdapterConfigurationDraftTest.test.mockResolvedValue({
      status: "ready",
      adapterType: CANONICAL_TEST_ADAPTER_TYPE,
      runtimeControls: [
        "session/status",
        "session/set_config_option",
      ],
      testedAt: "2026-08-04T18:00:00.000Z",
    });
  });

  it("creates only through the explicit runtime-agent contract", async () => {
    const configuration = runtimeConfiguration();
    const response = await request(createApp())
      .post("/api/companies/company-1/runtime-agents")
      .set("Idempotency-Key", "create-explicit-agent")
      .send(configuration);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      agent: expect.objectContaining({ id: agentId }),
      configuration,
      auditId: "audit-1",
      retried: false,
    });
    expect(mockRuntimeAgentConfiguration.create).toHaveBeenCalledWith({
      companyId: "company-1",
      actor: expect.objectContaining({
        kind: "board",
        actorId: "board-user",
      }),
      source: "board",
      configuration,
      idempotencyKey: "create-explicit-agent",
    });
  });

  it("rejects partial create payloads before the transaction", async () => {
    const response = await request(createApp())
      .post("/api/companies/company-1/runtime-agents")
      .send({ name: "Implicit defaults are forbidden" });

    expect(response.status).toBe(400);
    expect(mockRuntimeAgentConfiguration.create).not.toHaveBeenCalled();
  });

  it("tests an unsaved adapter configuration without creating an agent or revision", async () => {
    const adapterConfig = {
      model: "fixture-model",
      reasoning_effort: "high",
    };
    const response = await request(createApp())
      .post(
        `/api/companies/company-1/adapters/${CANONICAL_TEST_ADAPTER_TYPE}/test-configuration`,
      )
      .send({ adapterConfig });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ready",
      adapterType: CANONICAL_TEST_ADAPTER_TYPE,
      runtimeControls: [
        "session/status",
        "session/set_config_option",
      ],
      testedAt: "2026-08-04T18:00:00.000Z",
    });
    expect(mockAdapterConfigurationDraftTest.test).toHaveBeenCalledWith({
      adapterType: CANONICAL_TEST_ADAPTER_TYPE,
      adapterConfig,
    });
    expect(mockRuntimeAgentConfiguration.create).not.toHaveBeenCalled();
    expect(mockAdapterConfigurations.createRevision).not.toHaveBeenCalled();
  });

  it("rejects malformed unsaved adapter tests before opening ACPX", async () => {
    const response = await request(createApp())
      .post(
        `/api/companies/company-1/adapters/${CANONICAL_TEST_ADAPTER_TYPE}/test-configuration`,
      )
      .send({ adapterConfig: "invalid" });

    expect(response.status).toBe(400);
    expect(mockAdapterConfigurationDraftTest.test).not.toHaveBeenCalled();
  });

  it("denies adapter tests to a company viewer without agent-create authority", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      reason: "deny_missing_grant",
      explanation: "Viewer cannot create agents",
    });

    const response = await request(createApp())
      .post(
        `/api/companies/company-1/adapters/${CANONICAL_TEST_ADAPTER_TYPE}/test-configuration`,
      )
      .send({ adapterConfig: { model: "fixture-model" } });

    expect(response.status).toBe(403);
    expect(mockAdapterConfigurationDraftTest.test).not.toHaveBeenCalled();
  });

  it("denies adapter tests outside the board actor's company scope", async () => {
    const response = await request(createApp())
      .post(
        `/api/companies/company-2/adapters/${CANONICAL_TEST_ADAPTER_TYPE}/test-configuration`,
      )
      .send({ adapterConfig: { model: "fixture-model" } });

    expect(response.status).toBe(403);
    expect(mockAdapterConfigurationDraftTest.test).not.toHaveBeenCalled();
  });

  it("appends and reads redacted first-class adapter revisions", async () => {
    const configuration = {
      adapterType: CANONICAL_TEST_ADAPTER_TYPE,
      adapterConfig: { model: "fixture-model" },
    };
    const app = createApp();
    const created = await request(app)
      .post(`/api/agents/${agentId}/adapter-config-revisions`)
      .send(configuration);
    const history = await request(app)
      .get(`/api/agents/${agentId}/adapter-config-revisions`);
    const current = await request(app)
      .get(`/api/agents/${agentId}/adapter-config-revisions/current`);

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      revision: {
        id: revisionId,
        acpConfiguration: revision().acpConfiguration,
      },
      current: {
        agentId,
        currentAdapterConfigRevisionId: revisionId,
      },
      appended: true,
    });
    expect(Object.keys(created.body.revision).sort()).toEqual([
      "acpConfiguration",
      "agentId",
      "companyId",
      "createdAt",
      "createdByAgentId",
      "createdByUserId",
      "digest",
      "id",
      "parentRevisionId",
      "revisionNumber",
    ]);
    expect(Object.keys(created.body.revision.acpConfiguration).sort()).toEqual([
      "contractVersion",
      "launchProfile",
      "model",
      "sessionConfigSelections",
    ]);
    expect(history.status).toBe(200);
    expect(history.body.map((row: { revisionNumber: number }) =>
      row.revisionNumber)).toEqual([2, 1]);
    expect(current.status).toBe(200);
    expect(current.body.acpConfiguration).toEqual(revision().acpConfiguration);
    for (const response of [created.body, history.body, current.body]) {
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain("nativeCorrelationKind");
      expect(serialized).not.toContain("nativeCorrelation");
      expect(serialized).not.toContain("fixture-native/v1");
      expect(serialized).not.toContain("providerModel");
      expect(serialized).not.toContain("providerSelectors");
      expect(serialized).not.toContain("operatorNativeConfig");
      expect(serialized).not.toContain("secretReferenceIdentities");
      expect(serialized).not.toContain("runtimeFlags");
      expect(serialized).not.toContain("executionTargetSelector");
    }
  });

  it("updates only the board-owned operational contract", async () => {
    const response = await request(createApp())
      .patch(`/api/agents/${agentId}/operational-configuration`)
      .send({ budgetMonthlyAmount: "25" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: agentId,
      budgetMonthlyAmount: "25",
    });
    expect(mockOperationalConfigurations.update).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId,
      configuration: { budgetMonthlyAmount: "25" },
      actorUserId: "board-user",
    });
  });

  it("updates the board-owned agent instruction through the operational contract", async () => {
    const instruction = "Review changes carefully before reporting completion.";
    mockOperationalConfigurations.update.mockResolvedValue({
      agent: agent({ instruction }),
    });

    const response = await request(createApp())
      .patch(`/api/agents/${agentId}/operational-configuration`)
      .send({ instruction });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: agentId, instruction });
    expect(mockOperationalConfigurations.update).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId,
      configuration: { instruction },
      actorUserId: "board-user",
    });
  });

  it("removes every superseded mixed mutation route", async () => {
    const app = createApp();
    const statuses = await Promise.all([
      request(app).post("/api/companies/company-1/agents").send({}),
      request(app).patch(`/api/agents/${agentId}`).send({ name: "Legacy" }),
      request(app).post(`/api/agents/${agentId}/approve`).send({}),
    ]);

    expect(statuses.map((response) => response.status)).toEqual([
      404,
      404,
      404,
    ]);
  });

});
