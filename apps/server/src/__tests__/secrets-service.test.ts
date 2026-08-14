import "./secrets-service.test-suite-01-encrypts-and-resolves-local-values.js";
import "./secrets-service.test-suite-02-rotates-into-a-disabled-version.js";
import "./secrets-service.test-suite-03-records-redacted-failure-audits-for.js";
import * as t from "./secrets-service.test-support.js";
const { describe, registerSuiteSetup, it, providerState, createProviderDouble } = t;
const { mocks, createMockDb, providerConfigRow, secretService, companyId, expect } = t;
const { providerConfigId, SecretProviderClientError, secretRow, versionRow } = t;
const { secretId, SYSTEM_ACTOR, valuesCalls, companySecrets } = t;

describe("secretService", () => {
  registerSuiteSetup();

  it("previews remote references with duplicate enrichment and sanitized metadata", async () => {
    providerState.current = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => providerState.current);
    const duplicateRef = "arn:aws:secretsmanager:us-east-1:123456789012:secret:duplicate";
    const readyRef = "arn:aws:secretsmanager:us-east-1:123456789012:secret:ready";
    providerState.current.listRemoteSecrets.mockResolvedValue({
      nextToken: "next-page",
      secrets: [
        {
          externalRef: duplicateRef,
          name: "duplicate",
          metadata: { arn: duplicateRef },
        },
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
        [
          {
            id: "existing-secret",
            name: "Existing duplicate",
            key: "existing-duplicate",
            provider: "aws_secrets_manager",
            providerConfigId,
            externalRef: duplicateRef,
            status: "active",
          },
        ],
      ],
    });

    const preview = await secretService(harness.db).previewRemoteImport(companyId, {
      providerConfigId,
      query: "prod",
      pageSize: 25,
    });

    expect(providerState.current.listRemoteSecrets).toHaveBeenCalledWith({
      providerConfig: expect.objectContaining({
        id: providerConfigId,
      }),
      query: "prod",
      nextToken: undefined,
      pageSize: 25,
    });
    expect(preview.nextToken).toBe("next-page");
    expect(preview.candidates.map((candidate) => candidate.status)).toEqual(["duplicate", "ready"]);
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
    providerState.current = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => providerState.current);
    providerState.current.discoverProviderConfigs.mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "discoverProviderConfigs",
        message: "AWS Secrets Manager denied the request.",
        rawMessage: "AccessDenied: arn:aws:sts::123456789012:assumed-role/private",
      }),
    );
    const harness = createMockDb();

    const thrown = await secretService(harness.db)
      .previewProviderConfigDiscovery(companyId, {
        provider: "aws_secrets_manager",
        config: { region: "us-east-1" },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

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
    providerState.current = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => providerState.current);
    providerState.current.deleteOrArchive.mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "not_found",
        provider: "aws_secrets_manager",
        operation: "deleteSecret",
        message: "Remote secret was already removed.",
      }),
    );
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

    await expect(secretService(harness.db).remove(secretId, SYSTEM_ACTOR)).resolves.toEqual(secret);
    expect(providerState.current.deleteOrArchive).toHaveBeenCalledWith({
      material: versionRow().material,
      externalRef: secret.externalRef,
      providerConfig: expect.objectContaining({
        id: providerConfigId,
      }),
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
    expect(
      harness.calls.find((call) => call.operation === "delete" && call.method === "delete")?.args[0],
    ).toBe(companySecrets);
  });

  it("rejects generic retargeting and deletion paths for provider-managed identities", async () => {
    const cases = [
      {
        secret: secretRow({
          managedMode: "paperclip_managed",
          providerConfigId,
        }),
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
      await expect(
        secretService(harness.db).update(secretId, entry.patch, SYSTEM_ACTOR),
      ).rejects.toMatchObject({ status: 422 });
      expect(harness.calls.filter((call) => call.operation === "update")).toEqual([]);
    }
  });

  it("keeps strict persistence free of plaintext placeholders and sensitive env values", async () => {
    const harness = createMockDb();
    const service = secretService(harness.db);

    await expect(
      service.normalizeEnvBindingsForPersistence(
        companyId,
        {
          OPENAI_API_KEY: { type: "plain", value: "plaintext-key" },
        },
        { strictMode: true },
      ),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      service.normalizeEnvBindingsForPersistence(companyId, {
        SAFE_VALUE: { type: "plain", value: "***REDACTED***" },
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(harness.calls).toEqual([]);
  });
});
