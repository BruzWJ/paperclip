import "./aws-secrets-manager-provider.test-suite-02-rejects-non-exact-linked-aws.js";
import "./aws-secrets-manager-provider.test-suite-03-resolves-aws-secret-values-by.js";
import * as t from "./aws-secrets-manager-provider.test-support.js";
const { describe, registerSuiteSetup, it, createAwsSecretsManagerProvider, expect } = t;
const { vi } = t;

describe("awsSecretsManagerProvider", () => {
  registerSuiteSetup();

  it("creates Paperclip-managed AWS secrets without persisting plaintext in provider material", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = t.createConfiguredAwsProvider({
      gateway: {
        async createSecret(input) {
          calls.push({ op: "createSecret", input });
          return {
            ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
            VersionId: "aws-version-1",
          };
        },
        async putSecretValue(input) {
          calls.push({ op: "putSecretValue", input });
          return { ARN: String(input.SecretId), VersionId: "unused" };
        },
        async getSecretValue(input) {
          calls.push({ op: "getSecretValue", input });
          return { SecretString: "resolved-value", VersionId: "unused" };
        },
        async deleteSecret(input) {
          calls.push({ op: "deleteSecret", input });
          return {};
        },
      },
    });

    const prepared = await provider.createSecret({
      value: "super-secret-value",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/attacker",
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 1,
      },
    });

    expect(calls).toEqual([
      expect.objectContaining({
        op: "createSecret",
        input: expect.objectContaining({
          Name: "paperclip/prod-use1/company-1/openai-api-key",
          KmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        }),
      }),
    ]);
    expect(JSON.stringify(prepared)).not.toContain("super-secret-value");
    expect(prepared.externalRef).toContain("paperclip/prod-use1/company-1/openai-api-key");
    expect(prepared.providerVersionRef).toBe("aws-version-1");
  });

  it("creates AWS secrets from selected provider vault config without deployment env fallback", async () => {
    delete process.env.PAPERCLIP_SECRETS_AWS_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID;
    delete process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;

    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      gateway: {
        async createSecret(input) {
          calls.push({ op: "createSecret", input });
          return {
            ARN: "arn:aws:secretsmanager:us-west-2:123456789012:secret:clip/prod-us-west/company-1/openai-api-key",
            VersionId: "aws-version-1",
          };
        },
        async putSecretValue(input) {
          calls.push({ op: "putSecretValue", input });
          return { ARN: String(input.SecretId), VersionId: "unused" };
        },
        async getSecretValue(input) {
          calls.push({ op: "getSecretValue", input });
          return { SecretString: "resolved-value", VersionId: "unused" };
        },
        async deleteSecret(input) {
          calls.push({ op: "deleteSecret", input });
          return {};
        },
      },
    });

    const providerConfig = {
      id: "vault-1",
      provider: "aws_secrets_manager" as const,
      status: "ready",
      config: {
        region: "us-west-2",
        namespace: "prod-us-west",
        secretNamePrefix: "clip",
        ownerTag: "platform",
        environmentTag: "production",
      },
    };

    const health = await provider.healthCheck({ providerConfig });
    const explicitlyNonStrictHealth = await provider.healthCheck({
      providerConfig,
      strictMode: false,
    });
    const prepared = await provider.createSecret({
      value: "super-secret-value",
      providerConfig,
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 1,
      },
    });

    expect(health.status).toBe("ok");
    expect(health.details).toMatchObject({
      region: "us-west-2",
      prefix: "clip",
      deploymentId: "prod-us-west",
      kmsKeyConfigured: false,
    });
    expect(explicitlyNonStrictHealth).toMatchObject({
      status: "warn",
      warnings: ["Strict secret mode is disabled"],
    });
    expect(calls).toEqual([
      expect.objectContaining({
        op: "createSecret",
        input: expect.objectContaining({
          Name: "clip/prod-us-west/company-1/openai-api-key",
          SecretString: "super-secret-value",
          Tags: expect.arrayContaining([
            { Key: "paperclip:provider-owner", Value: "platform" },
            { Key: "paperclip:environment", Value: "production" },
          ]),
        }),
      }),
    ]);
    expect(calls[0]?.input).not.toHaveProperty("KmsKeyId");
    expect(JSON.stringify(prepared)).not.toContain("super-secret-value");
    expect(prepared.externalRef).toContain("clip/prod-us-west/company-1/openai-api-key");
  });

  it.each([
    { region: " us-east-1", kmsKeyId: null },
    {
      region: "us-east-1",
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test ",
    },
  ])("rejects non-exact AWS provider identity config at runtime", async ({ region, kmsKeyId }) => {
    const provider = createAwsSecretsManagerProvider();

    await expect(
      provider.linkExternalSecret({
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
        providerConfig: {
          id: "vault-1",
          provider: "aws_secrets_manager",
          status: "ready",
          config: { region, kmsKeyId },
        },
      }),
    ).rejects.toThrow(/exact value without surrounding whitespace/i);
  });

  it("signs AWS Secrets Manager JSON requests with default runtime credentials", async () => {
    delete process.env.AWS_PROFILE;
    delete process.env.AWS_DEFAULT_PROFILE;
    delete process.env.AWS_CONFIG_FILE;
    delete process.env.AWS_SHARED_CREDENTIALS_FILE;
    delete process.env.AWS_SDK_LOAD_CONFIG;
    process.env.AWS_ACCESS_KEY_ID = "AKIA_TEST_ACCESS";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.AWS_SESSION_TOKEN = "test-session-token";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/company-1/openai-api-key",
          VersionId: "aws-version-1",
        }),
        { status: 200 },
      ),
    );
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
    });

    await provider.createSecret({
      value: "super-secret-value",
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 1,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(String(url)).toBe("https://secretsmanager.us-east-1.amazonaws.com/");
    expect(headers["x-amz-target"]).toBe("secretsmanager.CreateSecret");
    expect(headers["x-amz-security-token"]).toBe("test-session-token");
    expect(headers.authorization).toContain("Credential=AKIA_TEST_ACCESS/");
    expect(headers.authorization).toContain("/us-east-1/secretsmanager/aws4_request");
    expect(headers.authorization).toContain("SignedHeaders=");
    expect(headers.authorization).toContain("Signature=");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("creates new AWS secret versions against a namespace-valid existing secret reference", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = t.createConfiguredAwsProvider({
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue(input) {
          calls.push({ op: "putSecretValue", input });
          return {
            ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
            VersionId: "aws-version-2",
          };
        },
        async getSecretValue() {
          throw new Error("not used");
        },
        async deleteSecret() {
          throw new Error("not used");
        },
      },
    });

    const prepared = await provider.createVersion({
      value: "rotated-secret-value",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 2,
      },
    });

    expect(calls).toEqual([
      {
        op: "putSecretValue",
        input: {
          SecretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
          SecretString: "rotated-secret-value",
          VersionStages: ["PAPERCLIP_PENDING"],
        },
      },
    ]);
    expect(JSON.stringify(prepared)).not.toContain("rotated-secret-value");
    expect(prepared.providerVersionRef).toBe("aws-version-2");
  });

  it("rejects out-of-namespace refs for managed AWS secret version writes", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = t.createConfiguredAwsProvider({
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue(input) {
          calls.push({ op: "putSecretValue", input });
          return { Name: String(input.SecretId), VersionId: "aws-version-2" };
        },
        async getSecretValue() {
          throw new Error("not used");
        },
        async deleteSecret() {
          throw new Error("not used");
        },
      },
    });

    await expect(
      provider.createVersion({
        value: "rotated-secret-value",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/attacker",
        context: {
          companyId: "company-1",
          secretKey: "openai-api-key",
          secretName: "OpenAI API Key",
          version: 2,
        },
      }),
    ).rejects.toThrow(/drifted outside the derived deployment\/company scope/i);

    expect(calls).toEqual([]);
  });

  it("stores linked external references as metadata-only provider material", async () => {
    const provider = t.createConfiguredAwsProvider();

    const prepared = await provider.linkExternalSecret({
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
      providerVersionRef: "linked-version-7",
    });

    expect(prepared.externalRef).toBe("arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external");
    expect(prepared.providerVersionRef).toBe("linked-version-7");
    expect(prepared.valueSha256).toBeTruthy();
  });
});
