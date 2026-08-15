import { FolderSwatch, selectedFolderFromList } from "@/routes/_authenticated/$companyId/routines/-folders/-FolderControls";
import { Skeleton } from "@/components/ui/skeleton";
import { RoutineComposerDialog } from "@/routes/_authenticated/$companyId/routines/-RoutineComposerDialog";
import { RoutinesBrowser, RoutinesDialogs } from "@/routes/_authenticated/$companyId/routines/-RoutinesBrowser";
import { TasksList } from "@/features/tasks/list";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowUpDown, ChevronDown, Folder as FolderIcon, Layers, Plus } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";

import { validateRoutinesSearch } from "./-routines-list-data";
import { useRoutinesController, type RoutinesController } from "./-useRoutinesController";

export const Route = createFileRoute("/_authenticated/$companyId/routines/")({
  validateSearch: validateRoutinesSearch,
  component: Routines,
});

export {
  buildRoutineGroups,
  buildRoutineSections,
  sortRoutines,
  validateRoutinesSearch,
} from "./-routines-list-data";

function Routines() {
  const controller = useRoutinesController();
  if (controller.status === "loading") {
    return <Skeleton className="h-32 w-full" />;
  }
  return (
    <div className="space-y-6">
      <RoutinesHeaderTabs controller={controller} />
      <RoutineComposerDialog controller={controller} />
      <RoutinesBrowser controller={controller} />
      <RoutinesDialogs controller={controller} />
    </div>
  );
}

interface RoutinesHeaderTabsProps {
  controller: RoutinesController;
}

export function RoutinesHeaderTabs({ controller }: RoutinesHeaderTabsProps) {
  if (controller.status !== "ready") return null;
  const {
    activeTab,
    agents,
    folderSelection,
    handleTabChange,
    hasRoutineFolders,
    liveTaskIds,
    openCreateRoutine,
    openCreateFolder,
    projects,
    railFolderResult,
    recentRunsError,
    recentRunsLoading,
    recentRunsTaskLinkState,
    routineExecutionTasks,
    routineViewState,
    selectMode,
    setMobileFoldersOpen,
    setSelectMode,
    showFolderRail,
    updateRoutineView,
    visibleRoutines,
  } = controller;
  const selectedFolder = railFolderResult
    ? selectedFolderFromList(railFolderResult.folders, folderSelection)
    : null;
  const selectedFolderLabel =
    folderSelection === "all"
      ? "All routines"
      : folderSelection === "unfiled"
        ? "Unfiled"
        : (selectedFolder?.name ?? "All routines");
  const selectedFolderCount = !railFolderResult
    ? 0
    : folderSelection === "all"
      ? railFolderResult.allCount
      : folderSelection === "unfiled"
        ? railFolderResult.unfiledCount
        : (selectedFolder?.itemCount ?? 0);

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Routines</h1>
          <p className="text-sm text-muted-foreground">
            Recurring work definitions that materialize into auditable execution tasks.
          </p>
        </div>
        <Button onClick={openCreateRoutine}>
          <Plus data-icon="inline-start" className="mr-2 h-4 w-4" />
          Create routine
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList variant="line" className="justify-start">
          <TabsTrigger value="routines">Routines</TabsTrigger>
          <TabsTrigger value="runs">Recent Runs</TabsTrigger>
        </TabsList>
        <TabsContent value="routines" className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {visibleRoutines.length} routine
              {visibleRoutines.length === 1 ? "" : "s"}
            </p>
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs" title="Sort">
                    <ArrowUpDown data-icon="inline-start" className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                    <span className="hidden sm:inline">Sort</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuRadioGroup value={routineViewState.sortField}>
                    {(
                      [
                        ["updated", "Updated"],
                        ["created", "Created"],
                        ["lastRun", "Last run"],
                        ["title", "Title"],
                      ] as const
                    ).map(([field, label]) => (
                      <DropdownMenuRadioItem
                        key={field}
                        value={field}
                        onSelect={() => {
                          updateRoutineView(
                            routineViewState.sortField === field
                              ? {
                                  sortDir: routineViewState.sortDir === "asc" ? "desc" : "asc",
                                }
                              : {
                                  sortField: field,
                                  sortDir: field === "title" ? "asc" : "desc",
                                },
                          );
                        }}
                      >
                        {label}
                        {routineViewState.sortField === field ? (
                          <DropdownMenuShortcut>
                            {routineViewState.sortDir === "asc" ? "Asc" : "Desc"}
                          </DropdownMenuShortcut>
                        ) : null}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs" title="Group">
                    <Layers data-icon="inline-start" className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                    <span className="hidden sm:inline">Group</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuRadioGroup
                    value={routineViewState.groupBy}
                    onValueChange={(value) =>
                      updateRoutineView({
                        groupBy: value as typeof routineViewState.groupBy,
                        collapsedGroups: [],
                      })
                    }
                  >
                    {(
                      [
                        ["folder", "Folder"],
                        ["project", "Project"],
                        ["assignee", "Agent"],
                        ["none", "None"],
                      ] as const
                    ).map(([value, label]) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        {label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {routineViewState.groupBy === "folder" && !hasRoutineFolders ? (
                <Button variant="outline" size="sm" onClick={() => openCreateFolder()}>
                  <Plus data-icon="inline-start" className="mr-2 h-3.5 w-3.5" />
                  New folder
                </Button>
              ) : null}
              {showFolderRail ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => setSelectMode((current) => !current)}
                >
                  {selectMode ? "Done" : "Select"}
                </Button>
              ) : null}
            </div>
          </div>
          {routineViewState.groupBy === "folder" ? (
            <div className="md:hidden">
              <Button variant="outline" size="sm" onClick={() => setMobileFoldersOpen(true)}>
                {folderSelection === "all" ? <FolderIcon /> : <FolderSwatch color={selectedFolder?.color} />}
                <span className="truncate">{selectedFolderLabel}</span>
                <span className="text-xs text-muted-foreground">{selectedFolderCount}</span>
                <ChevronDown />
              </Button>
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="runs">
          <TasksList
            tasks={routineExecutionTasks ?? []}
            isLoading={recentRunsLoading}
            error={recentRunsError as Error | null}
            agents={agents}
            projects={projects}
            liveTaskIds={liveTaskIds}
            viewStateKey="paperclip:routine-recent-runs-view"
            taskLinkState={recentRunsTaskLinkState}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}
