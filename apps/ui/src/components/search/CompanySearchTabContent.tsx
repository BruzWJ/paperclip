import { SearchResultRow } from "@/components/search/SearchResultRow";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Item, ItemGroup } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  clearFilterDimension,
  countActiveFilters,
  describeLoosenSuggestion,
  type FilterChipLookups,
  type SearchFilters,
} from "@/lib/search-filters";
import {
  describeScope,
  SUBGROUP_LABELS,
  type CompanySearchError,
  type CompanySearchSubgroup,
} from "@/routes/_authenticated/$companyId/search/-search-state";
import type {
  Agent,
  CompanySearchResult,
  CompanySearchScope,
  CompanySearchZeroResults,
} from "@paperclipai/shared";
import { AlertTriangle, FilterX, FileQuestion, Plus, RotateCcw, Search as SearchIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface SearchTabContentProps {
  showInitialState: boolean;
  isLoading: boolean;
  hasResults: boolean;
  hasError: boolean;
  apiError: CompanySearchError | null;
  isEmpty: boolean;
  trimmedQuery: string;
  scope: CompanySearchScope;
  showAllScope: () => void;
  navigateToTasks: () => void;
  openNewTask: () => void;
  refetch: () => void;
  recentSearches: string[];
  onRecentClick: (query: string) => void;
  subgroups: CompanySearchSubgroup[];
  totalResults: number;
  allMatchTotal: number;
  activeFilterCount: number;
  sortLabel: string;
  zeroResultsSlot: ReactNode;
  isFetching: boolean;
  agentsById: ReadonlyMap<string, Pick<Agent, "id" | "name">>;
}

export function ZeroResultsRecovery({
  query,
  filters,
  zeroResults,
  lookups,
  onChange,
  onClearAll,
}: {
  query: string;
  filters: SearchFilters;
  zeroResults: CompanySearchZeroResults;
  lookups: FilterChipLookups;
  onChange: (next: SearchFilters) => void;
  onClearAll: () => void;
}) {
  const activeCount = countActiveFilters(filters);
  const suggestions = [...zeroResults.loosenSuggestions].sort(
    (a, b) => b.additionalCount - a.additionalCount,
  );
  return (
    <Empty data-testid="search-zero-results-recovery">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FilterX aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No results with these filters</EmptyTitle>
        <EmptyDescription>
          {zeroResults.unfilteredTotal === 1
            ? "1 result matches"
            : `${zeroResults.unfilteredTotal} results match`}
          {query ? <> &ldquo;{query}&rdquo;</> : null}, but your{" "}
          {activeCount === 1 ? "active filter hides" : `${activeCount} active filters hide`} them.
        </EmptyDescription>
      </EmptyHeader>
      {suggestions.length > 0 ? (
        <EmptyContent>
          <p className="font-medium">Loosen a filter</p>
          {suggestions.map((suggestion) => (
            <Button
              key={`${suggestion.filter}:${suggestion.values.join(",")}`}
              type="button"
              variant="outline"
              className="h-auto w-full justify-between whitespace-normal"
              onClick={() => onChange(clearFilterDimension(filters, suggestion.filter))}
            >
              <span className="min-w-0 truncate">
                Remove{" "}
                <span className="font-medium">
                  {describeLoosenSuggestion(suggestion.filter, suggestion.values, lookups)}
                </span>
              </span>
              <Badge variant="secondary">
                +{suggestion.additionalCount} {suggestion.additionalCount === 1 ? "result" : "results"}
              </Badge>
            </Button>
          ))}
        </EmptyContent>
      ) : null}
      <Button onClick={onClearAll} size="sm">
        <RotateCcw data-icon="inline-start" />
        Clear all filters
      </Button>
    </Empty>
  );
}

export function CompanySearchTabContent({
  showInitialState,
  isLoading,
  hasResults,
  hasError,
  apiError,
  isEmpty,
  trimmedQuery,
  scope,
  showAllScope,
  navigateToTasks,
  openNewTask,
  refetch,
  recentSearches,
  onRecentClick,
  subgroups,
  totalResults,
  allMatchTotal,
  activeFilterCount,
  sortLabel,
  zeroResultsSlot,
  isFetching,
  agentsById,
}: SearchTabContentProps) {
  if (showInitialState) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10 sm:px-6">
        <div>
          <h2 className="text-lg font-semibold">Type to search company memory.</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Tasks, comments, plan documents, artifacts, agents, projects — same surface, ranked by relevance.
          </p>
        </div>
        {recentSearches.length > 0 ? (
          <div>
            <div className="mb-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
              Recent searches
            </div>
            <ItemGroup className="rounded-md border">
              {recentSearches.map((entry) => (
                <Item key={entry} asChild size="sm">
                  <Button
                    variant="ghost"
                    onClick={() => onRecentClick(entry)}
                    className="w-full justify-start"
                  >
                    <SearchIcon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="flex-1 truncate">{entry}</span>
                  </Button>
                </Item>
              ))}
            </ItemGroup>
          </div>
        ) : null}
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">Identifier lookup:</span> type{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-(length:--text-micro)">PAP-123</code> to jump
            straight to a task.
          </li>
          <li>
            <span className="font-medium text-foreground">Quoted phrases:</span> wrap a phrase in quotes to
            match the exact sequence.
          </li>
          <li>
            <span className="font-medium text-foreground">⌘K:</span> reopens the command palette pre-seeded
            with your current query.
          </li>
        </ul>
      </div>
    );
  }

  if (hasError) {
    const status = apiError?.status;
    return (
      <Alert variant="destructive" className="mx-auto my-12 max-w-xl">
        <AlertTriangle aria-hidden />
        <AlertTitle>Couldn’t run that search</AlertTitle>
        <AlertDescription>
          <p>
            {status ? `The server returned ${status}.` : "The request failed."} Your input and filters are
            still here, so you can retry or fall back to the Tasks filter.
          </p>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button onClick={refetch} size="sm">
              Retry
            </Button>
            <Button onClick={navigateToTasks} variant="outline" size="sm">
              Open Tasks filter view
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 px-2 py-3 sm:px-4">
        <div className="px-3 text-xs text-muted-foreground" data-testid="search-loading">
          Searching for &ldquo;{trimmedQuery}&rdquo;…
        </div>
        <div className="flex flex-col">
          <div className="px-3 py-2">
            <Skeleton className="h-3 w-24" />
          </div>
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="flex items-start gap-3 px-3 py-2">
              <Skeleton className="mt-1 h-4 w-4 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (isEmpty) {
    // Filters emptied the page → recovery UI (screen 4). Plain zero-results keeps
    // the tips card below.
    if (zeroResultsSlot) return zeroResultsSlot;
    return (
      <Empty className="mx-auto max-w-xl border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestion aria-hidden />
          </EmptyMedia>
          <EmptyTitle>No results for &ldquo;{trimmedQuery}&rdquo;</EmptyTitle>
          <EmptyDescription>
            We couldn’t find a match in {describeScope(scope).toLowerCase()}. Try widening the scope or
            rephrasing your query.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {scope !== "all" ? (
              <Button onClick={showAllScope} size="sm" variant="outline">
                Search all scopes
              </Button>
            ) : null}
            <Button onClick={openNewTask} size="sm" variant="default">
              <Plus data-icon="inline-start" className="mr-1.5 h-4 w-4" />
              Create task from this query
            </Button>
            <Button onClick={navigateToTasks} size="sm" variant="ghost">
              Open Tasks filter view
            </Button>
          </div>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            <li>Try fewer tokens or a single distinctive term.</li>
            <li>Search by a task title or a distinctive phrase from its content.</li>
            <li>Wrap multi-word phrases in quotes.</li>
          </ul>
        </EmptyContent>
      </Empty>
    );
  }

  if (!hasResults) return null;

  return (
    <div className="flex w-full max-w-(--sz-960px) flex-col px-2 sm:px-4" data-testid="search-results">
      <div className="flex items-center justify-between py-2 text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
        <span>
          {allMatchTotal > totalResults
            ? `${totalResults} of ${allMatchTotal} results`
            : totalResults === 1
              ? "1 result"
              : `${totalResults} results`}
          {` · sorted by ${sortLabel}`}
          {activeFilterCount > 0
            ? ` · ${activeFilterCount} ${activeFilterCount === 1 ? "filter" : "filters"} active`
            : ""}
        </span>
        {isFetching ? (
          <span aria-live="polite" className="normal-case tracking-normal">
            Updating…
          </span>
        ) : null}
      </div>
      <div className="flex flex-col pb-10">
        {scope === "all" ? (
          subgroups.map((group, groupIndex) => (
            <section
              key={group.key}
              aria-label={SUBGROUP_LABELS[group.key]}
              className={cn("flex flex-col", groupIndex > 0 && "mt-6")}
            >
              <div className="flex items-center pt-2 pr-3 pb-1 pl-1 text-(length:--text-micro) tracking-wider text-muted-foreground">
                <span className="truncate text-sm font-semibold uppercase tracking-wide">
                  {SUBGROUP_LABELS[group.key]}
                </span>
                <div className="ml-auto">
                  <span className="text-xs font-normal tabular-nums text-muted-foreground">
                    {group.results.length}
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-y-1">
                {group.results.map((result) => (
                  <SearchResultRow
                    key={`${result.type}:${result.id}`}
                    result={result}
                    agentsById={agentsById}
                  />
                ))}
              </div>
            </section>
          ))
        ) : (
          <div className="flex flex-col gap-y-1">
            {subgroups
              .flatMap((group) => group.results)
              .map((result) => (
                <SearchResultRow
                  key={`${result.type}:${result.id}`}
                  result={result}
                  agentsById={agentsById}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
