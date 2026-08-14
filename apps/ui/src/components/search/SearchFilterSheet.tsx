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
import { buildSearchFilterOptions, type SearchFilterDataProps } from "./SearchFilterBar";

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
          {options.status.length > 0 ? (
            <FieldSet className="gap-2">
              <FieldLegend variant="label">Status</FieldLegend>
              <ToggleGroup
                type="multiple"
                variant="outline"
                spacing={1}
                value={draft.status ?? []}
                onValueChange={(status) =>
                  update({ ...draft, status: status as NonNullable<SearchFilters["status"]> })
                }
                className="flex flex-wrap"
              >
                {options.status.map((option) => (
                  <ToggleGroupItem key={option.value} value={option.value}>
                    <span>{option.label}</span>
                    {typeof option.count === "number" ? (
                      <Badge variant="secondary" className="ml-1 tabular-nums">
                        {option.count}
                      </Badge>
                    ) : null}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FieldSet>
          ) : null}
          {options.priority.length > 0 ? (
            <FieldSet className="gap-2">
              <FieldLegend variant="label">Priority</FieldLegend>
              <ToggleGroup
                type="multiple"
                variant="outline"
                spacing={1}
                value={draft.priority ?? []}
                onValueChange={(priority) =>
                  update({ ...draft, priority: priority as NonNullable<SearchFilters["priority"]> })
                }
                className="flex flex-wrap"
              >
                {options.priority.map((option) => (
                  <ToggleGroupItem key={option.value} value={option.value}>
                    <span>{option.label}</span>
                    {typeof option.count === "number" ? (
                      <Badge variant="secondary" className="ml-1 tabular-nums">
                        {option.count}
                      </Badge>
                    ) : null}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FieldSet>
          ) : null}
          {options.owner.length > 0 ? (
            <FieldSet className="gap-2">
              <FieldLegend variant="label">Owner</FieldLegend>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={1}
                value={selectedOwner ?? ""}
                onValueChange={(owner) =>
                  update(applyOwnerSelectionId(draft, owner || undefined, data.currentUserId))
                }
                className="flex flex-wrap"
              >
                {options.owner.map((option) => (
                  <ToggleGroupItem key={option.value} value={option.value}>
                    <span>{option.label}</span>
                    {typeof option.count === "number" ? (
                      <Badge variant="secondary" className="ml-1 tabular-nums">
                        {option.count}
                      </Badge>
                    ) : null}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FieldSet>
          ) : null}
          {options.project.length > 0 ? (
            <FieldSet className="gap-2">
              <FieldLegend variant="label">Project</FieldLegend>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={1}
                value={draft.projectId ?? ""}
                onValueChange={(projectId) => update({ ...draft, projectId: projectId || undefined })}
                className="flex flex-wrap"
              >
                {options.project.map((option) => (
                  <ToggleGroupItem key={option.value} value={option.value}>
                    <span>{option.label}</span>
                    {typeof option.count === "number" ? (
                      <Badge variant="secondary" className="ml-1 tabular-nums">
                        {option.count}
                      </Badge>
                    ) : null}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FieldSet>
          ) : null}
          {options.label.length > 0 ? (
            <FieldSet className="gap-2">
              <FieldLegend variant="label">Label</FieldLegend>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={1}
                value={draft.labelId ?? ""}
                onValueChange={(labelId) => update({ ...draft, labelId: labelId || undefined })}
                className="flex flex-wrap"
              >
                {options.label.map((option) => (
                  <ToggleGroupItem key={option.value} value={option.value}>
                    {option.swatch ? (
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: option.swatch }}
                        aria-hidden
                      />
                    ) : null}
                    <span>{option.label}</span>
                    {typeof option.count === "number" ? (
                      <Badge variant="secondary" className="ml-1 tabular-nums">
                        {option.count}
                      </Badge>
                    ) : null}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FieldSet>
          ) : null}
          {options.updated.length > 0 ? (
            <FieldSet className="gap-2">
              <FieldLegend variant="label">Updated</FieldLegend>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={1}
                value={draft.updatedWithin ?? ""}
                onValueChange={(updatedWithin) =>
                  update({
                    ...draft,
                    updatedWithin: (updatedWithin || undefined) as SearchFilters["updatedWithin"],
                  })
                }
                className="flex flex-wrap"
              >
                {options.updated.map((option) => (
                  <ToggleGroupItem key={option.value} value={option.value}>
                    <span>{option.label}</span>
                    {typeof option.count === "number" ? (
                      <Badge variant="secondary" className="ml-1 tabular-nums">
                        {option.count}
                      </Badge>
                    ) : null}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FieldSet>
          ) : null}
          <FieldSet className="gap-2">
            <FieldLegend variant="label">Sort by</FieldLegend>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={1}
              value={sort}
              onValueChange={(value) => {
                if (value) onSortChange(value as CompanySearchSort);
              }}
              className="flex flex-wrap"
            >
              {COMPANY_SEARCH_SORTS.map((value) => (
                <ToggleGroupItem key={value} value={value}>
                  {SORT_LABELS[value]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldSet>
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
