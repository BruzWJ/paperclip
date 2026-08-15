import { CompanySearchTabContent, ZeroResultsRecovery } from "@/routes/_authenticated/$companyId/search/-CompanySearchTabContent";
import { SearchFilterBar, SearchFilterChips, SearchSortMenu } from "@/routes/_authenticated/$companyId/search/-SearchFilterBar";
import { SearchFilterSheet } from "@/routes/_authenticated/$companyId/search/-SearchFilterSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SORT_LABELS } from "@/lib/search-filters";
import { applySearchOperatorSuggestion } from "@/lib/search-query-parser";
import { COMPANY_SEARCH_SCOPES, type CompanySearchScope } from "@paperclipai/shared";
import { createFileRoute } from "@tanstack/react-router";
import { Search as SearchIcon, SlidersHorizontal, X } from "lucide-react";
import { useMemo } from "react";
import { SCOPE_LABELS, validateCompanySearch } from "./-search-state";
import { useCompanySearchController } from "./-useCompanySearchController";

export { buildSearchState, validateCompanySearch } from "./-search-state";
export type { SearchRouteState } from "./-search-state";

export const Route = createFileRoute("/_authenticated/$companyId/search/")({
  validateSearch: validateCompanySearch,
  component: Search,
});

function Search() {
  const controller = useCompanySearchController();
  const {
    activeFilterCount,
    activeFilters,
    agentsById,
    allMatchTotal,
    apiError,
    counts,
    data,
    draftQuery,
    filterData,
    filterLookups,
    filtersActive,
    handleClear,
    handleClearAllFilters,
    handleFiltersChange,
    handleRecentClick,
    handleScopeChange,
    handleSortChange,
    hasError,
    hasResults,
    inputRef,
    isEmpty,
    isFetching,
    isLoading,
    isMobile,
    navigateToTasks,
    onDraftSheetFiltersChange,
    onInputFocusChange,
    onQueryChange,
    onSheetOpenChange,
    openNewTask,
    operatorPills,
    operatorSuggestions,
    previewTotal,
    recentSearches,
    refetch,
    scope,
    searchDisplayLabel,
    sheetOpen,
    showAllScope,
    showInitialState,
    sort,
    subgroups,
    totalResults,
  } = controller;

  const tabItems = useMemo(() => {
    function pill(value: number) {
      if (!data) return null;
      return (
        <Badge
          variant="outline"
          className="ml-1.5 px-1.5 py-0 text-(length:--text-nano) tabular-nums font-normal"
        >
          {value}
        </Badge>
      );
    }
    const tasksTotal = counts.task ?? 0;
    return COMPANY_SEARCH_SCOPES.map((value) => {
      let count: number | null = null;
      if (value === "all") {
        count =
          (counts.task ?? 0) +
          (counts.comment ?? 0) +
          (counts.document ?? 0) +
          (counts.artifact ?? 0) +
          (counts.agent ?? 0) +
          (counts.project ?? 0);
      } else if (value === "tasks") count = tasksTotal;
      else if (value === "comments") count = counts.comment ?? 0;
      else if (value === "documents") count = counts.document ?? 0;
      else if (value === "artifacts") count = counts.artifact ?? 0;
      else if (value === "agents") count = counts.agent ?? 0;
      else if (value === "projects") count = counts.project ?? 0;
      const dashOut = filtersActive && (value === "agents" || value === "projects");
      return {
        value,
        label: (
          <span className="flex items-center">
            {SCOPE_LABELS[value as CompanySearchScope]}
            {dashOut ? (
              <span className="ml-1.5 text-(length:--text-nano) text-muted-foreground">—</span>
            ) : count !== null ? (
              pill(count)
            ) : null}
          </span>
        ),
      };
    });
  }, [counts, data, filtersActive]);

  const zeroResultsSlot = data?.zeroResults ? (
    <ZeroResultsRecovery
      query={searchDisplayLabel}
      filters={activeFilters}
      zeroResults={data.zeroResults}
      lookups={filterLookups}
      onChange={handleFiltersChange}
      onClearAll={handleClearAllFilters}
    />
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-page="search">
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <h1 className="sr-only">Search</h1>
        <InputGroup className="h-10">
          <InputGroupAddon>
            <SearchIcon aria-hidden  data-icon="inline-start"/>
          </InputGroupAddon>
          <InputGroupInput
            ref={inputRef}
            autoFocus
            value={draftQuery}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            onFocus={() => onInputFocusChange(true)}
            onBlur={() => onInputFocusChange(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                if (draftQuery.length > 0) {
                  event.preventDefault();
                  handleClear();
                } else {
                  event.currentTarget.blur();
                }
              }
            }}
            placeholder="Search tasks, comments, documents, artifacts, agents, projects…"
            aria-label="Search query"
          />
          {draftQuery.length > 0 ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" onClick={handleClear} aria-label="Clear search">
                <X  data-icon="inline-start"/>
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
          <InputGroupAddon align="inline-end">
            <Kbd aria-hidden>⌘K</Kbd>
          </InputGroupAddon>
        </InputGroup>
        <div className="mt-2 flex min-h-6 flex-wrap items-center gap-1.5 text-(length:--text-micro) text-muted-foreground">
          {operatorPills.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="search-operator-pills">
              {operatorPills.map((pill) => (
                <Badge
                  key={`${pill.key}:${pill.value}`}
                  variant="outline"
                  className="px-1.5 py-0 text-(length:--text-micro) font-normal normal-case"
                >
                  {pill.label}
                </Badge>
              ))}
            </div>
          ) : null}
          {operatorSuggestions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="search-operator-suggestions">
              {operatorSuggestions.map((suggestion) => (
                <Button
                  key={suggestion.token}
                  variant="outline"
                  size="xs"
                  aria-label={`Insert operator ${suggestion.token}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onQueryChange(applySearchOperatorSuggestion(draftQuery, suggestion.token));
                    inputRef.current?.focus();
                  }}
                >
                  <span className="font-mono text-(length:--text-micro)">{suggestion.token}</span>
                  <span className="hidden text-(length:--text-micro) sm:inline">
                    {suggestion.description}
                  </span>
                </Button>
              ))}
            </div>
          ) : (
            <span className="truncate">
              Try <code className="rounded bg-muted px-1 py-0.5 text-(length:--text-micro)">status:todo</code>
              , or{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-(length:--text-micro)">updated:&gt;7d</code>.
            </span>
          )}
        </div>
      </div>

      <Tabs value={scope} onValueChange={handleScopeChange} className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border px-2 sm:px-4">
          <TabsList variant="line" className="justify-start">
            {tabItems.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {!showInitialState ? (
          <div
            className="flex flex-col gap-2 border-b border-border px-2 py-2 sm:px-4"
            data-testid="search-filters"
          >
            {isMobile ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-xs font-normal"
                  onClick={() => onSheetOpenChange(true)}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5"  data-icon="inline-start"/>
                  Filters
                  {activeFilterCount > 0 ? (
                    <Badge className="ml-0.5 min-w-4 px-1 text-(length:--text-nano) tabular-nums">
                      {activeFilterCount}
                    </Badge>
                  ) : null}
                </Button>
                <div className="ml-auto">
                  <SearchSortMenu value={sort} onChange={handleSortChange} />
                </div>
              </div>
            ) : (
              <SearchFilterBar
                filters={activeFilters}
                onChange={handleFiltersChange}
                sort={sort}
                onSortChange={handleSortChange}
                data={filterData}
              />
            )}
            <SearchFilterChips
              filters={activeFilters}
              lookups={filterLookups}
              onChange={handleFiltersChange}
              onClearAll={handleClearAllFilters}
            />
          </div>
        ) : null}

        {COMPANY_SEARCH_SCOPES.map((scopeValue) => (
          <TabsContent
            key={scopeValue}
            value={scopeValue}
            className="flex h-full min-h-0 flex-col overflow-y-auto"
          >
            {scopeValue === scope ? (
              <CompanySearchTabContent
                showInitialState={showInitialState}
                isLoading={isLoading}
                hasResults={hasResults}
                hasError={hasError}
                apiError={apiError}
                isEmpty={isEmpty}
                trimmedQuery={searchDisplayLabel}
                scope={scope}
                showAllScope={showAllScope}
                navigateToTasks={navigateToTasks}
                openNewTask={() => openNewTask({ title: searchDisplayLabel })}
                refetch={() => void refetch()}
                recentSearches={recentSearches}
                onRecentClick={handleRecentClick}
                subgroups={subgroups}
                totalResults={totalResults}
                allMatchTotal={allMatchTotal}
                activeFilterCount={activeFilterCount}
                sortLabel={SORT_LABELS[sort]}
                zeroResultsSlot={zeroResultsSlot}
                isFetching={isFetching && !!data}
                agentsById={agentsById}
              />
            ) : null}
          </TabsContent>
        ))}
      </Tabs>

      {isMobile ? (
        <SearchFilterSheet
          open={sheetOpen}
          onOpenChange={onSheetOpenChange}
          filters={activeFilters}
          onApply={handleFiltersChange}
          onDraftChange={onDraftSheetFiltersChange}
          previewTotal={previewTotal}
          data={filterData}
          sort={sort}
          onSortChange={handleSortChange}
        />
      ) : null}
    </div>
  );
}
