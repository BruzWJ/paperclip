import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DataTable, DataTableColumnHeader, type ColumnDef } from "@/components/patterns/DataTable";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { EntityCombobox } from "@/components/patterns/EntityCombobox";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn, relativeTime as formatRelativeShort } from "@/lib/utils";
import type { CompanySecretProviderConfig, RemoteSecretImportCandidate } from "@paperclipai/shared";
import { useMemo, type KeyboardEvent } from "react";
import { AlertCircle, Cloud, Database, ExternalLink, RefreshCw, Search } from "lucide-react";

import {
  type DraftSelection,
  isPermissionError,
  isThrottlingError,
  isAwsSelectable,
  middleTruncate,
  readableErrorMessage,
} from "./-VaultImportUtils";
import { statusBadgeLabel } from "./-VaultImportUtils";

const PAGE_SIZE = 50;

function candidateCellClassName(candidate: RemoteSecretImportCandidate, className?: string) {
  return cn("-m-2 p-2", candidate.importable ? "cursor-pointer" : "cursor-not-allowed", className);
}

function selectableCellKeyDown(onToggle: () => void) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle();
    }
  };
}

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
  const columns = useMemo<ColumnDef<RemoteSecretImportCandidate>[]>(
    () => [
      {
        id: "selection",
        enableSorting: false,
        header: () => (
          <Checkbox
            checked={headerCheckboxState}
            onCheckedChange={() => toggleAllLoaded()}
            aria-label={`Select all loaded (${selectableInLoaded.length})`}
            disabled={selectableInLoaded.length === 0}
          />
        ),
        cell: ({ row }) => {
          const candidate = row.original;
          const isSelected = selection.has(candidate.externalRef);
          return (
            <div
              className="-m-2 p-2"
              data-testid={`vault-row-${candidate.externalRef}`}
              data-row-state={candidate.status}
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation();
                if (event.target === event.currentTarget) toggleRow(candidate);
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggleRow(candidate);
                }
              }}
            >
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => toggleRow(candidate)}
                disabled={!candidate.importable}
                aria-label={`Select ${candidate.remoteName}`}
              />
            </div>
          );
        },
      },
      {
        accessorKey: "remoteName",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Remote name" />,
        cell: ({ row }) => (
          <div
            className={candidateCellClassName(row.original)}
            role="button"
            tabIndex={0}
            onClick={() => toggleRow(row.original)}
            onKeyDown={selectableCellKeyDown(() => toggleRow(row.original))}
          >
            <div className="text-sm font-medium leading-tight">{row.original.remoteName}</div>
          </div>
        ),
      },
      {
        accessorKey: "externalRef",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Reference" />,
        cell: ({ row }) => (
          <div
            className={candidateCellClassName(row.original)}
            role="button"
            tabIndex={0}
            onClick={() => toggleRow(row.original)}
            onKeyDown={selectableCellKeyDown(() => toggleRow(row.original))}
          >
            <span className="font-mono text-muted-foreground" title={row.original.externalRef}>
              {middleTruncate(row.original.externalRef, 50)}
            </span>
          </div>
        ),
      },
      {
        id: "lastChanged",
        accessorFn: (candidate) => {
          const meta = (candidate.providerMetadata ?? {}) as Record<string, unknown>;
          return typeof meta.lastChangedAt === "string"
            ? meta.lastChangedAt
            : typeof meta.lastChangedDate === "string"
              ? meta.lastChangedDate
              : "";
        },
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last changed" />,
        cell: ({ row, getValue }) => (
          <div
            className={candidateCellClassName(row.original)}
            role="button"
            tabIndex={0}
            onClick={() => toggleRow(row.original)}
            onKeyDown={selectableCellKeyDown(() => toggleRow(row.original))}
          >
            {formatRelativeShort(getValue<string>() || null)}
          </div>
        ),
      },
      {
        accessorKey: "key",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Suggested name" />,
        cell: ({ row }) => (
          <div
            className={candidateCellClassName(row.original, "font-mono")}
            role="button"
            tabIndex={0}
            onClick={() => toggleRow(row.original)}
            onKeyDown={selectableCellKeyDown(() => toggleRow(row.original))}
          >
            {row.original.key}
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: ({ column }) => <DataTableColumnHeader column={column} title="State" />,
        cell: ({ row }) => {
          const candidate = row.original;
          return (
            <div
              className={candidateCellClassName(candidate)}
              role="button"
              tabIndex={0}
              onClick={() => toggleRow(candidate)}
              onKeyDown={selectableCellKeyDown(() => toggleRow(candidate))}
            >
              <div className="flex items-center gap-1.5">
                <DomainStatus status={candidate.status}>{statusBadgeLabel(candidate.status)}</DomainStatus>
                {candidate.status === "duplicate" &&
                  candidate.conflicts.find((conflict) => conflict.type === "exact_reference")
                    ?.existingSecretId && (
                    <span className="text-(length:--text-micro) text-muted-foreground">Already imported</span>
                  )}
              </div>
              {candidate.status === "conflict" && candidate.conflicts.length > 0 && (
                <div className="text-destructive">{candidate.conflicts[0].message}</div>
              )}
            </div>
          );
        },
      },
    ],
    [headerCheckboxState, selectableInLoaded.length, selection, toggleAllLoaded, toggleRow],
  );

  if (noEligibleVaults) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6" data-testid="select-empty-vaults">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Cloud  data-icon="inline-start"/>
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
  const vaultById = new Map(awsVaults.map((vault) => [vault.id, vault]));
  const vaultOptions = awsVaults.map((vault) => ({
    id: vault.id,
    label: vault.displayName,
    searchText: `${vault.displayName} ${vault.status}`,
    disabled: !isAwsSelectable(vault),
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-3">
        <LabeledFormField
          orientation="horizontal"
          className="w-auto gap-2"
          label="Vault"
          labelFor="vault-import-source"
        >
          {awsVaults.length === 1 && eligible.length === 1 ? (
            <span className="text-xs font-medium" data-testid="vault-static-label">
              {eligible[0].displayName}
            </span>
          ) : (
            <EntityCombobox
              value={vaultId ?? ""}
              options={vaultOptions}
              onValueChange={onVaultChange}
              type="AWS vault"
              ariaLabel="Select AWS vault"
              placeholder="Select an AWS vault"
              noneLabel="Select an AWS vault"
              includeNone={false}
              triggerClassName="h-8 w-auto text-xs"
              triggerProps={{ id: "vault-import-source", size: "sm" }}
              renderOption={(option) => {
                const vault = vaultById.get(option.id);
                if (!vault) return option.label;
                const blocked = !isAwsSelectable(vault);
                return (
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate">{vault.displayName}</span>
                    {vault.isDefault ? <Badge>default</Badge> : null}
                    {vault.status === "warning" ? <DomainStatus status="warning" /> : null}
                    {blocked ? (
                      <DomainStatus status={vault.status}>
                        {vault.status === "coming_soon" ? "coming soon" : vault.status}
                      </DomainStatus>
                    ) : null}
                  </span>
                );
              }}
            />
          )}
        </LabeledFormField>

        <InputGroup className="ml-auto w-64">
          <InputGroupAddon>
            <Search  data-icon="inline-start"/>
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
          {previewLoading ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5"  data-icon="inline-start"/>}
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
            <AlertCircle  data-icon="inline-start"/>
            <AlertTitle>{previewErrorTitle}</AlertTitle>
            <AlertDescription>
              <p>
                {permissionError
                  ? "The AWS principal behind this vault is missing secretsmanager:ListSecrets. Update IAM and try again."
                  : readableErrorMessage(previewError)}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={onRefresh}>
                  <RefreshCw  data-icon="inline-start"/> Retry
                </Button>
                {permissionError ? (
                  <a
                    href="https://docs.aws.amazon.com/service-authorization/latest/reference/list_awssecretsmanager.html"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium underline"
                  >
                    IAM reference <ExternalLink  data-icon="inline-start"/>
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
              <EmptyMedia variant="icon">{debouncedQuery ? <Search  data-icon="inline-start"/> : <Database  data-icon="inline-start"/>}</EmptyMedia>
              <EmptyTitle>{debouncedQuery ? "No matching remote secrets" : "No remote secrets"}</EmptyTitle>
              <EmptyDescription>
                {debouncedQuery
                  ? `No remote secrets match "${debouncedQuery}".`
                  : "No secrets are visible to this vault."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div data-testid="vault-table-body">
            <DataTable
              caption="Remote secrets"
              columns={columns}
              data={visibleCandidates}
              className="text-sm"
              headerClassName="sticky top-0 z-10 bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground"
              rowClassName={(candidate) =>
                cn(
                  "border-b border-border/60 transition-colors",
                  candidate.importable ? "hover:bg-accent/40" : "text-muted-foreground",
                  selection.has(candidate.externalRef) && "bg-accent/60",
                )
              }
              getHeadClassName={(columnId) =>
                columnId === "selection" ? "px-3 py-2 text-left" : "px-2 py-2 text-left font-medium"
              }
              getCellClassName={(_candidate, columnId) =>
                columnId === "selection"
                  ? "px-3 py-2.5"
                  : columnId === "remoteName"
                    ? "px-2 py-2.5"
                    : "px-2 py-2.5 text-xs"
              }
            />
            {pageLoading ? (
              <div className="flex flex-col gap-1.5 p-3">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-8 w-full" />
                ))}
              </div>
            ) : null}
          </div>
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
