import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { projectsApi } from "@/api/projects";
import { searchApi } from "@/api/search";
import { tasksApi } from "@/api/tasks";
import type { SearchFilterDataProps } from "@/routes/_authenticated/$companyId/search/-SearchFilterBar";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialogActions } from "@/context/DialogContext";
import { useSidebar } from "@/context/SidebarContext";
import { queryKeys } from "@/lib/queryKeys";
import { loadRecentSearches, pushRecentSearch } from "@/lib/recent-searches";
import { countActiveFilters, type FilterChipLookups } from "@/lib/search-filters";
import {
  hasSearchFilters,
  parseSearchQuery,
  searchFilterPills,
  searchOperatorSuggestions,
  type ParsedSearchQuery,
  type SearchQueryParserContext,
} from "@/lib/search-query-parser";
import {
  COMPANY_SEARCH_DEFAULT_LIMIT,
  type Agent,
  type CompanySearchResponse,
  type CompanySearchScope,
  type CompanySearchSort,
  type Project,
  type TaskLabel,
} from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildSearchState,
  buildSubgroups,
  isCompanySearchScope,
  mergeSearchFilters,
  SEARCH_DEBOUNCE_MS,
  searchFiltersFromRoute,
  shapeError,
  totalMatchCount,
} from "./-search-state";

export function useCompanySearchController() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewTask } = useDialogActions();
  const route = getRouteApi("/_authenticated/$companyId/search/");
  const { companyId } = route.useParams();
  const routeSearch = route.useSearch();
  const routeNavigate = route.useNavigate();
  const navigate = useNavigate();

  const { isMobile } = useSidebar();
  const urlQuery = routeSearch.q ?? "";
  const urlScope: CompanySearchScope = routeSearch.scope ?? "all";
  const urlSort: CompanySearchSort = routeSearch.sort ?? "relevance";

  const [draftQuery, setDraftQuery] = useState(urlQuery);
  const [committedQuery, setCommittedQuery] = useState(urlQuery);
  const [scope, setScope] = useState<CompanySearchScope>(urlScope);
  const [sort, setSort] = useState<CompanySearchSort>(urlSort);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draftSheetFilters, setDraftSheetFilters] = useState<ParsedSearchQuery["filters"]>({});
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Search" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setRecentSearches(loadRecentSearches(companyId));
  }, [companyId]);

  // Pull URL changes back into local state (e.g. browser back/forward).
  useEffect(() => {
    setDraftQuery(urlQuery);
    setCommittedQuery(urlQuery);
  }, [urlQuery]);

  useEffect(() => {
    setScope(urlScope);
  }, [urlScope]);

  useEffect(() => {
    setSort(urlSort);
  }, [urlSort]);

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const { data: projects = [] } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });

  const { data: labels = [] } = useQuery({
    queryKey: queryKeys.tasks.labels(companyId),
    queryFn: () => tasksApi.listLabels(companyId),
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const currentUserId = session?.user.id ?? null;
  const parserContext = useMemo<SearchQueryParserContext>(
    () => ({
      agents: agents as Agent[],
      projects: projects as Project[],
      labels: labels as TaskLabel[],
    }),
    [agents, labels, projects],
  );
  const parsedUrlFilters = useMemo(
    () => searchFiltersFromRoute(routeSearch),
    [
      routeSearch.labelId,
      routeSearch.ownerAgentId,
      routeSearch.ownerUserId,
      routeSearch.priority,
      routeSearch.projectId,
      routeSearch.status,
      routeSearch.updatedAfter,
      routeSearch.updatedWithin,
    ],
  );
  const [urlFilters, setUrlFilters] = useState(parsedUrlFilters);

  useEffect(() => {
    setUrlFilters(parsedUrlFilters);
  }, [parsedUrlFilters]);
  const parsedDraftQuery = useMemo(
    () => parseSearchQuery(draftQuery, parserContext),
    [draftQuery, parserContext],
  );
  const parsedCommittedQuery = useMemo(
    () => parseSearchQuery(committedQuery, parserContext),
    [committedQuery, parserContext],
  );
  const committedOperatorFilters = parsedCommittedQuery.filters;
  const draftOperatorFilters = parsedDraftQuery.filters;
  const activeFilters = useMemo(
    () => mergeSearchFilters(urlFilters, committedOperatorFilters),
    [committedOperatorFilters, urlFilters],
  );
  const draftFilters = useMemo(
    () => mergeSearchFilters(urlFilters, draftOperatorFilters),
    [draftOperatorFilters, urlFilters],
  );

  // Debounce the draft query into the route-validated, shareable search state.
  useEffect(() => {
    if (draftQuery === committedQuery) return;
    const handle = window.setTimeout(() => {
      setCommittedQuery(draftQuery);
      void routeNavigate({
        search: buildSearchState(draftQuery, scope, urlFilters, sort),
        replace: true,
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [committedQuery, draftQuery, routeNavigate, scope, sort, urlFilters]);

  const handleScopeChange = useCallback(
    (next: string) => {
      if (!isCompanySearchScope(next) || next === scope) return;
      setScope(next);
      void routeNavigate({
        search: buildSearchState(committedQuery, next, urlFilters, sort),
      });
    },
    [committedQuery, routeNavigate, scope, sort, urlFilters],
  );

  const handleSortChange = useCallback(
    (next: CompanySearchSort) => {
      setSort(next);
      void routeNavigate({
        search: buildSearchState(committedQuery, scope, urlFilters, next),
      });
    },
    [committedQuery, routeNavigate, scope, urlFilters],
  );

  // Filter-bar / chip / sheet changes make the controls authoritative: `next`
  // already contains any operator-derived values (the controls render the merged
  // view), so strip the typed tokens from the query to keep the plain text and
  // prevent a removed filter from resurrecting out of the input.
  const handleFiltersChange = useCallback(
    (next: ParsedSearchQuery["filters"]) => {
      const plain = parsedCommittedQuery.query;
      setDraftQuery(plain);
      setCommittedQuery(plain);
      setUrlFilters(next);
      void routeNavigate({
        search: buildSearchState(plain, scope, next, sort),
      });
    },
    [parsedCommittedQuery.query, routeNavigate, scope, sort],
  );

  // "Clear all" drops both URL filters and any typed operator tokens (keeping the
  // plain text query), so the results snap back to the unfiltered set.
  const handleClearAllFilters = useCallback(() => {
    const plain = parsedCommittedQuery.query;
    setDraftQuery(plain);
    setCommittedQuery(plain);
    setUrlFilters({});
    void routeNavigate({
      search: buildSearchState(plain, scope, {}, sort),
      replace: true,
    });
  }, [parsedCommittedQuery.query, routeNavigate, scope, sort]);

  const trimmedQuery = parsedCommittedQuery.query.trim();
  const displayQuery = committedQuery.trim();
  const queryEnabled = trimmedQuery.length > 0 || hasSearchFilters(activeFilters);

  const { data, isFetching, error, refetch } = useQuery<CompanySearchResponse>({
    queryKey: [
      ...queryKeys.companySearch.search(companyId, trimmedQuery, scope, COMPANY_SEARCH_DEFAULT_LIMIT, 0),
      activeFilters,
      sort,
    ] as const,
    queryFn: () =>
      searchApi.search(companyId, {
        q: trimmedQuery,
        scope,
        limit: COMPANY_SEARCH_DEFAULT_LIMIT,
        ...activeFilters,
        ...(sort !== "relevance" ? { sort } : {}),
      }),
    enabled: queryEnabled,
    placeholderData: (previousData) => previousData,
  });

  const agentsById = useMemo<ReadonlyMap<string, Pick<Agent, "id" | "name">>>(() => {
    const map = new Map<string, Pick<Agent, "id" | "name">>();
    for (const agent of agents) map.set(agent.id, agent);
    return map;
  }, [agents]);

  const projectsById = useMemo(() => new Map((projects as Project[]).map((p) => [p.id, p])), [projects]);
  const labelsById = useMemo(() => new Map((labels as TaskLabel[]).map((l) => [l.id, l])), [labels]);

  const filterLookups = useMemo<FilterChipLookups>(
    () => ({
      agentName: (id) => agentsById.get(id)?.name,
      userName: () => undefined,
      projectName: (id) => projectsById.get(id)?.name,
      labelName: (id) => labelsById.get(id)?.name,
      currentUserId,
    }),
    [agentsById, projectsById, labelsById, currentUserId],
  );

  const filterData = useMemo<SearchFilterDataProps>(
    () => ({
      counts: data?.filterOptionCounts,
      agents: agents as Agent[],
      projects: projects as Project[],
      labels: labels as TaskLabel[],
      currentUserId,
    }),
    [data?.filterOptionCounts, agents, projects, labels, currentUserId],
  );

  const filtersActive = hasSearchFilters(activeFilters);
  const activeFilterCount = countActiveFilters(activeFilters);

  // Preview query for the mobile bottom sheet: run the draft filters so the apply
  // button can show "Show N results" before the user commits.
  const { data: previewData } = useQuery<CompanySearchResponse>({
    queryKey: [
      ...queryKeys.companySearch.search(companyId, trimmedQuery, scope, COMPANY_SEARCH_DEFAULT_LIMIT, 0),
      "preview",
      draftSheetFilters,
      sort,
    ] as const,
    queryFn: () =>
      searchApi.search(companyId, {
        q: trimmedQuery,
        scope,
        limit: COMPANY_SEARCH_DEFAULT_LIMIT,
        ...draftSheetFilters,
        ...(sort !== "relevance" ? { sort } : {}),
      }),
    enabled: queryEnabled && sheetOpen,
    placeholderData: (previousData) => previousData,
  });

  // Persist recent searches once we have a successful response with a non-empty query.
  useEffect(() => {
    if (!data || !displayQuery) return;
    const next = pushRecentSearch(companyId, displayQuery);
    setRecentSearches(next);
  }, [data, displayQuery, companyId]);

  const handleClear = useCallback(() => {
    setDraftQuery("");
    setCommittedQuery("");
    inputRef.current?.focus();
    setUrlFilters({});
    void routeNavigate({
      search: buildSearchState("", scope, {}),
      replace: true,
    });
  }, [routeNavigate, scope]);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // Global "/" focus shortcut.
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (target?.isContentEditable || tag === "input" || tag === "textarea") return;
      event.preventDefault();
      focusInput();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusInput]);

  const counts = data?.countsByType ?? {
    task: 0,
    comment: 0,
    document: 0,
    artifact: 0,
    agent: 0,
    project: 0,
  };
  const totalResults = data?.results.length ?? 0;
  const allMatchTotal = data ? totalMatchCount(counts) : 0;
  const previewTotal = previewData ? totalMatchCount(previewData.countsByType) : null;

  const subgroups = useMemo(() => buildSubgroups(data?.results ?? []), [data?.results]);

  const operatorPills = useMemo(
    () => searchFilterPills(draftFilters, parserContext),
    [draftFilters, parserContext],
  );
  const operatorSuggestions = useMemo(
    () => (inputFocused ? searchOperatorSuggestions(draftQuery, 4) : []),
    [draftQuery, inputFocused],
  );
  const showInitialState = !displayQuery && !hasSearchFilters(activeFilters);
  const isLoading = queryEnabled && isFetching && !data;
  const hasResults = !!data && totalResults > 0;
  const isEmpty = !!data && !isFetching && totalResults === 0;
  const hasError = !!error && !isLoading;
  const apiError = hasError ? shapeError(error) : null;
  const apiMessage = data?.results === undefined && data ? null : null;
  void apiMessage;

  function navigateToTasks() {
    const taskQuery = trimmedQuery || displayQuery;
    void navigate({
      to: "/$companyId/tasks",
      params: { companyId },
      search: {
        q: taskQuery || undefined,
        participantAgentId: undefined,
        ownerAgentId: undefined,
        ownerUserId: undefined,
      },
    });
  }

  function handleRecentClick(value: string) {
    setDraftQuery(value);
    setCommittedQuery(value);
    setUrlFilters({});
    void routeNavigate({
      search: buildSearchState(value, scope, {}),
      replace: true,
    });
  }

  function showAllScope() {
    if (scope === "all") return;
    handleScopeChange("all");
  }

  const searchDisplayLabel = displayQuery || operatorPills.map((pill) => pill.label).join(" ");

  return {
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
    onDraftSheetFiltersChange: setDraftSheetFilters,
    onInputFocusChange: setInputFocused,
    onQueryChange: setDraftQuery,
    onSheetOpenChange: setSheetOpen,
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
  };
}
