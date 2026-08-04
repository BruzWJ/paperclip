import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createToolGatewayService,
  ToolGatewayHttpError,
} from "../services/tool-gateway.js";
import { createMockDb } from "./helpers/mock-db.js";

const dependencyMocks = vi.hoisted(() => ({
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: dependencyMocks.logActivity,
}));

vi.mock("../services/tool-runtime-supervisor.js", () => ({
  createToolRuntimeSupervisor: () => ({}),
  ToolRuntimeSupervisorError: class ToolRuntimeSupervisorError extends Error {},
}));

vi.mock("../services/tool-access-policy.js", () => ({
  toolAccessPolicyService: () => ({
    decide: vi.fn(async () => ({
      allowed: true,
      decision: "allow",
      reasonCode: "test_allow",
      matchedPolicyIds: [],
      effectiveProfileIds: [],
    })),
  }),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({}),
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const profileId = "00000000-0000-4000-8000-000000000002";
const gatewayId = "00000000-0000-4000-8000-000000000003";
const userId = "board-user";
const now = new Date("2026-07-25T14:00:00.000Z");

function gateway(overrides: Record<string, unknown> = {}) {
  return {
    id: gatewayId,
    companyId,
    gatewayPublicId: "gw_public_1",
    name: "Research Gateway",
    displaySlug: "research-gateway",
    slug: "research-gateway",
    description: null,
    status: "active",
    profileId,
    defaultProfileMode: "gateway_only",
    contextScopeType: "none",
    contextScopeId: null,
    agentId: null,
    projectId: null,
    issueId: null,
    approvalIssueId: null,
    authConfig: {},
    headerPolicy: {},
    metadataPolicy: {},
    metadata: {},
    createdByAgentId: null,
    createdByUserId: userId,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function token(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000004",
    companyId,
    gatewayId,
    name: "Local client",
    tokenHash: "hash",
    tokenPrefix: "pcgw_00000000",
    subjectType: "gateway_client",
    subjectId: null,
    clientLabel: "Gateway service test",
    ownerNote: null,
    allowedActions: ["tools/list", "tools/call"],
    expiresAt: null,
    expiryOverrideReason: null,
    expiryOverrideByUserId: null,
    expiryOverrideByAgentId: null,
    expiryOverrideAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdByAgentId: null,
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function actionRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    companyId,
    invocationId: "00000000-0000-4000-8000-000000000011",
    issueId: null,
    approvalId: null,
    status: "pending",
    canonicalArguments: { noteId: "n1", body: "reviewed" },
    canonicalArgumentsHash: "a".repeat(64),
    canonicalArgumentsSummary: { summary: "reviewed" },
    previewMarkdown: "It can change something, so we’re checking with you first.",
    requestedByAgentId: null,
    requestedByUserId: userId,
    resolvedByUserId: null,
    decidedByUserId: null,
    decidedAt: null,
    expiresAt: new Date("2026-07-26T14:00:00.000Z"),
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function invocation(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000011",
    companyId,
    actorType: "agent",
    runId: "00000000-0000-4000-8000-000000000012",
    issueId: "00000000-0000-4000-8000-000000000013",
    gatewayId: null,
    connectionId: "00000000-0000-4000-8000-000000000014",
    runInterfaceToolCallId: null,
    approvalState: "pending",
    status: "awaiting_approval",
    ...overrides,
  };
}

describe("tool gateway service without a database process", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a named gateway, binds its profile, audits it, and returns no tokens", async () => {
    const created = gateway();
    const harness = createMockDb({
      select: [[{ id: profileId }], [created], []],
      insert: [[created], [], []],
    });
    const service = createToolGatewayService(harness.db);

    const result = await service.createNamedGateway({
      companyId,
      body: {
        name: "Research Gateway",
        profileId,
      },
      actor: { userId },
    });

    expect(result).toMatchObject({
      id: gatewayId,
      companyId,
      displaySlug: "research-gateway",
      endpointPath: "/mcp/gateways/gw_public_1",
      tokens: [],
    });
    expect(result.clientSnippets.map((snippet) => snippet.client)).toEqual([
      "cursor",
      "claude_desktop",
      "vscode",
      "claude_code",
    ]);
    expect(dependencyMocks.logActivity).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({
        action: "tool_gateway.named_gateway_created",
        actorType: "user",
        actorId: userId,
      }),
    );
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("fails closed when a gateway profile is outside the company", async () => {
    const harness = createMockDb({ select: [[]] });

    await expect(createToolGatewayService(harness.db).createNamedGateway({
      companyId,
      body: { name: "Unsafe Gateway", profileId },
    })).rejects.toMatchObject({
      status: 422,
      reasonCode: "gateway_profile_invalid",
    });
    expect(harness.calls.some((call) => call.operation === "insert"))
      .toBe(false);
  });

  it("lists active named gateways with their public token projections", async () => {
    const firstGateway = gateway();
    const firstToken = token();
    const harness = createMockDb({
      select: [[firstGateway], [firstGateway], [firstToken]],
    });

    const result = await createToolGatewayService(harness.db)
      .listNamedGateways(companyId);

    expect(result).toEqual([
      expect.objectContaining({
        id: gatewayId,
        tokens: [expect.objectContaining({
          id: firstToken.id,
          tokenPrefix: firstToken.tokenPrefix,
        })],
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(firstToken.tokenHash);
  });

  it("creates an opaque named-gateway token while persisting only its hash", async () => {
    const persisted = token({ id: randomUUID(), tokenPrefix: "pcgw_expected" });
    const harness = createMockDb({
      select: [[gateway()]],
      insert: [[persisted]],
    });

    const result = await createToolGatewayService(harness.db)
      .createNamedGatewayToken({
        companyId,
        gatewayId,
        body: {
          name: "Local client",
          subjectType: "gateway_client",
          clientLabel: "Gateway service test",
          allowedActions: ["tools/list"],
        },
        actor: { userId },
      });

    expect(result).toMatchObject({
      id: persisted.id,
      gatewayId,
      tokenPrefix: "pcgw_expected",
      token: expect.stringMatching(/^pcgw_/),
    });
    expect(result).not.toHaveProperty("tokenHash");
    expect(result.token).not.toBe(persisted.tokenHash);
  });

  it("rejects token creation for an unknown gateway before writing", async () => {
    const harness = createMockDb({ select: [[]] });

    await expect(createToolGatewayService(harness.db)
      .createNamedGatewayToken({
        companyId,
        gatewayId,
        body: {
          name: "Unknown",
          subjectType: "gateway_client",
          clientLabel: "Unknown",
        },
      })).rejects.toMatchObject({
        status: 404,
        reasonCode: "gateway_not_found",
      });
    expect(harness.calls.some((call) => call.operation === "insert"))
      .toBe(false);
  });

  it("revokes a named-gateway token with a public projection", async () => {
    const revokedAt = new Date("2026-07-25T15:00:00.000Z");
    const revoked = token({ revokedAt, updatedAt: revokedAt });
    const harness = createMockDb({ update: [[revoked]] });

    await expect(createToolGatewayService(harness.db)
      .revokeNamedGatewayToken({
        companyId,
        tokenId: String(revoked.id),
        revokedAt,
      })).resolves.toMatchObject({
        id: revoked.id,
        revokedAt,
      });
  });

  it("requires a canonical Better Auth user before deciding an action request", async () => {
    const blankUser = createMockDb();
    await expect(createToolGatewayService(blankUser.db).declineActionRequest({
      companyId,
      actionRequestId: String(actionRequest().id),
      actor: { userId: "  " },
    })).rejects.toMatchObject({
      status: 401,
      reasonCode: "approval_user_required",
    });
    expect(blankUser.calls).toEqual([]);

    const missingUser = createMockDb({ select: [[]] });
    await expect(createToolGatewayService(missingUser.db).declineActionRequest({
      companyId,
      actionRequestId: String(actionRequest().id),
      actor: { userId },
    })).rejects.toMatchObject({
      status: 401,
      reasonCode: "approval_user_invalid",
    });
  });

  it("declines a pending request and marks its exact invocation failed", async () => {
    const pending = actionRequest();
    const rejected = {
      ...pending,
      status: "rejected",
      resolvedByUserId: userId,
      decidedByUserId: userId,
      decidedAt: now,
      resolvedAt: now,
    };
    const invocationRow = invocation();
    const harness = createMockDb({
      select: [[{ id: userId }], [], [pending], [invocationRow]],
      update: [[rejected], []],
    });

    const result = await createToolGatewayService(harness.db)
      .declineActionRequest({
        companyId,
        actionRequestId: String(pending.id),
        actor: { userId },
      });

    expect(result).toMatchObject({
      id: pending.id,
      status: "rejected",
      resolvedByUserId: userId,
      decidedByUserId: userId,
    });
    expect(harness.calls.filter((call) => call.method === "update"))
      .toHaveLength(2);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it("makes repeated decline idempotent without another write", async () => {
    const rejected = actionRequest({
      status: "rejected",
      resolvedByUserId: userId,
      decidedByUserId: userId,
      decidedAt: now,
      resolvedAt: now,
    });
    const harness = createMockDb({
      select: [[{ id: userId }], [], [rejected], [invocation()]],
    });

    await expect(createToolGatewayService(harness.db).declineActionRequest({
      companyId,
      actionRequestId: String(rejected.id),
      actor: { userId },
    })).resolves.toMatchObject({ status: "rejected" });
    expect(harness.calls.some((call) => call.operation === "update"))
      .toBe(false);
  });

  it("keeps destructive actions closed until the linked formal approval is approved", async () => {
    const pending = actionRequest({
      approvalId: "00000000-0000-4000-8000-000000000020",
    });
    const harness = createMockDb({
      select: [
        [{ id: userId }],
        [],
        [pending],
        [invocation()],
        [{ status: "pending" }],
      ],
    });

    await expect(createToolGatewayService(harness.db).approveActionRequest({
      companyId,
      actionRequestId: String(pending.id),
      actor: { userId },
    })).rejects.toMatchObject({
      status: 409,
      reasonCode: "formal_approval_required",
      details: { approvalId: pending.approvalId },
    });
    expect(harness.calls.some((call) => call.operation === "update"))
      .toBe(false);
  });

  it("rejects approval after a request has left the pending state", async () => {
    const rejected = actionRequest({ status: "rejected" });
    const harness = createMockDb({
      select: [[{ id: userId }], [], [rejected], [invocation()]],
    });

    await expect(createToolGatewayService(harness.db).approveActionRequest({
      companyId,
      actionRequestId: String(rejected.id),
      actor: { userId },
    })).rejects.toMatchObject({
      status: 409,
      reasonCode: "action_not_pending",
    });
  });

  it("preserves structured HTTP error status, reason, and details", () => {
    const error = new ToolGatewayHttpError(
      409,
      "Approval required",
      "approval_required",
      { actionRequestId: "request-1" },
    );

    expect(error).toMatchObject({
      status: 409,
      message: "Approval required",
      reasonCode: "approval_required",
      details: { actionRequestId: "request-1" },
    });
  });
});
