import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentCustomImageTemplate, SandboxEnvironmentConfig } from "@paperclipai/shared";
import {
  applyCustomImageTemplateToSandboxConfig,
  classifyEnvironmentCustomImageConfigChange,
  defaultEnvironmentCustomImageRuntimeConfigBinding,
  ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS,
  environmentCustomImageTemplateMatchesBaseConfig,
  fingerprintEnvironmentSandboxProviderConfig,
  normalizeEnvironmentCustomImageRuntimeConfigBinding,
  resolveActiveEnvironmentCustomImageTemplateForRuntime,
  resolveEnvironmentCustomImageRuntimeConfigBinding,
} from "../services/environment-custom-image-runtime.js";
import { environmentCustomImageService } from "../services/environment-custom-images.js";
import { createMockDb } from "./helpers/mock-db.js";

const dependencies = vi.hoisted(() => ({
  getEnvironment: vi.fn(),
  bindingCompanies: vi.fn(),
  resolveRuntimeConfig: vi.fn(),
  resolvePluginDriver: vi.fn(),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => ({ getById: dependencies.getEnvironment }),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    listBindingCompanyIdsForTarget: dependencies.bindingCompanies,
  }),
}));

vi.mock("../services/environment-config.js", async () => ({
  ...await vi.importActual<typeof import("../services/environment-config.js")>(
    "../services/environment-config.js",
  ),
  resolveEnvironmentDriverConfigForRuntime: dependencies.resolveRuntimeConfig,
}));

vi.mock("../services/plugin-environment-driver.js", async () => ({
  ...await vi.importActual<typeof import("../services/plugin-environment-driver.js")>(
    "../services/plugin-environment-driver.js",
  ),
  resolvePluginSandboxProviderDriverByKey: dependencies.resolvePluginDriver,
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const environmentId = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-07-30T18:00:00.000Z");
const baseConfig = {
  provider: "fake-plugin",
  image: "ubuntu:24.04",
  region: "us-east",
  timeoutMs: 30_000,
  reuseLease: false,
} as SandboxEnvironmentConfig;

function template(input: Partial<EnvironmentCustomImageTemplate> = {}): EnvironmentCustomImageTemplate {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    environmentId,
    provider: "fake-plugin",
    templateKind: "snapshot",
    templateRef: "snapshot-1",
    sourceTemplateRef: "ubuntu:24.04",
    sourceEnvironmentConfigFingerprint: fingerprintEnvironmentSandboxProviderConfig(baseConfig, {
      excludePaths: ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS,
    }),
    status: "active",
    createdByUserId: "user-1",
    createdByAgentId: null,
    capturedAt: now,
    lastUsedAt: null,
    supersededByTemplateId: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

function templateRow(input: Partial<EnvironmentCustomImageTemplate> = {}) {
  return template(input) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getEnvironment.mockResolvedValue({
    id: environmentId,
    companyId,
    name: "Fake sandbox",
    driver: "sandbox",
    status: "active",
    config: baseConfig,
    envVars: {},
    metadata: null,
    createdAt: now,
    updatedAt: now,
  });
  dependencies.bindingCompanies.mockResolvedValue([companyId]);
  dependencies.resolveRuntimeConfig.mockResolvedValue({
    driver: "sandbox",
    config: baseConfig,
  });
  dependencies.resolvePluginDriver.mockResolvedValue({
    plugin: { id: "plugin-1" },
    driver: {
      driverKey: "fake-plugin",
      supportsInteractiveSetup: true,
      supportsTemplateCapture: true,
      supportsTemplateDelete: true,
      templateRefKind: "snapshot",
      templateConfigBinding: { field: "snapshot", unsetFields: ["image"] },
    },
  });
});

describe("environment custom image runtime contracts", () => {
  it("creates stable fingerprints while explicitly excluding runtime-only and secret fields", () => {
    const left = {
      ...baseConfig,
      timeoutMs: 10_000,
      reuseLease: false,
      credentials: { token: "secret-a" },
    } as SandboxEnvironmentConfig;
    const right = {
      ...baseConfig,
      timeoutMs: 90_000,
      reuseLease: true,
      credentials: { token: "secret-b" },
    } as SandboxEnvironmentConfig;

    expect(fingerprintEnvironmentSandboxProviderConfig(left, {
      excludePaths: [
        ...ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS,
        "credentials.token",
      ],
    })).toBe(fingerprintEnvironmentSandboxProviderConfig(right, {
      excludePaths: [
        ...ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS,
        "credentials.token",
      ],
    }));
    expect(fingerprintEnvironmentSandboxProviderConfig(left)).not.toBe(
      fingerprintEnvironmentSandboxProviderConfig(right),
    );
  });

  it("normalizes provider bindings and falls back to the template-kind binding", () => {
    expect(normalizeEnvironmentCustomImageRuntimeConfigBinding({
      field: "customTemplate",
      unsetFields: ["image", "image", "customTemplate", "provider"],
    })).toEqual({ field: "customTemplate", unsetFields: ["image"] });
    expect(normalizeEnvironmentCustomImageRuntimeConfigBinding({ field: "provider" })).toBeNull();
    expect(defaultEnvironmentCustomImageRuntimeConfigBinding("snapshot")).toEqual({
      field: "snapshot",
      unsetFields: ["image"],
    });
    expect(resolveEnvironmentCustomImageRuntimeConfigBinding({
      templateKind: "image",
      metadata: { runtimeConfigBinding: { field: "customTemplate", unsetFields: ["image"] } },
    })).toEqual({ field: "customTemplate", unsetFields: ["image"] });
  });

  it("applies the captured artifact at the declared field and removes conflicting boot sources", () => {
    expect(applyCustomImageTemplateToSandboxConfig(baseConfig, {
      templateKind: "snapshot",
      templateRef: "snapshot-1",
      metadata: null,
    })).toEqual({
      provider: "fake-plugin",
      snapshot: "snapshot-1",
      region: "us-east",
      timeoutMs: 30_000,
      reuseLease: false,
    });
  });

  it("distinguishes runtime-only, relinkable, and breaking config changes", () => {
    const active = template();
    expect(classifyEnvironmentCustomImageConfigChange({
      template: active,
      previousConfig: baseConfig,
      nextConfig: { ...baseConfig, timeoutMs: 60_000 },
    })).toBe("none");
    expect(classifyEnvironmentCustomImageConfigChange({
      template: active,
      previousConfig: baseConfig,
      nextConfig: { ...baseConfig, region: "us-west" },
    })).toBe("relinkable");
    expect(classifyEnvironmentCustomImageConfigChange({
      template: active,
      previousConfig: baseConfig,
      nextConfig: { ...baseConfig, image: "debian:12" },
    })).toBe("breaking");
  });

  it("matches captures after runtime-only changes but not boot-source changes", () => {
    const active = template();
    expect(environmentCustomImageTemplateMatchesBaseConfig({
      template: active,
      baseConfig: { ...baseConfig, timeoutMs: 120_000, reuseLease: true },
    })).toBe(true);
    expect(environmentCustomImageTemplateMatchesBaseConfig({
      template: active,
      baseConfig: { ...baseConfig, image: "debian:12" },
    })).toBe(false);
  });
});

describe("active custom image resolution", () => {
  it("applies a matching active template and records its use", async () => {
    const active = templateRow();
    const harness = createMockDb({ select: [[active]], update: [[]] });
    const runtimeConfig = { ...baseConfig, timeoutMs: 120_000, reuseLease: true };

    await expect(resolveActiveEnvironmentCustomImageTemplateForRuntime(harness.db, {
      environmentId,
      baseConfig,
      runtimeConfig,
      now,
    })).resolves.toEqual({
      provider: "fake-plugin",
      snapshot: "snapshot-1",
      region: "us-east",
      timeoutMs: 120_000,
      reuseLease: true,
    });
    const updateValue = harness.calls.find(
      (call) => call.operation === "update" && call.method === "set",
    )?.args[0];
    expect(updateValue).toEqual({ lastUsedAt: now, updatedAt: now });
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it("leaves runtime config untouched when no active template exists or the base no longer matches", async () => {
    const missing = createMockDb({ select: [[]] });
    await expect(resolveActiveEnvironmentCustomImageTemplateForRuntime(missing.db, {
      environmentId,
      baseConfig,
      runtimeConfig: baseConfig,
    })).resolves.toBe(baseConfig);
    expect(missing.calls.some((call) => call.operation === "update")).toBe(false);

    const mismatched = createMockDb({ select: [[templateRow()]] });
    const changed = { ...baseConfig, image: "debian:12" } as SandboxEnvironmentConfig;
    await expect(resolveActiveEnvironmentCustomImageTemplateForRuntime(mismatched.db, {
      environmentId,
      baseConfig: changed,
      runtimeConfig: changed,
    })).resolves.toBe(changed);
    expect(mismatched.calls.some((call) => call.operation === "update")).toBe(false);
  });
});

describe("environment custom image setup service", () => {
  it("starts through the plugin boundary and persists only redacted connection metadata", async () => {
    const providerSession = {
      providerLeaseId: "provider-lease-1",
      status: "waiting_for_user",
      connectionSummary: {
        type: "ssh",
        username: "sandbox",
        hostRedacted: true,
        portRedacted: true,
      },
      connectionPayload: {
        type: "ssh",
        command: "ssh sandbox@203.0.113.10",
        expiresAt: now.toISOString(),
      },
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
      metadata: {
        connectUrl: "https://203.0.113.10/setup",
        safeLabel: "setup",
      },
    };
    const workerManager = {
      call: vi.fn(async () => providerSession),
    } as never;
    const persisted = {
      id: "setup-session-1",
      environmentId,
      templateId: null,
      promotedTemplateId: null,
      provider: "fake-plugin",
      providerLeaseId: "provider-lease-1",
      environmentLeaseId: null,
      status: "waiting_for_user",
      startedByUserId: "user-1",
      startedByAgentId: null,
      baseTemplateRef: "ubuntu:24.04",
      expiresAt: new Date(now.getTime() + 600_000),
      finishedAt: null,
      failureReason: null,
      connectionSummary: { type: "ssh", username: null, hostRedacted: true, portRedacted: true },
      connectionSecretRef: null,
      metadata: { connectUrl: "[redacted]", safeLabel: "setup", setupRpcCompanyId: companyId },
      createdAt: now,
      updatedAt: now,
    };
    const harness = createMockDb({
      select: [[], []],
      insert: [[]],
      update: [[persisted]],
    });
    const service = environmentCustomImageService(harness.db, { pluginWorkerManager: workerManager });

    const result = await service.startSetupSession({
      environmentId,
      actor: { userId: "user-1" },
      secretContextCompanyId: companyId,
      ttlSeconds: 600,
      now,
    });

    expect(result.session).toMatchObject({
      environmentId,
      status: "waiting_for_user",
      connectionSummary: { hostRedacted: true, portRedacted: true },
    });
    expect(result.connectionPayload?.command).toContain("203.0.113.10");
    const persistedUpdate = harness.calls.find(
      (call) => call.operation === "update" && call.method === "set",
    )?.args[0] as Record<string, unknown>;
    expect(JSON.stringify(persistedUpdate)).not.toContain("203.0.113.10");
    expect(persistedUpdate.connectionSummary).toEqual({
      type: "ssh",
      username: null,
      hostRedacted: true,
      portRedacted: true,
    });
    expect(workerManager.call).toHaveBeenCalledWith(
      "plugin-1",
      "environmentStartInteractiveSetup",
      expect.objectContaining({
        driverKey: "fake-plugin",
        companyId,
        environmentId,
        sourceTemplateRef: "ubuntu:24.04",
      }),
      expect.any(Number),
    );
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });
});
