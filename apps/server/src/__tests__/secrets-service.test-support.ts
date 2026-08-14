import {
  mkdtempSync as mkdtempSyncImport,
  existsSync as existsSyncImport,
  rmSync as rmSyncImport,
  statSync as statSyncImport,
} from "node:fs";
import osModule from "node:os";
import pathModule from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  companySecretBindings as companySecretBindingsImport,
  companySecretProviderConfigs as companySecretProviderConfigsImport,
  companySecrets as companySecretsImport,
  companySecretVersions as companySecretVersionsImport,
  userSecretDeclarations as userSecretDeclarationsImport,
  userSecretDefinitions as userSecretDefinitionsImport,
} from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { createLocalEncryptedProvider as createLocalEncryptedProviderImport } from "../secrets/local-encrypted-provider.js";
import {
  SecretProviderClientError as SecretProviderClientErrorImport,
  type SecretProviderModule,
} from "../secrets/types.js";
import {
  requireSecretMutationActor as requireSecretMutationActorImport,
  secretService as createSecretServiceImport,
  type SecretMutationActor,
} from "../services/secrets.js";
import { createMockDb as createMockDbImport } from "./helpers/mock-db.js";
import { testSecretsRuntimeConfig as testSecretsRuntimeConfigImport } from "./helpers/secrets-runtime.js";

export const mkdtempSync = mkdtempSyncImport;
export const existsSync = existsSyncImport;
export const rmSync = rmSyncImport;
export const statSync = statSyncImport;
export const os = osModule;
export const path = pathModule;
export const companySecretBindings = companySecretBindingsImport;
const companySecretProviderConfigs = companySecretProviderConfigsImport;
export const companySecrets = companySecretsImport;
export const companySecretVersions = companySecretVersionsImport;
export const userSecretDeclarations = userSecretDeclarationsImport;
const userSecretDefinitions = userSecretDefinitionsImport;
export const createLocalEncryptedProvider = createLocalEncryptedProviderImport;
export const SecretProviderClientError = SecretProviderClientErrorImport;
export const requireSecretMutationActor = requireSecretMutationActorImport;
const createSecretService = createSecretServiceImport;
export const createMockDb = createMockDbImport;
export const testSecretsRuntimeConfig = testSecretsRuntimeConfigImport;
const secretsRuntime = testSecretsRuntimeConfig();

export function secretService(db: Parameters<typeof createSecretService>[0]) {
  return createSecretService(db, secretsRuntime);
}

const hoistedMocks = vi.hoisted(() => ({
  getSecretProvider: vi.fn(),
  listSecretProviders: vi.fn(),
  checkSecretProviders: vi.fn(),
  authorizationDecide: vi.fn(),
}));
export const mocks = hoistedMocks;

vi.mock("../secrets/provider-registry.js", () => ({
  createSecretProviderRegistry: vi.fn(() => ({
    get: hoistedMocks.getSecretProvider,
    list: hoistedMocks.listSecretProviders,
    check: hoistedMocks.checkSecretProviders,
  })),
}));

vi.mock("../services/authorization.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/authorization.js")>();
  return {
    ...actual,
    authorizationService: vi.fn(() => ({ decide: hoistedMocks.authorizationDecide })),
  };
});

export const SYSTEM_ACTOR = { type: "system" } as const;
export const companyId = "00000000-0000-4000-8000-000000000001";
export const otherCompanyId = "00000000-0000-4000-8000-000000000002";
export const secretId = "00000000-0000-4000-8000-000000000003";
export const bindingId = "00000000-0000-4000-8000-000000000004";
export const providerConfigId = "00000000-0000-4000-8000-000000000005";
export const definitionId = "00000000-0000-4000-8000-000000000006";
export const declarationId = "00000000-0000-4000-8000-000000000007";
export const agentId = "00000000-0000-4000-8000-000000000008";
export const now = new Date("2026-01-02T03:04:05.000Z");

export function preparedVersion(overrides: Record<string, unknown> = {}) {
  return {
    material: { scheme: "test_opaque_v1", ciphertext: "opaque-material" },
    valueSha256: "value-sha256",
    fingerprintSha256: "fingerprint-sha256",
    externalRef: null,
    providerVersionRef: "provider-version-1",
    ...overrides,
  };
}

export function createProviderDouble(id: SecretProvider = "local_encrypted") {
  const provider = {
    id,
    descriptor: vi.fn(() => ({
      id,
      label: id,
      requiresExternalRef: false,
      supportsManagedValues: true,
      supportsExternalReferences: true,
      configured: true,
    })),
    validateConfig: vi.fn(async () => ({ ok: true, warnings: [] })),
    createSecret: vi.fn(async () => preparedVersion()),
    createVersion: vi.fn(async () => preparedVersion()),
    linkExternalSecret: vi.fn(async (input: { externalRef: string; providerVersionRef?: string | null }) =>
      preparedVersion({
        externalRef: input.externalRef,
        providerVersionRef: input.providerVersionRef ?? null,
      }),
    ),
    listRemoteSecrets: vi.fn(async () => ({ secrets: [], nextToken: null })),
    discoverProviderConfigs: vi.fn(async () => ({
      provider: id,
      candidates: [],
      warnings: [],
    })),
    resolveVersion: vi.fn(async () => "runtime-secret"),
    deleteOrArchive: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => ({
      provider: id,
      status: "ok",
      message: "Provider ready",
    })),
  };
  return provider as unknown as SecretProviderModule & typeof provider;
}

type ProviderDouble = ReturnType<typeof createProviderDouble>;
export const providerState = {
  current: createProviderDouble() as ProviderDouble,
};

export function secretRow(overrides: Record<string, unknown> = {}) {
  return {
    id: secretId,
    companyId,
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: "api-key",
    name: "API key",
    provider: "local_encrypted",
    providerConfigId: null,
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    createdByAgentId: null,
    createdByUserId: null,
    lastRotatedAt: now,
    lastResolvedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "version-1",
    secretId,
    version: 1,
    material: { scheme: "test_opaque_v1", ciphertext: "opaque-material" },
    valueSha256: "value-sha256",
    fingerprintSha256: "fingerprint-sha256",
    providerVersionRef: "provider-version-1",
    status: "current",
    revokedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: now,
    ...overrides,
  };
}

export function bindingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: bindingId,
    companyId,
    secretId,
    targetType: "agent",
    targetId: agentId,
    configPath: "env.API_KEY",
    versionSelector: "latest",
    required: true,
    label: null,
    projectionClass: "unclassified",
    projectionAllowlistKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function providerConfigRow(overrides: Record<string, unknown> = {}) {
  return {
    id: providerConfigId,
    companyId,
    provider: "aws_secrets_manager",
    displayName: "AWS production",
    status: "ready",
    isDefault: false,
    config: { region: "us-east-1", namespace: "production" },
    healthStatus: null,
    healthCheckedAt: null,
    healthMessage: null,
    healthDetails: null,
    disabledAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function definitionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: definitionId,
    companyId,
    key: "github_token",
    name: "GitHub token",
    description: null,
    status: "active",
    provider: "local_encrypted",
    providerConfigId: null,
    managedMode: "paperclip_managed",
    providerMetadata: null,
    usageGuidance: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function declarationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: declarationId,
    companyId,
    userSecretDefinitionId: definitionId,
    targetType: "agent",
    targetId: agentId,
    configPath: "env.GITHUB_TOKEN",
    envKey: "GITHUB_TOKEN",
    versionSelector: "latest",
    required: true,
    allowMissingOverride: false,
    label: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function valuesCalls(harness: ReturnType<typeof createMockDb>, operation: "insert" | "update") {
  return harness.calls
    .filter(
      (call) => call.operation === operation && call.method === (operation === "insert" ? "values" : "set"),
    )
    .map((call) => call.args[0]);
}

export function registerSuiteSetup() {
  beforeEach(() => {
    vi.clearAllMocks();
    providerState.current = createProviderDouble();
    mocks.getSecretProvider.mockImplementation(() => providerState.current);
    mocks.listSecretProviders.mockReturnValue([]);
    mocks.checkSecretProviders.mockResolvedValue([]);
    mocks.authorizationDecide.mockResolvedValue({
      allowed: true,
      reason: "allow_board_member",
      explanation: "Allowed",
    });
  });
}

export { describe, expect, it };
export type { SecretMutationActor };
