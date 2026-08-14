import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { SecretProvider } from "@paperclipai/shared";
import { AlertCircle } from "lucide-react";

import { apiErrorDetails, readableErrorMessage } from "./-secrets-model";

export function SafeProviderErrorDetails({ details }: { details: Record<string, unknown> }) {
  const text = JSON.stringify(details, null, 2);
  return (
    <div>
      <p className="text-sm font-medium">Safe request/error details</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void navigator.clipboard?.writeText(text)}
      >
        Copy safe error details
      </Button>
      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-(length:--text-micro)">
        {text}
      </pre>
    </div>
  );
}

export function SecretCreateError({
  error,
  provider,
  providerConfigId,
}: {
  error: unknown;
  provider: SecretProvider;
  providerConfigId: string | null;
}) {
  const details = apiErrorDetails(error);
  const message = readableErrorMessage(error);
  const isAwsCreateError =
    details?.provider === "aws_secrets_manager" && details.operation === "secret.create";
  const isAccessDenied = isAwsCreateError && details.code === "access_denied";
  const safeDetails = {
    message,
    status: error instanceof ApiError ? error.status : undefined,
    provider: details?.provider ?? provider,
    operation: details?.operation ?? "secret.create",
    providerConfigId: details?.providerConfigId ?? providerConfigId ?? "deployment-default",
    region: details?.region,
    code: details?.code,
    requiredCapability: details?.requiredCapability,
    credentialPath: details?.credentialPath,
    safeAlternative: details?.safeAlternative,
  };

  if (!isAwsCreateError) {
    return (
      <Alert variant="destructive" data-testid="secret-create-error">
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive" data-testid="secret-create-error">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>
        {isAccessDenied ? "AWS secret creation needs CreateSecret permission" : "AWS secret creation failed"}
      </AlertTitle>
      <AlertDescription>
        <p>{details?.actionableMessage ?? message}</p>
        {details?.safeAlternative ? <p>{details.safeAlternative}</p> : null}
        <dl className="grid gap-1 text-destructive/80 sm:grid-cols-2">
          {details?.requiredCapability ? (
            <div>
              <dt className="font-medium">Required IAM capability</dt>
              <dd className="font-mono">{details.requiredCapability}</dd>
            </div>
          ) : null}
          {details?.region ? (
            <div>
              <dt className="font-medium">Region</dt>
              <dd>{details.region}</dd>
            </div>
          ) : null}
          <div>
            <dt className="font-medium">Provider vault</dt>
            <dd className="break-all">
              {details?.providerConfigId ?? providerConfigId ?? "Deployment default"}
            </dd>
          </div>
          <div>
            <dt className="font-medium">Operation</dt>
            <dd>{details?.operation ?? "secret.create"}</dd>
          </div>
        </dl>
        <SafeProviderErrorDetails details={safeDetails} />
      </AlertDescription>
    </Alert>
  );
}
