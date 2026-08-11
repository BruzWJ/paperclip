import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import {
  SecretProviderClientError,
  type SecretProviderModule,
} from "../secrets/types.js";
import {
  requireSecretMutationActor,
  secretService,
  type SecretMutationActor,
} from "../services/secrets.js";
import { createMockDb } from "./helpers/mock-db.js";

const mocks = vi.hoisted(() => ({
  getSecretProvider: vi.fn(),
  listSecretProviders: vi.fn(),
  checkSecretProviders: vi.fn(),
  authorizationDecide: vi.fn(),
}));

vi.mock("../secrets/provider-registry.js", () => ({
  getSecretProvider: mocks.getSecretProvider,
  listSecretProviders: mocks.listSecretProviders,
  checkSecretProviders: mocks.checkSecretProviders,
}));

vi.mock("../services/authorization.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/authorization.js")>();
  return {
    ...actual,
    authorizationService: vi.fn(() => ({ decide: mocks.authorizationDecide })),
  };
});

const SYSTEM_ACTOR = { type: "system" } as const;
const companyId = "00000000-0000-4000-8000-000000000001";
const otherCompanyId = "00000000-0000-4000-8000-000000000002";
const secretId = "00000000-0000-4000-8000-000000000003";
const bindingId = "00000000-0000-4000-8000-000000000004";
const providerConfigId = "00000000-0000-4000-8000-000000000005";
const definitionId = "00000000-0000-4000-8000-000000000006";
const declarationId = "00000000-0000-4000-8000-000000000007";
const agentId = "00000000-0000-4000-8000-000000000008";
const now = new Date("2026-01-02T03:04:05.000Z");

function preparedVersion(overrides: Record<string, unknown> = {}) {
  return {
    material: { scheme: "test_opaque_v1", ciphertext: "opaque-material" },
    valueSha256: "value-sha256",
    fingerprintSha256: "fingerprint-sha256",
    externalRef: null,
    providerVersionRef: "provider-version-1",
    ...overrides,
  };
}

function createProviderDouble(id: SecretProvider = "local_encrypted") {
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
      })),
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
let provider: ProviderDouble;

function secretRow(overrides: Record<string, unknown> = {}) {
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

function versionRow(overrides: Record<string, unknown> = {}) {
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

function bindingRow(overrides: Record<string, unknown> = {}) {
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

function providerConfigRow(overrides: Record<string, unknown> = {}) {
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

function definitionRow(overrides: Record<string, unknown> = {}) {
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

function declarationRow(overrides: Record<string, unknown> = {}) {
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

function valuesCalls(harness: ReturnType<typeof createMockDb>, operation: "insert" | "update") {
  return harness.calls
    .filter((call) => call.operation === operation && call.method === (operation === "insert" ? "values" : "set"))
    .map((call) => call.args[0]);
}

describe("secretService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider = createProviderDouble();
    mocks.getSecretProvider.mockImplementation(() => provider);
    mocks.listSecretProviders.mockReturnValue([]);
    mocks.checkSecretProviders.mockResolvedValue([]);
    mocks.authorizationDecide.mockResolvedValue({
      allowed: true,
      reason: "allow_board_member",
      explanation: "Allowed",
    });
  });

  it("encrypts and resolves local values with an isolated master-key file", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-secrets-service-"));
    const keyPath = path.join(tempDir, "master.key");
    const previousFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyPath;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;

    try {
      const prepared = await localEncryptedProvider.createSecret({
        value: "local-runtime-secret",
      });
      expect(existsSync(keyPath)).toBe(true);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(prepared.material)).not.toContain("local-runtime-secret");
      await expect(localEncryptedProvider.resolveVersion({
        material: prepared.material,
        externalRef: null,
      })).resolves.toBe("local-runtime-secret");
    } finally {
      if (previousFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousFile;
      if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousKey;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts only exact canonical mutation actors", () => {
    expect(requireSecretMutationActor({ type: "user", userId: "user-1" })).toEqual({
      userId: "user-1",
      agentId: null,
    });
    expect(requireSecretMutationActor({ type: "agent", agentId: "agent-1" })).toEqual({
      userId: null,
      agentId: "agent-1",
    });
    expect(requireSecretMutationActor(SYSTEM_ACTOR)).toEqual({
      userId: null,
      agentId: null,
    });

    for (const actor of [
      undefined,
      { userId: "legacy-user" },
      { agentId: "legacy-agent" },
      { type: "user", userId: "user-1", agentId: "agent-1" },
      { type: "agent", agentId: "agent-1", userId: "user-1" },
      { type: "user", userId: "   " },
      { type: "agent", agentId: "" },
      { type: "system", userId: "wrong" },
      { type: "plugin", actorId: "plugin-1" },
    ]) {
      expect(() => requireSecretMutationActor(actor)).toThrowError(
        expect.objectContaining({
          status: 422,
          details: { code: "invalid_secret_mutation_actor" },
        }),
      );
    }
  });

  it("persists exact user, agent, and system attribution on the secret and first version", async () => {
    const cases: Array<{
      actor: SecretMutationActor;
      userId: string | null;
      agentId: string | null;
    }> = [
      { actor: { type: "user", userId: "secret-operator" }, userId: "secret-operator", agentId: null },
      { actor: { type: "agent", agentId }, userId: null, agentId },
      { actor: SYSTEM_ACTOR, userId: null, agentId: null },
    ];

    for (const [index, entry] of cases.entries()) {
      const reserved = secretRow({ id: `reserved-${index}`, status: "archived", latestVersion: 0 });
      const active = secretRow({ id: reserved.id });
      const harness = createMockDb({
        select: [[], []],
        insert: [[reserved], []],
        update: [[], [], [active]],
      });

      await expect(secretService(harness.db).create(companyId, {
        name: `Actor secret ${index}`,
        provider: "local_encrypted",
        value: "provider-only-value",
      }, entry.actor)).resolves.toEqual(active);

      const [secretValues, versionValues] = valuesCalls(harness, "insert");
      expect(secretValues).toMatchObject({
        createdByUserId: entry.userId,
        createdByAgentId: entry.agentId,
        status: "archived",
        latestVersion: 0,
      });
      expect(versionValues).toMatchObject({
        secretId: reserved.id,
        version: 1,
        createdByUserId: entry.userId,
        createdByAgentId: entry.agentId,
        status: "disabled",
      });
      expect(JSON.stringify([secretValues, versionValues])).not.toContain("provider-only-value");
      expect(harness.remaining("select")).toBe(0);
      expect(harness.remaining("insert")).toBe(0);
      expect(harness.remaining("update")).toBe(0);
    }
  });

  it("links an external provider reference without persisting or resolving plaintext", async () => {
    provider = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => provider);
    const externalRef = "arn:aws:secretsmanager:us-east-1:123456789012:secret:linked";
    const config = providerConfigRow();
    const reserved = secretRow({
      status: "archived",
      latestVersion: 0,
      provider: "aws_secrets_manager",
      providerConfigId,
      managedMode: "external_reference",
    });
    const active = secretRow({
      provider: "aws_secrets_manager",
      providerConfigId,
      managedMode: "external_reference",
      externalRef,
    });
    const harness = createMockDb({
      select: [[], [], [config]],
      insert: [[reserved], []],
      update: [[], [], [active]],
    });

    await expect(secretService(harness.db).create(companyId, {
      name: "Linked AWS secret",
      provider: "aws_secrets_manager",
      providerConfigId,
      managedMode: "external_reference",
      externalRef,
    }, SYSTEM_ACTOR)).resolves.toEqual(active);

    expect(provider.linkExternalSecret).toHaveBeenCalledWith(expect.objectContaining({
      externalRef,
      providerConfig: {
        id: providerConfigId,
        provider: "aws_secrets_manager",
        status: "ready",
        config: config.config,
      },
    }));
    expect(provider.createSecret).not.toHaveBeenCalled();
    expect(provider.resolveVersion).not.toHaveBeenCalled();
    expect(JSON.stringify(valuesCalls(harness, "insert"))).not.toContain("runtime-secret");
  });

  it("sanitizes provider create failures and removes the reserved row", async () => {
    provider = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => provider);
    const rawMessage = "AccessDenied: arn:aws:sts::123456789012:assumed-role/private";
    provider.createSecret.mockRejectedValueOnce(new SecretProviderClientError({
      code: "access_denied",
      provider: "aws_secrets_manager",
      operation: "createSecret",
      message: "AWS Secrets Manager denied the request.",
      rawMessage,
    }));
    const config = providerConfigRow();
    const reserved = secretRow({
      provider: "aws_secrets_manager",
      providerConfigId,
      status: "archived",
      latestVersion: 0,
    });
    const harness = createMockDb({
      select: [[], [], [config]],
      insert: [[reserved]],
      delete: [[]],
    });

    const thrown = await secretService(harness.db).create(companyId, {
      name: "Managed AWS secret",
      key: "managed_aws_secret",
      provider: "aws_secrets_manager",
      providerConfigId,
      value: "provider-only-value",
    }, SYSTEM_ACTOR).then(() => null, (error: unknown) => error);

    expect(thrown).toMatchObject({
      status: 403,
      message: "AWS Secrets Manager denied the request.",
      details: {
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "secret.create",
        providerConfigId,
        region: "us-east-1",
        requiredCapability: "secretsmanager:CreateSecret",
      },
    });
    expect(JSON.stringify(thrown)).not.toContain("arn:aws");
    expect(JSON.stringify(thrown)).not.toContain("provider-only-value");
    expect(harness.calls.find((call) =>
      call.operation === "delete" && call.method === "delete"
    )?.args[0]).toBe(companySecrets);
    expect(harness.remaining("delete")).toBe(0);
  });

  it("cleans provider material and both local rows when prepared-version persistence fails", async () => {
    const reserved = secretRow({ status: "archived", latestVersion: 0 });
    const persistenceFailure = new Error("version persistence failed");
    const harness = createMockDb({
      select: [[], []],
      insert: [[reserved], persistenceFailure],
      update: [[]],
      delete: [[], []],
    });

    await expect(secretService(harness.db).create(companyId, {
      name: "Rollback secret",
      provider: "local_encrypted",
      value: "provider-only-value",
    }, SYSTEM_ACTOR)).rejects.toBe(persistenceFailure);

    expect(provider.deleteOrArchive).toHaveBeenCalledWith(expect.objectContaining({
      mode: "delete",
      externalRef: null,
    }));
    const deletedTables = harness.calls
      .filter((call) => call.operation === "delete" && call.method === "delete")
      .map((call) => call.args[0]);
    expect(deletedTables).toEqual([companySecretVersions, companySecrets]);
  });

  it("rotates into a disabled version before atomically promoting it", async () => {
    provider = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => provider);
    const secret = secretRow({
      provider: "aws_secrets_manager",
      providerConfigId,
      latestVersion: 1,
    });
    const config = providerConfigRow();
    const updated = secretRow({
      provider: "aws_secrets_manager",
      providerConfigId,
      latestVersion: 2,
    });
    const harness = createMockDb({
      select: [[secret], [config]],
      insert: [[]],
      update: [[], [], [updated]],
    });

    await expect(secretService(harness.db).rotate(secretId, {
      value: "rotated-provider-value",
    }, { type: "user", userId: "rotator" })).resolves.toEqual(updated);

    expect(provider.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      value: "rotated-provider-value",
      providerConfig: expect.objectContaining({ id: providerConfigId }),
      context: {
        companyId,
        secretKey: "api-key",
        secretName: "API key",
        version: 2,
      },
    }));
    expect(valuesCalls(harness, "insert")[0]).toMatchObject({
      secretId,
      version: 2,
      status: "disabled",
      createdByUserId: "rotator",
      createdByAgentId: null,
    });
    expect(valuesCalls(harness, "update")).toEqual([
      expect.objectContaining({ status: "previous" }),
      expect.objectContaining({ status: "current" }),
      expect.objectContaining({ latestVersion: 2, providerConfigId }),
    ]);
  });

  it("archives prepared provider material when a new version cannot be persisted", async () => {
    const secret = secretRow();
    const failure = new Error("version insert failed");
    const harness = createMockDb({
      select: [[secret]],
      insert: [failure],
    });

    await expect(secretService(harness.db).rotate(secretId, {
      value: "rotated-provider-value",
    }, SYSTEM_ACTOR)).rejects.toBe(failure);
    expect(provider.deleteOrArchive).toHaveBeenCalledWith(expect.objectContaining({
      mode: "archive",
      context: expect.objectContaining({ version: 2 }),
    }));
  });

  it("rejects inactive secrets and inactive versions before provider resolution", async () => {
    for (const unavailable of [
      { select: [[secretRow({ status: "archived" })]], code: "secret_inactive" },
      { select: [[secretRow()], [versionRow({ status: "disabled" })]], code: "version_inactive" },
      { select: [[secretRow()], [versionRow({ revokedAt: now })]], code: "version_inactive" },
    ]) {
      const harness = createMockDb({ select: unavailable.select });
      await expect(secretService(harness.db).resolveSecretVersion(
        companyId,
        secretId,
        "latest",
      )).rejects.toMatchObject({
        status: 422,
        details: { code: unavailable.code },
      });
    }
    expect(provider.resolveVersion).not.toHaveBeenCalled();
  });

  it("rejects cross-company references during environment normalization", async () => {
    const harness = createMockDb({
      select: [[secretRow({ companyId: otherCompanyId })]],
    });

    await expect(secretService(harness.db).normalizeEnvBindingsForPersistence(companyId, {
      API_KEY: { type: "secret_ref", secretId, version: "latest" },
    })).rejects.toThrow(/same company/i);
    expect(provider.resolveVersion).not.toHaveBeenCalled();
  });

  it("rejects retired access paths and class-3 leases outside the canonical allowlist", async () => {
    const invalidBindings = [
      { configPath: "access.API_KEY" },
      { configPath: "access" },
      { configPath: 'access["x.y"]' },
      {
        configPath: "env.GITHUB_TOKEN",
        projectionClass: "class_3_static_lease" as const,
        projectionAllowlistKey: "not-approved",
      },
    ];

    for (const invalid of invalidBindings) {
      const harness = createMockDb({ select: [[secretRow()]] });
      await expect(secretService(harness.db).createBinding({
        companyId,
        secretId,
        targetType: "agent",
        targetId: agentId,
        required: true,
        ...invalid,
      }, SYSTEM_ACTOR)).rejects.toMatchObject({ status: 422 });
      expect(harness.calls.filter((call) => call.operation === "insert")).toEqual([]);
    }
  });

  it("creates one canonical binding and rejects a duplicate target config path", async () => {
    const created = bindingRow();
    const createHarness = createMockDb({
      select: [[secretRow()], []],
      insert: [[created]],
    });

    await expect(secretService(createHarness.db).createBinding({
      companyId,
      secretId,
      targetType: "agent",
      targetId: agentId,
      configPath: "env.API_KEY",
    }, SYSTEM_ACTOR)).resolves.toEqual(created);
    expect(valuesCalls(createHarness, "insert")[0]).toMatchObject({
      companyId,
      secretId,
      targetType: "agent",
      targetId: agentId,
      configPath: "env.API_KEY",
      versionSelector: "latest",
      required: true,
      projectionClass: "unclassified",
    });

    const duplicateHarness = createMockDb({
      select: [[secretRow()], [bindingRow({ secretId: "other-secret" })]],
    });
    await expect(secretService(duplicateHarness.db).createBinding({
      companyId,
      secretId,
      targetType: "agent",
      targetId: agentId,
      configPath: "env.API_KEY",
    }, SYSTEM_ACTOR)).rejects.toMatchObject({ status: 409 });
    expect(duplicateHarness.calls.filter((call) => call.operation === "insert")).toEqual([]);
  });

  it("replaces only the target environment bindings with canonical secret refs", async () => {
    const harness = createMockDb({
      select: [[secretRow()]],
      delete: [[], []],
      insert: [[]],
    });

    await expect(secretService(harness.db).syncEnvBindingsForTarget(
      companyId,
      { targetType: "agent", targetId: agentId },
      {
        API_KEY: { type: "secret_ref", secretId, version: "latest" },
        PLAIN_VALUE: { type: "plain", value: "visible" },
      },
      { actor: SYSTEM_ACTOR },
    )).resolves.toEqual([{
      secretId,
      configPath: "env.API_KEY",
      versionSelector: "latest",
      projectionClass: "unclassified",
      projectionAllowlistKey: null,
    }]);

    expect(valuesCalls(harness, "insert")[0]).toEqual([{
      companyId,
      secretId,
      targetType: "agent",
      targetId: agentId,
      configPath: "env.API_KEY",
      versionSelector: "latest",
      required: true,
      projectionClass: "unclassified",
      projectionAllowlistKey: null,
    }]);
    expect(harness.calls.filter((call) => call.operation === "delete" && call.method === "delete")
      .map((call) => call.args[0])).toEqual([
      companySecretBindings,
      userSecretDeclarations,
    ]);
  });

  it("resolves binding target labels without leaking fallback identifiers", async () => {
    const harness = createMockDb({
      select: [
        [bindingRow()],
        [{ id: agentId, name: "Codex Coder", title: "Engineer", status: "idle" }],
      ],
    });

    await expect(secretService(harness.db).listBindingReferences(companyId, secretId))
      .resolves.toEqual([
        expect.objectContaining({
          id: bindingId,
          target: {
            type: "agent",
            id: agentId,
            label: "Codex Coder (Engineer)",
            href: "/agents/codex-coder",
            status: "idle",
          },
        }),
      ]);
  });

  it("resolves an allowed binding and records value-free success metadata", async () => {
    const harness = createMockDb({
      select: [[secretRow()], [bindingRow()], [versionRow()]],
      update: [[]],
      insert: [[]],
    });

    const resolved = await secretService(harness.db).resolveEnvBindings(companyId, {
      API_KEY: { type: "secret_ref", secretId, version: "latest" },
    }, {
      consumerType: "agent",
      consumerId: agentId,
      actorType: "agent",
      actorId: agentId,
      issueId: "issue-1",
      runId: "run-1",
      allowedBindingIds: [bindingId],
    });

    expect(resolved.env).toEqual({ API_KEY: "runtime-secret" });
    expect([...resolved.secretKeys]).toEqual(["API_KEY"]);
    expect(resolved.manifest).toEqual([
      expect.objectContaining({
        configPath: "env.API_KEY",
        envKey: "API_KEY",
        secretId,
        bindingId,
        version: 1,
        outcome: "success",
      }),
    ]);
    expect(provider.resolveVersion).toHaveBeenCalledWith(expect.objectContaining({
      material: versionRow().material,
      context: { companyId, secretId, secretKey: "api-key", version: 1 },
    }));
    const accessValues = valuesCalls(harness, "insert")[0];
    expect(accessValues).toMatchObject({
      companyId,
      secretId,
      version: 1,
      actorType: "agent",
      actorId: agentId,
      consumerType: "agent",
      consumerId: agentId,
      configPath: "env.API_KEY",
      issueId: "issue-1",
      runId: "run-1",
      outcome: "success",
      errorCode: null,
    });
    expect(JSON.stringify(accessValues)).not.toContain("runtime-secret");
  });

  it("records redacted failure audits for missing and disallowed bindings", async () => {
    const cases = [
      {
        select: [[secretRow()], []],
        context: {},
        code: "binding_missing",
      },
      {
        select: [[secretRow()], [bindingRow()]],
        context: { allowedBindingIds: ["another-binding"] },
        code: "binding_not_allowed",
      },
    ];

    for (const entry of cases) {
      const harness = createMockDb({ select: entry.select, insert: [[]] });
      await expect(secretService(harness.db).resolveEnvBindings(companyId, {
        API_KEY: { type: "secret_ref", secretId, version: "latest" },
      }, {
        consumerType: "agent",
        consumerId: agentId,
        actorType: "agent",
        actorId: agentId,
        ...entry.context,
      })).rejects.toMatchObject({
        status: 422,
        details: { code: entry.code },
      });

      const accessValues = valuesCalls(harness, "insert")[0];
      expect(accessValues).toMatchObject({
        companyId,
        secretId,
        outcome: "failure",
      });
      expect(JSON.stringify(accessValues)).not.toContain("runtime-secret");
    }
    expect(provider.resolveVersion).not.toHaveBeenCalled();
  });

  it("returns resolved values even when best-effort access metadata writes fail", async () => {
    const harness = createMockDb({
      select: [[secretRow()], [bindingRow()], [versionRow()]],
      update: [new Error("last-resolved audit unavailable")],
      insert: [new Error("access audit unavailable")],
    });

    await expect(secretService(harness.db).resolveSecretValue(
      companyId,
      secretId,
      "latest",
      {
        consumerType: "agent",
        consumerId: agentId,
        configPath: "env.API_KEY",
        actorType: "agent",
        actorId: agentId,
      },
    )).resolves.toBe("runtime-secret");
    expect(harness.remaining("update")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("creates user secret definitions with canonical attribution and maps unique races to conflict", async () => {
    const created = definitionRow({
      createdByUserId: "owner-user",
      updatedByUserId: "owner-user",
    });
    const harness = createMockDb({ select: [[]], insert: [[created]] });

    await expect(secretService(harness.db).createUserSecretDefinition(companyId, {
      key: " github_token ",
      name: " GitHub token ",
      provider: "local_encrypted",
    }, { type: "user", userId: "owner-user" })).resolves.toEqual(created);
    expect(valuesCalls(harness, "insert")[0]).toMatchObject({
      companyId,
      key: "github_token",
      name: "GitHub token",
      createdByUserId: "owner-user",
      createdByAgentId: null,
      updatedByUserId: "owner-user",
      updatedByAgentId: null,
    });

    const uniqueRace = Object.assign(new Error("duplicate definition"), {
      cause: {
        code: "23505",
        constraint: "user_secret_definitions_company_key_uq",
      },
    });
    const raceHarness = createMockDb({ select: [[]], insert: [uniqueRace] });
    await expect(secretService(raceHarness.db).createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
    }, SYSTEM_ACTOR)).rejects.toMatchObject({ status: 409 });
  });

  it("persists a target-scoped user-secret declaration without resolving its value", async () => {
    const harness = createMockDb({
      select: [[definitionRow()]],
      delete: [[]],
      insert: [[]],
    });

    await expect(secretService(harness.db).syncUserSecretDeclarationsForTarget(
      companyId,
      { targetType: "agent", targetId: agentId },
      [{
        definitionKey: "github_token",
        configPath: "env.GITHUB_TOKEN",
        envKey: "GITHUB_TOKEN",
      }],
      { actor: SYSTEM_ACTOR },
    )).resolves.toEqual([{
      definitionId,
      configPath: "env.GITHUB_TOKEN",
      envKey: "GITHUB_TOKEN",
      versionSelector: "latest",
      required: true,
      allowMissingOverride: false,
      label: null,
    }]);

    expect(valuesCalls(harness, "insert")[0]).toEqual([{
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
    }]);
    expect(provider.resolveVersion).not.toHaveBeenCalled();
  });

  it("resolves a declared responsible-user value and audits credential ownership", async () => {
    const userSecret = secretRow({
      scope: "user",
      ownerUserId: "responsible-user",
      userSecretDefinitionId: definitionId,
      name: "GitHub token (responsible-user)",
    });
    const harness = createMockDb({
      select: [
        [definitionRow()],
        [declarationRow()],
        [userSecret],
        [userSecret],
        [versionRow()],
      ],
      update: [[]],
      insert: [[]],
    });

    const result = await secretService(harness.db).resolveUserSecretValue(companyId, {
      definitionKey: "github_token",
      responsibleUserId: "responsible-user",
      version: "latest",
    }, {
      consumerType: "agent",
      consumerId: agentId,
      configPath: "env.GITHUB_TOKEN",
      actorType: "agent",
      actorId: agentId,
      allowedBindingIds: [declarationId],
    });

    expect(result).toMatchObject({
      value: "runtime-secret",
      manifestEntry: {
        bindingId: declarationId,
        secretId,
        version: 1,
      },
    });
    const accessValues = valuesCalls(harness, "insert")[0];
    expect(accessValues).toMatchObject({
      secretId,
      userSecretDefinitionId: definitionId,
      secretScope: "user",
      responsibleUserId: "responsible-user",
      credentialOwnerUserId: "responsible-user",
      credentialSubjectType: "user",
      credentialSubjectId: "responsible-user",
      outcome: "success",
    });
    expect(JSON.stringify(accessValues)).not.toContain("runtime-secret");
  });

  it("fails closed outside the user declaration allowlist and skips optional missing declarations", async () => {
    const deniedHarness = createMockDb({
      select: [[definitionRow()], [declarationRow()]],
    });
    await expect(secretService(deniedHarness.db).resolveUserSecretValue(companyId, {
      definitionKey: "github_token",
      responsibleUserId: "responsible-user",
    }, {
      consumerType: "agent",
      consumerId: agentId,
      configPath: "env.GITHUB_TOKEN",
      allowedBindingIds: ["another-declaration"],
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "binding_not_allowed" },
    });

    const optionalHarness = createMockDb({ select: [[]] });
    await expect(secretService(optionalHarness.db).resolveUserSecretValue(companyId, {
      definitionKey: "missing_optional",
      required: false,
      responsibleUserId: "responsible-user",
    })).resolves.toBeNull();
  });

  it("maintains one default provider vault and rejects disabled defaults", async () => {
    const created = providerConfigRow({
      provider: "local_encrypted",
      config: {},
      displayName: "Local vault",
      isDefault: true,
      createdByAgentId: agentId,
    });
    const harness = createMockDb({ update: [[]], insert: [[created]] });

    await expect(secretService(harness.db).createProviderConfig(companyId, {
      provider: "local_encrypted",
      displayName: " Local vault ",
      isDefault: true,
      config: {},
    }, { type: "agent", agentId })).resolves.toEqual(created);

    expect(valuesCalls(harness, "update")[0]).toMatchObject({ isDefault: false });
    expect(valuesCalls(harness, "insert")[0]).toMatchObject({
      companyId,
      provider: "local_encrypted",
      displayName: "Local vault",
      status: "ready",
      isDefault: true,
      createdByAgentId: agentId,
      createdByUserId: null,
    });

    const invalidHarness = createMockDb();
    await expect(secretService(invalidHarness.db).createProviderConfig(companyId, {
      provider: "local_encrypted",
      displayName: "Disabled",
      status: "disabled",
      isDefault: true,
      config: {},
    }, SYSTEM_ACTOR)).rejects.toMatchObject({ status: 422 });
    expect(invalidHarness.calls).toEqual([]);

    const disabledHarness = createMockDb({
      select: [[providerConfigRow({ status: "disabled" })]],
    });
    await expect(secretService(disabledHarness.db).setDefaultProviderConfig(
      providerConfigId,
      SYSTEM_ACTOR,
    )).rejects.toMatchObject({ status: 422 });
    expect(disabledHarness.calls.filter((call) => call.operation === "update")).toEqual([]);
  });

  it("passes the selected provider vault into health checks", async () => {
    provider = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => provider);
    const config = providerConfigRow();
    const harness = createMockDb({ select: [[config]], update: [[]] });

    await expect(secretService(harness.db).checkProviderConfigHealth(
      providerConfigId,
      SYSTEM_ACTOR,
    )).resolves.toMatchObject({
      configId: providerConfigId,
      provider: "aws_secrets_manager",
      status: "ready",
      message: "Provider ready",
      checkedAt: expect.any(Date),
    });
    expect(provider.healthCheck).toHaveBeenCalledWith({
      providerConfig: {
        id: providerConfigId,
        provider: "aws_secrets_manager",
        status: "ready",
        config: config.config,
      },
    });
    expect(valuesCalls(harness, "update")[0]).toMatchObject({
      healthStatus: "ready",
      healthMessage: "Provider ready",
    });
  });

  it("rejects cross-company and disabled provider vaults before provider writes", async () => {
    for (const config of [
      providerConfigRow({ companyId: otherCompanyId }),
      providerConfigRow({ status: "disabled" }),
    ]) {
      provider = createProviderDouble("aws_secrets_manager");
      mocks.getSecretProvider.mockImplementation(() => provider);
      const harness = createMockDb({ select: [[], [], [config]] });

      await expect(secretService(harness.db).create(companyId, {
        name: "Rejected vault",
        provider: "aws_secrets_manager",
        providerConfigId,
        value: "must-not-reach-provider",
      }, SYSTEM_ACTOR)).rejects.toMatchObject({ status: 422 });
      expect(provider.createSecret).not.toHaveBeenCalled();
      expect(harness.calls.filter((call) => call.operation === "insert")).toEqual([]);
    }
  });

  it("previews remote references with duplicate enrichment and sanitized metadata", async () => {
    provider = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => provider);
    const duplicateRef = "arn:aws:secretsmanager:us-east-1:123456789012:secret:duplicate";
    const readyRef = "arn:aws:secretsmanager:us-east-1:123456789012:secret:ready";
    provider.listRemoteSecrets.mockResolvedValue({
      nextToken: "next-page",
      secrets: [
        { externalRef: duplicateRef, name: "duplicate", metadata: { arn: duplicateRef } },
        {
          externalRef: readyRef,
          name: "ready",
          metadata: { arn: readyRef, hasKmsKey: true, tagCount: 2 },
        },
      ],
    });
    const harness = createMockDb({
      select: [
        [providerConfigRow()],
        [{
          id: "existing-secret",
          name: "Existing duplicate",
          key: "existing-duplicate",
          provider: "aws_secrets_manager",
          providerConfigId,
          externalRef: duplicateRef,
          status: "active",
        }],
      ],
    });

    const preview = await secretService(harness.db).previewRemoteImport(companyId, {
      providerConfigId,
      query: "prod",
      pageSize: 25,
    });

    expect(provider.listRemoteSecrets).toHaveBeenCalledWith({
      providerConfig: expect.objectContaining({ id: providerConfigId }),
      query: "prod",
      nextToken: undefined,
      pageSize: 25,
    });
    expect(preview.nextToken).toBe("next-page");
    expect(preview.candidates.map((candidate) => candidate.status)).toEqual([
      "duplicate",
      "ready",
    ]);
    expect(preview.candidates[0]?.conflicts[0]).toMatchObject({
      type: "exact_reference",
      existingSecretId: "existing-secret",
    });
    expect(preview.candidates[1]).toMatchObject({
      importable: true,
      providerMetadata: { hasKmsKey: true, tagCount: 2 },
    });
    expect(JSON.stringify(preview.candidates[1]?.providerMetadata)).not.toContain("arn:aws");
  });

  it("sanitizes draft provider discovery failures without persistence", async () => {
    provider = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => provider);
    provider.discoverProviderConfigs.mockRejectedValueOnce(new SecretProviderClientError({
      code: "access_denied",
      provider: "aws_secrets_manager",
      operation: "discoverProviderConfigs",
      message: "AWS Secrets Manager denied the request.",
      rawMessage: "AccessDenied: arn:aws:sts::123456789012:assumed-role/private",
    }));
    const harness = createMockDb();

    const thrown = await secretService(harness.db).previewProviderConfigDiscovery(companyId, {
      provider: "aws_secrets_manager",
      config: { region: "us-east-1" },
    }).then(() => null, (error: unknown) => error);

    expect(thrown).toMatchObject({
      status: 403,
      message: "AWS Secrets Manager denied the request.",
      details: {
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "secret_provider_config.discovery.preview",
        providerConfigId: "discovery-preview",
        providerVaultContext: "draft_config",
        region: "us-east-1",
        requiredCapability: "secretsmanager:ListSecrets",
      },
    });
    expect(JSON.stringify(thrown)).not.toContain("arn:aws");
    expect(harness.calls).toEqual([]);
  });

  it("removes provider material with canonical context and treats provider not-found as idempotent", async () => {
    provider = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => provider);
    provider.deleteOrArchive.mockRejectedValueOnce(new SecretProviderClientError({
      code: "not_found",
      provider: "aws_secrets_manager",
      operation: "deleteSecret",
      message: "Remote secret was already removed.",
    }));
    const secret = secretRow({
      provider: "aws_secrets_manager",
      providerConfigId,
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed",
    });
    const harness = createMockDb({
      select: [[secret], [versionRow()], [providerConfigRow()]],
      update: [[]],
      delete: [[]],
    });

    await expect(secretService(harness.db).remove(secretId, SYSTEM_ACTOR))
      .resolves.toEqual(secret);
    expect(provider.deleteOrArchive).toHaveBeenCalledWith({
      material: versionRow().material,
      externalRef: secret.externalRef,
      providerConfig: expect.objectContaining({ id: providerConfigId }),
      context: {
        companyId,
        secretKey: "api-key",
        secretName: "API key",
        version: 1,
      },
      mode: "delete",
    });
    expect(valuesCalls(harness, "update")[0]).toMatchObject({
      key: `api-key__deleted__${secretId}`,
      name: `API key__deleted__${secretId}`,
      status: "deleted",
    });
    expect(harness.calls.find((call) =>
      call.operation === "delete" && call.method === "delete"
    )?.args[0]).toBe(companySecrets);
  });

  it("rejects generic retargeting and deletion paths for provider-managed identities", async () => {
    const cases = [
      {
        secret: secretRow({ managedMode: "paperclip_managed", providerConfigId }),
        patch: { providerConfigId: "another-provider-config" },
      },
      {
        secret: secretRow({
          managedMode: "external_reference",
          externalRef: "arn:old",
        }),
        patch: { externalRef: "arn:new" },
      },
      {
        secret: secretRow({ managedMode: "paperclip_managed" }),
        patch: { status: "deleted" as const },
      },
    ];

    for (const entry of cases) {
      const harness = createMockDb({ select: [[entry.secret]] });
      await expect(secretService(harness.db).update(
        secretId,
        entry.patch,
        SYSTEM_ACTOR,
      )).rejects.toMatchObject({ status: 422 });
      expect(harness.calls.filter((call) => call.operation === "update")).toEqual([]);
    }
  });

  it("keeps strict persistence free of plaintext placeholders and sensitive env values", async () => {
    const harness = createMockDb();
    const service = secretService(harness.db);

    await expect(service.normalizeEnvBindingsForPersistence(companyId, {
      OPENAI_API_KEY: { type: "plain", value: "plaintext-key" },
    }, { strictMode: true })).rejects.toMatchObject({ status: 422 });
    await expect(service.normalizeEnvBindingsForPersistence(companyId, {
      SAFE_VALUE: { type: "plain", value: "***REDACTED***" },
    })).rejects.toMatchObject({ status: 422 });
    expect(harness.calls).toEqual([]);
  });

});
