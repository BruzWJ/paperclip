import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { companySkillPolicyRoutes } from "../routes/company-skill-policy.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mocks = vi.hoisted(() => ({
  canUser: vi.fn(),
  get: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
  evaluate: vi.fn(),
  resolveAgentPrincipal: vi.fn(),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => ({ canUser: mocks.canUser }),
}));

vi.mock("../services/company-skill-policy.js", () => ({
  companySkillPolicyService: () => ({
    get: mocks.get,
    replace: mocks.replace,
    reset: mocks.reset,
    evaluate: mocks.evaluate,
    resolveAgentPrincipal: mocks.resolveAgentPrincipal,
  }),
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const otherCompanyId = "00000000-0000-4000-8000-000000000002";
const agentId = "00000000-0000-4000-8000-000000000003";
const MEMBER_USER_ID = "skill-policy-member";
const ADMIN_USER_ID = "skill-policy-admin";
const CROSS_COMPANY_USER_ID = "skill-policy-cross-company";

function actorFor(requestedActor: string | undefined) {
  if (requestedActor === "none") {
    return { type: "none", source: "none" } as const;
  }
  if (requestedActor === "cross-company") {
    return testBoardSessionActor({
      userId: CROSS_COMPANY_USER_ID,
      companyIds: [otherCompanyId],
    });
  }
  const userId = requestedActor === "board" ? ADMIN_USER_ID : MEMBER_USER_ID;
  return testBoardSessionActor({
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: requestedActor === "board" ? "owner" : "operator", status: "active" }],
  });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actorFor(req.header("x-test-actor") ?? undefined);
    next();
  });
  app.use(companySkillPolicyRoutes({} as Db));
  app.use(errorHandler);
  return app;
}

describe("company skill policy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canUser.mockImplementation(async (_companyId, userId) => userId === ADMIN_USER_ID);
    mocks.get.mockResolvedValue({
      schemaVersion: 1,
      revision: 0,
      materialized: false,
      defaultEffect: "allow",
      rules: [],
    });
    mocks.replace.mockResolvedValue({
      schemaVersion: 1,
      revision: 1,
      materialized: true,
      defaultEffect: "allow",
      rules: [],
    });
    mocks.reset.mockResolvedValue({
      schemaVersion: 1,
      revision: 0,
      materialized: false,
      defaultEffect: "allow",
      rules: [],
    });
    mocks.resolveAgentPrincipal.mockResolvedValue({ type: "agent", id: agentId });
    mocks.evaluate.mockResolvedValue({
      allowed: false,
      reason: "explicit_rule",
      matchedRuleId: "deny-remove",
    });
  });

  it("returns the open default and stable authentication/company boundary errors", async () => {
    const app = createApp();
    await request(app)
      .get(`/companies/${companyId}/skill-policy`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ revision: 0, materialized: false, defaultEffect: "allow" }));
    await request(app)
      .get(`/companies/${companyId}/skill-policy`)
      .set("x-test-actor", "none")
      .expect(401)
      .expect(({ body }) => expect(body.error).toBe("Unauthorized"));
    await request(app)
      .get(`/companies/${companyId}/skill-policy`)
      .set("x-test-actor", "cross-company")
      .expect(403)
      .expect(({ body }) => expect(body.error).toBe("User does not have access to this company"));
  });

  it("restricts policy administration and forwards canonical mutation/evaluation contracts", async () => {
    const app = createApp();
    const body = {
      schemaVersion: 1,
      expectedRevision: 0,
      defaultEffect: "allow",
      rules: [{
        id: "deny-remove",
        priority: 1,
        effect: "deny",
        subject: { type: "all_agents" },
        actions: ["skills.remove"],
      }],
    };
    await request(app)
      .put(`/companies/${companyId}/skill-policy`)
      .send(body)
      .expect(403)
      .expect(({ body: responseBody }) => expect(responseBody.code).toBe("skill_policy_admin_required"));
    await request(app)
      .put(`/companies/${companyId}/skill-policy`)
      .set("x-test-actor", "board")
      .send(body)
      .expect(200)
      .expect(({ body: responseBody }) => expect(responseBody).toMatchObject({ revision: 1, materialized: true }));
    expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      expectedRevision: 0,
      activity: { actorType: "user", actorId: ADMIN_USER_ID },
    }));

    mocks.replace.mockRejectedValueOnce(conflict("Skill policy revision conflict", {
      code: "skill_policy_revision_conflict",
    }));
    await request(app)
      .put(`/companies/${companyId}/skill-policy`)
      .set("x-test-actor", "board")
      .send(body)
      .expect(409)
      .expect(({ body: responseBody }) => expect(responseBody.code).toBe("skill_policy_revision_conflict"));
    await request(app)
      .post(`/companies/${companyId}/skill-policy/evaluate`)
      .set("x-test-actor", "board")
      .send({ action: "skills.remove", resource: {}, principal: { agentId } })
      .expect(200)
      .expect(({ body: responseBody }) => expect(responseBody).toMatchObject({
        allowed: false,
        reason: "explicit_rule",
        matchedRuleId: "deny-remove",
      }));
    expect(mocks.resolveAgentPrincipal).toHaveBeenCalledWith(companyId, agentId);
    await request(app)
      .post(`/companies/${companyId}/skill-policy/evaluate`)
      .send({ action: "skills.remove", resource: {}, principal: { agentId } })
      .expect(403)
      .expect(({ body: responseBody }) => expect(responseBody.code).toBe("skill_policy_admin_required"));
    await request(app)
      .delete(`/companies/${companyId}/skill-policy`)
      .set("x-test-actor", "board")
      .expect(200)
      .expect(({ body: responseBody }) => expect(responseBody).toMatchObject({ revision: 0, materialized: false }));
    expect(mocks.reset).toHaveBeenCalledWith({
      companyId,
      activity: { actorType: "user", actorId: ADMIN_USER_ID },
    });
  });

  it("rejects unknown actions and secret-bearing policy locators with 422", async () => {
    const app = createApp();
    await request(app)
      .post(`/companies/${companyId}/skill-policy/evaluate`)
      .send({ action: "skills.publish", resource: {} })
      .expect(422)
      .expect(({ body }) => expect(body.code).toBe("skill_policy_validation_failed"));
    await request(app)
      .put(`/companies/${companyId}/skill-policy`)
      .set("x-test-actor", "board")
      .send({
        schemaVersion: 1,
        expectedRevision: 0,
        defaultEffect: "allow",
        rules: [{
          id: "secret-locator",
          priority: 1,
          effect: "deny",
          subject: { type: "all_agents" },
          actions: ["skills.import"],
          resources: { sourceLocators: ["https://example.com/skill?token=do-not-store"] },
        }],
      })
      .expect(422)
      .expect(({ body }) => expect(body.code).toBe("skill_policy_validation_failed"));
  });
});
