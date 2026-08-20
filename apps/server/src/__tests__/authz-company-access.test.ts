import { describe, expect, it } from "vitest";
import {
  assertBoardOrgAccess,
  assertCompanyAccess,
  getAccessibleResource,
  hasBoardOrgAccess,
} from "../routes/authz.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

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

  it("allows active viewer memberships to write", () => {
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

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
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
