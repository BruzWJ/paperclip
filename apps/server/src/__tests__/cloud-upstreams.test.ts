import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import {
  cloudUpstreamRemoteFailureReport,
  cloudUpstreamService,
  reconcileCloudUpstreamRunsOnStartup,
  sealCloudUpstreamCredential,
  unsealCloudUpstreamCredential,
} from "../services/cloud-upstreams.js";
import { createMockDb, type MockDbHarness } from "./helpers/mock-db.js";

const ordinaryIssues = { create: vi.fn() } as never;
const companyId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000010";
const runId = "00000000-0000-4000-8000-000000000020";
const now = new Date("2026-05-22T13:00:00.000Z");
const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cloudConnectionRow(overrides: Record<string, unknown> = {}) {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    id: connectionId,
    companyId,
    remoteUrl: "https://cloud.example.test",
    sourceInstanceId: "source-1",
    sourceInstanceFingerprint: "sha256:test",
    sourcePublicKey: "public-key",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    tokenStatus: "connected",
    scopes: ["upstream_import:write"],
    authorizedGlobalUserId: "user-1",
    accessToken: "legacy-token",
    tokenId: "token-1",
    tokenExpiresAt: null,
    targetStackId: "stack-1",
    targetStackSlug: null,
    targetStackDisplayName: null,
    targetCompanyId: "cloud-company-1",
    targetOrigin: "https://cloud.example.test",
    targetPrimaryHost: "cloud.example.test",
    targetProduct: "Paperclip Cloud",
    targetSchemaMajor: 1,
    targetMaxChunkBytes: 8192,
    pendingState: null,
    pendingCodeVerifier: null,
    pendingRedirectUri: null,
    pendingTokenUrl: null,
    lastRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function cloudRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    connectionId,
    companyId,
    remoteRunId: "remote-run-1",
    status: "running",
    activeStep: "push",
    progressPercent: 45,
    dryRun: false,
    retryOfRunId: null,
    summary: [],
    warnings: [],
    conflicts: [],
    events: [],
    report: {},
    idempotencyKey: `key-${runId}`,
    manifestHash: "sha256:test",
    targetUrl: "https://cloud.example.test",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

function latestCallArgument(harness: MockDbHarness, operation: "insert" | "update", method: "values" | "set") {
  return [...harness.calls]
    .reverse()
    .find((call) => call.operation === operation && call.method === method)?.args[0] as Record<string, unknown>;
}

describe("cloud upstream service", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "12345678901234567890123456789012";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
  });

  it("preserves the cloud response body and message on run reports", () => {
    const body = {
      error: "bad_request",
      message: "entities[42].body must be an object",
      errors: [{ path: "entities[42].body" }],
    };

    expect(cloudUpstreamRemoteFailureReport(new HttpError(400, "bad_request", body))).toEqual({
      error: "bad_request",
      errorMessage: "entities[42].body must be an object",
      details: body,
    });
  });

  it("falls back to the thrown error message for non-remote failures", () => {
    expect(cloudUpstreamRemoteFailureReport(new Error("network failed"))).toEqual({
      error: "network failed",
    });
  });

  it("encrypts credential envelopes and preserves legacy plaintext reads", async () => {
    const sealed = await sealCloudUpstreamCredential("cloud-access-token");

    expect(sealed).toMatch(/^paperclip-cloud-credential:/);
    expect(sealed).not.toContain("cloud-access-token");
    await expect(unsealCloudUpstreamCredential(sealed)).resolves.toBe("cloud-access-token");
    await expect(unsealCloudUpstreamCredential("legacy-plaintext-token")).resolves.toBe("legacy-plaintext-token");
  });

  it("keeps connect and token exchange usable while only writing encrypted credentials", async () => {
    let harness!: MockDbHarness;
    let pending: ReturnType<typeof cloudConnectionRow> | undefined;
    harness = createMockDb({
      select: [[{ id: companyId }], () => [pending]],
      insert: [() => {
        const values = latestCallArgument(harness, "insert", "values");
        pending = cloudConnectionRow({
          ...values,
          id: values.id,
          tokenStatus: "pending",
          authorizedGlobalUserId: null,
          accessToken: null,
          tokenId: null,
          createdAt: now,
          updatedAt: now,
        });
        return [pending];
      }],
      update: [() => {
        const patch = latestCallArgument(harness, "update", "set");
        return [{ ...pending, ...patch, updatedAt: now }];
      }],
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://cloud.example.test/.well-known/paperclip-upstream")) {
        return jsonResponse({
          product: "Paperclip Cloud",
          stack: {
            id: "stack-1",
            companyId: "cloud-company-1",
            origin: "https://cloud.example.test",
            primaryHost: "cloud.example.test",
          },
          transfer: { supportedSchemaMajor: 1, maxChunkBytes: 8192 },
          auth: {
            scopes: ["upstream_import:write"],
            pkce: {
              authorizeUrl: "https://cloud.example.test/oauth/authorize",
              tokenUrl: "https://cloud.example.test/oauth/token",
            },
          },
        });
      }
      if (url === "https://cloud.example.test/oauth/token" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as { codeVerifier: string };
        expect(payload.codeVerifier).not.toContain("paperclip-cloud-credential:");
        return jsonResponse({
          accessToken: "cloud-access-token",
          token: { id: "token-1", expiresAt: now.toISOString(), globalUserId: "user-1" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const service = cloudUpstreamService(harness.db, ordinaryIssues, { instanceId: "test" });

    const started = await service.startConnect({
      companyId,
      remoteUrl: "https://cloud.example.test",
      redirectUri: "http://localhost:3100/callback",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    const finished = await service.finishConnect({
      pendingConnectionId: started.pendingConnectionId,
      code: "auth-code",
      state,
    });

    const inserted = harness.calls.find((call) => call.operation === "insert" && call.method === "values")?.args[0] as Record<string, unknown>;
    const updated = harness.calls.find((call) => call.operation === "update" && call.method === "set")?.args[0] as Record<string, unknown>;
    expect(inserted.privateKeyPem).toMatch(/^paperclip-cloud-credential:/);
    expect(inserted.privateKeyPem).not.toContain("BEGIN PRIVATE KEY");
    expect(inserted.pendingCodeVerifier).toMatch(/^paperclip-cloud-credential:/);
    expect(updated.accessToken).toMatch(/^paperclip-cloud-credential:/);
    expect(updated.accessToken).not.toContain("cloud-access-token");
    expect(finished).toMatchObject({ id: started.pendingConnectionId, tokenStatus: "connected" });
    expect(harness.remaining("select")).toBe(0);
  });

  it("marks every orphaned running run failed during startup reconciliation", async () => {
    const running = cloudRunRow({
      events: [{ timestamp: "2026-05-22T12:00:00.000Z", step: "push", status: "updated", message: "Uploading" }],
      report: { retained: true },
    });
    const harness = createMockDb({ select: [[running]], update: [[]] });

    await expect(reconcileCloudUpstreamRunsOnStartup(harness.db, now)).resolves.toEqual({ reconciled: 1 });

    const patch = latestCallArgument(harness, "update", "set");
    expect(patch).toMatchObject({
      status: "failed",
      progressPercent: 100,
      completedAt: now,
      report: {
        retained: true,
        error: "orphaned_running_run",
        reconciledAt: now.toISOString(),
      },
    });
    expect(patch.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "failed", message: expect.stringContaining("server startup") }),
    ]));
  });

  it("rejects a new run when its connection already has a running run", async () => {
    const harness = createMockDb({
      select: [[cloudConnectionRow()], [{ id: runId }]],
    });

    await expect(cloudUpstreamService(harness.db, ordinaryIssues).createRun({
      connectionId,
      companyId,
    })).rejects.toMatchObject({
      status: 409,
      details: { runId },
    });
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
  });

  it("cancels a running remote run without invoking apply", async () => {
    const running = cloudRunRow();
    const connection = cloudConnectionRow();
    let harness!: MockDbHarness;
    harness = createMockDb({
      select: [[running], [connection]],
      update: [() => {
        const patch = latestCallArgument(harness, "update", "set");
        return [{ ...running, ...patch }];
      }],
    });
    const remotePaths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      remotePaths.push(new URL(String(input)).pathname);
      return jsonResponse({ ok: true });
    });

    const cancelled = await cloudUpstreamService(harness.db, ordinaryIssues)
      .cancelRun(connectionId, runId, companyId);

    expect(cancelled.status).toBe("cancelled");
    expect(remotePaths).toEqual([`/api/upstream-import-runs/${running.remoteRunId}/cancel`]);
    expect(remotePaths.some((path) => path.endsWith("/apply"))).toBe(false);
    expect(latestCallArgument(harness, "update", "set")).toMatchObject({
      status: "cancelled",
      progressPercent: 100,
    });
  });
});
