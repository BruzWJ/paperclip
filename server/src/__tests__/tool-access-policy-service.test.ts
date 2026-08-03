import { describe, expect, it } from "vitest";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { createMockDb } from "./helpers/mock-db.js";

const companyId = "00000000-0000-4000-8000-000000000001";

function decisionInput(argumentsValue: Record<string, unknown> = {}) {
  return {
    companyId,
    actor: {
      actorType: "system" as const,
      actorId: "scheduler",
    },
    request: {
      toolName: "read_file",
      arguments: argumentsValue,
    },
  };
}

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "policy-1",
    companyId,
    name: "Allow safe reads",
    description: null,
    policyType: "allow",
    priority: 10,
    enabled: true,
    selectors: { toolName: "read_file" },
    conditions: null,
    config: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("tool access policy service", () => {
  it("redacts secret keys and credential-shaped values before audit storage", () => {
    const service = toolAccessPolicyService(createMockDb().db);
    const result = service.summarizeAndRedact({
      path: "README.md",
      authorization: "Bearer top-secret-token-value",
      nested: {
        note: "send ghp_abcdefghijklmnop to the provider",
        visible: "safe",
      },
    });

    expect(result.redactionPlan).toEqual({
      redactedFieldCount: 2,
      redactedFields: ["authorization", "nested.note"],
    });
    expect(result.summary.summary).toContain('"authorization":"[REDACTED]"');
    expect(result.summary.summary).toContain('"note":"[REDACTED]"');
    expect(result.summary.summary).toContain('"visible":"safe"');
    expect(result.summary.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when no profile, grant, or policy authorizes a call", async () => {
    const mock = createMockDb({ select: [[], []] });

    await expect(toolAccessPolicyService(mock.db).decide(decisionInput()))
      .resolves.toMatchObject({
        allowed: false,
        decision: "deny",
        reasonCode: "deny_default",
        effectiveProfileIds: [],
        matchedPolicyIds: [],
      });
    expect(mock.remaining("select")).toBe(0);
  });

  it("applies an exact matching allow policy before the default deny", async () => {
    const mock = createMockDb({ select: [[], [policyRow()]] });

    await expect(toolAccessPolicyService(mock.db).decide(decisionInput({ path: "README.md" })))
      .resolves.toMatchObject({
        allowed: true,
        decision: "allow",
        reasonCode: "allow_policy",
        matchedPolicyIds: ["policy-1"],
      });
  });

  it("treats glob-looking tool selectors as exact names", async () => {
    const mock = createMockDb({
      select: [[], [policyRow({
        policyType: "block",
        name: "Wildcard-looking block",
        selectors: { toolName: "*read*" },
      })]],
    });

    await expect(toolAccessPolicyService(mock.db).decide(decisionInput()))
      .resolves.toMatchObject({
        allowed: false,
        reasonCode: "deny_default",
        matchedPolicyIds: [],
      });
  });

  it("persists only supported generic policies with canonical actor ownership", async () => {
    const created = policyRow({ createdByUserId: "board-user" });
    const mock = createMockDb({ insert: [[created]] });
    const service = toolAccessPolicyService(mock.db);

    await expect(service.createPolicy(companyId, {
      name: "Allow safe reads",
      description: null,
      policyType: "allow",
      priority: 10,
      enabled: true,
      selectors: { toolName: "read_file" },
      conditions: null,
      config: null,
    }, { userId: "board-user" })).resolves.toEqual(created);

    const values = mock.calls.find((call) =>
      call.operation === "insert" && call.method === "values")?.args[0];
    expect(values).toMatchObject({
      companyId,
      name: "Allow safe reads",
      policyType: "allow",
      createdByAgentId: null,
      createdByUserId: "board-user",
    });
  });

  it("rejects trust-rule creation and duplicate reorder ids before persistence", async () => {
    const mock = createMockDb();
    const service = toolAccessPolicyService(mock.db);

    await expect(service.createPolicy(companyId, {
      name: "Unreviewed trust",
      description: null,
      policyType: "trust_rule",
      priority: 100,
      enabled: true,
      selectors: {},
      conditions: null,
      config: null,
    })).rejects.toMatchObject({ status: 422 });

    await expect(service.reorderPolicies(companyId, {
      policyIds: ["policy-1", "policy-1"],
    })).rejects.toMatchObject({ status: 400 });
    expect(mock.calls).toEqual([]);
  });

  it("maps unique-index failures to a stable conflict", () => {
    const service = toolAccessPolicyService(createMockDb().db);
    expect(() => service.ensureNoDuplicatePolicyNameError(
      new Error("duplicate key value violates unique constraint"),
    )).toThrowError(expect.objectContaining({ status: 409 }));
  });
});
