import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SMOKE_LAB_OAUTH_SCOPE,
  smokeLabService,
} from "../services/smoke-lab.js";
import { createMockDb } from "./helpers/mock-db.js";

const settings = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => settings),
}));

const companyId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-08-01T12:00:00.000Z");

function runningRun() {
  return {
    id: runId,
    companyId,
    trigger: "manual",
    status: "running",
    startedAt: now,
    finishedAt: null,
    summary: { scenario: "P1" },
    createdAt: now,
    updatedAt: now,
  };
}

function recordedStep() {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    companyId,
    runId,
    path: "P1",
    scenarioStep: "oauth-login",
    status: "pass",
    detail: "OAuth login completed",
    screenshotArtifactRef: null,
    durationMs: 42,
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.getExperimental.mockResolvedValue({ enableSmokeLab: true });
});

describe("smoke lab gate and deterministic OAuth", () => {
  it("gates the lab by the experimental flag and deployment exposure", async () => {
    const harness = createMockDb();
    settings.getExperimental.mockResolvedValueOnce({ enableSmokeLab: false });
    await expect(
      smokeLabService(harness.db, { deploymentExposure: "private" }).assertEnabled(),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      smokeLabService(harness.db, { deploymentExposure: "public" }).assertEnabled(),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      smokeLabService(harness.db, {
        deploymentExposure: "private",
        nodeEnv: "production",
      }).assertEnabled(),
    ).resolves.toBeUndefined();
    expect(harness.calls).toEqual([]);
  });

  it("runs the stable code, refresh, userinfo, and revoke flow", () => {
    const harness = createMockDb();
    const service = smokeLabService(harness.db);
    const redirectUri = "http://127.0.0.1/callback";
    const authorizeInput = {
      companyId,
      clientId: "smoke-client",
      redirectUri,
      state: "state-1",
      scope: SMOKE_LAB_OAUTH_SCOPE,
      email: "smoke@paperclip.test",
      password: "smoke-password",
      requestOrigin: "http://paperclip-dev",
    };

    expect(service.oauthAuthorizePage({
      ...authorizeInput,
      responseType: "code",
    })).toContain("SMOKE TEST - not a real provider");

    const firstLocation = new URL(service.completeAuthorize(authorizeInput));
    const code = firstLocation.searchParams.get("code");
    expect(code).toMatch(/^smoke_code_/);
    expect(firstLocation.searchParams.get("state")).toBe("state-1");

    const token = service.issueToken({
      companyId,
      grantType: "authorization_code",
      code: code!,
      clientId: "smoke-client",
      redirectUri,
    });
    const repeatedLocation = new URL(service.completeAuthorize(authorizeInput));
    expect(repeatedLocation.searchParams.get("code")).toBe(code);
    const repeatedToken = service.issueToken({
      companyId,
      grantType: "authorization_code",
      code: code!,
      clientId: "smoke-client",
      redirectUri,
    });
    expect(repeatedToken).toEqual(token);
    expect(token).toMatchObject({
      access_token: expect.stringMatching(/^smoke_access_/),
      refresh_token: expect.stringMatching(/^smoke_refresh_/),
      scope: SMOKE_LAB_OAUTH_SCOPE,
    });

    const refreshed = service.issueToken({
      companyId,
      grantType: "refresh_token",
      refreshToken: token.refresh_token,
    });
    expect(service.userinfo({
      companyId,
      authorization: `Bearer ${refreshed.access_token}`,
    })).toMatchObject({
      sub: "smoke-user-1",
      email: "smoke@paperclip.test",
    });
    expect(service.revoke({ companyId, token: refreshed.access_token })).toEqual({
      revoked: true,
    });
    expect(() => service.userinfo({
      companyId,
      authorization: `Bearer ${refreshed.access_token}`,
    })).toThrow();
    expect(harness.calls).toEqual([]);
  });

  it("rejects vendor scopes and redirects outside loopback or the trusted origin", () => {
    const service = smokeLabService(createMockDb().db);
    expect(() => service.oauthAuthorizePage({
      companyId,
      clientId: "smoke-client",
      redirectUri: "http://127.0.0.1/callback",
      scope: "repo user:email offline_access",
      responseType: "code",
    })).toThrow("Smoke OAuth only supports fixture scopes");
    expect(() => service.oauthAuthorizePage({
      companyId,
      clientId: "smoke-client",
      redirectUri: "http://other-host/callback",
      responseType: "code",
      requestOrigin: "http://paperclip-dev",
    })).toThrow("must stay on this instance or loopback");
    expect(() => service.oauthAuthorizePage({
      companyId,
      clientId: "smoke-client",
      redirectUri: "ftp://localhost/callback",
      responseType: "code",
    })).toThrow("must use http or https");
    expect(service.oauthAuthorizePage({
      companyId,
      clientId: "smoke-client",
      redirectUri: "http://paperclip-dev/callback",
      responseType: "code",
      requestOrigin: "http://paperclip-dev",
    })).toContain("Paperclip Smoke OAuth");
  });
});

describe("smoke lab run ledger", () => {
  it("records, reads, and terminalizes a run through explicit persistence calls", async () => {
    const initial = runningRun();
    const step = recordedStep();
    const terminal = {
      ...initial,
      status: "passed",
      summary: { totalSteps: 1, passedSteps: 1 },
      finishedAt: now,
    };
    const harness = createMockDb({
      select: [[initial], [step], [initial], [step], [initial], [terminal]],
      insert: [[initial], [step]],
      update: [[], [terminal]],
    });
    const service = smokeLabService(harness.db);

    await expect(service.createRun(companyId, {
      trigger: "manual",
      summary: { scenario: "P1" },
    })).resolves.toMatchObject({ id: runId, status: "running" });

    await expect(service.recordStep(companyId, runId, {
      path: "P1",
      scenarioStep: "oauth-login",
      status: "pass",
      detail: "OAuth login completed",
      durationMs: 42,
    })).resolves.toMatchObject({
      step: { id: step.id, status: "pass" },
      summary: {
        totalSteps: 1,
        passedSteps: 1,
        failedSteps: 0,
        skippedSteps: 0,
      },
    });

    await expect(service.getRun(companyId, runId)).resolves.toMatchObject({
      run: { id: runId },
      steps: [{ id: step.id }],
    });
    await expect(service.updateRun(companyId, runId, {
      status: "passed",
      summary: { totalSteps: 1, passedSteps: 1 },
    })).resolves.toMatchObject({ id: runId, status: "passed" });
    await expect(service.recordStep(companyId, runId, {
      path: "P1",
      scenarioStep: "late",
      status: "pass",
    })).rejects.toMatchObject({ status: 409 });

    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });
});
