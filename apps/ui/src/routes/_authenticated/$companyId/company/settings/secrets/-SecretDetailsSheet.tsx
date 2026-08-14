import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Item, ItemActions, ItemContent } from "@/components/ui/item";
import {
  Archive,
  ArchiveRestore,
  Ban,
  CheckCircle2,
  Copy,
  KeyRound,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { SecretDetailsTab, SecretEventsTab, SecretUsageTab } from "./-CompanySecretDetails";
import {
  CoverageInline,
  UserSecretCoverageTab,
  UserSecretDetailsTab,
  UserSecretUsageTab,
} from "./-UserSecretDetails";
import { modeLabel, providerLabel, statusLabel } from "./-secrets-model";
import { useSecretsPage } from "./-SecretsPageContext";

function SecretKeyRow({ onCopy, value }: { onCopy: () => void; value: string }) {
  return (
    <Item variant="muted" size="sm" className="min-w-0 flex-nowrap py-1.5">
      <ItemContent>
        <code className="min-w-0 truncate font-mono text-xs text-foreground">{value}</code>
      </ItemContent>
      <ItemActions>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={onCopy}
        >
          <Copy data-icon="inline-start" className="mr-1 h-3.5 w-3.5" /> Copy
        </Button>
      </ItemActions>
    </Item>
  );
}

function SecretDetailTabs<T extends string>({
  children,
  onValueChange,
  tabs,
  value,
}: {
  children: ReactNode;
  onValueChange: (value: T) => void;
  tabs: Array<{ label: ReactNode; value: T }>;
  value: T;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as T)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="border-b border-border px-4">
        <TabsList variant="line" className="justify-start">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
    </Tabs>
  );
}

export function SecretDetailsSheet() {
  const {
    companyId,
    copySecretKey,
    definitionStatusMutation,
    eventsQuery,
    openEditDefinition,
    openRotateSecret,
    providerConfigs,
    providers,
    secretDetailTab,
    selectedDefinition,
    selectedDefinitionMyEntry,
    selectedSecret,
    setDefinitionDeleteConfirm,
    setDeleteConfirm,
    setSecretDetailTab,
    setSelectedDefinitionId,
    setSelectedSecretId,
    setSetMyValueFor,
    statusMutation,
    usageQuery,
  } = useSecretsPage();
  return (
    <Sheet
      open={Boolean(selectedSecret || selectedDefinition)}
      onOpenChange={(open) => {
        if (!open) {
          setSelectedSecretId(null);
          setSelectedDefinitionId(null);
        }
      }}
    >
      <SheetContent className="w-full sm:max-w-xl flex flex-col gap-0">
        {selectedSecret ? (
          <>
            <SheetHeader className="space-y-3">
              <SheetTitle className="flex min-w-0 items-center gap-2 pr-8 text-base">
                <KeyRound className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{selectedSecret.name}</span>
                <span className="shrink-0">
                  <DomainStatus status={selectedSecret.status}>
                    {statusLabel(selectedSecret.status)}
                  </DomainStatus>
                </span>
              </SheetTitle>
              <SheetDescription className="sr-only">
                {providerLabel(providers, selectedSecret.provider)} secret {selectedSecret.key}
              </SheetDescription>
              <SecretKeyRow value={selectedSecret.key} onCopy={() => copySecretKey(selectedSecret.key)} />
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="secondary">
                  <ShieldCheck className="h-3 w-3" /> Company
                </Badge>
                <Badge variant="secondary">{modeLabel(selectedSecret.managedMode)}</Badge>
                <Badge variant="secondary">{providerLabel(providers, selectedSecret.provider)}</Badge>
                <Badge variant="secondary">v{selectedSecret.latestVersion}</Badge>
              </div>
            </SheetHeader>
            <div className="flex items-center gap-2 px-4 pb-2">
              <Button size="sm" onClick={() => openRotateSecret(selectedSecret)}>
                <RefreshCw data-icon="inline-start" className="h-3.5 w-3.5 mr-1" />
                {selectedSecret.managedMode === "external_reference" ? "Update reference" : "Update value"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" aria-label={`More actions for ${selectedSecret.name}`}>
                    <MoreHorizontal data-icon="inline-start" className="mr-1 h-3.5 w-3.5" /> More
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem
                    disabled={statusMutation.isPending}
                    onSelect={() =>
                      statusMutation.mutate({
                        id: selectedSecret.id,
                        status: selectedSecret.status === "active" ? "disabled" : "active",
                      })
                    }
                  >
                    {selectedSecret.status === "active" ? (
                      <Ban className="h-4 w-4" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    {selectedSecret.status === "active" ? "Disable" : "Activate"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={statusMutation.isPending}
                    onSelect={() =>
                      statusMutation.mutate({
                        id: selectedSecret.id,
                        status: selectedSecret.status === "archived" ? "active" : "archived",
                      })
                    }
                  >
                    {selectedSecret.status === "archived" ? (
                      <ArchiveRestore className="h-4 w-4" />
                    ) : (
                      <Archive className="h-4 w-4" />
                    )}
                    {selectedSecret.status === "archived" ? "Unarchive" : "Archive"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleteConfirm(selectedSecret)}>
                    <Trash2 className="h-4 w-4" /> Delete secret
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <SecretDetailTabs
              value={secretDetailTab}
              onValueChange={setSecretDetailTab}
              tabs={[
                { value: "details", label: "Details" },
                {
                  value: "usage",
                  label: usageQuery.data ? `Usage (${usageQuery.data.bindings.length})` : "Usage",
                },
                { value: "events", label: "Access events" },
              ]}
            >
              <TabsContent value="details">
                <div className="space-y-3">
                  <SecretDetailsTab
                    secret={selectedSecret}
                    providers={providers}
                    providerConfigs={providerConfigs}
                    onViewUsage={() => setSecretDetailTab("usage")}
                  />
                </div>
              </TabsContent>
              <TabsContent value="usage">
                <SecretUsageTab loading={usageQuery.isPending} bindings={usageQuery.data?.bindings ?? []} />
              </TabsContent>
              <TabsContent value="events">
                <SecretEventsTab
                  loading={eventsQuery.isPending}
                  events={eventsQuery.data ?? []}
                  companyId={companyId}
                />
              </TabsContent>
            </SecretDetailTabs>
          </>
        ) : selectedDefinition ? (
          <>
            <SheetHeader className="space-y-3">
              <SheetTitle className="flex min-w-0 items-center gap-2 pr-8 text-base">
                <UserRound className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{selectedDefinition.name}</span>
                <span className="shrink-0">
                  <DomainStatus status={selectedDefinition.status}>
                    {statusLabel(selectedDefinition.status)}
                  </DomainStatus>
                </span>
              </SheetTitle>
              <SheetDescription className="sr-only">
                Each user secret definition {selectedDefinition.key}
              </SheetDescription>
              <SecretKeyRow
                value={selectedDefinition.key}
                onCopy={() => copySecretKey(selectedDefinition.key)}
              />
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="secondary">
                  <UserRound /> Each user
                </Badge>
                <Badge variant="secondary">
                  <CoverageInline companyId={companyId} definitionId={selectedDefinition.id} compact />
                </Badge>
              </div>
            </SheetHeader>
            <div className="flex items-center gap-2 px-4 pb-2">
              <Button
                size="sm"
                onClick={() =>
                  setSetMyValueFor(
                    selectedDefinitionMyEntry ?? {
                      definition: selectedDefinition,
                      secret: null,
                    },
                  )
                }
                disabled={selectedDefinition.status !== "active"}
              >
                <KeyRound data-icon="inline-start" className="h-3.5 w-3.5 mr-1" />
                {selectedDefinitionMyEntry?.secret ? "Update my value" : "Set my value"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`More actions for ${selectedDefinition.name}`}
                  >
                    <MoreHorizontal data-icon="inline-start" className="mr-1 h-3.5 w-3.5" /> More
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem onSelect={() => openEditDefinition(selectedDefinition)}>
                    <Pencil className="h-4 w-4" /> Edit definition
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={definitionStatusMutation.isPending}
                    onSelect={() =>
                      definitionStatusMutation.mutate({
                        definition: selectedDefinition,
                        status: selectedDefinition.status === "active" ? "disabled" : "active",
                      })
                    }
                  >
                    {selectedDefinition.status === "active" ? (
                      <Ban className="h-4 w-4" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    {selectedDefinition.status === "active" ? "Disable" : "Activate"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={definitionStatusMutation.isPending}
                    onSelect={() =>
                      definitionStatusMutation.mutate({
                        definition: selectedDefinition,
                        status: selectedDefinition.status === "archived" ? "active" : "archived",
                      })
                    }
                  >
                    {selectedDefinition.status === "archived" ? (
                      <ArchiveRestore className="h-4 w-4" />
                    ) : (
                      <Archive className="h-4 w-4" />
                    )}
                    {selectedDefinition.status === "archived" ? "Unarchive" : "Archive"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDefinitionDeleteConfirm(selectedDefinition)}
                  >
                    <Trash2 className="h-4 w-4" /> Delete definition
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <SecretDetailTabs
              value={secretDetailTab}
              onValueChange={setSecretDetailTab}
              tabs={[
                { value: "details", label: "Details" },
                { value: "coverage", label: "Coverage" },
                { value: "usage", label: "Usage" },
                { value: "events", label: "Access events" },
              ]}
            >
              <TabsContent value="details">
                <div className="space-y-3">
                  <UserSecretDetailsTab
                    companyId={companyId}
                    definition={selectedDefinition}
                    onViewCoverage={() => setSecretDetailTab("coverage")}
                  />
                </div>
              </TabsContent>
              <TabsContent value="coverage">
                <UserSecretCoverageTab companyId={companyId} definitionId={selectedDefinition.id} />
              </TabsContent>
              <TabsContent value="usage">
                <UserSecretUsageTab definition={selectedDefinition} />
              </TabsContent>
              <TabsContent value="events">
                <Empty className="py-6">
                  <EmptyDescription>
                    Access events are recorded on each member&apos;s stored value when runtime resolution
                    occurs.
                  </EmptyDescription>
                </Empty>
              </TabsContent>
            </SecretDetailTabs>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
