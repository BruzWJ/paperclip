import { Spinner } from "@/components/ui/spinner";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import type {
  SecretProviderConfigDiscoveryCandidate,
  SecretProviderConfigDiscoveryPreviewResult,
} from "@paperclipai/shared";
import { AlertCircle, AlertTriangle, Database, Search } from "lucide-react";

import {
  apiErrorDetails,
  isAwsDiscoveryAccessDenied,
  providerConfigValue,
  ProviderVaultForm,
  readableErrorMessage,
} from "./-secrets-model";
import { ProviderErrorDetails } from "./-ProviderVaultErrors";

export function AwsProviderVaultDiscoveryPanel({
  form,
  preview,
  error,
  loading,
  onDiscover,
  onApply,
}: {
  form: ProviderVaultForm;
  preview: SecretProviderConfigDiscoveryPreviewResult | null;
  error: unknown | null;
  loading: boolean;
  onDiscover: () => void;
  onApply: (candidate: SecretProviderConfigDiscoveryCandidate) => void;
}) {
  const canDiscover = Boolean(form.region.trim());
  const warnings = preview?.warnings ?? [];

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">AWS discovery</p>
          <p className="text-xs text-muted-foreground">
            Uses the current draft routing fields to inspect AWS Secrets Manager metadata. Values are not
            read.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onDiscover}
          disabled={!canDiscover || loading}
          data-testid="aws-vault-discovery-button"
        >
          {loading ? <Spinner className="h-3.5 w-3.5 mr-1" /> : <Search className="h-3.5 w-3.5 mr-1" />}
          Find existing AWS values
        </Button>
      </div>

      {!canDiscover ? (
        <p className="text-xs text-muted-foreground">Enter an AWS region before discovery.</p>
      ) : null}

      {loading ? (
        <Alert>
          <Spinner />
          <AlertDescription>Searching AWS Secrets Manager metadata</AlertDescription>
        </Alert>
      ) : null}

      {error ? <AwsProviderVaultDiscoveryError form={form} error={error} /> : null}

      {warnings.length > 0 ? (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Discovery warnings</AlertTitle>
          <AlertDescription>{warnings.join(" ")}</AlertDescription>
        </Alert>
      ) : null}

      {preview && preview.candidates.length === 0 && !loading ? (
        <Alert>
          <AlertDescription>
            No AWS vault metadata candidates found. Manual entry is still available.
          </AlertDescription>
        </Alert>
      ) : null}

      {preview && preview.candidates.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Database className="h-3.5 w-3.5" />
            <span>
              {preview.candidates.length} candidate
              {preview.candidates.length === 1 ? "" : "s"} from {preview.sampledSecretCount} sampled secret
              {preview.sampledSecretCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="space-y-2" data-testid="aws-vault-discovery-candidates">
            {preview.candidates.map((candidate, index) => (
              <AwsProviderVaultDiscoveryCandidateRow
                key={`${candidate.displayName}-${index}`}
                candidate={candidate}
                onApply={() => onApply(candidate)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AwsProviderVaultDiscoveryError({ form, error }: { form: ProviderVaultForm; error: unknown }) {
  const details = apiErrorDetails(error);
  const isAccessDenied = isAwsDiscoveryAccessDenied(error);
  const region = (details?.region ?? form.region.trim()) || "unspecified";
  const message = readableErrorMessage(error);
  const safeDetails = {
    message,
    status: error instanceof ApiError ? error.status : undefined,
    provider: details?.provider ?? form.provider,
    operation: details?.operation ?? "secret_provider_config.discovery.preview",
    providerVaultContext: details?.providerVaultContext ?? "draft_config",
    region,
    code: details?.code,
    requiredCapability: details?.requiredCapability,
    credentialPath: details?.credentialPath,
    safeAlternative: details?.safeAlternative,
  };
  return (
    <Alert variant="destructive" data-testid="aws-vault-discovery-error">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>
        {isAccessDenied ? "AWS discovery needs ListSecrets permission" : "AWS discovery failed"}
      </AlertTitle>
      <AlertDescription>
        <p>
          {isAccessDenied
            ? (details?.actionableMessage ??
              "Discovery needs secretsmanager:ListSecrets in the selected region for the Paperclip server runtime/provider credential path.")
            : message}
        </p>
        {isAccessDenied ? (
          <p>
            {details?.safeAlternative ??
              "If you already know the exact AWS Secrets Manager ARN, paste/link that ARN instead of using discovery. Exact-resource DescribeSecret and runtime read permissions are still required."}
          </p>
        ) : null}
        <dl className="grid gap-1 text-destructive/80 sm:grid-cols-2">
          <div>
            <dt className="font-medium">Region</dt>
            <dd>{region}</dd>
          </div>
          <div>
            <dt className="font-medium">Operation</dt>
            <dd>{details?.operation ?? "secret_provider_config.discovery.preview"}</dd>
          </div>
          <div>
            <dt className="font-medium">Provider</dt>
            <dd>{details?.provider ?? "aws_secrets_manager"}</dd>
          </div>
          <div>
            <dt className="font-medium">Vault context</dt>
            <dd>{details?.providerVaultContext ?? "draft_config"}</dd>
          </div>
        </dl>
        <ProviderErrorDetails details={safeDetails} />
      </AlertDescription>
    </Alert>
  );
}

export function AwsProviderVaultDiscoveryCandidateRow({
  candidate,
  onApply,
}: {
  candidate: SecretProviderConfigDiscoveryCandidate;
  onApply: () => void;
}) {
  const fieldSummary = [
    providerConfigValue(candidate.config, "region"),
    providerConfigValue(candidate.config, "namespace"),
    providerConfigValue(candidate.config, "secretNamePrefix"),
  ].filter(Boolean);

  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>
          {candidate.displayName}
          <span>
            {candidate.sampleCount} sample
            {candidate.sampleCount === 1 ? "" : "s"}
          </span>
        </ItemTitle>
        <ItemDescription>
          {fieldSummary.length > 0 ? fieldSummary.join(" / ") : "No stable namespace or prefix detected"}
        </ItemDescription>
        {candidate.samples[0] ? <ItemDescription>{candidate.samples[0].name}</ItemDescription> : null}
      </ItemContent>
      <ItemActions>
        <Button type="button" variant="ghost" size="sm" onClick={onApply}>
          Use values
        </Button>
      </ItemActions>
      {candidate.warnings.length > 0 ? (
        <Alert>
          <AlertTriangle />
          <AlertDescription>{candidate.warnings.join(" ")}</AlertDescription>
        </Alert>
      ) : null}
    </Item>
  );
}
