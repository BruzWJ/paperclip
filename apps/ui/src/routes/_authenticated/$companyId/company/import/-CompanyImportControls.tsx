import { listUIAdapters } from "@/adapters";
import { useAdapterCatalogSyncState } from "@/adapters/use-adapter-catalog";
import { defaultCreateValues } from "@/routes/_authenticated/$companyId/-agent-configuration/-agent-config-defaults";
import { AgentConfigForm } from "@/routes/_authenticated/$companyId/-agent-configuration/-AgentConfigForm";
import type { FileTreeNode } from "@/components/patterns/FileTree";
import { EntityCombobox } from "@/components/patterns/EntityCombobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import * as Collapse from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import * as ItemUI from "@/components/ui/item";
import { cn } from "@/lib/utils";
import type { ConflictItem } from "@/routes/_authenticated/$companyId/company/import/-company-import-data";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { ArrowRight, Check, ChevronRight } from "lucide-react";
import { useMemo } from "react";

export function importActionBadgeVariant(action: string) {
  if (action === "overwrite" || action === "replace") return "destructive" as const;
  if (action === "create") return "default" as const;
  if (action === "update") return "secondary" as const;
  return "outline" as const;
}

export function renderImportFileExtra(node: FileTreeNode, checked: boolean, renameMap: Map<string, string>) {
  // Show rename indicator only on directories (folders), not individual files
  const renamedTo = node.kind === "dir" ? renameMap.get(node.path) : undefined;
  const actionBadge = node.action ? (
    <Badge variant={importActionBadgeVariant(checked ? node.action : "skip")}>
      {checked ? node.action : "skip"}
    </Badge>
  ) : null;

  if (!actionBadge && !renamedTo) return null;

  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      {renamedTo && checked && (
        <span
          className="max-w-(--sz-7rem) truncate font-mono text-(length:--text-nano) text-muted-foreground"
          title={renamedTo}
        >
          &rarr; {renamedTo}
        </span>
      )}
      {actionBadge}
    </span>
  );
}

export function ConflictResolutionList({
  conflicts,
  nameOverrides,
  skippedSlugs,
  confirmedSlugs,
  onRename,
  onToggleSkip,
  onToggleConfirm,
}: {
  conflicts: ConflictItem[];
  nameOverrides: Record<string, string>;
  skippedSlugs: Set<string>;
  confirmedSlugs: Set<string>;
  onRename: (slug: string, newName: string) => void;
  onToggleSkip: (slug: string, filePath: string | null) => void;
  onToggleConfirm: (slug: string) => void;
}) {
  if (conflicts.length === 0) return null;

  return (
    <Card className="mx-5 mt-3">
      <CardHeader className="flex-row items-center gap-2">
        <CardTitle>Renames</CardTitle>
        <Badge variant="secondary">
          {conflicts.length} item{conflicts.length === 1 ? "" : "s"}
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        <ItemUI.ItemGroup className="divide-y">
          {conflicts.map((item) => {
            const isSkipped = skippedSlugs.has(item.slug);
            const isConfirmed = confirmedSlugs.has(item.slug);
            const currentName = nameOverrides[item.slug] ?? item.plannedName;
            return (
              <ItemUI.Item
                key={item.slug}
                size="sm"
                className={cn(
                  "rounded-none border-0",
                  isSkipped && "opacity-40",
                  isConfirmed && !isSkipped && "bg-muted/50",
                )}
              >
                <ItemUI.ItemMedia>
                  <Button
                    type="button"
                    variant={isSkipped ? "secondary" : "outline"}
                    size="xs"
                    onClick={() => onToggleSkip(item.slug, item.filePath)}
                  >
                    {isSkipped ? "skipped" : "skip"}
                  </Button>
                </ItemUI.ItemMedia>
                <ItemUI.ItemContent className="min-w-0 flex-row items-center">
                  <Badge variant={isSkipped ? "outline" : isConfirmed ? "default" : "secondary"}>
                    {item.kind}
                  </Badge>
                  <ItemUI.ItemTitle
                    className={cn(
                      "shrink-0 font-mono text-xs text-muted-foreground",
                      isSkipped && "line-through",
                    )}
                  >
                    {item.originalName}
                  </ItemUI.ItemTitle>
                  {!isSkipped && (
                    <>
                      <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground"  data-icon="inline-start"/>
                      {isConfirmed ? (
                        <ItemUI.ItemDescription className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                          {currentName}
                        </ItemUI.ItemDescription>
                      ) : (
                        <Input
                          aria-label={`Rename ${item.originalName}`}
                          className="min-w-0 flex-1 font-mono"
                          value={currentName}
                          onChange={(e) => onRename(item.slug, e.target.value)}
                        />
                      )}
                    </>
                  )}
                </ItemUI.ItemContent>
                {!isSkipped && (
                  <ItemUI.ItemActions>
                    <Button
                      type="button"
                      variant={isConfirmed ? "default" : "outline"}
                      size="xs"
                      onClick={() => onToggleConfirm(item.slug)}
                    >
                      {isConfirmed ? (
                        <>
                          <Check className="h-3 w-3"  data-icon="inline-start"/>
                          confirmed
                        </>
                      ) : (
                        "confirm rename"
                      )}
                    </Button>
                  </ItemUI.ItemActions>
                )}
              </ItemUI.Item>
            );
          })}
        </ItemUI.ItemGroup>
      </CardContent>
    </Card>
  );
}

// ── Adapter picker for imported agents ───────────────────────────────

export interface AdapterPickerItem {
  slug: string;
  name: string;
}

export function AdapterPickerList({
  agents,
  adapterOverrides,
  expandedSlugs,
  configValues,
  onChangeAdapter,
  onToggleExpand,
  onChangeConfig,
}: {
  agents: AdapterPickerItem[];
  adapterOverrides: Record<string, string>;
  expandedSlugs: Set<string>;
  configValues: Record<string, CreateConfigValues>;
  onChangeAdapter: (slug: string, adapterType: string) => void;
  onToggleExpand: (slug: string) => void;
  onChangeConfig: (slug: string, patch: Partial<CreateConfigValues>) => void;
}) {
  const { adapters: admittedAdapters } = useAdapterCatalogSyncState();
  const adapterOptions = useMemo(
    () =>
      listUIAdapters().map((adapter) => ({
        value: adapter.type,
        label: adapter.label,
      })),
    [admittedAdapters],
  );
  if (agents.length === 0) return null;

  return (
    <Card className="mx-5 mt-3">
      <CardHeader className="flex-row items-center gap-2">
        <CardTitle>Adapters</CardTitle>
        <Badge variant="secondary">
          {agents.length} agent{agents.length === 1 ? "" : "s"}
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        <ItemUI.ItemGroup className="divide-y">
          {agents.map((agent) => {
            const selectedType = adapterOverrides[agent.slug] ?? "";
            const isExpanded = expandedSlugs.has(agent.slug);
            const vals = configValues[agent.slug] ?? {
              ...defaultCreateValues,
              adapterType: selectedType,
            };
            return (
              <Collapse.Collapsible
                key={agent.slug}
                open={isExpanded}
                onOpenChange={(open) => {
                  if (open !== isExpanded) onToggleExpand(agent.slug);
                }}
              >
                <ItemUI.Item size="sm" className="rounded-none border-0">
                  <ItemUI.ItemMedia>
                    <Badge>agent</Badge>
                  </ItemUI.ItemMedia>
                  <ItemUI.ItemContent className="min-w-0">
                    <ItemUI.ItemTitle className="font-mono text-xs">{agent.name}</ItemUI.ItemTitle>
                    <ItemUI.ItemDescription>
                      {selectedType ? "Operator-managed native" : "Select an adapter first"}
                    </ItemUI.ItemDescription>
                  </ItemUI.ItemContent>
                  <ItemUI.ItemActions className="min-w-full flex-wrap sm:min-w-0">
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground"  data-icon="inline-start"/>
                    <EntityCombobox
                      value={selectedType}
                      options={adapterOptions.map((option) => ({
                        id: option.value,
                        label: option.label,
                      }))}
                      onValueChange={(value) => onChangeAdapter(agent.slug, value)}
                      type="adapter"
                      ariaLabel="Target adapter"
                      placeholder="Select target adapter"
                      noneLabel="Select target adapter"
                      includeNone={false}
                      triggerClassName="min-w-(--sz-14rem) flex-1"
                    />
                    <Collapse.CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant={isExpanded ? "secondary" : "outline"}
                        size="sm"
                        disabled={!selectedType}
                      >
                        <ChevronRight
                          className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-90")}
                         data-icon="inline-start"/>
                        configure adapter
                      </Button>
                    </Collapse.CollapsibleTrigger>
                  </ItemUI.ItemActions>
                </ItemUI.Item>
                <Collapse.CollapsibleContent>
                  {selectedType && (
                    <div className="border-t border-border bg-accent/10 px-4 py-3 space-y-3">
                      <AgentConfigForm
                        mode="create"
                        values={vals}
                        onChange={(patch) => onChangeConfig(agent.slug, patch)}
                        showAdapterTypeField={false}
                        applyAdapterSchemaDefaults={false}
                      />
                    </div>
                  )}
                </Collapse.CollapsibleContent>
              </Collapse.Collapsible>
            );
          })}
        </ItemUI.ItemGroup>
      </CardContent>
    </Card>
  );
}
