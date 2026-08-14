import * as t from "./aws-secrets-manager-provider.test-support.js";
const { describe, registerSuiteSetup, it, createAwsSecretsManagerProvider, expect } = t;

describe("awsSecretsManagerProvider", () => {
  registerSuiteSetup();

  it("resolves AWS secret values by provider version reference", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = t.createConfiguredAwsProvider({
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue(input) {
          calls.push({ op: "getSecretValue", input });
          return {
            SecretString: "resolved-secret-value",
            VersionId: "aws-version-2",
          };
        },
        async deleteSecret() {
          throw new Error("not used");
        },
      },
    });

    const resolved = await provider.resolveVersion({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
        versionId: "aws-version-2",
        source: "managed",
      },
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
      providerVersionRef: "aws-version-2",
      context: {
        companyId: "company-1",
        secretId: "secret-1",
        secretKey: "openai-api-key",
        version: 2,
      },
    });

    expect(resolved).toBe("resolved-secret-value");
    expect(calls).toEqual([
      {
        op: "getSecretValue",
        input: {
          SecretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
          VersionId: "aws-version-2",
          VersionStage: undefined,
        },
      },
    ]);
  });

  it("rejects managed resolve attempts when stored refs drift outside the derived scope", async () => {
    const provider = t.createConfiguredAwsProvider({
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue() {
          throw new Error("should not be called");
        },
        async deleteSecret() {
          throw new Error("not used");
        },
      },
    });

    await expect(
      provider.resolveVersion({
        material: {
          scheme: "aws_secrets_manager_v1",
          secretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-2/openai-api-key",
          versionId: "aws-version-2",
          source: "managed",
        },
        externalRef:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-2/openai-api-key",
        providerVersionRef: "aws-version-2",
        context: {
          companyId: "company-1",
          secretId: "secret-1",
          secretKey: "openai-api-key",
          version: 2,
        },
      }),
    ).rejects.toThrow(/drifted outside the derived deployment\/company scope/i);
  });

  it("warns when AWS provider configuration is incomplete and blocks managed writes", async () => {
    delete process.env.PAPERCLIP_SECRETS_AWS_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID;
    delete process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID;

    const provider = createAwsSecretsManagerProvider();
    const health = await provider.healthCheck();

    expect(health.status).toBe("warn");
    expect(health.message).toContain("missing PAPERCLIP_SECRETS_AWS_REGION");
    expect(health.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Missing required non-secret AWS provider config"),
        expect.stringContaining("AWS bootstrap credentials must be available"),
        expect.stringContaining("Do not store AWS root credentials"),
      ]),
    );
    expect(health.details).toMatchObject({
      missingConfig: [
        "PAPERCLIP_SECRETS_AWS_REGION or AWS_REGION/AWS_DEFAULT_REGION",
        "PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID",
        "PAPERCLIP_SECRETS_AWS_KMS_KEY_ID",
      ],
      credentialSource: "AWS SDK default credential provider chain",
    });
    await expect(
      provider.createSecret({
        value: "super-secret-value",
        context: {
          companyId: "company-1",
          secretKey: "openai-api-key",
          secretName: "OpenAI API Key",
          version: 1,
        },
      }),
    ).rejects.toThrow(/PAPERCLIP_SECRETS_AWS_REGION|AWS_REGION/i);
  });

  it("deletes only Paperclip-managed AWS secrets", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = t.createConfiguredAwsProvider({
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue() {
          throw new Error("not used");
        },
        async deleteSecret(input) {
          calls.push({ op: "deleteSecret", input });
          return {};
        },
      },
    });

    await provider.deleteOrArchive({
      mode: "delete",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
        versionId: null,
        source: "managed",
      },
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 2,
      },
    });
    await expect(
      provider.deleteOrArchive({
        mode: "delete",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/attacker",
        material: {
          scheme: "aws_secrets_manager_v1",
          secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/attacker",
          versionId: null,
          source: "managed",
        },
        context: {
          companyId: "company-1",
          secretKey: "openai-api-key",
          secretName: "OpenAI API Key",
          version: 2,
        },
      }),
    ).rejects.toThrow(/drifted outside the derived deployment\/company scope/i);
    await provider.deleteOrArchive({
      mode: "delete",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
        versionId: "linked-version-7",
        source: "external_reference",
      },
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 2,
      },
    });

    expect(calls).toEqual([
      {
        op: "deleteSecret",
        input: {
          SecretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
          RecoveryWindowInDays: 30,
        },
      },
    ]);
  });

  it("archives pending Paperclip-managed AWS versions without deleting the secret", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = t.createConfiguredAwsProvider({
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue() {
          throw new Error("not used");
        },
        async deleteSecret(input) {
          calls.push({ op: "deleteSecret", input });
          return {};
        },
        async updateSecretVersionStage(input) {
          calls.push({ op: "updateSecretVersionStage", input });
          return {};
        },
      },
    });

    await provider.deleteOrArchive({
      mode: "archive",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
        versionId: "aws-version-2",
        source: "managed",
      },
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 2,
      },
    });

    expect(calls).toEqual([
      {
        op: "updateSecretVersionStage",
        input: {
          SecretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
          VersionStage: "PAPERCLIP_PENDING",
          RemoveFromVersionId: "aws-version-2",
        },
      },
    ]);
  });
});
