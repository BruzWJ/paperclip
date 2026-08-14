import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsSecretsManagerProvider } from "../secrets/aws-secrets-manager-provider.js";
import { SecretProviderClientError } from "../secrets/types.js";

const previousEnv = {
  PAPERCLIP_SECRETS_AWS_REGION: process.env.PAPERCLIP_SECRETS_AWS_REGION,
  AWS_REGION: process.env.AWS_REGION,
  AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID: process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID,
  PAPERCLIP_SECRETS_AWS_KMS_KEY_ID: process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
  AWS_PROFILE: process.env.AWS_PROFILE,
  AWS_DEFAULT_PROFILE: process.env.AWS_DEFAULT_PROFILE,
  AWS_CONFIG_FILE: process.env.AWS_CONFIG_FILE,
  AWS_SHARED_CREDENTIALS_FILE: process.env.AWS_SHARED_CREDENTIALS_FILE,
  AWS_SDK_LOAD_CONFIG: process.env.AWS_SDK_LOAD_CONFIG,
};

export function createConfiguredAwsProvider(
  options: Omit<NonNullable<Parameters<typeof createAwsSecretsManagerProvider>[0]>, "config"> = {},
) {
  return createAwsSecretsManagerProvider({
    ...options,
    config: {
      region: "us-east-1",
      endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
      deploymentId: "prod-use1",
      prefix: "paperclip",
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
      environmentTag: "production",
      providerOwnerTag: "paperclip",
      deleteRecoveryWindowDays: 30,
    },
  });
}

export function registerSuiteSetup() {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

export { describe, expect, it, vi, createAwsSecretsManagerProvider };
export { SecretProviderClientError };
