import { describe, expect, it } from "vitest";
import {
  authorizationService,
  type AuthorizationAction,
  type AuthorizationResource,
} from "../services/authorization.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const otherCompanyId = "00000000-0000-4000-8000-000000000002";
const actorId = "00000000-0000-4000-8000-000000000003";
const targetId = "00000000-0000-4000-8000-000000000004";
const descendantId = "00000000-0000-4000-8000-000000000005";

function agentRow(id: string, rowCompanyId = companyId) {
  return { id, companyId: rowCompanyId, status: "idle" };
}

function membership(membershipRole = "operator") {
  return {
    id: `membership-${membershipRole}`,
    companyId,
    status: "active",
    membershipRole,
  };
}

function agentActor(id = actorId) {
  return {
    type: "agent" as const,
    agentId: id,
    companyId,
    source: "internal" as const,
  };
}

describe("authorization service canonical boundaries", () => {
  it("treats an authenticated Board MCP user as full-control only in an active company", async () => {
    const boardUserId = "board-mcp-user";
    const { db } = createMockDb({
      select: [
        [agentRow(targetId)],
        [{ id: boardUserId }],
        [membership("viewer")],
      ],
    });

    await expect(authorizationService(db).decide({
      actor: { type: "board", userId: boardUserId, source: "board_mcp" },
      action: "agent_config:update",
      resource: { type: "agent", companyId, agentId: targetId },
      scope: { requiresChangeGrant: true, targetAgentId: targetId },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_board_mcp" });
  });

  it("preserves board reads while requiring non-viewer membership for board task mutation", async () => {
    const viewerId = "viewer-user";
    const operatorId = "operator-user";
    const { db } = createMockDb({
      select: [
        [{ id: viewerId }], [], [membership("viewer")],
        [{ id: viewerId }], [], [membership("viewer")],
        [{ id: operatorId }], [], [membership("operator")],
      ],
    });
    const authorization = authorizationService(db);

    await expect(authorization.decide({
      actor: testBoardSessionActor({ userId: viewerId }),
      action: "task:read",
      resource: { type: "task", companyId, taskId: targetId },
    })).resolves.toMatchObject({ allowed: true });
    await expect(authorization.decide({
      actor: testBoardSessionActor({ userId: viewerId }),
      action: "task:mutate",
      resource: { type: "task", companyId, taskId: targetId },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_missing_grant" });
    await expect(authorization.decide({
      actor: testBoardSessionActor({ userId: operatorId }),
      action: "task:mutate",
      resource: { type: "task", companyId, taskId: targetId },
    })).resolves.toMatchObject({ allowed: true });
  });

  it("denies every generic REST content/control action to a same-company agent", async () => {
    const actions: Array<{ action: AuthorizationAction; resource: AuthorizationResource }> = [
      { action: "company_scope:read", resource: { type: "company", companyId } },
      { action: "project:read", resource: { type: "project", companyId, projectId: targetId } },
      {
        action: "task:read",
        resource: { type: "task", companyId, taskId: targetId, ownerKind: "agent", ownerAgentId: actorId },
      },
      { action: "task:comment", resource: { type: "task", companyId, taskId: targetId } },
      { action: "task:mutate", resource: { type: "task", companyId, taskId: targetId } },
      { action: "runtime:manage", resource: { type: "company", companyId } },
      { action: "secrets:read", resource: { type: "company", companyId } },
      { action: "agent:read", resource: { type: "agent", companyId, agentId: actorId } },
    ];
    const { db } = createMockDb({
      select: actions.map(() => [agentRow(actorId)]),
    });
    const authorization = authorizationService(db);

    for (const entry of actions) {
      const decision = await authorization.decide({ actor: agentActor(), ...entry });
      expect(decision).toMatchObject({
        allowed: false,
        reason: "deny_unsupported_action",
      });
      expect(decision.explanation).toContain("run-scoped compiled interface");
    }
  });

  it("allows only non-protected self configuration without an explicit grant", async () => {
    const { db } = createMockDb({
      select: [
        [agentRow(actorId)], [agentRow(actorId)],
        [agentRow(actorId)], [agentRow(actorId)], [],
      ],
    });
    const authorization = authorizationService(db);
    const base = {
      actor: agentActor(),
      action: "agent_config:update" as const,
      resource: { type: "agent" as const, companyId, agentId: actorId },
    };

    await expect(authorization.decide({
      ...base,
      scope: { targetAgentId: actorId },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_self" });
    await expect(authorization.decide({
      ...base,
      scope: { requiresChangeGrant: true, targetAgentId: actorId },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_missing_membership" });
  });

  it("does not infer target edit authority from hierarchy position", async () => {
    const rootId = actorId;
    const childId = targetId;
    const grandchildId = descendantId;
    const attempts = [
      { actor: rootId, target: childId },
      { actor: rootId, target: grandchildId },
      { actor: grandchildId, target: rootId },
    ];
    const { db } = createMockDb({
      select: attempts.flatMap(({ actor, target }) => [
        [agentRow(target)],
        [agentRow(actor)],
        [],
      ]),
    });
    const authorization = authorizationService(db);

    for (const attempt of attempts) {
      await expect(authorization.decide({
        actor: agentActor(attempt.actor),
        action: "agent_config:update",
        resource: { type: "agent", companyId, agentId: attempt.target },
        scope: { requiresChangeGrant: true, targetAgentId: attempt.target },
      })).resolves.toMatchObject({ allowed: false, reason: "deny_missing_membership" });
    }
  });

  it("honors an exact target grant without extending it to descendants", async () => {
    const exactGrant = {
      id: "grant-direct",
      scope: { targetAgentIds: [targetId] },
    };
    const { db } = createMockDb({
      select: [
        [agentRow(targetId)], [agentRow(actorId)], [membership()], [exactGrant],
        [agentRow(descendantId)], [agentRow(actorId)], [membership()], [exactGrant],
        [membership()], [],
      ],
    });
    const authorization = authorizationService(db);

    await expect(authorization.decide({
      actor: agentActor(),
      action: "agent_config:update",
      resource: { type: "agent", companyId, agentId: targetId },
      scope: { requiresChangeGrant: true, targetAgentId: targetId },
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_direct_change",
      grant: { permissionKey: "agents:configure" },
    });
    await expect(authorization.decide({
      actor: agentActor(),
      action: "agent_config:update",
      resource: { type: "agent", companyId, agentId: descendantId },
      scope: { requiresChangeGrant: true, targetAgentId: descendantId },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
  });

  it("requires accepted consent for an exact suggestion grant", async () => {
    const suggestionGrant = { id: "grant-suggest", scope: { targetAgentId: targetId } };
    const oneDecision = [
      [agentRow(targetId)],
      [agentRow(actorId)],
      [membership()], [],
      [membership()], [suggestionGrant],
    ];
    const { db } = createMockDb({ select: [...oneDecision, ...oneDecision] });
    const authorization = authorizationService(db);
    const base = {
      actor: agentActor(),
      action: "agent_config:update" as const,
      resource: { type: "agent" as const, companyId, agentId: targetId },
    };

    await expect(authorization.decide({
      ...base,
      scope: { requiresChangeGrant: true, targetAgentId: targetId },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_missing_consent" });
    await expect(authorization.decide({
      ...base,
      scope: { requiresChangeGrant: true, consentedChange: true, targetAgentId: targetId },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_consented_change" });
  });

  it("rejects a cross-company target before evaluating a broad grant", async () => {
    const { db, calls } = createMockDb({
      select: [[agentRow(targetId, otherCompanyId)]],
    });

    await expect(authorizationService(db).decide({
      actor: agentActor(),
      action: "agent_config:update",
      resource: { type: "agent", companyId, agentId: targetId },
      scope: { requiresChangeGrant: true, targetAgentId: targetId },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_company_boundary" });
    expect(calls.filter((call) => call.method === "select")).toHaveLength(1);
  });

  it("requires an exact same-company target even for an instance-admin preview", async () => {
    const { db } = createMockDb({
      select: [[], [agentRow(targetId, otherCompanyId)]],
    });
    const authorization = authorizationService(db);
    const actor = testBoardSessionActor({
      userId: "instance-admin",
      isInstanceAdmin: false,
    });

    await expect(authorization.decide({
      actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId, agentId: descendantId },
      scope: { requiresChangeGrant: true },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_company_boundary" });
    await expect(authorization.decide({
      actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId, agentId: targetId },
      scope: { requiresChangeGrant: true },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_company_boundary" });
  });

  it("never treats a request-supplied admin snapshot as authorization proof", async () => {
    const { db } = createMockDb({
      select: [[agentRow(targetId)], []],
    });
    const actor = testBoardSessionActor({
      userId: "missing-user",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    await expect(authorizationService(db).decide({
      actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId, agentId: targetId },
      scope: { requiresChangeGrant: true, targetAgentId: targetId },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_unauthenticated",
    });
  });
});
