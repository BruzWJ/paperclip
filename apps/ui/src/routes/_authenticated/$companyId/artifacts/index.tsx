import { createFileRoute } from "@tanstack/react-router";
import { COMPANY_ARTIFACTS_MAX_QUERY_LENGTH } from "@paperclipai/shared";
import {
  assertOnlySearchKeys,
  optionalCanonicalUuidSearch,
  optionalExactSearchString,
  optionalSearchEnum,
} from "@/routes/-search";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowLeft, Layers, Package, Search, X } from "lucide-react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { artifactsApi, type ArtifactGroupBy, type ArtifactKindFilter } from "@/api/artifacts";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { Skeleton } from "@/components/ui/skeleton";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { ArtifactGroupCard } from "@/components/artifacts/ArtifactGroupCard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

type ArtifactsSearch = {
  kind?: "all" | "image" | "video" | "document" | "text" | "file";
  q?: string;
  groupBy?: "none" | "task" | "parent_task";
  groupTaskId?: string;
};

const ARTIFACT_SEARCH_KEYS = ["kind", "q", "groupBy", "groupTaskId"] as const;

const ARTIFACT_KINDS = ["all", "image", "video", "document", "text", "file"] as const;

const ARTIFACT_GROUPS = ["none", "task", "parent_task"] as const;

export function validateArtifactsSearch(search: Record<string, unknown>): ArtifactsSearch {
  assertOnlySearchKeys(search, ARTIFACT_SEARCH_KEYS);
  const validated = {
    kind: optionalSearchEnum(search.kind, ARTIFACT_KINDS, "kind"),
    q: optionalExactSearchString(search.q, "q", COMPANY_ARTIFACTS_MAX_QUERY_LENGTH),
    groupBy: optionalSearchEnum(search.groupBy, ARTIFACT_GROUPS, "groupBy"),
    groupTaskId: optionalCanonicalUuidSearch(search.groupTaskId, "groupTaskId"),
  };
  if (validated.groupBy === "none" && validated.groupTaskId !== undefined) {
    throw new Error('Invalid search parameters: "groupTaskId" requires artifact grouping');
  }
  return validated;
}

export const Route = createFileRoute("/_authenticated/$companyId/artifacts/")({
  validateSearch: validateArtifactsSearch,
  component: Artifacts,
});

const ARTIFACTS_PAGE_SIZE = 30;

const SEARCH_DEBOUNCE_MS = 250;

export const ARTIFACT_KIND_FILTERS: {
  value: ArtifactKindFilter;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "document", label: "Documents" },
  { value: "text", label: "Text" },
  { value: "file", label: "Files" },
];

export const ARTIFACT_GROUP_OPTIONS: {
  value: ArtifactGroupBy;
  label: string;
}[] = [
  { value: "none", label: "None" },
  { value: "task", label: "Task" },
  { value: "parent_task", label: "Parent task" },
];

export function artifactGroupByLabel(value: ArtifactGroupBy): string {
  return ARTIFACT_GROUP_OPTIONS.find((option) => option.value === value)?.label ?? "None";
}

function Artifacts() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const route = getRouteApi("/_authenticated/$companyId/artifacts/");
  const { companyId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();

  const kind = search.kind ?? "all";
  const query = search.q ?? "";
  const groupBy = search.groupBy ?? "task";
  const groupTaskId = search.groupTaskId;

  const [draftQuery, setDraftQuery] = useState(query);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const grouping = groupBy !== "none";
  const viewingStackList = grouping && !groupTaskId;
  const viewingSelectedStack = grouping && !!groupTaskId;

  // Keep the search box in sync when the committed query changes from outside
  // (e.g. back/forward navigation or a shared URL), without clobbering in-flight
  // typing (which leaves `query` unchanged until the debounce commits).
  useEffect(() => {
    setDraftQuery((prev) => (prev.trim() === query ? prev : query));
  }, [query]);

  // Debounce the search box into the `q` URL param so searches are shareable.
  useEffect(() => {
    const trimmed = draftQuery.trim();
    if (trimmed === query) return;
    const handle = window.setTimeout(() => {
      void navigate({
        search: (previous) => ({
          ...previous,
          q: trimmed || undefined,
        }),
        replace: true,
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draftQuery, navigate, query]);

  const selectKind = useCallback(
    (value: ArtifactKindFilter) => {
      void navigate({
        search: (previous) => ({
          ...previous,
          kind: value === "all" ? undefined : value,
        }),
      });
    },
    [navigate],
  );

  const selectGroupBy = useCallback(
    (value: ArtifactGroupBy) => {
      void navigate({
        search: (previous) => ({
          ...previous,
          groupBy: value === "task" ? undefined : value,
          groupTaskId: undefined,
        }),
      });
    },
    [navigate],
  );

  const stackSearch = useCallback(
    (taskId: string): typeof search => ({
      ...search,
      groupBy: groupBy === "task" ? undefined : groupBy,
      groupTaskId: taskId,
    }),
    [groupBy, search],
  );

  const backToStacksSearch = useMemo<typeof search>(
    () => ({
      ...search,
      groupBy: groupBy === "task" ? undefined : groupBy,
      groupTaskId: undefined,
    }),
    [groupBy, search],
  );

  const { data, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, error } =
    useInfiniteQuery({
      queryKey: queryKeys.artifacts.list(companyId, kind, query, groupBy, groupTaskId),
      queryFn: ({ pageParam }) =>
        artifactsApi.list(companyId, {
          kind,
          q: query || undefined,
          groupBy,
          groupTaskId,
          limit: ARTIFACTS_PAGE_SIZE,
          cursor: pageParam,
        }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    });

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasNextPage || isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void fetchNextPage();
        }
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const artifacts = useMemo(() => data?.pages.flatMap((page) => page.artifacts) ?? [], [data]);
  const groups = useMemo(() => data?.pages.flatMap((page) => page.groups ?? []) ?? [], [data]);
  const selectedGroup = useMemo(
    () => data?.pages.map((page) => page.selectedGroup).find(Boolean) ?? null,
    [data],
  );
  const searching = query.length > 0;

  useEffect(() => {
    if (viewingSelectedStack && selectedGroup) {
      setBreadcrumbs([
        {
          label: "Artifacts",
          renderLink: (content) => (
            <Link to="/$companyId/artifacts" params={{ companyId }} search={search}>
              {content}
            </Link>
          ),
        },
        { label: `${selectedGroup.task.identifier} · ${selectedGroup.title}` },
      ]);
    } else {
      setBreadcrumbs([{ label: "Artifacts" }]);
    }
  }, [companyId, search, setBreadcrumbs, viewingSelectedStack, selectedGroup]);

  const showGroupCards = viewingStackList;
  const items = showGroupCards ? groups : artifacts;

  const emptyMessage = showGroupCards
    ? searching
      ? "No artifact stacks match this search."
      : "No artifact stacks yet."
    : searching
      ? "No artifacts match this search."
      : viewingSelectedStack
        ? "No artifacts in this stack match the current filters."
        : kind === "all"
          ? "No artifacts yet. Outputs attached to tasks will appear here."
          : "No artifacts of this type yet.";

  return (
    <div className="w-full max-w-6xl space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <InputGroup className="w-full sm:max-w-sm">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.currentTarget.value)}
            placeholder="Search artifacts..."
            aria-label="Search artifacts"
          />
          {draftQuery.length > 0 ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                onClick={() => setDraftQuery("")}
                aria-label="Clear artifact search"
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>

        <div className="flex flex-wrap items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={`Group artifacts (currently ${artifactGroupByLabel(groupBy)})`}
                title="Group artifacts"
                data-testid="artifact-group-control"
                data-group-by={groupBy}
                className={cn("h-8 w-8 shrink-0", grouping && "bg-accent")}
              >
                <Layers className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Group by</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={groupBy}
                onValueChange={(value) => selectGroupBy(value as ArtifactGroupBy)}
              >
                {ARTIFACT_GROUP_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.value}
                    value={option.value}
                    data-testid={`artifact-group-option-${option.value}`}
                  >
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <ToggleGroup
            type="single"
            value={kind}
            variant="outline"
            size="sm"
            aria-label="Filter artifacts by type"
            onValueChange={(value) => {
              if (value) selectKind(value as ArtifactKindFilter);
            }}
          >
            {ARTIFACT_KIND_FILTERS.map((filter) => (
              <ToggleGroupItem key={filter.value} value={filter.value}>
                {filter.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {viewingSelectedStack ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button asChild variant="ghost" size="sm">
            <Link
              to="/$companyId/artifacts"
              params={{ companyId }}
              search={backToStacksSearch}
              data-testid="artifact-stack-back"
            >
              <ArrowLeft aria-hidden="true" />
              All stacks
            </Link>
          </Button>
          {selectedGroup ? (
            <span className="truncate text-muted-foreground">
              <span className="text-foreground/80">{selectedGroup.task.identifier}</span>{" "}
              {selectedGroup.title}
            </span>
          ) : null}
        </div>
      ) : null}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div role="status">
          <span className="sr-only">Loading artifacts…</span>
          <Skeleton className="h-32 w-full" />
        </div>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">{showGroupCards ? <Layers /> : <Package />}</EmptyMedia>
            <EmptyTitle>{emptyMessage}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            {showGroupCards
              ? groups.map((group) => (
                  <ArtifactGroupCard
                    key={group.id}
                    group={group}
                    linkOptions={{
                      to: "/$companyId/artifacts",
                      params: { companyId },
                      search: stackSearch(group.task.id),
                    }}
                  />
                ))
              : artifacts.map((artifact) => (
                  <ArtifactCard key={`${artifact.source}:${artifact.id}`} artifact={artifact} />
                ))}
          </div>
          <div
            ref={loadMoreRef}
            aria-live="polite"
            className="flex min-h-10 items-center justify-center pb-2 text-xs text-muted-foreground"
          >
            {isFetchingNextPage
              ? "Loading more artifacts..."
              : hasNextPage
                ? null
                : isFetching
                  ? "Updating artifacts..."
                  : null}
          </div>
        </>
      )}
    </div>
  );
}
