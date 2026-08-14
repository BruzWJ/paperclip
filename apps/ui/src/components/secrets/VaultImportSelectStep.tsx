import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { FieldLabel } from "@/components/ui/field";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { CompanySecretProviderConfig, RemoteSecretImportCandidate } from "@paperclipai/shared";
import {
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Cloud,
  Database,
  ExternalLink,
  Link2,
  RefreshCw,
  Search,
} from "lucide-react";

import {
  type DraftSelection,
  formatRelativeShort,
  isPermissionError,
  isThrottlingError,
  isAwsSelectable,
  middleTruncate,
  readableErrorMessage,
} from "./VaultImportUtils";
import { statusBadgeLabel } from "./VaultImportUtils";

const PAGE_SIZE = 50;

interface SelectStepProps {
  awsVaults: CompanySecretProviderConfig[];
  eligible: CompanySecretProviderConfig[];
  vaultId: string | null;
  onVaultChange: (id: string) => void;
  searchInput: string;
  onSearchInput: (value: string) => void;
  debouncedQuery: string;
  onRefresh: () => void;
  previewLoading: boolean;
  pageLoading: boolean;
  previewError: unknown;
  candidates: RemoteSecretImportCandidate[];
  visibleCandidates: RemoteSecretImportCandidate[];
  selectableInLoaded: RemoteSecretImportCandidate[];
  selection: Map<string, DraftSelection>;
  toggleRow: (candidate: RemoteSecretImportCandidate) => void;
  toggleAllLoaded: () => void;
  headerCheckboxState: boolean | "indeterminate";
  hasNextPage: boolean;
  onLoadMore: () => void;
  showOnlySelected: boolean;
  onShowOnlySelectedChange: (value: boolean) => void;
  selectedNotVisible: number;
  noEligibleVaults: boolean;
  onManageVaults?: () => void;
}

export function SelectStep(props: SelectStepProps) {
  const {
    awsVaults,
    eligible,
    vaultId,
    onVaultChange,
    searchInput,
    onSearchInput,
    debouncedQuery,
    onRefresh,
    previewLoading,
    pageLoading,
    previewError,
    candidates,
    visibleCandidates,
    selectableInLoaded,
    selection,
    toggleRow,
    toggleAllLoaded,
    headerCheckboxState,
    hasNextPage,
    onLoadMore,
    showOnlySelected,
    onShowOnlySelectedChange,
    selectedNotVisible,
    noEligibleVaults,
    onManageVaults,
  } = props;
  const permissionError = Boolean(previewError && isPermissionError(previewError));
  const previewErrorTitle = permissionError
    ? "AWS denied list access"
    : previewError && isThrottlingError(previewError)
      ? "AWS throttled the listing request"
      : "Could not load remote secrets";

  if (noEligibleVaults) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6" data-testid="select-empty-vaults">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Cloud />
            </EmptyMedia>
            <EmptyTitle>No AWS provider vault configured. Add one to import secrets.</EmptyTitle>
          </EmptyHeader>
          {onManageVaults ? (
            <EmptyContent>
              <Button onClick={onManageVaults}>Manage vaults</Button>
            </EmptyContent>
          ) : null}
        </Empty>
      </div>
    );
  }

  const showSearchSpinner = previewLoading && Boolean(debouncedQuery);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-3">
        <FieldLabel htmlFor="vault-import-source">Vault</FieldLabel>
        {awsVaults.length === 1 && eligible.length === 1 ? (
          <span className="text-xs font-medium" data-testid="vault-static-label">
            {eligible[0].displayName}
          </span>
        ) : (
          <Select value={vaultId ?? undefined} onValueChange={onVaultChange}>
            <SelectTrigger
              id="vault-import-source"
              size="sm"
              className="text-xs"
              aria-label="Select AWS vault"
            >
              <SelectValue placeholder="Select an AWS vault" />
            </SelectTrigger>
            <SelectContent>
              {awsVaults.map((vault) => {
                const blocked = !isAwsSelectable(vault);
                return (
                  <SelectItem key={vault.id} value={vault.id} disabled={blocked} aria-disabled={blocked}>
                    <span className="flex items-center gap-2">
                      <span>{vault.displayName}</span>
                      {vault.isDefault && <Badge>default</Badge>}
                      {vault.status === "warning" && <Badge variant="secondary">warning</Badge>}
                      {blocked && (
                        <Badge variant="outline">
                          {vault.status === "coming_soon" ? "coming soon" : vault.status}
                        </Badge>
                      )}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        )}

        <InputGroup className="ml-auto w-64">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={searchInput}
            onChange={(event) => onSearchInput(event.target.value)}
            placeholder="Search by name, ARN, tag"
            className="text-xs"
            aria-label="Search remote secrets"
            data-testid="vault-search"
          />
          {showSearchSpinner && (
            <InputGroupAddon align="inline-end">
              <Spinner />
            </InputGroupAddon>
          )}
        </InputGroup>

        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={previewLoading || !vaultId}
          aria-label="Refresh remote secrets"
        >
          {previewLoading ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {selectedNotVisible > 0 && (
        <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-5 py-1.5 text-xs text-muted-foreground">
          <span>
            {selection.size} selected · {selectedNotVisible} not visible with current search
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onShowOnlySelectedChange(!showOnlySelected)}
          >
            {showOnlySelected ? "Show all" : "Show selected"}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="vault-table-scroll">
        {previewError ? (
          <Alert variant="destructive" className="m-5" data-testid="preview-error-banner">
            <AlertCircle />
            <AlertTitle>{previewErrorTitle}</AlertTitle>
            <AlertDescription>
              <p>
                {permissionError
                  ? "The AWS principal behind this vault is missing secretsmanager:ListSecrets. Update IAM and try again."
                  : readableErrorMessage(previewError)}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={onRefresh}>
                  <RefreshCw /> Retry
                </Button>
                {permissionError ? (
                  <a
                    href="https://docs.aws.amazon.com/service-authorization/latest/reference/list_awssecretsmanager.html"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium underline"
                  >
                    IAM reference <ExternalLink />
                  </a>
                ) : null}
              </div>
            </AlertDescription>
          </Alert>
        ) : previewLoading && candidates.length === 0 ? (
          <div className="flex flex-col gap-1.5 p-3">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : candidates.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">{debouncedQuery ? <Search /> : <Database />}</EmptyMedia>
              <EmptyTitle>{debouncedQuery ? "No matching remote secrets" : "No remote secrets"}</EmptyTitle>
              <EmptyDescription>
                {debouncedQuery
                  ? `No remote secrets match "${debouncedQuery}".`
                  : "No secrets are visible to this vault."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table className="text-sm">
            <TableHeader className="sticky top-0 z-10 bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <TableRow>
                <TableHead className="px-3 py-2 text-left">
                  <Checkbox
                    checked={headerCheckboxState}
                    onCheckedChange={() => toggleAllLoaded()}
                    aria-label={`Select all loaded (${selectableInLoaded.length})`}
                    disabled={selectableInLoaded.length === 0}
                  />
                </TableHead>
                <TableHead className="px-2 py-2 text-left font-medium">Remote name</TableHead>
                <TableHead className="px-2 py-2 text-left font-medium">Reference</TableHead>
                <TableHead className="px-2 py-2 text-left font-medium">Last changed</TableHead>
                <TableHead className="px-2 py-2 text-left font-medium">Suggested name</TableHead>
                <TableHead className="px-2 py-2 text-left font-medium">State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody data-testid="vault-table-body">
              {visibleCandidates.map((candidate) => {
                const isSelected = selection.has(candidate.externalRef);
                const meta = (candidate.providerMetadata ?? {}) as Record<string, unknown>;
                const lastChanged =
                  typeof meta.lastChangedAt === "string"
                    ? meta.lastChangedAt
                    : typeof meta.lastChangedDate === "string"
                      ? meta.lastChangedDate
                      : null;
                return (
                  <TableRow
                    key={candidate.externalRef}
                    className={cn(
                      "border-b border-border/60 transition-colors",
                      candidate.importable
                        ? "cursor-pointer hover:bg-accent/40"
                        : "cursor-not-allowed text-muted-foreground",
                      isSelected && "bg-accent/60",
                    )}
                    onClick={() => toggleRow(candidate)}
                    data-testid={`vault-row-${candidate.externalRef}`}
                    data-row-state={candidate.status}
                  >
                    <TableCell className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleRow(candidate)}
                        disabled={!candidate.importable}
                        aria-label={`Select ${candidate.remoteName}`}
                      />
                    </TableCell>
                    <TableCell className="px-2 py-2.5">
                      <div className="text-sm font-medium leading-tight">{candidate.remoteName}</div>
                    </TableCell>
                    <TableCell className="px-2 py-2.5 text-xs">
                      <span className="font-mono text-muted-foreground" title={candidate.externalRef}>
                        {middleTruncate(candidate.externalRef, 50)}
                      </span>
                    </TableCell>
                    <TableCell className="px-2 py-2.5 text-xs text-muted-foreground">
                      {formatRelativeShort(lastChanged)}
                    </TableCell>
                    <TableCell className="px-2 py-2.5 text-xs font-mono">{candidate.key}</TableCell>
                    <TableCell className="px-2 py-2.5 text-xs">
                      <div className="flex items-center gap-1.5">
                        <Badge variant={candidate.status === "conflict" ? "destructive" : "outline"}>
                          {candidate.status === "conflict" ? (
                            <AlertTriangle />
                          ) : candidate.status === "duplicate" ? (
                            <Link2 />
                          ) : (
                            <CheckCircle2 />
                          )}
                          {statusBadgeLabel(candidate.status)}
                        </Badge>
                        {candidate.status === "duplicate" &&
                          candidate.conflicts.find((c) => c.type === "exact_reference")?.existingSecretId && (
                            <span className="text-(length:--text-micro) text-muted-foreground">
                              Already imported
                            </span>
                          )}
                      </div>
                      {candidate.status === "conflict" && candidate.conflicts.length > 0 && (
                        <div className="text-destructive">{candidate.conflicts[0].message}</div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {pageLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="p-0">
                    <div className="flex flex-col gap-1.5 p-3">
                      {Array.from({ length: 4 }).map((_, index) => (
                        <Skeleton key={index} className="h-8 w-full" />
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}

        {hasNextPage && !previewError && (
          <div className="flex items-center justify-between border-t border-border/60 px-5 py-2 text-xs text-muted-foreground">
            <span>
              {candidates.length} loaded
              {selectableInLoaded.length > 0 && <span> · {selectableInLoaded.length} selectable</span>}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={onLoadMore}
              disabled={pageLoading}
              data-testid="vault-load-more"
            >
              {pageLoading ? (
                <>
                  <Spinner className="mr-1.5 h-3.5 w-3.5" /> Loading…
                </>
              ) : (
                `Load ${PAGE_SIZE} more`
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
