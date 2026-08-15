import { secretsApi } from "@/api/secrets";
import { coverageSummaryLabel } from "@/routes/_authenticated/$companyId/company/settings/secrets/-user-secret-presentation";
import { queryKeys } from "@/lib/queryKeys";
import type { UserSecretCoverageSummary, UserSecretDefinition } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { DetailList } from "@/components/patterns/DetailList";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { relativeTime as formatRelative } from "@/lib/utils";

import { statusLabel } from "./-secrets-model";

export function CoverageInline({
  companyId,
  definitionId,
  compact = false,
}: {
  companyId: string;
  definitionId: string;
  compact?: boolean;
}) {
  const coverageQuery = useQuery({
    queryKey: queryKeys.secrets.userDefinitionCoverage(companyId, definitionId),
    queryFn: () => secretsApi.userSecretDefinitionCoverage(companyId, definitionId),
    staleTime: 30_000,
  });
  const summary = coverageQuery.data;
  if (coverageQuery.isPending) return <Spinner aria-label="Loading secret coverage" />;
  if (coverageQuery.isError) return <DomainStatus status="unhealthy">Coverage unavailable</DomainStatus>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
      <Users className="h-3 w-3" />
      <span className="truncate">
        {compact && summary
          ? `${summary.configuredCount}/${summary.configuredCount + summary.missingCount + summary.inactiveCount} set`
          : coverageSummaryLabel(summary)}
      </span>
      {summary && summary.missingCount > 0 ? (
        <DomainStatus status="missing">
          {compact ? `${summary.missingCount} miss` : `${summary.missingCount} missing`}
        </DomainStatus>
      ) : null}
    </span>
  );
}

export function UserSecretDetailsTab({
  companyId,
  definition,
  onViewCoverage,
}: {
  companyId: string;
  definition: UserSecretDefinition;
  onViewCoverage: () => void;
}) {
  const details = [
    {
      label: "Description",
      value: definition.description ?? <span className="text-muted-foreground">—</span>,
    },
    { label: "Provided by", value: "Each user" },
    { label: "Key", value: <code>{definition.key}</code> },
    {
      label: "Status",
      value: <DomainStatus status={definition.status}>{statusLabel(definition.status)}</DomainStatus>,
    },
    {
      label: "Coverage",
      value: (
        <Button type="button" variant="link" className="h-auto min-w-0 p-0" onClick={onViewCoverage}>
          <CoverageInline companyId={companyId} definitionId={definition.id} />
          <span className="shrink-0 text-muted-foreground">· View in Coverage</span>
        </Button>
      ),
    },
    { label: "Created", value: formatRelative(definition.createdAt) },
    { label: "Updated", value: formatRelative(definition.updatedAt) },
    {
      label: "Usage guidance",
      value: definition.usageGuidance ?? <span className="text-muted-foreground">—</span>,
    },
  ];

  return (
    <>
      <DetailList items={details} />
      <Alert className="mt-3">
        <AlertDescription>
          No value is stored on this admin row. Each member manages their own value under My secrets.
        </AlertDescription>
      </Alert>
    </>
  );
}

export function UserSecretCoverageTab({
  companyId,
  definitionId,
}: {
  companyId: string;
  definitionId: string;
}) {
  const coverageQuery = useQuery({
    queryKey: queryKeys.secrets.userDefinitionCoverage(companyId, definitionId),
    queryFn: () => secretsApi.userSecretDefinitionCoverage(companyId, definitionId),
    staleTime: 30_000,
  });
  if (coverageQuery.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner aria-label="Loading secret coverage" />
      </div>
    );
  }
  if (coverageQuery.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Coverage unavailable.</AlertDescription>
      </Alert>
    );
  }
  const summary: UserSecretCoverageSummary = coverageQuery.data;
  const total = summary.configuredCount + summary.missingCount + summary.inactiveCount;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5" />
        <span>{coverageSummaryLabel(summary)}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[
          ["Set", summary.configuredCount],
          ["Missing", summary.missingCount],
          ["Inactive", summary.inactiveCount],
        ].map(([label, value]) => (
          <Item key={label} variant="outline" size="sm">
            <ItemContent>
              <ItemTitle className="tabular-nums">{value}</ItemTitle>
              <ItemDescription>{label}</ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Coverage is counts only across {total} member{total === 1 ? "" : "s"}. Secret values are never shown
        here.
      </p>
    </div>
  );
}

export function UserSecretUsageTab({ definition }: { definition: UserSecretDefinition }) {
  return (
    <div className="space-y-3 text-xs text-muted-foreground">
      <Alert>
        <AlertDescription>
          Bind runtime environment variables to this user-provided secret by choosing{" "}
          <strong>User secret</strong> and selecting <code>{definition.key}</code>.
        </AlertDescription>
      </Alert>
      {definition.usageGuidance ? (
        <div>
          <p className="mb-1 text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
            Member guidance
          </p>
          <p className="text-foreground">{definition.usageGuidance}</p>
        </div>
      ) : null}
    </div>
  );
}
