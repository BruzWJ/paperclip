import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import type { RemoteSecretImportResult, RemoteSecretImportRowResult } from "@paperclipai/shared";
import { useMemo } from "react";

import { type DraftSelection, middleTruncate, type VaultImportStep } from "./-VaultImportUtils";

interface ResultStepProps {
  result: RemoteSecretImportResult;
  draftList: DraftSelection[];
}

export function ResultStep({ result, draftList }: ResultStepProps) {
  const grouped = useMemo(() => {
    const created: RemoteSecretImportRowResult[] = [];
    const skipped: RemoteSecretImportRowResult[] = [];
    const failed: RemoteSecretImportRowResult[] = [];
    for (const row of result.results) {
      if (row.status === "imported") created.push(row);
      else if (row.status === "skipped") skipped.push(row);
      else failed.push(row);
    }
    return { created, skipped, failed };
  }, [result]);

  const draftLookup = useMemo(() => {
    const map = new Map<string, DraftSelection>();
    for (const draft of draftList) map.set(draft.candidate.externalRef, draft);
    return map;
  }, [draftList]);

  const heading =
    result.errorCount === result.results.length && result.errorCount > 0
      ? "Import failed"
      : result.errorCount === 0 && result.skippedCount === 0
        ? `All ${result.importedCount} secrets imported`
        : "Import complete";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Alert data-testid="result-summary">
        <AlertTitle>{heading}</AlertTitle>
        <AlertDescription>
          <DomainStatus status="imported">{result.importedCount} created</DomainStatus>
          <DomainStatus status="skipped">{result.skippedCount} skipped</DomainStatus>
          <DomainStatus status="failed">{result.errorCount} failed</DomainStatus>
        </AlertDescription>
      </Alert>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {grouped.created.length > 0 && (
          <ResultGroup label="Created" rows={grouped.created} draftLookup={draftLookup} />
        )}
        {grouped.skipped.length > 0 && (
          <ResultGroup label="Skipped" rows={grouped.skipped} draftLookup={draftLookup} />
        )}
        {grouped.failed.length > 0 && (
          <ResultGroup label="Failed" rows={grouped.failed} draftLookup={draftLookup} />
        )}
      </div>
    </div>
  );
}

export function ResultGroup({
  label,
  rows,
  draftLookup,
}: {
  label: string;
  rows: RemoteSecretImportRowResult[];
  draftLookup: Map<string, DraftSelection>;
}) {
  return (
    <section>
      <header className="bg-muted/30 px-5 py-1.5 text-xs uppercase tracking-wide text-muted-foreground">
        {label} · {rows.length}
      </header>
      <ItemGroup>
        {rows.map((row) => {
          const draft = draftLookup.get(row.externalRef);
          const remoteName = draft?.candidate.remoteName ?? row.name;
          return (
            <Item
              key={row.externalRef}
              variant="outline"
              data-testid={`result-row-${row.externalRef}`}
              data-row-status={row.status}
            >
              <ItemContent>
                <ItemTitle>
                  <DomainStatus status={row.status}>
                    {row.status === "imported" ? "Created" : row.status === "skipped" ? "Skipped" : "Failed"}
                  </DomainStatus>
                  {row.name}
                </ItemTitle>
                <ItemDescription>{row.key}</ItemDescription>
                <ItemDescription title={row.externalRef}>
                  {middleTruncate(row.externalRef, 40)}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {row.status === "imported" && row.secretId && <span>{remoteName}</span>}
                {row.reason && <span title={row.reason}>{row.reason}</span>}
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>
    </section>
  );
}

interface FooterStatusProps {
  step: VaultImportStep;
  totalSelected: number;
  readyReviewCount: number;
  blockedReviewCount: number;
  result: RemoteSecretImportResult | null;
}

export function FooterStatus({
  step,
  totalSelected,
  readyReviewCount,
  blockedReviewCount,
  result,
}: FooterStatusProps) {
  if (step === "select") {
    return (
      <div className="text-xs text-muted-foreground">
        {totalSelected === 0 ? "Select remote secrets to import" : `${totalSelected} selected`}
      </div>
    );
  }
  if (step === "review") {
    return (
      <div className="text-xs text-muted-foreground">
        {readyReviewCount} ready
        {blockedReviewCount > 0 && <DomainStatus status="blocked">{blockedReviewCount} blocked</DomainStatus>}
      </div>
    );
  }
  if (result) {
    return (
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{result.importedCount} created</span>
        <span>{result.skippedCount} skipped</span>
        <span>{result.errorCount} failed</span>
      </div>
    );
  }
  return null;
}
