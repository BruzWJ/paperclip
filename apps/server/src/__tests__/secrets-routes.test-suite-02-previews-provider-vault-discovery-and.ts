import * as t from "./secrets-routes.test-support.js";
const { describe, registerSuiteSetup, it, mockSecretService, request, createApp } = t;
const { expect, mockLogActivity, HttpError } = t;

describe("secret routes", () => {
  registerSuiteSetup();

  it("previews provider vault discovery and logs only aggregate metadata", async () => {
    mockSecretService.previewProviderConfigDiscovery.mockResolvedValue({
      provider: "aws_secrets_manager",
      nextToken: null,
      sampledSecretCount: 2,
      skippedForeignPaperclipSampleCount: 0,
      candidates: [
        {
          provider: "aws_secrets_manager",
          displayName: "AWS production",
          config: {
            region: "us-east-1",
            namespace: "prod-use1",
            secretNamePrefix: "paperclip",
            environmentTag: "production",
            ownerTag: "platform",
            kmsKeyId: null,
          },
          sampleCount: 2,
          samples: [
            {
              name: "paperclip/prod-use1/company-1/openai",
              hasKmsKey: false,
              tagKeys: ["environment"],
            },
          ],
          signals: {
            namespace: "prod-use1",
            secretNamePrefix: "paperclip",
            environmentTag: "production",
            ownerTag: "platform",
            kmsKeyId: null,
            hasKmsKey: false,
            sampleCount: 2,
            paperclipManagedSampleCount: 0,
            skippedForeignPaperclipSampleCount: 0,
          },
          warnings: [],
        },
      ],
      warnings: [],
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/secret-provider-configs/discovery/preview")
      .send({
        provider: "aws_secrets_manager",
        config: { region: "us-east-1" },
        query: "paperclip",
        pageSize: 25,
      });

    expect(res.status).toBe(200);
    expect(mockSecretService.previewProviderConfigDiscovery).toHaveBeenCalledWith("company-1", {
      provider: "aws_secrets_manager",
      config: { region: "us-east-1" },
      query: "paperclip",
      nextToken: undefined,
      pageSize: 25,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "secret_provider_config.discovery_previewed",
        entityType: "secret_provider_config_discovery",
        entityId: "company-1",
        details: {
          provider: "aws_secrets_manager",
          candidateCount: 1,
          sampledSecretCount: 2,
          warningCount: 0,
        },
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("paperclip/prod-use1/company-1/openai");
  });

  it("returns actionable sanitized provider vault discovery errors", async () => {
    mockSecretService.previewProviderConfigDiscovery.mockRejectedValue(
      new HttpError(
        403,
        "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        {
          code: "access_denied",
          provider: "aws_secrets_manager",
          operation: "secret_provider_config.discovery.preview",
          providerConfigId: "discovery-preview",
          providerVaultContext: "draft_config",
          region: "us-east-1",
          credentialPath: "Paperclip server runtime/provider credential path",
          requiredCapability: "secretsmanager:ListSecrets",
          actionableMessage:
            "AWS discovery preview needs secretsmanager:ListSecrets in the selected region for the Paperclip server runtime/provider credential path.",
          safeAlternative:
            "If the operator already knows the exact AWS Secrets Manager ARN, paste/link that ARN instead of using discovery. Exact-resource DescribeSecret and runtime read permissions are still required.",
        },
      ),
    );

    const res = await request(createApp())
      .post("/api/companies/company-1/secret-provider-configs/discovery/preview")
      .send({
        provider: "aws_secrets_manager",
        config: { region: "us-east-1" },
        pageSize: 25,
      });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
      details: {
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "secret_provider_config.discovery.preview",
        providerVaultContext: "draft_config",
        region: "us-east-1",
        requiredCapability: "secretsmanager:ListSecrets",
      },
    });
    expect(res.body.details.actionableMessage).toContain("Paperclip server runtime/provider credential path");
    expect(res.body.details.safeAlternative).toContain("paste/link that ARN");
    expect(JSON.stringify(res.body)).not.toContain("arn:aws");
    expect(JSON.stringify(res.body)).not.toContain("123456789012");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects ready status for coming-soon provider vaults", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/secret-provider-configs")
      .send({
        provider: "vault",
        displayName: "Vault draft",
        status: "ready",
        config: {
          address: "https://vault.example.com",
        },
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/locked while coming soon/i);
    expect(mockSecretService.createProviderConfig).not.toHaveBeenCalled();
  });

  it("rejects credential-bearing Vault provider vault addresses before persistence", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/secret-provider-configs")
      .send({
        provider: "vault",
        displayName: "Vault draft",
        config: {
          address: "https://user:pass@vault.example.com",
        },
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/origin-only HTTP\(S\) URL/i);
    expect(mockSecretService.createProviderConfig).not.toHaveBeenCalled();
  });

  it.each(["https://vault.example.com?token=hvs.x", "https://vault.example.com#token=hvs.x"])(
    "rejects token-bearing Vault provider vault address %s before persistence",
    async (address) => {
      const res = await request(createApp()).post("/api/companies/company-1/secret-provider-configs").send({
        provider: "vault",
        displayName: "Vault draft",
        config: { address },
      });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/origin-only HTTP\(S\) URL/i);
      expect(mockSecretService.createProviderConfig).not.toHaveBeenCalled();
    },
  );

  it("rejects unsafe Vault provider vault address patches before persistence", async () => {
    const res = await request(createApp())
      .patch("/api/secret-provider-configs/vault-1")
      .send({
        config: {
          address: "https://vault.example.com#token=hvs.x",
        },
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/origin-only HTTP\(S\) URL/i);
    expect(mockSecretService.getProviderConfigById).not.toHaveBeenCalled();
    expect(mockSecretService.updateProviderConfig).not.toHaveBeenCalled();
  });

  it("creates provider vaults and logs safe activity details", async () => {
    const createdAt = new Date("2026-05-06T00:00:00.000Z");
    mockSecretService.createProviderConfig.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      provider: "aws_secrets_manager",
      displayName: "AWS prod",
      status: "ready",
      isDefault: true,
      config: { region: "us-east-1" },
      healthStatus: null,
      healthCheckedAt: null,
      healthMessage: null,
      healthDetails: null,
      disabledAt: null,
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdAt,
      updatedAt: createdAt,
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/secret-provider-configs")
      .send({
        provider: "aws_secrets_manager",
        displayName: "AWS prod",
        isDefault: true,
        config: { region: "us-east-1" },
      });

    expect(res.status).toBe(201);
    expect(mockSecretService.createProviderConfig).toHaveBeenCalledWith(
      "company-1",
      {
        provider: "aws_secrets_manager",
        displayName: "AWS prod",
        status: undefined,
        isDefault: true,
        config: { region: "us-east-1" },
      },
      { type: "user", userId: "user-1" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "secret_provider_config.created",
        details: {
          provider: "aws_secrets_manager",
          displayName: "AWS prod",
          status: "ready",
          isDefault: true,
        },
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("accessKey");
  });

  it("removes provider vault config locally without deleting remote provider data", async () => {
    const createdAt = new Date("2026-05-06T00:00:00.000Z");
    const providerConfig = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      provider: "aws_secrets_manager",
      displayName: "AWS prod",
      status: "ready",
      isDefault: false,
      config: { region: "us-east-1" },
      healthStatus: null,
      healthCheckedAt: null,
      healthMessage: null,
      healthDetails: null,
      disabledAt: null,
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdAt,
      updatedAt: createdAt,
    };
    mockSecretService.getProviderConfigById.mockResolvedValue(providerConfig);
    mockSecretService.removeProviderConfig.mockResolvedValue(providerConfig);

    const res = await request(createApp()).delete(
      "/api/secret-provider-configs/11111111-1111-4111-8111-111111111111",
    );

    expect(res.status).toBe(200);
    expect(mockSecretService.removeProviderConfig).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      {
        type: "user",
        userId: "user-1",
      },
    );
    expect(mockSecretService.disableProviderConfig).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "secret_provider_config.removed",
        details: {
          provider: "aws_secrets_manager",
          displayName: "AWS prod",
          remoteDeleted: false,
        },
      }),
    );
  });

  it("previews remote imports and logs only aggregate metadata", async () => {
    mockSecretService.previewRemoteImport.mockResolvedValue({
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      provider: "aws_secrets_manager",
      nextToken: null,
      candidates: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
          remoteName: "prod/openai",
          name: "openai",
          key: "openai",
          providerVersionRef: null,
          providerMetadata: { description: "OpenAI API key" },
          status: "ready",
          importable: true,
          conflicts: [],
        },
      ],
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/secrets/remote-import/preview")
      .send({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        query: "openai",
        pageSize: 25,
      });

    expect(res.status).toBe(200);
    expect(mockSecretService.previewRemoteImport).toHaveBeenCalledWith("company-1", {
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      query: "openai",
      nextToken: undefined,
      pageSize: 25,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "secret.remote_import.previewed",
        details: {
          provider: "aws_secrets_manager",
          candidateCount: 1,
          readyCount: 1,
          duplicateCount: 0,
          conflictCount: 0,
        },
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("prod/openai");
  });

  it("returns sanitized remote import preview provider errors", async () => {
    mockSecretService.previewRemoteImport.mockRejectedValue(
      new HttpError(
        403,
        "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        { code: "access_denied" },
      ),
    );

    const res = await request(createApp())
      .post("/api/companies/company-1/secrets/remote-import/preview")
      .send({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      code: "access_denied",
      error: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
      details: { code: "access_denied" },
    });
    expect(JSON.stringify(res.body)).not.toContain("arn:aws");
    expect(JSON.stringify(res.body)).not.toContain("123456789012");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
