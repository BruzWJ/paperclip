import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createRequest,
  isJsonRpcSuccessResponse,
  parseMessage,
  serializeMessage,
} from "../../../packages/plugins/sdk/src/protocol.js";
import { definePlugin } from "../../../packages/plugins/sdk/src/define-plugin.js";
import { startWorkerRpcHost } from "../../../packages/plugins/sdk/src/worker-rpc-host.js";
import { pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

const baseManifest: PaperclipPluginManifestV1 = {
  id: "test.environment-driver",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Environment Driver",
  description: "Test environment driver plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "dist/worker.js" },
  environmentDrivers: [
    {
      driverKey: "fake-plugin",
      displayName: "Fake plugin",
      supportsInteractiveSetup: true,
      interactiveSetupConnectionTypes: ["ssh"],
      supportsTemplateCapture: true,
      templateRefKind: "snapshot",
      supportsTemplateDelete: true,
      configSchema: {
        type: "object",
        properties: {
          template: { type: "string" },
        },
        required: ["template"],
      },
    },
  ],
};

describe("plugin environment driver seam", () => {
  it("validates environment driver manifest declarations", () => {
    expect(pluginManifestV1Schema.safeParse(baseManifest).success).toBe(true);

    const missingCapability = pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: ["http.outbound"],
    });
    expect(missingCapability.success).toBe(false);
    expect(JSON.stringify(missingCapability.error?.issues)).toContain(
      "environment.drivers.register",
    );

    const duplicateDriver = pluginManifestV1Schema.safeParse({
      ...baseManifest,
      environmentDrivers: [
        baseManifest.environmentDrivers![0],
        { ...baseManifest.environmentDrivers![0], displayName: "Duplicate" },
      ],
    });
    expect(duplicateDriver.success).toBe(false);
    expect(JSON.stringify(duplicateDriver.error?.issues)).toContain(
      "Duplicate environment driver keys",
    );
  });

  it("enforces environment driver capability requirements", () => {
    const validator = pluginCapabilityValidator();
    expect(validator.getRequiredCapabilities("environment.acquireLease")).toEqual([
      "environment.drivers.register",
    ]);
    expect(validator.getRequiredCapabilities("environment.captureTemplate")).toEqual([
      "environment.drivers.register",
    ]);
    expect(validator.checkOperation(baseManifest, "environment.execute").allowed).toBe(true);

    const withoutCapability = {
      ...baseManifest,
      capabilities: ["http.outbound"],
    } satisfies PaperclipPluginManifestV1;

    expect(validator.checkOperation(withoutCapability, "environment.execute")).toMatchObject({
      allowed: false,
      missing: ["environment.drivers.register"],
    });
    expect(validator.validateManifestCapabilities(withoutCapability)).toMatchObject({
      allowed: false,
      missing: ["environment.drivers.register"],
    });
  });

  it("dispatches the execution lifecycle and reports exact worker support", async () => {
    const plugin = definePlugin({
      async setup() {},
      async onEnvironmentProbe(params) {
        return {
          ok: true,
          summary: `probed ${params.driverKey}`,
          metadata: { environmentId: params.environmentId },
        };
      },
      async onEnvironmentStartInteractiveSetup(params) {
        return {
          providerLeaseId: `setup-${params.sessionId}`,
          status: "waiting_for_user",
          connectionSummary: {
            type: "ssh",
            username: "sandbox",
            hostRedacted: true,
            portRedacted: true,
          },
          connectionPayload: null,
          metadata: { environmentId: params.environmentId },
        };
      },
      async onEnvironmentAcquireLease(params) {
        return {
          providerLeaseId: `lease-${params.runId}`,
          metadata: { remoteCwd: "/plugin/workspace" },
        };
      },
      async onEnvironmentReleaseLease() {},
      async onEnvironmentRealizeWorkspace() {
        return {
          cwd: "/plugin/workspace",
          metadata: { realized: true },
        };
      },
      async onEnvironmentExecute(params) {
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: `${params.executionId}:${params.command}`,
          stderr: "",
        };
      },
      async onEnvironmentCancelExecution(params) {
        return {
          executionId: params.executionId,
          cancelled: true,
        };
      },
      async onEnvironmentSyncIn(params) {
        return {
          operations: params.operations.map((operation) => ({
            operationId: operation.operationId,
            filesTransferred: operation.files.length,
            bytesTransferred: 1,
          })),
        };
      },
      async onEnvironmentSyncOut(params) {
        return {
          operations: params.operations.map((operation) => ({
            operationId: operation.operationId,
            filesTransferred: operation.files.length,
            bytesTransferred: 1,
          })),
        };
      },
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startWorkerRpcHost({ plugin, stdin, stdout });
    const responses: unknown[] = [];
    stdout.on("data", (chunk) => {
      const lines = String(chunk).split("\n").filter(Boolean);
      for (const line of lines) {
        responses.push(parseMessage(line));
      }
    });

    stdin.write(serializeMessage(createRequest("initialize", {
      manifest: baseManifest,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
    }, 1)));
    await waitForResponses(responses, 1);

    const initializeResponse = responses[0];
    expect(isJsonRpcSuccessResponse(initializeResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(initializeResponse)) return;
    expect(initializeResponse.result.supportedMethods).toContain("environmentProbe");
    expect(initializeResponse.result.supportedMethods).toContain("environmentStartInteractiveSetup");
    expect(initializeResponse.result.supportedMethods).toEqual(
      expect.arrayContaining([
        "environmentAcquireLease",
        "environmentReleaseLease",
        "environmentRealizeWorkspace",
        "environmentExecute",
        "environmentCancelExecution",
        "environmentSyncIn",
        "environmentSyncOut",
      ]),
    );

    stdin.write(serializeMessage(createRequest("environmentProbe", {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "environment-1",
      config: { template: "base" },
    }, 2)));
    await waitForResponses(responses, 2);

    const probeResponse = responses[1];
    expect(isJsonRpcSuccessResponse(probeResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(probeResponse)) return;
    expect(probeResponse.result).toMatchObject({
      ok: true,
      summary: "probed fake-plugin",
      metadata: { environmentId: "environment-1" },
    });

    stdin.write(serializeMessage(createRequest("environmentStartInteractiveSetup", {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "environment-1",
      sessionId: "session-1",
      config: { template: "base" },
    }, 3)));
    await waitForResponses(responses, 3);

    const setupResponse = responses[2];
    expect(isJsonRpcSuccessResponse(setupResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(setupResponse)) return;
    expect(setupResponse.result).toMatchObject({
      providerLeaseId: "setup-session-1",
      status: "waiting_for_user",
      connectionSummary: {
        type: "ssh",
        hostRedacted: true,
        portRedacted: true,
      },
    });

    stdin.write(serializeMessage(createRequest("environmentAcquireLease", {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "environment-1",
      config: { template: "base" },
      runId: "productive-run-1",
      workspaceMode: "isolated",
      executionWorkspaceId: "workspace-1",
      adapterType: "codex",
    }, 4)));
    await waitForResponses(responses, 4);

    const acquireResponse = responses[3];
    expect(isJsonRpcSuccessResponse(acquireResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(acquireResponse)) return;
    expect(acquireResponse.result).toMatchObject({
      providerLeaseId: "lease-productive-run-1",
      metadata: { remoteCwd: "/plugin/workspace" },
    });

    stdin.write(serializeMessage(createRequest("environmentRealizeWorkspace", {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "environment-1",
      config: { template: "base" },
      lease: { providerLeaseId: "lease-productive-run-1" },
      workspace: {
        localPath: "/host/workspace",
        mode: "isolated",
      },
    }, 5)));
    await waitForResponses(responses, 5);

    const realizeResponse = responses[4];
    expect(isJsonRpcSuccessResponse(realizeResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(realizeResponse)) return;
    expect(realizeResponse.result).toEqual({
      cwd: "/plugin/workspace",
      metadata: { realized: true },
    });

    stdin.write(serializeMessage(createRequest("environmentExecute", {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "environment-1",
      config: { template: "base" },
      lease: { providerLeaseId: "lease-productive-run-1" },
      executionId: "productive-attempt-1",
      command: "echo",
      cwd: "/plugin/workspace",
    }, 6)));
    await waitForResponses(responses, 6);

    const executeResponse = responses[5];
    expect(isJsonRpcSuccessResponse(executeResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(executeResponse)) return;
    expect(executeResponse.result).toMatchObject({
      exitCode: 0,
      stdout: "productive-attempt-1:echo",
    });

    stdin.write(serializeMessage(createRequest("environmentCancelExecution", {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "environment-1",
      config: { template: "base" },
      lease: { providerLeaseId: "lease-productive-run-1" },
      executionId: "productive-attempt-1",
      reason: "operator cancelled",
    }, 7)));
    await waitForResponses(responses, 7);

    const cancelResponse = responses[6];
    expect(isJsonRpcSuccessResponse(cancelResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(cancelResponse)) return;
    expect(cancelResponse.result).toEqual({
      executionId: "productive-attempt-1",
      cancelled: true,
    });

    const syncParams = {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "environment-1",
      config: { template: "base" },
      lease: { providerLeaseId: "lease-productive-run-1" },
      operations: [
        {
          operationId: "workspace-sync",
          files: [
            {
              sourcePath: "/source",
              targetPath: "/target",
              kind: "directory" as const,
            },
          ],
        },
      ],
    };
    stdin.write(serializeMessage(createRequest(
      "environmentSyncIn",
      syncParams,
      8,
    )));
    stdin.write(serializeMessage(createRequest(
      "environmentSyncOut",
      syncParams,
      9,
    )));
    await waitForResponses(responses, 9);

    for (const response of responses.slice(7, 9)) {
      expect(isJsonRpcSuccessResponse(response)).toBe(true);
      if (!isJsonRpcSuccessResponse(response)) continue;
      expect(response.result.operations).toEqual([
        {
          operationId: "workspace-sync",
          filesTransferred: 1,
          bytesTransferred: 1,
        },
      ]);
    }

    stdin.write(serializeMessage(createRequest(
      "environmentReleaseLease",
      {
        driverKey: "fake-plugin",
        companyId: "company-1",
        environmentId: "environment-1",
        config: { template: "base" },
        providerLeaseId: "lease-productive-run-1",
      },
      10,
    )));
    await waitForResponses(responses, 10);
    expect(
      isJsonRpcSuccessResponse(responses[9]),
    ).toBe(true);

    host.stop();
  });
});

const objectReferenceManifest: PaperclipPluginManifestV1 = {
  id: "test.external-object-provider",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "External Object Provider",
  description: "Test external object provider plugin",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: ["external.objects.detect", "external.objects.read"],
  entrypoints: { worker: "dist/worker.js" },
  objectReferences: [
    {
      providerKey: "mocktracker",
      displayName: "Mock Tracker",
      objectTypes: ["ticket"],
      urlPatterns: ["https://mock.example/tickets/:id"],
      refreshPolicy: { defaultTtlSeconds: 300, staleAfterSeconds: 1800 },
    },
  ],
};

describe("plugin external object provider seam", () => {
  it("validates provider manifest declarations and capabilities", () => {
    expect(pluginManifestV1Schema.safeParse(objectReferenceManifest).success).toBe(true);

    const missingCapability = pluginManifestV1Schema.safeParse({
      ...objectReferenceManifest,
      capabilities: ["external.objects.detect"],
    });
    expect(missingCapability.success).toBe(false);
    expect(JSON.stringify(missingCapability.error?.issues)).toContain("external.objects.read");

    const duplicateProvider = pluginManifestV1Schema.safeParse({
      ...objectReferenceManifest,
      objectReferences: [
        objectReferenceManifest.objectReferences![0],
        { ...objectReferenceManifest.objectReferences![0], displayName: "Duplicate" },
      ],
    });
    expect(duplicateProvider.success).toBe(false);
    expect(JSON.stringify(duplicateProvider.error?.issues)).toContain(
      "Duplicate object reference provider keys",
    );
  });

  it("enforces provider capability requirements", () => {
    const validator = pluginCapabilityValidator();
    expect(validator.getRequiredCapabilities("external.objects.detect")).toEqual([
      "external.objects.detect",
    ]);
    expect(validator.getRequiredCapabilities("external.objects.read")).toEqual([
      "external.objects.read",
    ]);
    expect(validator.checkOperation(objectReferenceManifest, "external.objects.read").allowed).toBe(true);

    const withoutCapability = {
      ...objectReferenceManifest,
      capabilities: ["external.objects.detect"],
    } satisfies PaperclipPluginManifestV1;

    expect(validator.checkOperation(withoutCapability, "external.objects.read")).toMatchObject({
      allowed: false,
      missing: ["external.objects.read"],
    });
    expect(validator.validateManifestCapabilities(withoutCapability)).toMatchObject({
      allowed: false,
      missing: ["external.objects.read"],
    });
  });

  it("dispatches provider detection and resolution worker hooks", async () => {
    const plugin = definePlugin({
      async setup() {},
      async onDetectExternalObjects(params) {
        return {
          detections: params.urls.map((url) => ({
            urlIdentityHash: url.canonicalIdentityHash,
            providerKey: "mocktracker",
            objectType: "ticket",
            externalId: "MOCK-123",
            displayTitle: "Mock ticket",
            confidence: "exact",
          })),
        };
      },
      async onResolveExternalObject(params) {
        return {
          ok: true,
          snapshot: {
            displayTitle: `Resolved ${params.externalId}`,
            statusKey: "ready",
            statusLabel: "Ready",
            statusCategory: "succeeded",
            statusTone: "success",
            isTerminal: true,
            ttlSeconds: 600,
          },
        };
      },
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startWorkerRpcHost({ plugin, stdin, stdout });
    const responses: unknown[] = [];
    stdout.on("data", (chunk) => {
      const lines = String(chunk).split("\n").filter(Boolean);
      for (const line of lines) {
        responses.push(parseMessage(line));
      }
    });

    stdin.write(serializeMessage(createRequest("initialize", {
      manifest: objectReferenceManifest,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
    }, 1)));
    await waitForResponses(responses, 1);

    const initializeResponse = responses[0];
    expect(isJsonRpcSuccessResponse(initializeResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(initializeResponse)) return;
    expect(initializeResponse.result.supportedMethods).toContain("detectExternalObjects");
    expect(initializeResponse.result.supportedMethods).toContain("resolveExternalObject");

    stdin.write(serializeMessage(createRequest("detectExternalObjects", {
      companyId: "company-1",
      urls: [{
        sanitizedCanonicalUrl: "https://mock.example/tickets/123",
        sanitizedDisplayUrl: "https://mock.example/tickets/123",
        canonicalIdentityHash: "hash-123",
        canonicalIdentity: { scheme: "https", host: "mock.example", path: "/tickets/123" },
        redactedMatchedText: "https://mock.example/tickets/123",
      }],
      sourceContext: {
        companyId: "company-1",
        sourceIssueId: "issue-1",
        sourceKind: "description",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
      },
    }, 2)));
    await waitForResponses(responses, 2);

    const detectResponse = responses[1];
    expect(isJsonRpcSuccessResponse(detectResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(detectResponse)) return;
    expect(detectResponse.result.detections[0]).toMatchObject({
      providerKey: "mocktracker",
      objectType: "ticket",
      externalId: "MOCK-123",
    });

    stdin.write(serializeMessage(createRequest("resolveExternalObject", {
      companyId: "company-1",
      providerKey: "mocktracker",
      objectType: "ticket",
      externalId: "MOCK-123",
      object: {
        id: "object-1",
        companyId: "company-1",
        providerKey: "mocktracker",
        objectType: "ticket",
        externalId: "MOCK-123",
        sanitizedCanonicalUrl: "https://mock.example/tickets/123",
        canonicalIdentityHash: "hash-123",
        displayTitle: "Mock ticket",
        statusKey: null,
        statusLabel: null,
        statusCategory: "unknown",
        statusTone: "neutral",
        liveness: "unknown",
        isTerminal: false,
        data: {},
        remoteVersion: null,
        etag: null,
      },
    }, 3)));
    await waitForResponses(responses, 3);

    const resolveResponse = responses[2];
    expect(isJsonRpcSuccessResponse(resolveResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(resolveResponse)) return;
    expect(resolveResponse.result).toMatchObject({
      ok: true,
      snapshot: {
        statusCategory: "succeeded",
        statusTone: "success",
      },
    });

    host.stop();
  });
});

async function waitForResponses(responses: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (responses.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(responses.length).toBeGreaterThanOrEqual(count);
}
