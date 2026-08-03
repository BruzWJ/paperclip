import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyRisk,
  googleSheetsRobotEmailFromEnv,
  toolAccessService,
} from "../services/tool-access.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import {
  createToolGatewayService,
  ToolGatewayHttpError,
} from "../services/tool-gateway.js";
import { createMockDb, type MockDbHarness } from "./helpers/mock-db.js";

const dependencyMocks = vi.hoisted(() => ({
  logActivity: vi.fn(async () => undefined),
  supervisor: {
    stopSlot: vi.fn(async () => undefined),
    restartSlot: vi.fn(async () => undefined),
  },
}));

vi.mock("../services/activity-log.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/activity-log.js")>();
  return { ...actual, logActivity: dependencyMocks.logActivity };
});

vi.mock("../services/tool-runtime-supervisor.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../services/tool-runtime-supervisor.js")
  >();
  return {
    ...actual,
    createToolRuntimeSupervisor: vi.fn(() => dependencyMocks.supervisor),
  };
});

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const APPLICATION_ID = "00000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000003";
const CATALOG_ID = "00000000-0000-4000-8000-000000000004";
const PROFILE_ID = "00000000-0000-4000-8000-000000000005";
const AGENT_ID = "00000000-0000-4000-8000-000000000006";
const SLOT_ID = "00000000-0000-4000-8000-000000000007";
const ACTION_ID = "00000000-0000-4000-8000-000000000008";
const INVOCATION_ID = "00000000-0000-4000-8000-000000000009";
const USER_ID = "board-user";
const NOW = new Date("2026-07-25T14:00:00.000Z");
const USER_ACTOR = {
  actorType: "user",
  actorId: USER_ID,
  sessionId: "session-1",
} as const;

function applicationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APPLICATION_ID,
    companyId: COMPANY_ID,
    applicationKey: "fixture-app",
    name: "Fixture app",
    description: null,
    type: "mcp_http",
    status: "active",
    pluginId: null,
    ownerAgentId: null,
    ownerUserId: null,
    metadata: {},
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    companyId: COMPANY_ID,
    applicationId: APPLICATION_ID,
    name: "Fixture connection",
    uid: "fixture-app/fixture-00000000",
    connectionKind: "managed",
    ownership: "customer",
    transport: "mcp_remote",
    authKind: "none",
    status: "active",
    enabled: true,
    config: { url: "http://127.0.0.1:8848/mcp" },
    transportConfig: { url: "http://127.0.0.1:8848/mcp" },
    credentialRefs: [],
    credentialSecretRefs: [],
    healthStatus: "ok",
    healthMessage: null,
    healthCheckedAt: NOW,
    lastHealthAt: NOW,
    lastCatalogRefreshAt: null,
    lastError: null,
    createdByAgentId: null,
    createdByUserId: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CATALOG_ID,
    companyId: COMPANY_ID,
    applicationId: APPLICATION_ID,
    connectionId: CONNECTION_ID,
    entryKind: "tool",
    name: "read_data",
    toolName: "read_data",
    title: "Read data",
    description: "Read fixture data.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: null,
    annotations: { readOnlyHint: true },
    riskLevel: "read",
    isReadOnly: true,
    isWrite: false,
    isDestructive: false,
    status: "active",
    version: 1,
    versionHash: "old-version",
    schemaHash: "old-schema",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    reviewedAt: NOW,
    reviewedByAgentId: null,
    reviewedByUserId: USER_ID,
    quarantinedAt: null,
    quarantineReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROFILE_ID,
    companyId: COMPANY_ID,
    profileKey: "safe-tools",
    name: "Safe tools",
    description: null,
    status: "active",
    defaultAction: "deny",
    newToolsReviewedAt: null,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function profileEntryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "profile-entry-1",
    companyId: COMPANY_ID,
    profileId: PROFILE_ID,
    selectorType: "tool_name",
    effect: "include",
    applicationId: null,
    connectionId: null,
    catalogEntryId: null,
    toolName: "read_data",
    riskLevel: null,
    conditions: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function profileBindingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "profile-binding-1",
    companyId: COMPANY_ID,
    profileId: PROFILE_ID,
    targetType: "agent",
    targetId: AGENT_ID,
    priority: 25,
    metadata: {},
    createdByAgentId: null,
    createdByUserId: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function runtimeSlotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SLOT_ID,
    companyId: COMPANY_ID,
    applicationId: APPLICATION_ID,
    connectionId: CONNECTION_ID,
    projectWorkspaceId: null,
    executionWorkspaceId: null,
    issueId: null,
    ownerScopeType: "connection",
    ownerScopeId: CONNECTION_ID,
    runtimeKind: "local_stdio",
    slotKey: `mcp:${COMPANY_ID}:${CONNECTION_ID}`,
    status: "stopped",
    reuseKey: null,
    workspaceScope: null,
    credentialScopeHash: null,
    provider: "paperclip",
    providerRef: "template:local.echo-admin",
    processId: null,
    commandTemplateKey: "local.echo-admin",
    healthStatus: "ok",
    healthMessage: null,
    lastHealthCheckAt: NOW,
    lastStartedAt: null,
    startedAt: null,
    stoppedAt: NOW,
    lastUsedAt: null,
    idleExpiresAt: null,
    idleDeadlineAt: null,
    lastError: null,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function actionRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTION_ID,
    companyId: COMPANY_ID,
    invocationId: INVOCATION_ID,
    issueId: null,
    approvalId: null,
    status: "pending",
    canonicalArguments: {
      channel: "general",
      token: "secret-token-value",
    },
    canonicalArgumentsHash: "a".repeat(64),
    canonicalArgumentsSummary: { summary: "redacted" },
    policySnapshot: {},
    approvalSnapshot: null,
    previewMarkdown: "This action needs approval.",
    requestedByAgentId: null,
    requestedByUserId: USER_ID,
    resolvedByUserId: null,
    decidedByUserId: null,
    decidedAt: null,
    expiresAt: new Date("2026-07-26T14:00:00.000Z"),
    resolvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function invocationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOCATION_ID,
    companyId: COMPANY_ID,
    idempotencyKey: null,
    actorType: "user",
    actorId: USER_ID,
    agentId: AGENT_ID,
    issueId: null,
    runId: null,
    gatewayId: null,
    gatewayPublicId: null,
    gatewayTokenId: null,
    clientSubjectType: null,
    clientSubjectId: null,
    clientName: null,
    mcpSessionId: null,
    correlationId: null,
    applicationId: APPLICATION_ID,
    connectionId: CONNECTION_ID,
    connectionInstallId: null,
    companyToolSelectionId: null,
    catalogEntryId: CATALOG_ID,
    callIdentitySource: null,
    callIdentityType: null,
    callIdentityValue: null,
    runInterfaceToolCallId: null,
    catalogVersionHash: "version-1",
    catalogSchemaHash: "schema-1",
    providerType: "mcp_remote_http",
    applicationKey: "fixture-app",
    upstreamToolName: "send_message",
    riskLevel: "write",
    toolName: "send_message",
    argumentsHash: "a".repeat(64),
    argumentsSummary: { summary: "redacted" },
    policyDecision: "require_approval",
    matchedPolicyIds: ["policy-1"],
    approvalState: "pending",
    status: "awaiting_approval",
    upstreamRequestId: null,
    resultHash: null,
    resultSummary: null,
    resultSizeBytes: null,
    resultArtifactId: null,
    errorCode: null,
    errorMessage: null,
    startedAt: NOW,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function valuesFor(
  harness: MockDbHarness,
  operation: "insert" | "update",
) {
  const method = operation === "insert" ? "values" : "set";
  return harness.calls
    .filter((call) => call.operation === operation && call.method === method)
    .map((call) => call.args[0]);
}

function mcpSseResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "text/event-stream" : null,
    },
    text: async () => `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
    json: async () => payload,
  } as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("tool access service without a database process", () => {
  describe("catalog import and transport admission", () => {
    it("previews remote headers as sorted credential fields without echoing values", async () => {
      const service = toolAccessService(createMockDb().db);
      const result = await service.previewMcpJsonImport({
        mcpJson: JSON.stringify({
          mcpServers: {
            remote: {
              url: "https://mcp.example.test",
              headers: {
                Authorization: "Bearer should-never-be-returned",
                "X-Api-Key": "also-secret",
              },
            },
          },
        }),
      });

      expect(result.drafts).toEqual([
        expect.objectContaining({
          name: "remote",
          transport: "mcp_remote",
          status: "draft",
          config: { url: "https://mcp.example.test" },
          credentialFields: [
            expect.objectContaining({ key: "Authorization" }),
            expect.objectContaining({ key: "X-Api-Key" }),
          ],
        }),
      ]);
      expect(JSON.stringify(result)).not.toContain("should-never-be-returned");
      expect(JSON.stringify(result)).not.toContain("also-secret");
    });

    it("keeps imported stdio commands draft-only", async () => {
      const result = await toolAccessService(createMockDb().db)
        .previewMcpJsonImport({
          mcpJson: {
            mcpServers: {
              local: { command: "node", args: ["server.js"] },
            },
          },
        });

      expect(result.drafts[0]).toMatchObject({
        name: "local",
        transport: "local_stdio",
        status: "draft",
        config: { importedCommand: "node", importedArgs: ["server.js"] },
      });
      expect(result.drafts[0]?.warnings.join(" ")).toContain("approved Paperclip template");
    });

    it("rejects malformed and empty mcp.json imports before persistence", async () => {
      const harness = createMockDb();
      const service = toolAccessService(harness.db);

      await expect(service.previewMcpJsonImport({ mcpJson: "{" }))
        .rejects.toMatchObject({ status: 400 });
      await expect(service.previewMcpJsonImport({ mcpJson: { mcpServers: {} } }))
        .rejects.toMatchObject({ status: 400 });
      expect(harness.calls).toEqual([]);
    });

    it("blocks private remote endpoints on public deployments before persistence", async () => {
      const harness = createMockDb();
      const service = toolAccessService(harness.db, {
        deploymentExposure: "public",
      });

      await expect(service.createConnection(COMPANY_ID, {
        applicationName: "Private endpoint",
        name: "Private endpoint",
        transport: "mcp_remote",
        config: { url: "http://127.0.0.1/mcp" },
        enabled: false,
        status: "draft",
      }, USER_ACTOR)).rejects.toMatchObject({
        status: 400,
        details: { code: "remote_http_private_endpoint" },
      });
      expect(harness.calls).toEqual([]);
    });

    it("blocks enabled local stdio on public deployments without a trusted runtime host", async () => {
      const harness = createMockDb();
      const service = toolAccessService(harness.db, {
        deploymentExposure: "public",
      });

      await expect(service.createConnection(COMPANY_ID, {
        applicationName: "Local tools",
        name: "Local tools",
        transport: "local_stdio",
        config: { templateId: "paperclip.echo-calculator-time" },
        enabled: true,
        status: "active",
      }, USER_ACTOR)).rejects.toMatchObject({ status: 422 });
      expect(harness.calls).toEqual([]);
    });

    it("persists normalized administrator-approved stdio templates", async () => {
      const created = {
        id: "stdio-template-1",
        companyId: COMPANY_ID,
        templateKey: "local.echo-admin",
        name: "Local echo",
        description: null,
        status: "active",
        command: "node",
        args: ["server.js"],
        envKeys: ["TOKEN"],
        tools: [{
          name: "echo",
          title: null,
          description: null,
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        }],
        createdByAgentId: null,
        createdByUserId: USER_ID,
        disabledAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const harness = createMockDb({ select: [[]], insert: [[created]] });

      const result = await toolAccessService(harness.db)
        .createStdioCommandTemplate(COMPANY_ID, {
          templateId: "local.echo-admin",
          name: "Local echo",
          command: "node",
          args: ["server.js"],
          envKeys: ["TOKEN"],
          tools: [{ name: "echo", annotations: { readOnlyHint: true } }],
        }, USER_ACTOR);

      expect(result).toMatchObject({
        templateId: "local.echo-admin",
        source: "admin",
        tools: [expect.objectContaining({ name: "echo" })],
      });
      expect(valuesFor(harness, "insert")[0]).toMatchObject({
        companyId: COMPANY_ID,
        templateKey: "local.echo-admin",
        createdByUserId: USER_ID,
        createdByAgentId: null,
      });
      expect(harness.remaining("select")).toBe(0);
      expect(harness.remaining("insert")).toBe(0);
    });

    it("never allows built-in stdio templates to be disabled", async () => {
      const harness = createMockDb();
      await expect(toolAccessService(harness.db).disableStdioCommandTemplate(
        COMPANY_ID,
        "paperclip.echo-calculator-time",
      )).rejects.toMatchObject({ status: 422 });
      expect(harness.calls).toEqual([]);
    });
  });

  describe("catalog refresh and quarantine", () => {
    it("uses MCP Streamable HTTP and quarantines new or changed tools", async () => {
      const connection = connectionRow({
        config: {
          url: "http://127.0.0.1:8848/mcp",
          quarantineNewEntries: true,
        },
      });
      const existing = catalogRow();
      const changed = catalogRow({
        status: "quarantined",
        description: "Updated read fixture data.",
        quarantinedAt: NOW,
        quarantineReason: "pending_review",
      });
      const created = catalogRow({
        id: "catalog-delete",
        name: "delete_data",
        toolName: "delete_data",
        description: "Delete fixture data.",
        annotations: { destructiveHint: true },
        riskLevel: "destructive",
        isReadOnly: false,
        isWrite: false,
        isDestructive: true,
        status: "quarantined",
        quarantinedAt: NOW,
        quarantineReason: "pending_review",
      });
      const updatedConnection = connectionRow({
        lastCatalogRefreshAt: NOW,
        healthMessage: "Tool catalog refreshed.",
      });
      const harness = createMockDb({
        select: [[connection], [existing]],
        update: [[changed], [updatedConnection]],
        insert: [[created], []],
      });
      const payload = {
        jsonrpc: "2.0",
        id: "paperclip-catalog-refresh",
        result: {
          tools: [
            {
              name: "read_data",
              description: "Updated read fixture data.",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
              },
              annotations: { readOnlyHint: true },
            },
            {
              name: "delete_data",
              description: "Delete fixture data.",
              annotations: { destructiveHint: true },
            },
          ],
        },
      };
      const fetchMock = vi.spyOn(globalThis, "fetch")
        .mockResolvedValue(mcpSseResponse(payload));

      const result = await toolAccessService(harness.db)
        .refreshCatalog(CONNECTION_ID, USER_ACTOR);

      expect(result).toMatchObject({
        discoveredCount: 2,
        quarantinedCount: 2,
        catalog: [
          expect.objectContaining({
            toolName: "read_data",
            status: "quarantined",
          }),
          expect.objectContaining({
            toolName: "delete_data",
            riskLevel: "destructive",
            quarantineReason: "pending_review",
          }),
        ],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8848/mcp",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            accept: "application/json, text/event-stream",
          }),
        }),
      );
      expect(valuesFor(harness, "update")[0]).toMatchObject({
        status: "quarantined",
        quarantineReason: "pending_review",
      });
      expect(valuesFor(harness, "insert")[0]).toMatchObject({
        toolName: "delete_data",
        status: "quarantined",
        riskLevel: "destructive",
        quarantineReason: "pending_review",
      });
      expect(valuesFor(harness, "insert")[1]).toMatchObject({
        actorType: "user",
        actorId: USER_ID,
        action: "tool_connection.catalog_refresh",
        outcome: "success",
        details: { discoveredCount: 2, quarantinedCount: 2 },
      });
      expect(harness.remaining("select")).toBe(0);
      expect(harness.remaining("update")).toBe(0);
      expect(harness.remaining("insert")).toBe(0);
    });
  });

  describe("profiles and policies", () => {
    it("creates a profile and its explicit entries", async () => {
      const profile = profileRow();
      const entry = profileEntryRow();
      const harness = createMockDb({
        insert: [[profile], []],
        select: [[profile], [entry], [], [], [], [], []],
      });

      const result = await toolAccessService(harness.db).createProfile(
        COMPANY_ID,
        {
          profileKey: "safe-tools",
          name: "Safe tools",
          defaultAction: "deny",
          entries: [{
            selectorType: "tool_name",
            effect: "include",
            toolName: "read_data",
          }],
        },
      );

      expect(result).toMatchObject({
        id: PROFILE_ID,
        defaultAction: "deny",
        entries: [expect.objectContaining({
          selectorType: "tool_name",
          toolName: "read_data",
        })],
      });
      expect(valuesFor(harness, "insert")[1]).toEqual([
        expect.objectContaining({
          companyId: COMPANY_ID,
          profileId: PROFILE_ID,
          selectorType: "tool_name",
          toolName: "read_data",
        }),
      ]);
      expect(harness.remaining("select")).toBe(0);
    });

    it("rejects incomplete profile selectors before persistence", async () => {
      const harness = createMockDb();
      await expect(toolAccessService(harness.db).createProfile(COMPANY_ID, {
        profileKey: "invalid",
        name: "Invalid",
        entries: [{ selectorType: "tool_name", effect: "include" }],
      })).rejects.toMatchObject({ status: 400 });
      expect(harness.calls).toEqual([]);
    });

    it("resolves only the narrowest agent profile and applies its exclusions", async () => {
      const companyProfile = profileRow({
        id: "company-profile",
        profileKey: "company-default",
        name: "Company default",
        defaultAction: "allow",
      });
      const agentProfile = profileRow();
      const companyBinding = profileBindingRow({
        id: "company-binding",
        profileId: "company-profile",
        targetType: "company",
        targetId: COMPANY_ID,
        priority: 100,
      });
      const agentBinding = profileBindingRow();
      const includeRead = profileEntryRow();
      const excludeWrite = profileEntryRow({
        id: "profile-entry-2",
        selectorType: "risk_level",
        effect: "exclude",
        toolName: null,
        riskLevel: "write",
      });
      const readTool = catalogRow();
      const writeTool = catalogRow({
        id: "catalog-write",
        name: "send_data",
        toolName: "send_data",
        annotations: { readOnlyHint: false },
        riskLevel: "write",
        isReadOnly: false,
        isWrite: true,
      });
      const agent = { id: AGENT_ID, companyId: COMPANY_ID };
      const harness = createMockDb({
        select: [
          [agent],
          [companyBinding, agentBinding],
          [companyProfile, agentProfile],
          [includeRead, excludeWrite],
          [readTool, writeTool],
          [{ id: AGENT_ID }],
          [agent],
          [],
        ],
      });

      const result = await toolAccessService(harness.db)
        .getEffectiveProfilesForAgent(COMPANY_ID, AGENT_ID);

      expect(result.profiles.map((profile) => profile.id)).toEqual([PROFILE_ID]);
      expect(result.bindings.map((binding) => binding.id)).toEqual(["profile-binding-1"]);
      expect(result.allowedToolNames).toEqual(["read_data"]);
      expect(result.allowedTools.map((tool) => tool.id)).toEqual([CATALOG_ID]);
      expect(result.installedConnections).toEqual([]);
      expect(harness.remaining("select")).toBe(0);
    });

    it("evaluates enabled policies in priority order with first match winning", async () => {
      const blocked = {
        id: "policy-block",
        companyId: COMPANY_ID,
        name: "Block deletes",
        description: "Deletion is blocked.",
        policyType: "block",
        priority: 10,
        enabled: true,
        selectors: { toolName: "delete_item" },
        conditions: null,
        config: null,
        createdByAgentId: null,
        createdByUserId: USER_ID,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const allowed = { ...blocked, id: "policy-allow", policyType: "allow", priority: 20 };
      const harness = createMockDb({ select: [[], [blocked, allowed]] });

      const decision = await toolAccessPolicyService(harness.db).decide({
        companyId: COMPANY_ID,
        actor: { actorType: "user", actorId: USER_ID },
        request: {
          toolName: "delete_item",
          riskLevel: "destructive",
          arguments: {},
        },
      });

      expect(decision).toMatchObject({
        decision: "deny",
        allowed: false,
        reasonCode: "deny_policy_block",
        matchedPolicyIds: ["policy-block"],
      });
      expect(harness.remaining("select")).toBe(0);
    });

    it("redacts credential-shaped arguments before they enter audit summaries", () => {
      const result = toolAccessPolicyService(createMockDb().db)
        .summarizeAndRedact({
          api_key: "sk-abcdefghijklmnop",
          nested: { password: "not-for-storage", visible: "safe" },
        });

      expect(result.redactionPlan).toEqual({
        redactedFieldCount: 2,
        redactedFields: ["api_key", "nested.password"],
      });
      expect(result.summary.summary).not.toContain("sk-abcdefghijklmnop");
      expect(result.summary.summary).not.toContain("not-for-storage");
      expect(result.summary.summary).toContain('"visible":"safe"');
    });
  });

  describe("credential and OAuth boundaries", () => {
    it("derives the Google Sheets robot email without exposing the credential", () => {
      const credential = JSON.stringify({
        client_email: "robot@example.test",
        private_key: "never-return-this",
      });
      const result = googleSheetsRobotEmailFromEnv({
        GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: credential,
      });

      expect(result).toEqual({ available: true, robotEmail: "robot@example.test" });
      expect(JSON.stringify(result)).not.toContain("never-return-this");
      expect(googleSheetsRobotEmailFromEnv({})).toMatchObject({ available: false });
      expect(googleSheetsRobotEmailFromEnv({
        GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: "not-json",
      })).toMatchObject({ available: false });
    });

    it("rejects class-3 static leases outside the canonical allowlist", async () => {
      const harness = createMockDb();

      await expect(toolAccessService(harness.db).createConnection(COMPANY_ID, {
        applicationName: "Invalid class-3 app",
        name: "Invalid class-3 connection",
        transport: "mcp_remote",
        config: { url: "http://127.0.0.1:8848/mcp" },
        enabled: false,
        status: "draft",
        credentialSecretRefs: [{
          secretId: "secret-1",
          configPath: "credentials.bot_token",
          projectionClass: "class_3_static_lease",
          projectionAllowlistKey: "github.token",
        }],
      }, USER_ACTOR)).rejects.toMatchObject({
        status: 422,
        details: { code: "class_3_static_lease_not_allowed" },
      });
      expect(harness.calls).toEqual([]);
    });

    it("starts OAuth with PKCE state bound to the initiating Better Auth session", async () => {
      vi.stubEnv("PAPERCLIP_TOOL_OAUTH_ACME_CLIENT_ID", "client-1");
      const connection = connectionRow({
        config: {
          url: "https://mcp.example.test",
          oauth: {
            provider: "acme",
            authorizationUrl: "https://auth.example.test/authorize",
            tokenUrl: "https://auth.example.test/token",
            scopes: ["read", "write"],
          },
        },
      });
      const harness = createMockDb({
        select: [[connection]],
        delete: [[]],
        insert: [[]],
        update: [[]],
      });

      const result = await toolAccessService(harness.db).startOAuth(
        COMPANY_ID,
        CONNECTION_ID,
        {
          redirectUri: "https://paperclip.example.test/oauth/callback",
          actor: USER_ACTOR,
        },
      );

      const authorizationUrl = new URL(result.authorizationUrl);
      expect(authorizationUrl.origin + authorizationUrl.pathname)
        .toBe("https://auth.example.test/authorize");
      expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizationUrl.searchParams.get("client_id")).toBe("client-1");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
      expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
      expect(valuesFor(harness, "insert")[0]).toMatchObject({
        companyId: COMPANY_ID,
        connectionId: CONNECTION_ID,
        createdByActorType: "user",
        createdByActorId: USER_ID,
        createdBySessionId: "session-1",
      });
      const serializedWrites = JSON.stringify({
        insert: valuesFor(harness, "insert"),
        update: valuesFor(harness, "update"),
      });
      expect(serializedWrites).not.toContain("client-1");
      expect(serializedWrites).not.toContain("access_token");
      expect(serializedWrites).not.toContain("refresh_token");
      expect(harness.remaining("select")).toBe(0);
      expect(harness.remaining("delete")).toBe(0);
      expect(harness.remaining("insert")).toBe(0);
      expect(harness.remaining("update")).toBe(0);
    });

    it("rejects OAuth completion from a different authenticated session", async () => {
      const state = {
        state: "oauth-state",
        companyId: COMPANY_ID,
        connectionId: CONNECTION_ID,
        codeVerifier: "verifier",
        createdByActorType: "user",
        createdByActorId: USER_ID,
        createdBySessionId: "session-1",
        subjectUserId: null,
        requestedScopes: null,
        returnTo: null,
        issueId: null,
        expiresAt: new Date("2026-07-25T14:10:00.000Z"),
        createdAt: NOW,
      };
      const harness = createMockDb({ select: [[state]] });
      const fetchMock = vi.spyOn(globalThis, "fetch");

      await expect(toolAccessService(harness.db).completeOAuthCallback({
        state: "oauth-state",
        code: "authorization-code",
        redirectUri: "https://paperclip.example.test/oauth/callback",
        actor: { ...USER_ACTOR, sessionId: "session-2" },
      })).rejects.toMatchObject({ status: 403 });
      expect(harness.calls.some((call) => call.operation === "delete")).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects provider OAuth errors without touching persistence", async () => {
      const harness = createMockDb();
      await expect(toolAccessService(harness.db).completeOAuthCallback({
        state: "oauth-state",
        error: "access_denied",
        errorDescription: "The user denied access.",
        redirectUri: "https://paperclip.example.test/oauth/callback",
        actor: USER_ACTOR,
      })).rejects.toMatchObject({ status: 400 });
      expect(harness.calls).toEqual([]);
    });
  });

  describe("application and connection lifecycle", () => {
    it("creates first-class tool applications", async () => {
      const created = applicationRow();
      const harness = createMockDb({ insert: [[created]] });

      await expect(toolAccessService(harness.db).createApplication(COMPANY_ID, {
        applicationKey: "fixture-app",
        name: "Fixture app",
        type: "mcp_http",
      })).resolves.toMatchObject({
        id: APPLICATION_ID,
        companyId: COMPANY_ID,
        applicationKey: "fixture-app",
        status: "active",
      });
      expect(valuesFor(harness, "insert")[0]).toMatchObject({
        companyId: COMPANY_ID,
        name: "Fixture app",
        type: "mcp_http",
        status: "active",
      });
    });

    it("rejects duplicate application names before update", async () => {
      const harness = createMockDb({
        select: [[applicationRow()], [{ id: "another-app" }]],
      });

      await expect(toolAccessService(harness.db).updateApplication(
        APPLICATION_ID,
        { name: "Already used" },
      )).rejects.toMatchObject({ status: 409 });
      expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
    });

    it("keeps applications with linked connections from being deleted", async () => {
      const harness = createMockDb({
        select: [[applicationRow()], [{ id: CONNECTION_ID }]],
      });

      await expect(toolAccessService(harness.db).deleteApplication(APPLICATION_ID))
        .rejects.toMatchObject({ status: 409 });
      expect(harness.calls.some((call) => call.operation === "delete")).toBe(false);
    });

    it("archives the application when its final connection is archived", async () => {
      const archivedConnection = connectionRow({ status: "archived", enabled: false });
      const harness = createMockDb({
        update: [[archivedConnection], []],
        select: [[]],
      });

      const result = await toolAccessService(harness.db).archiveConnection(CONNECTION_ID);

      expect(result).toMatchObject({ status: "archived", enabled: false });
      expect(valuesFor(harness, "update")).toEqual([
        expect.objectContaining({ status: "archived", enabled: false }),
        expect.objectContaining({ status: "archived", archivedAt: NOW }),
      ]);
      expect(harness.remaining("update")).toBe(0);
      expect(harness.remaining("select")).toBe(0);
    });

    it("keeps the application active while another connection remains", async () => {
      const archivedConnection = connectionRow({ status: "archived", enabled: false });
      const harness = createMockDb({
        update: [[archivedConnection]],
        select: [[{ id: "another-connection" }]],
      });

      await expect(toolAccessService(harness.db).archiveConnection(CONNECTION_ID))
        .resolves.toMatchObject({ status: "archived" });
      expect(valuesFor(harness, "update")).toHaveLength(1);
    });

    it("maps database uniqueness failures to the stable application conflict", () => {
      const service = toolAccessService(createMockDb().db);
      expect(() => service.ensureNoDuplicateNameError({
        code: "23505",
        constraint: "tool_applications_company_id_name_unique",
      })).toThrowError(expect.objectContaining({ status: 409 }));
    });
  });

  describe("test-call approval lifecycle", () => {
    it.each([
      {
        name: "waiting",
        action: { status: "pending" },
        invocation: { status: "awaiting_approval" },
        phase: "waiting",
      },
      {
        name: "running",
        action: { status: "approved", resolvedAt: NOW },
        invocation: { status: "executing" },
        phase: "running",
      },
      {
        name: "denied",
        action: { status: "rejected", resolvedAt: NOW },
        invocation: { status: "failed" },
        phase: "denied",
      },
      {
        name: "successful",
        action: { status: "executed", resolvedAt: NOW },
        invocation: {
          status: "succeeded",
          completedAt: new Date(NOW.getTime() + 125),
          resultSummary: { summary: '{"ok":true}' },
        },
        phase: "done",
        result: { ok: true },
      },
      {
        name: "failed",
        action: { status: "approved", resolvedAt: NOW },
        invocation: {
          status: "failed",
          completedAt: new Date(NOW.getTime() + 125),
          errorCode: "upstream_failed",
          errorMessage: "Upstream failed.",
        },
        phase: "done",
        error: { reasonCode: "upstream_failed", message: "Upstream failed." },
      },
    ])("projects the $name test-call phase from canonical records", async (example) => {
      const harness = createMockDb({
        select: [
          [actionRequestRow(example.action)],
          [invocationRow(example.invocation)],
        ],
      });

      const result = await createToolGatewayService(harness.db).getTestCallStatus({
        companyId: COMPANY_ID,
        connectionId: CONNECTION_ID,
        actionRequestId: ACTION_ID,
      });

      expect(result).toMatchObject({
        actionRequestId: ACTION_ID,
        invocationId: INVOCATION_ID,
        phase: example.phase,
        parameters: { channel: "general", token: "***REDACTED***" },
        ...(example.result ? { result: example.result } : {}),
        ...(example.error ? { error: example.error } : {}),
      });
      expect(JSON.stringify(result)).not.toContain("secret-token-value");
      expect(harness.remaining("select")).toBe(0);
    });

    it("does not expose non-test-origin action requests through test status", async () => {
      const harness = createMockDb({
        select: [
          [actionRequestRow()],
          [invocationRow({
            actorType: "agent",
            runId: "run-1",
            issueId: "issue-1",
          })],
        ],
      });

      await expect(createToolGatewayService(harness.db).getTestCallStatus({
        companyId: COMPANY_ID,
        connectionId: CONNECTION_ID,
        actionRequestId: ACTION_ID,
      })).rejects.toEqual(expect.objectContaining<ToolGatewayHttpError>({
        status: 404,
        reasonCode: "action_request_not_found",
      }));
    });

    it("requires a persisted Better Auth user to decide approvals", async () => {
      const harness = createMockDb({ select: [[]] });

      await expect(createToolGatewayService(harness.db).declineActionRequest({
        companyId: COMPANY_ID,
        actionRequestId: ACTION_ID,
        actor: { userId: USER_ID },
      })).rejects.toMatchObject({
        status: 401,
        reasonCode: "approval_user_invalid",
      });
      expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
    });

    it("declines the pending request and its exact invocation atomically in the service flow", async () => {
      const pending = actionRequestRow();
      const rejected = actionRequestRow({
        status: "rejected",
        resolvedByUserId: USER_ID,
        decidedByUserId: USER_ID,
        decidedAt: NOW,
        resolvedAt: NOW,
      });
      const harness = createMockDb({
        select: [[{ id: USER_ID }], [], [pending], [invocationRow()]],
        update: [[rejected], []],
      });

      const result = await createToolGatewayService(harness.db).declineActionRequest({
        companyId: COMPANY_ID,
        actionRequestId: ACTION_ID,
        actor: { userId: USER_ID },
      });

      expect(result).toMatchObject({
        id: ACTION_ID,
        status: "rejected",
        resolvedByUserId: USER_ID,
        decidedByUserId: USER_ID,
      });
      expect(valuesFor(harness, "update")).toEqual([
        expect.objectContaining({
          status: "rejected",
          resolvedByUserId: USER_ID,
          decidedByUserId: USER_ID,
        }),
        expect.objectContaining({
          approvalState: "rejected",
          status: "failed",
          errorCode: "action_declined",
        }),
      ]);
      expect(harness.remaining("select")).toBe(0);
      expect(harness.remaining("update")).toBe(0);
    });
  });

  describe("runtime health and activity", () => {
    it("reports stale slots, degraded connections, failures, and durable audit failures", async () => {
      const staleAt = new Date(NOW.getTime() - 6 * 60 * 1000);
      const slots = [
        runtimeSlotRow({
          status: "starting",
          startedAt: staleAt,
          updatedAt: staleAt,
          lastUsedAt: null,
        }),
        runtimeSlotRow({
          id: "slot-running",
          status: "running",
          startedAt: staleAt,
          updatedAt: staleAt,
          lastUsedAt: staleAt,
        }),
      ];
      const connections = [connectionRow({ healthStatus: "failed" })];
      const audits = [
        {
          action: "runtime_deferred",
          reasonCode: "runtime_company_capacity_exhausted",
          outcome: "failure",
          details: { durationMs: 250 },
          createdAt: NOW,
        },
        {
          action: "runtime_started",
          reasonCode: "operator_restart",
          outcome: "success",
          details: { durationMs: 100 },
          createdAt: NOW,
        },
      ];
      const callEvents = [
        ...Array.from({ length: 3 }, (_, index) => ({
          id: `timeout-${index}`,
          eventType: "call_failed",
          outcome: "timeout",
          createdAt: NOW,
        })),
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `failure-${index}`,
          eventType: "call_failed",
          outcome: "failure",
          createdAt: NOW,
        })),
      ];
      const harness = createMockDb({
        select: [slots, connections, audits, callEvents, [{ count: 1 }]],
      });

      const result = await toolAccessService(harness.db, {
        deploymentExposure: "public",
        now: () => NOW,
      }).getRuntimeHealth(COMPANY_ID);

      expect(result.status).toBe("critical");
      expect(result.metrics).toMatchObject({
        activeSlots: 2,
        stuckStartingSlots: 1,
        stuckRunningSlots: 1,
        degradedConnections: 1,
        toolTimeoutsLastHour: 3,
        toolFailuresLastHour: 5,
        auditWriteFailuresLastHour: 1,
      });
      expect(result.supportMatrix.localStdio.supported).toBe(false);
      expect(result.alerts.map((alert) => alert.name)).toEqual(expect.arrayContaining([
        "mcp_runtime_stuck_starting_slot",
        "mcp_runtime_stuck_running_slot",
        "mcp_runtime_connection_health_degraded",
        "mcp_runtime_audit_write_failures",
      ]));
      expect(harness.remaining("select")).toBe(0);
    });

    it("does not degrade health for draft or disabled-path setup connections", async () => {
      const harness = createMockDb({
        select: [
          [],
          [
            connectionRow({ status: "draft", enabled: false, healthStatus: "failed" }),
            connectionRow({ id: "disabled", status: "active", enabled: false, healthStatus: "failed" }),
          ],
          [],
          [],
          [{ count: 0 }],
        ],
      });

      const result = await toolAccessService(harness.db, { now: () => NOW })
        .getRuntimeHealth(COMPANY_ID);

      expect(result.status).toBe("ok");
      expect(result.metrics).toMatchObject({
        activeConnections: 0,
        degradedConnections: 0,
      });
      expect(result.alerts).toEqual([]);
    });

    it("delegates runtime stop and attributes the operator activity", async () => {
      const slot = runtimeSlotRow();
      const harness = createMockDb({ select: [[slot]] });

      const result = await toolAccessService(harness.db)
        .stopRuntimeSlot(COMPANY_ID, SLOT_ID, USER_ACTOR);

      expect(result).toMatchObject({ id: SLOT_ID, status: "stopped" });
      expect(dependencyMocks.supervisor.stopSlot).toHaveBeenCalledWith({
        companyId: COMPANY_ID,
        slotId: SLOT_ID,
        reason: "operator_stop",
      });
      expect(dependencyMocks.logActivity).toHaveBeenCalledWith(
        harness.db,
        expect.objectContaining({
          companyId: COMPANY_ID,
          actorType: "user",
          actorId: USER_ID,
          action: "tool_runtime_slot.operator_stopped",
          entityType: "tool_runtime_slot",
          entityId: SLOT_ID,
        }),
      );
      expect(harness.remaining("select")).toBe(0);
    });
  });
});

describe("classifyRisk", () => {
  it.each([
    ["create_item", "write"],
    ["github.create_issue", "write"],
    ["createIssue", "write"],
    ["delete_item", "destructive"],
    ["github.delete_repo", "destructive"],
    ["get_item", "read"],
    ["list_items", "read"],
    ["search_docs", "read"],
    ["telemetry_noise", "read"],
  ] as const)("classifies %s as %s", (name, expected) => {
    expect(classifyRisk({ name })).toBe(expected);
  });

  it("honors explicit annotations over name heuristics", () => {
    expect(classifyRisk({
      name: "get_item",
      annotations: { destructiveHint: true },
    })).toBe("destructive");
    expect(classifyRisk({
      name: "get_item",
      annotations: { readOnlyHint: false },
    })).toBe("write");
  });
});
