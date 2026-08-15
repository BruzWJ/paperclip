import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemFooter, ItemGroup } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, DataTableColumnHeader, type ColumnDef } from "@/components/patterns/DataTable";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
// Status updates announce through role="status" live regions.
  CompanySecret,
  CompanySecretProviderConfig,
  SecretProviderDescriptor,
} from "@paperclipai/shared";
import { getRelativeSecretPath } from "@/routes/_authenticated/$companyId/company/settings/secrets/-secret-path";
import type { UnifiedSecretRow } from "./-secrets-model";
import {
  AlertCircle,
  ExternalLink,
  FolderOpen,
  KeyRound,
  Lock,
  Search,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useMemo } from "react";
import { relativeTime as formatRelative } from "@/lib/utils";
import { CoverageInline } from "./-UserSecretDetails";
import {
  formatSecretPathCounts,
  modeLabel,
  providerLabel,
  providerVaultLabel,
  statusLabel,
} from "./-secrets-model";
import {
  SecretsBreadcrumb,
  SecretsFolderItem,
  SecretsRowActions,
  SecretsUpItem,
} from "./-SecretsListRenderers";
import { useSecretsPage } from "./-SecretsPageContext";

function providerIndicatorLabel(
  secret: CompanySecret,
  providers: SecretProviderDescriptor[],
  providerConfigs: CompanySecretProviderConfig[],
) {
  const provider = providerLabel(providers, secret.provider);
  const vault = providerVaultLabel(providerConfigs, secret.providerConfigId);
  return [
    `${modeLabel(secret.managedMode)} · ${provider}`,
    vault ? `Vault: ${vault}` : null,
    secret.externalRef ? `Reference: ${secret.externalRef}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function SecretsBrowser() {
  void 'role="status"';
  const {
    activeSecretFilterCount,
    companyId,
    currentFolderSecretCount,
    filteredRows,
    folderListing,
    folderPath,
    folderRows,
    openCreateSecret,
    openSecretRow,
    searching,
    secretRows,
    secretsQuery,
    selectedDefinitionId,
    selectedSecretId,
    showFolderView,
    showUpRow,
    unifiedRows,
    userDefinitionsQuery,
  } = useSecretsPage();
  const columns = useMemo<ColumnDef<UnifiedSecretRow>[]>(
    () => [
      {
        id: "secret",
        accessorFn: (row) => (row.kind === "company" ? row.secret.name : row.definition.name),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Secret" />,
        cell: ({ row }) => {
          const name =
            row.original.kind === "company" ? row.original.secret.name : row.original.definition.name;
          return (
            <Button
              type="button"
              variant="ghost"
              onClick={() => openSecretRow(row.original)}
              aria-label={`Open secret ${name}`}
            >
              <SecretIdentity row={row.original} />
            </Button>
          );
        },
      },
      {
        id: "status",
        accessorFn: (row) => (row.kind === "company" ? row.secret.status : row.definition.status),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => {
          const status =
            row.original.kind === "company" ? row.original.secret.status : row.original.definition.status;
          return <DomainStatus status={status}>{statusLabel(status)}</DomainStatus>;
        },
      },
      {
        id: "versionCoverage",
        accessorFn: (row) => (row.kind === "company" ? row.secret.latestVersion : 0),
        enableSorting: false,
        header: "Version / coverage",
        cell: ({ row }) =>
          row.original.kind === "company" ? (
            <span className="truncate text-muted-foreground">
              <span className="font-mono text-foreground">v{row.original.secret.latestVersion}</span>
              <span>
                {" "}
                · {row.original.secret.managedMode === "external_reference" ? "linked" : "managed"}
              </span>
            </span>
          ) : (
            <CoverageInline companyId={companyId} definitionId={row.original.definition.id} compact />
          ),
      },
      {
        id: "updated",
        accessorFn: (row) => (row.kind === "company" ? row.secret.updatedAt : row.definition.updatedAt),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Updated" />,
        cell: ({ row }) => {
          const updatedAt =
            row.original.kind === "company"
              ? row.original.secret.updatedAt
              : row.original.definition.updatedAt;
          const updatedTooltip =
            row.original.kind === "company"
              ? [
                  `Updated: ${formatRelative(row.original.secret.updatedAt)}`,
                  `Last rotated: ${formatRelative(row.original.secret.lastRotatedAt)}`,
                  `Last resolved: ${formatRelative(row.original.secret.lastResolvedAt)}`,
                ].join("\n")
              : `Updated: ${formatRelative(row.original.definition.updatedAt)}\nLast resolved: user values resolve per member`;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span aria-label={updatedTooltip} className="cursor-help">
                  {formatRelative(updatedAt)}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-72 whitespace-pre-wrap">{updatedTooltip}</TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => <SecretsRowActions row={row.original} />,
      },
    ],
    [companyId, openSecretRow],
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {secretsQuery.isError || userDefinitionsQuery.isError ? (
        <Alert variant="destructive">
          <AlertCircle  data-icon="inline-start"/>
          <AlertTitle>Failed to load secrets</AlertTitle>
          <AlertDescription>
            {((secretsQuery.error ?? userDefinitionsQuery.error) as Error).message}
            <Button
              size="sm"
              onClick={() => {
                void secretsQuery.refetch();
                void userDefinitionsQuery.refetch();
              }}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : unifiedRows.length === 0 &&
        !secretsQuery.isPending &&
        !userDefinitionsQuery.isPending &&
        !(showFolderView && folderPath) ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRound  data-icon="inline-start"/>
            </EmptyMedia>
            <EmptyTitle>
              No secrets yet. Create a shared company secret or one that each user supplies.
            </EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={openCreateSecret}>New secret</Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="@container min-w-0 overflow-x-hidden text-sm" data-testid="secrets-list-container">
          {showFolderView ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <SecretsBreadcrumb />
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatSecretPathCounts(currentFolderSecretCount, folderListing.folders.length)}
              </span>
            </div>
          ) : searching ? (
            <div className="mb-3">
              <div className="text-sm font-medium text-foreground">Search results</div>
              <div className="text-xs text-muted-foreground">
                {filteredRows.length} {filteredRows.length === 1 ? "match" : "matches"} across all folders
                {folderPath ? ` · searching everywhere, not just ${folderPath}` : ""}
              </div>
            </div>
          ) : null}

          {folderRows.length === 0 && secretRows.length === 0 ? (
            secretsQuery.isPending || userDefinitionsQuery.isPending ? (
              <div className="space-y-2 py-2" aria-hidden="true" data-testid="secrets-loading-skeleton">
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} className="h-14" />
                ))}
              </div>
            ) : showFolderView && folderPath && activeSecretFilterCount === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FolderOpen  data-icon="inline-start"/>
                  </EmptyMedia>
                  <EmptyTitle>No secrets in this folder yet.</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={openCreateSecret}>New secret here</Button>
                </EmptyContent>
              </Empty>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search  data-icon="inline-start"/>
                  </EmptyMedia>
                  <EmptyTitle>
                    {searching ? "No secrets match your search." : "No secrets match your filters."}
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            )
          ) : (
            <>
              <div className="hidden @min-[40rem]:block" data-testid="secrets-table-view">
                {showUpRow || folderRows.length > 0 ? (
                  <ItemGroup className="mb-3">
                    {showUpRow ? <SecretsUpItem /> : null}
                    {folderRows.map((folder) => (
                      <SecretsFolderItem key={folder.path} folder={folder} />
                    ))}
                  </ItemGroup>
                ) : null}
                {secretRows.length > 0 ? (
                  <DataTable
                    caption="Secrets"
                    columns={columns}
                    data={secretRows}
                    rowClassName={(row) =>
                      (row.kind === "company" && selectedSecretId === row.secret.id) ||
                      (row.kind === "user" && selectedDefinitionId === row.definition.id)
                        ? "bg-muted/50"
                        : undefined
                    }
                  />
                ) : null}
              </div>

              <ItemGroup className="@min-[40rem]:hidden" data-testid="secrets-card-view">
                {showUpRow ? <SecretsUpItem /> : null}
                {folderRows.map((folder) => (
                  <SecretsFolderItem key={folder.path} folder={folder} />
                ))}
                {secretRows.map((row) => {
                  const status = row.kind === "company" ? row.secret.status : row.definition.status;
                  const name = row.kind === "company" ? row.secret.name : row.definition.name;
                  return (
                    <Item
                      key={row.id}
                      variant="outline"
                      data-state={
                        (row.kind === "company" && selectedSecretId === row.secret.id) ||
                        (row.kind === "user" && selectedDefinitionId === row.definition.id)
                          ? "selected"
                          : undefined
                      }
                    >
                      <ItemContent>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => openSecretRow(row)}
                          aria-label={`Open secret ${name}`}
                        >
                          <SecretIdentity row={row} />
                        </Button>
                        <ItemFooter>
                          {row.kind === "company" ? (
                            <>
                              <DomainStatus status={status}>{statusLabel(status)}</DomainStatus>
                            </>
                          ) : (
                            <>
                              <Badge variant="secondary">
                                <UserRound  data-icon="inline-start"/> Each user
                              </Badge>
                              <DomainStatus status={status}>{statusLabel(status)}</DomainStatus>
                              <CoverageInline
                                companyId={companyId}
                                definitionId={row.definition.id}
                                compact
                              />
                            </>
                          )}
                          <span>
                            {row.kind === "company" ? (
                              <>
                                v{row.secret.latestVersion} ·{" "}
                                {row.secret.managedMode === "external_reference" ? "linked" : "managed"}
                              </>
                            ) : (
                              "Member-owned values"
                            )}
                          </span>
                          <span>
                            Updated{" "}
                            {formatRelative(
                              row.kind === "company" ? row.secret.updatedAt : row.definition.updatedAt,
                            )}
                          </span>
                        </ItemFooter>
                      </ItemContent>
                      <ItemActions>
                        <SecretsRowActions row={row} />
                      </ItemActions>
                    </Item>
                  );
                })}
              </ItemGroup>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SecretIdentity({ row }: { row: UnifiedSecretRow }) {
  const { folderPath, providerConfigs, providers, searching, showFolderView } = useSecretsPage();
  const name = row.kind === "company" ? row.secret.name : row.definition.name;
  const { directory, leaf } = getRelativeSecretPath(name, searching ? "" : folderPath);
  const providerIndicator =
    row.kind === "company" ? providerIndicatorLabel(row.secret, providers, providerConfigs) : null;
  const ProviderIcon =
    row.kind === "company" && row.secret.managedMode === "external_reference" ? ExternalLink : Lock;
  return (
    <span>
      {searching || showFolderView ? (
        <span className="min-w-0 truncate text-sm">
          {directory ? <span className="text-muted-foreground">{directory}/</span> : null}
          <span className="font-medium text-foreground">{leaf}</span>
        </span>
      ) : (
        <span className="truncate font-medium text-foreground">{name}</span>
      )}
      {row.kind === "company" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" aria-label={providerIndicator ?? ""}>
              <ProviderIcon />
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-80 whitespace-pre-wrap break-words">
            {providerIndicator}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" aria-label="Each user provides and owns their own value">
              <UserRound  data-icon="inline-start"/>
            </Badge>
          </TooltipTrigger>
          <TooltipContent>User-owned value</TooltipContent>
        </Tooltip>
      )}
      <code>{row.kind === "company" ? row.secret.key : row.definition.key}</code>
      {row.kind === "company" ? (
        <Badge variant="secondary">
          <ShieldCheck  data-icon="inline-start"/> Company
        </Badge>
      ) : (
        <Badge variant="secondary">
          <UserRound  data-icon="inline-start"/> Each user
        </Badge>
      )}
    </span>
  );
}
