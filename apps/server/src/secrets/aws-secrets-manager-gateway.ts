import { SecretProviderClientError } from "./types.js";
import * as awsCredentials from "./aws-secrets-manager-credentials.js";
import { awsProviderSafeMessage, classifyAwsProviderError } from "./aws-secrets-manager-discovery.js";

export class AwsSecretsManagerJsonGateway implements awsCredentials.AwsSecretsManagerGateway {
  private readonly endpoint: URL;

  constructor(private readonly config: awsCredentials.AwsSecretsManagerConfig) {
    this.endpoint = new URL(config.endpoint);
  }

  createSecret(input: {
    Name: string;
    SecretString: string;
    KmsKeyId?: string;
    Description?: string;
    Tags: awsCredentials.AwsSecretsManagerTag[];
  }) {
    return this.call<{
      ARN?: string;
      Name?: string;
      VersionId?: string;
    }>("CreateSecret", input);
  }

  putSecretValue(input: { SecretId: string; SecretString: string; VersionStages?: string[] }) {
    return this.call<{
      ARN?: string;
      Name?: string;
      VersionId?: string;
    }>("PutSecretValue", input);
  }

  getSecretValue(input: { SecretId: string; VersionId?: string; VersionStage?: string }) {
    return this.call<{
      SecretString?: string;
      ARN?: string;
      Name?: string;
      VersionId?: string;
    }>("GetSecretValue", input);
  }

  deleteSecret(input: { SecretId: string; RecoveryWindowInDays: number }) {
    return this.call("DeleteSecret", input);
  }

  updateSecretVersionStage(input: {
    SecretId: string;
    VersionStage: string;
    RemoveFromVersionId?: string;
    MoveToVersionId?: string;
  }) {
    return this.call("UpdateSecretVersionStage", input);
  }

  listSecrets(input: {
    MaxResults?: number;
    NextToken?: string;
    Filters?: Array<{
      Key: "all" | "name" | "description" | "tag-key" | "tag-value" | "primary-region" | "owning-service";
      Values: string[];
    }>;
    IncludePlannedDeletion?: boolean;
  }) {
    return this.call<{
      SecretList?: awsCredentials.AwsSecretsManagerListSecretEntry[];
      NextToken?: string;
    }>("ListSecrets", input);
  }

  private async call<T>(operation: string, payload: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(payload);
    const credentials = await awsCredentials.loadAwsCredentials(this.config.region);
    const headers = awsCredentials.signAwsSecretsManagerRequest({
      endpoint: this.endpoint,
      region: this.config.region,
      operation,
      body,
      credentials,
    });
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(awsCredentials.AWS_SECRETS_MANAGER_REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      const code = String(
        parsed.__type ?? parsed.code ?? parsed.Code ?? response.statusText ?? "UnknownError",
      );
      const message = String(parsed.message ?? parsed.Message ?? code);
      const rawMessage = `${code}: ${message}`;
      const clientCode = classifyAwsProviderError(rawMessage);
      throw new SecretProviderClientError({
        code: clientCode,
        provider: "aws_secrets_manager",
        operation,
        message: awsProviderSafeMessage(clientCode),
        rawMessage,
      });
    }

    return parsed as T;
  }
}
