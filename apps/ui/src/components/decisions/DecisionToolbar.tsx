import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ATTENTION_GROUP_BY_OPTIONS,
  ATTENTION_SORT_OPTIONS,
  NO_GROUP_SENTINEL,
  countActiveAttentionFilters,
  defaultAttentionFilterState,
  sourceMeta,
  type AttentionFilterState,
  type AttentionGroupBy,
  type AttentionSortOrder,
  type buildAttentionFilterOptions,
} from "@/lib/attention";
import { ArrowUpDown, Layers, ListFilter } from "lucide-react";

const SEVERITY_LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function DecisionToolbar({
  visibleCount,
  options,
  filters,
  groupBy,
  sortOrder,
  onFiltersChange,
  onGroupByChange,
  onSortOrderChange,
}: {
  visibleCount: number;
  options: ReturnType<typeof buildAttentionFilterOptions>;
  filters: AttentionFilterState;
  groupBy: AttentionGroupBy;
  sortOrder: AttentionSortOrder;
  onFiltersChange: (next: AttentionFilterState) => void;
  onGroupByChange: (next: AttentionGroupBy) => void;
  onSortOrderChange: (next: AttentionSortOrder) => void;
}) {
  const activeFilterCount = countActiveAttentionFilters(filters);
  return (
    <div className="flex items-center gap-2">
      {visibleCount > 0 ? (
        <span className="text-sm text-muted-foreground">
          {visibleCount} {visibleCount === 1 ? "decision" : "decisions"}
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={activeFilterCount > 0 ? "secondary" : "outline"}
            size="icon-sm"
            title="Filter"
            aria-label="Filter"
          >
            <ListFilter />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DecisionFilterMenu options={options} filters={filters} onChange={onFiltersChange} />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={groupBy !== "none" ? "secondary" : "outline"}
            size="icon-sm"
            title="Group"
            aria-label="Group"
          >
            <Layers />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Group by</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={groupBy}
            onValueChange={(value) => onGroupByChange(value as AttentionGroupBy)}
          >
            {ATTENTION_GROUP_BY_OPTIONS.map(([value, label]) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="icon-sm" title="Sort" aria-label="Sort">
            <ArrowUpDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Sort by</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sortOrder}
            onValueChange={(value) => onSortOrderChange(value as AttentionSortOrder)}
          >
            {ATTENTION_SORT_OPTIONS.map(([value, label]) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function DecisionFilterMenu({
  options,
  filters,
  onChange,
}: {
  options: ReturnType<typeof buildAttentionFilterOptions>;
  filters: AttentionFilterState;
  onChange: (next: AttentionFilterState) => void;
}) {
  const toggle = (key: keyof AttentionFilterState, value: string) => {
    const list = filters[key] as string[];
    onChange({
      ...filters,
      [key]: list.includes(value) ? list.filter((current) => current !== value) : [...list, value],
    });
  };

  return (
    <>
      <DropdownMenuLabel>Filter</DropdownMenuLabel>
      {countActiveAttentionFilters(filters) > 0 ? (
        <DropdownMenuItem onSelect={() => onChange(defaultAttentionFilterState)}>
          Clear filters
        </DropdownMenuItem>
      ) : null}
      {options.sourceKinds.length > 1 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Type</DropdownMenuLabel>
          {options.sourceKinds.map((kind) => (
            <DropdownMenuCheckboxItem
              key={kind}
              checked={filters.sourceKinds.includes(kind)}
              onCheckedChange={() => toggle("sourceKinds", kind)}
              onSelect={(event) => event.preventDefault()}
            >
              {sourceMeta(kind).label}
            </DropdownMenuCheckboxItem>
          ))}
        </>
      ) : null}
      {options.severities.length > 1 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Severity</DropdownMenuLabel>
          {options.severities.map((severity) => (
            <DropdownMenuCheckboxItem
              key={severity}
              checked={filters.severities.includes(severity)}
              onCheckedChange={() => toggle("severities", severity)}
              onSelect={(event) => event.preventDefault()}
            >
              {SEVERITY_LABELS[severity] ?? severity}
            </DropdownMenuCheckboxItem>
          ))}
        </>
      ) : null}
      {options.projects.length > 0 || options.hasNoProject ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Project</DropdownMenuLabel>
          {options.projects.map((project) => (
            <DropdownMenuCheckboxItem
              key={project.id}
              checked={filters.projectIds.includes(project.id)}
              onCheckedChange={() => toggle("projectIds", project.id)}
              onSelect={(event) => event.preventDefault()}
            >
              {project.name}
            </DropdownMenuCheckboxItem>
          ))}
          {options.hasNoProject ? (
            <DropdownMenuCheckboxItem
              checked={filters.projectIds.includes(NO_GROUP_SENTINEL)}
              onCheckedChange={() => toggle("projectIds", NO_GROUP_SENTINEL)}
              onSelect={(event) => event.preventDefault()}
            >
              No project
            </DropdownMenuCheckboxItem>
          ) : null}
        </>
      ) : null}
      {options.workspaces.length > 0 || options.hasNoWorkspace ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Workspace</DropdownMenuLabel>
          {options.workspaces.map((workspace) => (
            <DropdownMenuCheckboxItem
              key={workspace.id}
              checked={filters.workspaceIds.includes(workspace.id)}
              onCheckedChange={() => toggle("workspaceIds", workspace.id)}
              onSelect={(event) => event.preventDefault()}
            >
              {workspace.name}
            </DropdownMenuCheckboxItem>
          ))}
          {options.hasNoWorkspace ? (
            <DropdownMenuCheckboxItem
              checked={filters.workspaceIds.includes(NO_GROUP_SENTINEL)}
              onCheckedChange={() => toggle("workspaceIds", NO_GROUP_SENTINEL)}
              onSelect={(event) => event.preventDefault()}
            >
              No workspace
            </DropdownMenuCheckboxItem>
          ) : null}
        </>
      ) : null}
    </>
  );
}
