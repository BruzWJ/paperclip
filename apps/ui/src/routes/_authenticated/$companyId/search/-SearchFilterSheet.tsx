import { useEffect, useState } from "react";
import { COMPANY_SEARCH_SORTS, type CompanySearchSort } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  applyOwnerSelectionId,
  ownerSelectionId,
  countActiveFilters,
  SORT_LABELS,
  type SearchFilters,
} from "@/lib/search-filters";
import { buildSearchFilterOptions, type SearchFilterDataProps } from "./-SearchFilterBar";
import type { FilterMenuOption } from "./-SearchFilterMenu";

function SearchFilterToggleGroup({
  label,
  options,
  value,
  onValueChange,
  multiple = false,
}: {
  label: string;
  options: FilterMenuOption[];
  value: string | string[];
  onValueChange: (value: string | string[]) => void;
  multiple?: boolean;
}) {
  if (options.length === 0) return null;

  const items = options.map((option) => (
    <ToggleGroupItem key={option.value} value={option.value}>
      {option.swatch ? (
        <span className="size-2 rounded-full" style={{ backgroundColor: option.swatch }} aria-hidden />
      ) : null}
      <span>{option.label}</span>
      {typeof option.count === "number" ? (
        <Badge variant="secondary" className="ml-1 tabular-nums">
          {option.count}
        </Badge>
      ) : null}
    </ToggleGroupItem>
  ));

  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label">{label}</FieldLegend>
      {multiple ? (
        <ToggleGroup
          type="multiple"
          variant="outline"
          spacing={1}
          value={value as string[]}
          onValueChange={onValueChange}
          className="flex flex-wrap"
        >
          {items}
        </ToggleGroup>
      ) : (
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={1}
          value={value as string}
          onValueChange={onValueChange}
          className="flex flex-wrap"
        >
          {items}
        </ToggleGroup>
      )}
    </FieldSet>
  );
}

export function SearchFilterSheet({
  open,
  onOpenChange,
  filters,
  onApply,
  onDraftChange,
  previewTotal,
  data,
  sort,
  onSortChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: SearchFilters;
  onApply: (next: SearchFilters) => void;
  /** Fires whenever the in-sheet draft changes so the parent can preview the count. */
  onDraftChange: (draft: SearchFilters) => void;
  /** Total result count for the current draft, previewed before applying. */
  previewTotal: number | null;
  data: SearchFilterDataProps;
  sort: CompanySearchSort;
  onSortChange: (next: CompanySearchSort) => void;
}) {
  const [draft, setDraft] = useState<SearchFilters>(filters);
  const options = buildSearchFilterOptions(data);

  // Re-seed the draft from committed filters each time the sheet opens.
  useEffect(() => {
    if (open) {
      setDraft(filters);
      onDraftChange(filters);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function update(next: SearchFilters) {
    setDraft(next);
    onDraftChange(next);
  }

  const activeCount = countActiveFilters(draft);
  const selectedOwner = ownerSelectionId(draft);
  const applyLabel =
    previewTotal === null
      ? "Show results"
      : `Show ${previewTotal} ${previewTotal === 1 ? "result" : "results"}`;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-(--sz-85vh) gap-0 rounded-t-xl p-0" data-testid="search-filter-sheet">
        <DrawerHeader className="flex-row items-center justify-between border-b border-border">
          <div>
            <DrawerTitle className="text-base">Filters</DrawerTitle>
            <DrawerDescription>Refine company search results.</DrawerDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className={activeCount === 0 ? "invisible" : undefined}
            onClick={() => update({})}
          >
            Clear all
          </Button>
        </DrawerHeader>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <SearchFilterToggleGroup
            label="Status"
            options={options.status}
            multiple
            value={draft.status ?? []}
            onValueChange={(status) =>
              update({ ...draft, status: status as NonNullable<SearchFilters["status"]> })
            }
          />
          <SearchFilterToggleGroup
            label="Priority"
            options={options.priority}
            multiple
            value={draft.priority ?? []}
            onValueChange={(priority) =>
              update({ ...draft, priority: priority as NonNullable<SearchFilters["priority"]> })
            }
          />
          <SearchFilterToggleGroup
            label="Owner"
            options={options.owner}
            value={selectedOwner ?? ""}
            onValueChange={(owner) =>
              update(applyOwnerSelectionId(draft, (owner as string) || undefined, data.currentUserId))
            }
          />
          <SearchFilterToggleGroup
            label="Project"
            options={options.project}
            value={draft.projectId ?? ""}
            onValueChange={(projectId) => update({ ...draft, projectId: (projectId as string) || undefined })}
          />
          <SearchFilterToggleGroup
            label="Label"
            options={options.label}
            value={draft.labelId ?? ""}
            onValueChange={(labelId) => update({ ...draft, labelId: (labelId as string) || undefined })}
          />
          <SearchFilterToggleGroup
            label="Updated"
            options={options.updated}
            value={draft.updatedWithin ?? ""}
            onValueChange={(updatedWithin) =>
              update({
                ...draft,
                updatedWithin: ((updatedWithin as string) || undefined) as SearchFilters["updatedWithin"],
              })
            }
          />
          <SearchFilterToggleGroup
            label="Sort by"
            options={COMPANY_SEARCH_SORTS.map((value) => ({ value, label: SORT_LABELS[value] }))}
            value={sort}
            onValueChange={(value) => {
              if (value) onSortChange(value as CompanySearchSort);
            }}
          />
        </div>

        <DrawerFooter className="flex-row gap-2 border-t border-border">
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="flex-1"
            onClick={() => {
              onApply(draft);
              onOpenChange(false);
            }}
          >
            {applyLabel}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
