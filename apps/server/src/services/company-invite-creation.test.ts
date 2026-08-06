import { describe, expect, it } from "vitest";
import { createMockDb } from "../__tests__/helpers/mock-db.js";
import { createCompanyInvite } from "./company-invite-creation.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const invitedByUserId = "board-user";
const createdAt = new Date("2026-08-06T00:00:00.000Z");

function inviteRow(source: "board_api" | "plugin_host") {
  return {
    id: `invite-${source}`,
    companyId,
    inviteType: "company_join",
    tokenHash: "stored-hash",
    allowedJoinTypes: "both",
    defaultsPayload: null,
    expiresAt: new Date("2026-08-09T00:00:00.000Z"),
    source,
    invitedByUserId: source === "board_api" ? invitedByUserId : null,
    revokedAt: null,
    acceptedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("createCompanyInvite", () => {
  it("applies one defaults and token policy while preserving explicit board provenance", async () => {
    const row = inviteRow("board_api");
    const harness = createMockDb({ insert: [[row]] });

    const result = await createCompanyInvite(harness.db, {
      companyId,
      provenance: { source: "board_api", invitedByUserId },
      allowedJoinTypes: "both",
      humanRole: "viewer",
      defaultsPayload: { human: { label: "Reviewer" }, custom: true },
      agentMessage: "  Review the onboarding notes.  ",
    });

    expect(result.invite).toEqual(row);
    expect(result.normalizedAgentMessage).toBe("Review the onboarding notes.");
    expect(result.token).toMatch(/^pcp_invite_[A-Za-z0-9_-]{22,}$/);
    expect(harness.calls.find((call) =>
      call.operation === "insert" && call.method === "values"
    )?.args[0]).toMatchObject({
      companyId,
      source: "board_api",
      invitedByUserId,
      allowedJoinTypes: "both",
      defaultsPayload: {
        human: {
          label: "Reviewer",
          role: "viewer",
          grants: expect.any(Array),
        },
        custom: true,
        agentMessage: "Review the onboarding notes.",
      },
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("uses the same creation policy with plugin-host provenance and no human inviter", async () => {
    const row = inviteRow("plugin_host");
    const harness = createMockDb({ insert: [[row]] });

    await createCompanyInvite(harness.db, {
      companyId,
      provenance: { source: "plugin_host" },
      allowedJoinTypes: "human",
    });

    expect(harness.calls.find((call) =>
      call.operation === "insert" && call.method === "values"
    )?.args[0]).toMatchObject({
      companyId,
      source: "plugin_host",
      invitedByUserId: null,
      allowedJoinTypes: "human",
      defaultsPayload: {
        human: {
          role: "operator",
          grants: expect.any(Array),
        },
      },
    });
  });

  it("retries only the exact invite-token uniqueness collision", async () => {
    const collision = Object.assign(new Error("duplicate invite token"), {
      code: "23505",
      constraint: "invites_token_hash_unique_idx",
    });
    const row = inviteRow("plugin_host");
    const harness = createMockDb({ insert: [collision, [row]] });

    await expect(createCompanyInvite(harness.db, {
      companyId,
      provenance: { source: "plugin_host" },
    })).resolves.toMatchObject({ invite: row });
    expect(harness.calls.filter((call) => call.operation === "insert" && call.method === "insert"))
      .toHaveLength(2);

    const otherConstraint = Object.assign(new Error("duplicate company record"), {
      code: "23505",
      constraint: "other_unique_idx",
    });
    const failedHarness = createMockDb({ insert: [otherConstraint] });
    await expect(createCompanyInvite(failedHarness.db, {
      companyId,
      provenance: { source: "plugin_host" },
    })).rejects.toBe(otherConstraint);
    expect(failedHarness.calls.filter((call) => call.operation === "insert" && call.method === "insert"))
      .toHaveLength(1);
  });
});
