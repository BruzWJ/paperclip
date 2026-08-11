import { describe, expect, it } from "vitest";
import {
  assertBoardOrgAccess,
  assertCompanyAccess,
  authorizeHumanTaskSteering,
  getAccessibleResource,
  hasBoardOrgAccess,
} from "../routes/authz.js";
import { testBoardKeyActor, testBoardSessionActor } from "./helpers/request-actor.js";

function makeReq(input: {
  method?: string;
  actor: Record<string, unknown>;
}) {
  const actor =
    input.actor.type === "board"
      ? {
          source: "session",
          sessionId: "session-1",
          userName: "Test User",
          userEmail: "test@example.com",
          companyIds: [],
          memberships: [],
          isInstanceAdmin: false,
          ...input.actor,
        }
      : input.actor;
  return {
    method: input.method ?? "GET",
    actor,
  } as Express.Request;
}

function steeringDb(responses: readonly (readonly Record<string, unknown>[])[]) {
  let selectIndex = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(responses[selectIndex++] ?? []),
        }),
      }),
    }),
  } as never;
}

describe("assertCompanyAccess", () => {
  it("allows viewer memberships to read", () => {
    const req = makeReq({
      method: "GET",
      actor: testBoardSessionActor({
        userId: "user-1",
        companyIds: ["company-1"],
        memberships: [
          { companyId: "company-1", membershipRole: "viewer", status: "active" },
        ],
      }),
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("rejects viewer memberships for writes", () => {
    const req = makeReq({
      method: "PATCH",
      actor: testBoardSessionActor({
        userId: "user-1",
        companyIds: ["company-1"],
        memberships: [
          { companyId: "company-1", membershipRole: "viewer", status: "active" },
        ],
      }),
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow("Viewer access is read-only");
  });

  it("rejects writes when membership details are present but omit the target company", () => {
    const req = makeReq({
      method: "POST",
      actor: testBoardSessionActor({
        userId: "user-1",
        companyIds: ["company-1"],
        memberships: [],
      }),
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow("User does not have active company access");
  });

  it("rejects incomplete board actors without a source-specific session id", () => {
    const req = {
      method: "POST",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [
          { companyId: "company-1", membershipRole: "operator", status: "active" },
        ],
        isInstanceAdmin: false,
        userName: "Test User",
        userEmail: "test@example.com",
      },
    } as Express.Request;

    expect(() => assertCompanyAccess(req, "company-1")).toThrow(
      "Board access required",
    );
  });

  it("rejects signed-in instance admins without explicit company access", () => {
    const req = makeReq({
      method: "GET",
      actor: testBoardSessionActor({
        userId: "admin-1",
        isInstanceAdmin: true,
        companyIds: [],
        memberships: [],
      }),
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow("User does not have access to this company");
  });

  it("rejects instance admins when the company-access snapshot is absent", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "board-user",
        source: "session",
        isInstanceAdmin: true,
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow(
      "User does not have access to this company",
    );
  });

  it("rejects exact runtime-agent actors at the generic company boundary", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
        source: "internal",
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow(
      "Board access required",
    );
  });
});

describe("getAccessibleResource", () => {
  function response() {
    const payloads: Array<{ status: number; body: unknown }> = [];
    const res = {
      status(status: number) {
        return {
          json(body: unknown) {
            payloads.push({ status, body });
          },
        };
      },
    } as Express.Response;
    return { res, payloads };
  }

  it("returns resources in an accessible company", async () => {
    const req = makeReq({
      actor: testBoardSessionActor({
        userId: "user-1",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
      }),
    });
    const { res, payloads } = response();
    const resource = { id: "resource-1", companyId: "company-1" };

    await expect(getAccessibleResource(req, res, resource, "Resource not found"))
      .resolves.toEqual(resource);
    expect(payloads).toEqual([]);
  });

  it("folds cross-company resources into the canonical not-found response", async () => {
    const req = makeReq({
      actor: testBoardSessionActor({
        userId: "user-1",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
      }),
    });
    const { res, payloads } = response();

    await expect(getAccessibleResource(
      req,
      res,
      { id: "resource-2", companyId: "company-2" },
      "Resource not found",
    )).resolves.toBeNull();
    expect(payloads).toEqual([{
      status: 404,
      body: { error: "Resource not found" },
    }]);
  });

  it("folds missing resources into the same not-found response", async () => {
    const req = makeReq({
      actor: testBoardSessionActor({
        userId: "user-1",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
      }),
    });
    const { res, payloads } = response();

    await expect(getAccessibleResource(req, res, null, "Resource not found"))
      .resolves.toBeNull();
    expect(payloads).toEqual([{
      status: 404,
      body: { error: "Resource not found" },
    }]);
  });
});

describe("assertBoardOrgAccess", () => {
  it("allows signed-in board users with active company access", () => {
    const req = makeReq({
      actor: testBoardSessionActor({
        userId: "user-1",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
        isInstanceAdmin: false,
      }),
    });

    expect(hasBoardOrgAccess(req)).toBe(true);
    expect(() => assertBoardOrgAccess(req)).not.toThrow();
  });

  it("allows instance admins without company memberships", () => {
    const req = makeReq({
      actor: testBoardSessionActor({
        userId: "admin-1",
        companyIds: [],
        memberships: [],
        isInstanceAdmin: true,
      }),
    });

    expect(hasBoardOrgAccess(req)).toBe(true);
    expect(() => assertBoardOrgAccess(req)).not.toThrow();
  });

  it("rejects signed-in users without company access or instance admin rights", () => {
    const req = makeReq({
      actor: testBoardSessionActor({
        userId: "outsider-1",
        companyIds: [],
        memberships: [],
        isInstanceAdmin: false,
      }),
    });

    expect(hasBoardOrgAccess(req)).toBe(false);
    expect(() => assertBoardOrgAccess(req)).toThrow("Company membership or instance admin access required");
  });
});

describe("authorizeHumanTaskSteering", () => {
  const operator = {
    companyId: "company-1",
    membershipRole: "operator" as const,
    status: "active" as const,
  };

  it("authorizes a Better Auth session only when its user and active write membership persist", async () => {
    const req = makeReq({
      method: "POST",
      actor: testBoardSessionActor({
        userId: "user-1",
        companyIds: ["company-1"],
        memberships: [operator],
      }),
    });

    await expect(authorizeHumanTaskSteering(
      steeringDb([
        [{ id: "user-1" }],
        [{ id: "membership-1", status: "active", membershipRole: "operator" }],
      ]),
      req,
      "company-1",
    )).resolves.toBe("user-1");
  });

  it("applies the same persisted-human predicate to derivative board keys", async () => {
    const req = makeReq({
      method: "POST",
      actor: testBoardKeyActor({
        userId: "user-1",
        companyIds: ["company-1"],
        memberships: [operator],
      }),
    });

    await expect(authorizeHumanTaskSteering(
      steeringDb([
        [{ id: "user-1" }],
        [{ id: "membership-1", status: "active", membershipRole: "operator" }],
      ]),
      req,
      "company-1",
    )).resolves.toBe("user-1");
  });

  it("rejects a board identity whose canonical Better Auth user is absent", async () => {
    const req = makeReq({
      method: "POST",
      actor: testBoardSessionActor({
        userId: "deleted-user",
        companyIds: ["company-1"],
        memberships: [operator],
      }),
    });

    await expect(authorizeHumanTaskSteering(
      steeringDb([
        [],
        [{ id: "membership-1", status: "active", membershipRole: "operator" }],
      ]),
      req,
      "company-1",
    )).rejects.toThrow("Human steering requires active comment permission");
  });

  it("rejects persisted viewer membership even when the request snapshot claims write access", async () => {
    const req = makeReq({
      method: "POST",
      actor: testBoardSessionActor({
        userId: "user-1",
        companyIds: ["company-1"],
        memberships: [operator],
      }),
    });

    await expect(authorizeHumanTaskSteering(
      steeringDb([
        [{ id: "user-1" }],
        [{ id: "membership-1", status: "active", membershipRole: "viewer" }],
      ]),
      req,
      "company-1",
    )).rejects.toThrow("Human steering requires active comment permission");
  });

  it("rejects runtime agents before consulting persistence", async () => {
    const req = makeReq({
      method: "POST",
      actor: {
        type: "agent",
        source: "internal",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
      },
    });

    await expect(authorizeHumanTaskSteering(
      steeringDb([]),
      req,
      "company-1",
    )).rejects.toThrow("Board access required");
  });
});
