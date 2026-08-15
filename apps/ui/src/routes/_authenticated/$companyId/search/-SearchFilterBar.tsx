import { useMemo } from "react";
import { ArrowUpDown, User, X } from "lucide-react";
import {
  COMPANY_SEARCH_SORTS,
  COMPANY_SEARCH_UPDATED_WITHIN_OPTIONS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type CompanySearchFilterOptionCounts,
  type CompanySearchSort,
  type TaskStatus,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchFilterMenu, type FilterMenuOption } from "./-SearchFilterMenu";
import {
  applyOwnerSelectionId,
  buildFilterChips,
  ownerSelectionId,
  SORT_LABELS,
  updatedWithinLabel,
  type FilterChipLookups,
  type SearchFilters,
} from "@/lib/search-filters";
import type { ColoredNamedEntity, NamedEntity } from "@/lib/presentation-contracts";

export interface SearchFilterDataProps {
  counts?: CompanySearchFilterOptionCounts;
  agents: NamedEntity[];
  projects: NamedEntity[];
  labels: ColoredNamedEntity[];
  currentUserId: string | null;
}

// Non-terminal statuses — the single-click "Open items" preset from wireframe screen 2.
const OPEN_STATUS_PRESET: TaskStatus[] = TASK_STATUSES.filter(
  (status) => status !== "done" && status !== "cancelled",
);

function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function count(record: Record<string, number> | undefined, key: string): number | undefined {
  return record?.[key];
}

export interface SearchFilterOptionGroups {
  status: FilterMenuOption[];
  priority: FilterMenuOption[];
  owner: FilterMenuOption[];
  project: FilterMenuOption[];
  label: FilterMenuOption[];
  updated: FilterMenuOption[];
}

/** Build option lists (with filter-aware counts) shared by the desktop bar and mobile sheet. */
export function buildSearchFilterOptions({
  counts,
  agents,
  projects,
  labels,
  currentUserId,
}: SearchFilterDataProps): SearchFilterOptionGroups {
  const status: FilterMenuOption[] = TASK_STATUSES.map((value) => ({
    value,
    label: humanize(value),
    count: count(counts?.status as Record<string, number> | undefined, value),
  }));

  const priority: FilterMenuOption[] = TASK_PRIORITIES.map((value) => ({
    value,
    label: humanize(value),
    count: count(counts?.priority as Record<string, number> | undefined, value),
  }));

  const owner: FilterMenuOption[] = [];
  if (currentUserId) {
    owner.push({
      value: currentUserId,
      label: "Me",
      icon: <User className="h-3.5 w-3.5 text-muted-foreground" />,
      count: count(counts?.ownerUserId, currentUserId),
      searchText: "me mine",
    });
  }
  for (const agent of agents) {
    owner.push({
      value: agent.id,
      label: agent.name,
      count: count(counts?.ownerAgentId, agent.id),
      searchText: agent.name,
    });
  }

  const project: FilterMenuOption[] = projects.map((item) => ({
    value: item.id,
    label: item.name,
    count: count(counts?.projectId, item.id),
    searchText: item.name,
  }));

  const label: FilterMenuOption[] = labels.map((item) => ({
    value: item.id,
    label: item.name,
    swatch: item.color,
    count: count(counts?.labelId, item.id),
    searchText: item.name,
  }));

  const updated: FilterMenuOption[] = COMPANY_SEARCH_UPDATED_WITHIN_OPTIONS.map((value) => ({
    value,
    label: updatedWithinLabel(value),
    count: count(counts?.updatedWithin as Record<string, number> | undefined, value),
  }));

  return { status, priority, owner, project, label, updated };
}

export function SearchFilterBar({
  filters,
  onChange,
  sort,
  onSortChange,
  data,
}: {
  filters: SearchFilters;
  onChange: (next: SearchFilters) => void;
  sort: CompanySearchSort;
  onSortChange: (next: CompanySearchSort) => void;
  data: SearchFilterDataProps;
}) {
  const options = useMemo(() => buildSearchFilterOptions(data), [data]);

  function toggleMulti(dimension: "status" | "priority", value: string) {
    const current = (filters[dimension] ?? []) as string[];
    const next = current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
    onChange({ ...filters, [dimension]: next });
  }

  const selectedOwner = ownerSelectionId(filters);

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="search-filter-bar">
      <SearchFilterMenu
        label="Status"
        multi
        options={options.status}
        selected={filters.status ?? []}
        onToggle={(value) => toggleMulti("status", value)}
        onClear={() => onChange({ ...filters, status: [] })}
        presets={[{ label: "Open items", values: OPEN_STATUS_PRESET }]}
      />
      <SearchFilterMenu
        label="Owner"
        options={options.owner}
        selected={selectedOwner ? [selectedOwner] : []}
        onSelect={(value) => onChange(applyOwnerSelectionId(filters, value, data.currentUserId))}
        searchable
        searchPlaceholder="Search owners…"
        emptyMessage="No owners"
      />
      <SearchFilterMenu
        label="Project"
        options={options.project}
        selected={filters.projectId ? [filters.projectId] : []}
        onSelect={(value) => onChange({ ...filters, projectId: value })}
        searchable
        searchPlaceholder="Search projects…"
        emptyMessage="No projects"
      />
      <SearchFilterMenu
        label="Label"
        options={options.label}
        selected={filters.labelId ? [filters.labelId] : []}
        onSelect={(value) => onChange({ ...filters, labelId: value })}
        searchable
        searchPlaceholder="Search labels…"
        emptyMessage="No labels"
      />
      <SearchFilterMenu
        label="Priority"
        multi
        options={options.priority}
        selected={filters.priority ?? []}
        onToggle={(value) => toggleMulti("priority", value)}
        onClear={() => onChange({ ...filters, priority: [] })}
      />
      <SearchFilterMenu
        label="Updated"
        options={options.updated}
        selected={filters.updatedWithin ? [filters.updatedWithin] : []}
        onSelect={(value) => onChange({ ...filters, updatedWithin: value })}
      />
      <div className="ml-auto">
        <SearchSortMenu value={sort} onChange={onSortChange} />
      </div>
    </div>
  );
}

export function SearchSortMenu({
  value,
  onChange,
}: {
  value: CompanySearchSort;
  onChange: (next: CompanySearchSort) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Sort results">
          <ArrowUpDown aria-hidden />
          <span className="hidden text-muted-foreground sm:inline">Sort:</span>
          {SORT_LABELS[value]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={value} onValueChange={(sort) => onChange(sort as CompanySearchSort)}>
          {COMPANY_SEARCH_SORTS.map((sort) => (
            <DropdownMenuRadioItem key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SearchFilterChips({
  filters,
  lookups,
  onChange,
  onClearAll,
}: {
  filters: SearchFilters;
  lookups: FilterChipLookups;
  onChange: (next: SearchFilters) => void;
  onClearAll: () => void;
}) {
  const chips = buildFilterChips(filters, lookups);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="search-filter-chips">
      {chips.map((chip) => (
        <Badge key={chip.id} variant="secondary">
          {chip.label}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove filter ${chip.label}`}
            onClick={() => onChange(chip.remove(filters))}
          >
            <X />
          </Button>
        </Badge>
      ))}
      <Button type="button" variant="ghost" size="xs" onClick={onClearAll}>
        Clear all
      </Button>
    </div>
  );
}
