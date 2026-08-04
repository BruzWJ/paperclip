import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companySkillPolicyService } from "../services/company-skill-policy.js";
import { createMockDb } from "./helpers/mock-db.js";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

function storedPolicy(
  companyId: string,
  input: {
    revision?: number;
    defaultEffect?: "allow" | "deny";
    rules?: unknown[];
  } = {},
) {
  const now = new Date("2026-03-11T00:00:00.000Z");
  return {
    companyId,
    schemaVersion: 1,
    revision: input.revision ?? 1,
    defaultEffect: input.defaultEffect ?? "allow",
    rules: input.rules ?? [],
    createdAt: now,
    updatedAt: now,
  };
}

describe("companySkillPolicyService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("allows every canonical action when no explicit policy exists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const actions = [
      "skills.create",
      "skills.import",
      "skills.install",
      "skills.edit",
      "skills.update",
      "skills.test",
      "skills.reset",
      "skills.remove",
    ] as const;
    const { db } = createMockDb({ select: actions.map(() => []) });
    const service = companySkillPolicyService(db);

    for (const action of actions) {
      await expect(service.evaluate({
        companyId,
        principal: { type: "agent", id: agentId },
        action,
      })).resolves.toMatchObject({
        allowed: true,
        action,
        reason: "no_policy_default",
        policyRevision: 0,
      });
    }
  });

  it("evaluates protected resources and exact-agent overrides deterministically", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const protectedSkillId = randomUUID();
    const policy = storedPolicy(companyId, {
      rules: [
        {
          id: "agent-override",
          priority: 1,
          effect: "allow",
          subject: { type: "agents", agentIds: [agentId] },
          actions: ["skills.install"],
          resources: { sourceTypes: ["external_package"] },
        },
        {
          id: "agent-edit-override",
          priority: 5,
          effect: "allow",
          subject: { type: "agents", agentIds: [agentId] },
          actions: ["skills.edit"],
          resources: { skillIds: [protectedSkillId] },
        },
        {
          id: "protected-skill",
          priority: 10,
          effect: "deny",
          subject: { type: "all_agents" },
          actions: ["skills.edit", "skills.remove"],
          resources: { skillIds: [protectedSkillId] },
        },
        {
          id: "deny-external",
          priority: 20,
          effect: "deny",
          subject: { type: "all_agents" },
          actions: ["skills.install"],
          resources: { sourceTypes: ["external_package"] },
        },
      ],
    });
    const { db } = createMockDb({ select: [[policy], [policy], [policy]] });
    const service = companySkillPolicyService(db);
    const principal = { type: "agent" as const, id: agentId };

    await expect(service.evaluate({
      companyId,
      principal,
      action: "skills.edit",
      resource: { skillId: protectedSkillId },
    })).resolves.toMatchObject({ allowed: true, matchedRuleId: "agent-edit-override" });
    await expect(service.evaluate({
      companyId,
      principal,
      action: "skills.remove",
      resource: { skillId: protectedSkillId },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "explicit_rule",
      matchedRuleId: "protected-skill",
    });
    await expect(service.evaluate({
      companyId,
      principal,
      action: "skills.install",
      resource: { sourceType: "external_package" },
    })).resolves.toMatchObject({ allowed: true, matchedRuleId: "agent-override" });
  });

  it("does not consult retired broad grants when applying the explicit policy", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const policy = storedPolicy(companyId, {
      revision: 3,
      defaultEffect: "deny",
      rules: [{
        id: "deny-removal",
        priority: 1,
        effect: "deny",
        subject: { type: "all_agents" },
        actions: ["skills.remove"],
      }],
    });
    const { db, calls } = createMockDb({ select: [[policy], [policy]] });
    const service = companySkillPolicyService(db);
    const principal = { type: "agent" as const, id: agentId };

    await expect(service.evaluate({
      companyId,
      principal,
      action: "skills.edit",
    })).resolves.toMatchObject({ allowed: false, reason: "policy_default" });
    await expect(service.evaluate({
      companyId,
      principal,
      action: "skills.remove",
    })).resolves.toMatchObject({ allowed: false, reason: "explicit_rule" });
    expect(calls.filter((call) => call.method === "select")).toHaveLength(2);
  });

  it("matches sourceLocator deny rules regardless of GitHub URL casing or .git suffix", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const normalizedPolicy = storedPolicy(companyId, {
      rules: [{
        id: "deny-repo",
        priority: 1,
        effect: "deny",
        subject: { type: "all_agents" },
        actions: ["skills.import"],
        resources: { sourceLocators: ["https://github.com/owner/repo"] },
      }],
    });
    const { db } = createMockDb({
      select: [[], [normalizedPolicy], [normalizedPolicy], [normalizedPolicy]],
      insert: [[{ revision: 1 }]],
    });
    const service = companySkillPolicyService(db);
    const replaced = await service.replace({
      companyId,
      expectedRevision: 0,
      policy: {
        schemaVersion: 1,
        defaultEffect: "allow",
        rules: [{
          id: "deny-repo",
          priority: 1,
          effect: "deny",
          subject: { type: "all_agents" },
          actions: ["skills.import"],
          resources: { sourceLocators: ["https://WWW.GitHub.com/Owner/Repo.git"] },
        }],
      },
      activity: { actorType: "agent", actorId: agentId, agentId },
    });
    expect(replaced.rules[0]!.resources!.sourceLocators).toEqual([
      "https://github.com/owner/repo",
    ]);

    for (const sourceLocator of [
      "https://github.com/owner/repo",
      "https://github.com/Owner/Repo.git",
    ]) {
      await expect(service.evaluate({
        companyId,
        principal: { type: "agent", id: agentId },
        action: "skills.import",
        resource: { sourceType: "git", sourceLocator },
      })).resolves.toMatchObject({
        allowed: false,
        reason: "explicit_rule",
        matchedRuleId: "deny-repo",
      });
    }
    await expect(service.evaluate({
      companyId,
      principal: { type: "agent", id: agentId },
      action: "skills.import",
      resource: {
        sourceType: "git",
        sourceLocator: "https://github.com/owner/other-repo",
      },
    })).resolves.toMatchObject({ allowed: true, reason: "policy_default" });
  });

  it("matches deny rules persisted before locator normalization existed", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const policy = storedPolicy(companyId, {
      revision: 2,
      rules: [{
        id: "legacy-deny-repo",
        priority: 1,
        effect: "deny",
        subject: { type: "all_agents" },
        actions: ["skills.import"],
        resources: { sourceLocators: ["https://github.com/Owner/Repo.git"] },
      }],
    });
    const { db } = createMockDb({ select: [[policy]] });

    await expect(companySkillPolicyService(db).evaluate({
      companyId,
      principal: { type: "agent", id: agentId },
      action: "skills.import",
      resource: {
        sourceType: "git",
        sourceLocator: "https://github.com/owner/repo",
      },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "explicit_rule",
      matchedRuleId: "legacy-deny-repo",
    });
  });

  it("rejects cross-company simulation principals", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const { db } = createMockDb({
      select: [[{ id: agentId, companyId: randomUUID() }]],
    });

    await expect(
      companySkillPolicyService(db).resolveAgentPrincipal(companyId, agentId),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "skill_company_boundary_denied" },
    });
  });

  it("keeps activity persistence inside the policy replacement transaction", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const { db, calls } = createMockDb({
      select: [[]],
      insert: [[{ revision: 1 }]],
    });
    mockLogActivity.mockRejectedValueOnce(new Error("activity insert failed"));

    await expect(companySkillPolicyService(db).replace({
      companyId,
      expectedRevision: 0,
      policy: { schemaVersion: 1, defaultEffect: "deny", rules: [] },
      activity: { actorType: "agent", actorId: agentId, agentId },
    })).rejects.toThrow("activity insert failed");

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(calls.filter((call) => call.method === "insert")).toHaveLength(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        companyId,
        action: "company.skill_policy_replaced",
      }),
    );
  });
});
