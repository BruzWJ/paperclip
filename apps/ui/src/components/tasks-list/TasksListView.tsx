import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowUpDown,
  ChevronsDownUp,
  CircleDot,
  Layers,
  List,
  ListCollapse,
  ListTree,
  PanelTopClose,
  Plus,
  RotateCcw,
  SquareKanban,
} from "lucide-react";
import {
  KanbanBoard,
  KANBAN_COLUMN_DEFAULT_PAGE_SIZE,
  KANBAN_COLUMN_PAGE_SIZE_OPTIONS,
} from "../KanbanBoard";
import { TaskColumnPicker } from "../TaskColumns";
import { TaskFiltersPopover } from "../TaskFiltersPopover";
import { cn } from "@/lib/utils";
import { TASK_BOARD_COLUMN_RESULT_LIMIT, TASK_SEARCH_RESULT_LIMIT, type TaskViewState } from "./model";
import { TaskSearchInput, SubTaskProgressSummaryStrip } from "./TaskListSummary";
import { useTasksListViewModel } from "./context";
import { TaskListRows } from "./TaskListRows";

export function TasksListView() {
  const model = useTasksListViewModel();
  const {
    isLoading,
    isLoadingMoreTasks,
    progressSummary,
    taskLinkState,
    parentTaskIdForCostSummary,
    createButtonLabel,
    taskSearch,
    onSearchChange,
    viewState,
    activeFilterCount,
    agents,
    ownerUserOptions,
    projects,
    currentUserId,
    visibleTaskColumnSet,
    availableTaskColumns,
    boardCompactCards,
    boardCollapsedStatuses,
    boardDensityCustomized,
    filtered,
    normalizedTaskSearch,
    searchWithinLoadedTasks,
    searchedTasks,
    boardColumnLimitReached,
    createActionLabel,
    liveTaskIds,
    error,
    rootRef,
    setTaskSearch,
    creatorOptions,
    labels,
    enableRoutineVisibilityFilter,
    DEFAULT_INBOX_TASK_COLUMNS,
  } = model.values;
  const { openCreateTaskDialog, updateView, toggleTaskColumn, setTaskColumns } = model.actions;
  return (
    <div ref={rootRef} className="space-y-4">
      {isLoading || isLoadingMoreTasks ? (
        <p className="sr-only" role="status">
          {isLoading ? "Loading tasks." : "Loading more tasks."}
        </p>
      ) : null}
      {progressSummary ? (
        <SubTaskProgressSummaryStrip
          summary={progressSummary}
          taskLinkState={taskLinkState}
          parentTaskIdForCostSummary={parentTaskIdForCostSummary}
        />
      ) : null}

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Button size="sm" variant="outline" onClick={() => openCreateTaskDialog()}>
            <Plus className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">{createButtonLabel}</span>
          </Button>
          <TaskSearchInput
            value={taskSearch}
            onDebouncedChange={(nextSearch) => {
              setTaskSearch(nextSearch);
              onSearchChange?.(nextSearch);
            }}
          />
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={viewState.viewMode}
            onValueChange={(viewMode) => {
              if (viewMode) updateView({ viewMode: viewMode as TaskViewState["viewMode"] });
            }}
            aria-label="View mode"
          >
            <ToggleGroupItem value="list" title="List view" aria-label="List view">
              <List className="h-3.5 w-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="board" title="Board view" aria-label="Board view">
              <SquareKanban className="h-3.5 w-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>

          {viewState.viewMode === "list" && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className={cn(
                "hidden h-8 w-8 shrink-0 sm:inline-flex",
                viewState.nestingEnabled && "bg-accent",
              )}
              onClick={() => updateView({ nestingEnabled: !viewState.nestingEnabled })}
              title={
                viewState.nestingEnabled ? "Disable parent-child nesting" : "Enable parent-child nesting"
              }
            >
              <ListTree className="h-3.5 w-3.5" />
            </Button>
          )}

          {viewState.viewMode === "board" && (
            <>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={cn("h-8 w-8 shrink-0", boardCompactCards && "bg-accent")}
                onClick={() =>
                  updateView({
                    boardCardDensity: boardCompactCards ? "comfortable" : "compact",
                  })
                }
                title={boardCompactCards ? "Use comfortable cards" : "Use compact cards"}
              >
                <ChevronsDownUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={cn("h-8 w-8 shrink-0", boardCollapsedStatuses.length > 0 && "bg-accent")}
                onClick={() =>
                  updateView({
                    boardColdLaneMode: boardCollapsedStatuses.length > 0 ? "expanded" : "collapsed",
                  })
                }
                title={boardCollapsedStatuses.length > 0 ? "Expand cold lanes" : "Collapse cold lanes"}
              >
                <PanelTopClose className="h-3.5 w-3.5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn(
                      "h-8 shrink-0 gap-1.5 px-2",
                      viewState.boardColumnPageSize !== KANBAN_COLUMN_DEFAULT_PAGE_SIZE && "bg-accent",
                    )}
                    title="Cards per column"
                  >
                    <ListCollapse className="h-3.5 w-3.5" />
                    <span className="min-w-4 text-xs tabular-nums">{viewState.boardColumnPageSize}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuRadioGroup
                    value={String(viewState.boardColumnPageSize)}
                    onValueChange={(v) =>
                      updateView({
                        boardColumnPageSize: Number(v) as 10 | 25 | 50,
                      })
                    }
                  >
                    {KANBAN_COLUMN_PAGE_SIZE_OPTIONS.map((pageSize) => (
                      <DropdownMenuRadioItem key={pageSize} value={String(pageSize)} className="text-sm">
                        {pageSize} per column
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() =>
                  updateView({
                    boardCardDensity: "auto",
                    boardColdLaneMode: "expanded",
                    boardColumnPageSize: KANBAN_COLUMN_DEFAULT_PAGE_SIZE,
                  })
                }
                disabled={!boardDensityCustomized}
                title="Reset board density"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </>
          )}

          <TaskColumnPicker
            availableColumns={availableTaskColumns}
            visibleColumnSet={visibleTaskColumnSet}
            onToggleColumn={toggleTaskColumn}
            onResetColumns={() => setTaskColumns(DEFAULT_INBOX_TASK_COLUMNS)}
            title="Choose which task columns stay visible"
            iconOnly
          />

          <TaskFiltersPopover
            state={viewState}
            onChange={updateView}
            buttonVariant="outline"
            activeFilterCount={activeFilterCount}
            agents={agents}
            users={ownerUserOptions}
            creators={creatorOptions}
            projects={projects?.map((project) => ({
              id: project.id,
              name: project.name,
            }))}
            labels={labels?.map((label: { id: string; name: string; color: string }) => ({
              id: label.id,
              name: label.name,
              color: label.color,
            }))}
            currentUserId={currentUserId}
            enableRoutineVisibilityFilter={enableRoutineVisibilityFilter}
            iconOnly
          />

          {/* Sort (list view only) */}
          {viewState.viewMode === "list" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" title="Sort">
                  <ArrowUpDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {(
                  [
                    ["workflow", "Workflow"],
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["title", "Title"],
                    ["created", "Created"],
                    ["updated", "Updated"],
                  ] as const
                ).map(([field, label]) => (
                  <DropdownMenuItem
                    key={field}
                    className="text-sm"
                    onClick={() => {
                      if (viewState.sortField === field) {
                        updateView({
                          sortDir: viewState.sortDir === "asc" ? "desc" : "asc",
                        });
                      } else {
                        updateView({ sortField: field, sortDir: "asc" });
                      }
                    }}
                  >
                    <span>{label}</span>
                    {viewState.sortField === field && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {viewState.sortDir === "asc" ? "\u2191" : "\u2193"}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Group (list view only) */}
          {viewState.viewMode === "list" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" title="Group">
                  <Layers className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuRadioGroup
                  value={viewState.groupBy ?? "none"}
                  onValueChange={(v) =>
                    updateView({
                      groupBy: (v === "none" ? undefined : v) as TaskViewState["groupBy"],
                    })
                  }
                >
                  {(
                    [
                      ["status", "Status"],
                      ["priority", "Priority"],
                      ["owner", "Owner"],
                      ["project", "Project"],
                      ["parent", "Parent Task"],
                      ["none", "None"],
                    ] as const
                  ).map(([value, label]) => (
                    <DropdownMenuRadioItem key={value} value={value} className="text-sm">
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-96 w-full" />
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      {!searchWithinLoadedTasks &&
        normalizedTaskSearch.length > 0 &&
        searchedTasks.length === TASK_SEARCH_RESULT_LIMIT && (
          <Alert role="status">
            <AlertDescription>
              Showing up to {TASK_SEARCH_RESULT_LIMIT} matches. Refine the search to narrow further.
            </AlertDescription>
          </Alert>
        )}
      {boardColumnLimitReached && (
        <Alert role="status">
          <AlertDescription>
            Some board columns are showing up to {TASK_BOARD_COLUMN_RESULT_LIMIT} tasks. Refine filters or
            search to reveal the rest.
          </AlertDescription>
        </Alert>
      )}
      {!isLoading && filtered.length === 0 && viewState.viewMode === "list" && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleDot />
            </EmptyMedia>
            <EmptyDescription>No tasks match the current filters or search.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => openCreateTaskDialog()}>
              <Plus />
              {createActionLabel}
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {viewState.viewMode === "board" ? (
        <KanbanBoard
          tasks={filtered}
          agents={agents}
          liveTaskIds={liveTaskIds}
          compactCards={boardCompactCards}
          collapsedStatuses={boardCollapsedStatuses}
          initialVisibleCount={viewState.boardColumnPageSize}
          revealIncrement={viewState.boardColumnPageSize}
        />
      ) : (
        <>
          <TaskListRows />
        </>
      )}
    </div>
  );
}
