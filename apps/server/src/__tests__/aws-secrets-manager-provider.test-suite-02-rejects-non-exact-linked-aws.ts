import * as t from "./aws-secrets-manager-provider.test-support.js";
const { describe, registerSuiteSetup, it, createAwsSecretsManagerProvider, expect } = t;
const { SecretProviderClientError } = t;

describe("awsSecretsManagerProvider", () => {
  registerSuiteSetup();

  it.each([
    {
      externalRef: " arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
      providerVersionRef: "linked-version-7",
    },
    {
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
      providerVersionRef: "linked-version-7 ",
    },
  ])(
    "rejects non-exact linked AWS references before creating provider material",
    async ({ externalRef, providerVersionRef }) => {
      const provider = t.createConfiguredAwsProvider();

      await expect(provider.linkExternalSecret({ externalRef, providerVersionRef })).rejects.toThrow(
        /exact value without surrounding whitespace/i,
      );
    },
  );

  it("rejects non-exact AWS response references instead of persisting aliases", async () => {
    const provider = t.createConfiguredAwsProvider({
      gateway: {
        async createSecret() {
          return {
            ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed ",
            VersionId: "aws-version-1",
          };
        },
        async putSecretValue() {
          throw new Error("not used");
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
      provider.createSecret({
        value: "secret-value",
        context: {
          companyId: "company-1",
          secretKey: "api-key",
          secretName: "API key",
          version: 1,
        },
      }),
    ).rejects.toMatchObject({
      code: "provider_error",
      provider: "aws_secrets_manager",
      operation: "createSecret",
    });
  });

  it("rejects linked external references under the Paperclip-managed namespace", async () => {
    const provider = t.createConfiguredAwsProvider();

    await expect(
      provider.linkExternalSecret({
        externalRef:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-2/openai-api-key",
        providerVersionRef: "linked-version-7",
      }),
    ).rejects.toThrow(/Paperclip-managed namespace/i);
  });

  it("lists remote AWS secrets with metadata only and never resolves plaintext", async () => {
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
          throw new Error("GetSecretValue must not be used for remote import preview");
        },
        async deleteSecret() {
          throw new Error("not used");
        },
        async listSecrets(input) {
          calls.push({ op: "listSecrets", input });
          return {
            NextToken: "token-2",
            SecretList: [
              {
                ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
                Name: "prod/openai",
                Description: "OpenAI API key",
                CreatedDate: new Date("2026-05-06T00:00:00.000Z"),
                Tags: [{ Key: "team", Value: "platform" }],
              },
            ],
          };
        },
      },
    });

    const listed = await provider.listRemoteSecrets?.({
      query: "openai",
      nextToken: "token-1",
      pageSize: 25,
    });

    expect(calls).toEqual([
      {
        op: "listSecrets",
        input: {
          MaxResults: 25,
          NextToken: "token-1",
          IncludePlannedDeletion: false,
          Filters: [{ Key: "all", Values: ["openai"] }],
        },
      },
    ]);
    expect(listed).toEqual({
      nextToken: "token-2",
      secrets: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
          name: "prod/openai",
          providerVersionRef: null,
          metadata: expect.objectContaining({
            createdDate: "2026-05-06T00:00:00.000Z",
            hasDescription: true,
            tagCount: 1,
          }),
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("SecretString");
    expect(JSON.stringify(listed)).not.toContain("OpenAI API key");
    expect(JSON.stringify(listed)).not.toContain("team");
  });

  it("discovers AWS provider vault prefill candidates from metadata without reading values", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue() {
          throw new Error("GetSecretValue must not be used for provider vault discovery");
        },
        async deleteSecret() {
          throw new Error("not used");
        },
        async listSecrets(input) {
          calls.push({ op: "listSecrets", input });
          return {
            NextToken: "next-page",
            SecretList: [
              {
                ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai",
                Name: "paperclip/prod-use1/company-1/openai",
                KmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/prod",
                Tags: [
                  { Key: "paperclip:managed-by", Value: "paperclip" },
                  { Key: "paperclip:deployment-id", Value: "prod-use1" },
                  { Key: "paperclip:company-id", Value: "company-1" },
                  { Key: "paperclip:environment", Value: "production" },
                  { Key: "paperclip:provider-owner", Value: "platform" },
                ],
              },
              {
                ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-2/stripe",
                Name: "paperclip/prod-use1/company-2/stripe",
                Tags: [
                  { Key: "paperclip:managed-by", Value: "paperclip" },
                  { Key: "paperclip:company-id", Value: "company-2" },
                ],
              },
            ],
          };
        },
      },
    });

    const preview = await provider.discoverProviderConfigs?.({
      companyId: "company-1",
      providerConfig: {
        id: "draft",
        provider: "aws_secrets_manager",
        status: "ready",
        config: { region: "us-east-1" },
      },
      query: "paperclip",
      pageSize: 25,
    });

    expect(calls).toEqual([
      {
        op: "listSecrets",
        input: {
          MaxResults: 25,
          NextToken: undefined,
          IncludePlannedDeletion: false,
          Filters: [{ Key: "all", Values: ["paperclip"] }],
        },
      },
    ]);
    expect(preview).toMatchObject({
      provider: "aws_secrets_manager",
      nextToken: "next-page",
      sampledSecretCount: 1,
      skippedForeignPaperclipSampleCount: 1,
      candidates: [
        expect.objectContaining({
          displayName: "AWS production",
          config: expect.objectContaining({
            region: "us-east-1",
            namespace: "prod-use1",
            secretNamePrefix: "paperclip",
            kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/prod",
            ownerTag: "platform",
            environmentTag: "production",
          }),
          signals: expect.objectContaining({
            paperclipManagedSampleCount: 1,
            skippedForeignPaperclipSampleCount: 1,
          }),
        }),
      ],
    });
    expect(JSON.stringify(preview)).not.toContain("SecretString");
    expect(JSON.stringify(preview)).not.toContain("company-2/stripe");
  });

  it("redacts AWS provider exception text when remote listing fails", async () => {
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized to perform secretsmanager:ListSecrets on arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai";
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
        async deleteSecret() {
          throw new Error("not used");
        },
        async listSecrets() {
          throw new Error(rawProviderMessage);
        },
      },
    });

    let thrown: unknown;
    try {
      await provider.listRemoteSecrets?.({});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SecretProviderClientError);
    expect(thrown).toMatchObject({
      code: "access_denied",
      status: 403,
      message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
      rawMessage: rawProviderMessage,
    });
    expect(thrown instanceof Error ? thrown.message : String(thrown)).not.toContain("arn:aws");
    expect(thrown instanceof Error ? thrown.message : String(thrown)).not.toContain("123456789012");
  });
});
