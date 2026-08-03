import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { buildInviteOnboardingTextDocument } from "../routes/access.js";
import { resolveRequestAuthority } from "../http/request-authority.js";

function buildReq(host: string): Request {
  const req = {
    protocol: "http",
    headers: { host },
    socket: { remoteAddress: "127.0.0.1" },
    header(name: string) {
      if (name.toLowerCase() === "host") return host;
      return undefined;
    },
  } as unknown as Request;
  resolveRequestAuthority(req, () => false);
  return req;
}

describe("buildInviteOnboardingTextDocument", () => {
  it("renders a plain-text onboarding doc with expected endpoint references", () => {
    const req = buildReq("localhost:3100");
    const invite = {
      id: "invite-1",
      companyId: "company-1",
      inviteType: "company_join",
      source: "board_api",
      allowedJoinTypes: "agent",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date("2026-03-05T00:00:00.000Z"),
      invitedByUserId: "board-user",
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
      updatedAt: new Date("2026-03-04T00:00:00.000Z"),
    } as const;

    const text = buildInviteOnboardingTextDocument(
      req,
      "token-123",
      invite as any,
      {},
    );

    expect(text).toContain("Paperclip Agent Onboarding");
    expect(text).toContain("/api/invites/token-123/accept");
    expect(text).not.toContain("claim-api-key");
    expect(text).toContain("/api/invites/token-123/onboarding.txt");
    expect(text).not.toContain("/skills/");
    expect(text).not.toContain("Suggested Paperclip base URLs");
    expect(text).not.toContain("host.docker.internal");
    expect(text).not.toContain("Connectivity");
    expect(text).not.toContain("paperclipApiUrl");
    expect(text).toContain("run-scoped compiled tool interface");
    expect(text).not.toContain("PAPERCLIP_API_KEY");
    expect(text).not.toContain("PAPERCLIP_API_URL");
    expect(text).toContain("agent-configuration proposal");
    expect(text).toContain("existing Paperclip worker");
  });

  it("includes inviter message in the onboarding text when provided", () => {
    const req = buildReq("localhost:3100");
    const invite = {
      id: "invite-3",
      companyId: "company-1",
      inviteType: "company_join",
      source: "board_api",
      allowedJoinTypes: "agent",
      tokenHash: "hash",
      defaultsPayload: {
        agentMessage: "Please join as our QA lead and prioritize flaky test triage first.",
      },
      expiresAt: new Date("2026-03-05T00:00:00.000Z"),
      invitedByUserId: "board-user",
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
      updatedAt: new Date("2026-03-04T00:00:00.000Z"),
    } as const;

    const text = buildInviteOnboardingTextDocument(
      req,
      "token-789",
      invite as any,
      {},
    );

    expect(text).toContain("Message from inviter");
    expect(text).toContain("prioritize flaky test triage first");
  });
});
// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: PAPERCLIP_API_KEY, PAPERCLIP_API_URL
