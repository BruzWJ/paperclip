import {
  AllUnfiledBanner,
  BulkBar,
  DeleteFolderDialog,
  FolderFormDialog,
  FolderRail,
  FolderSwatch,
  MobileFolderSheet,
  MoveToMenu,
} from "@/routes/_authenticated/$companyId/routines/-folders/-FolderControls";
import { RoutineListRow } from "@/routes/_authenticated/$companyId/routines/-list/-RoutineList";
import { RoutineRunVariablesDialog } from "@/routes/_authenticated/$companyId/routines/-RoutineRunVariablesDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { ChevronRight, Plus, Repeat } from "lucide-react";
import { toast } from "sonner";

import type { RoutinesController } from "@/routes/_authenticated/$companyId/routines/-useRoutinesController";

interface RoutinesBrowserProps {
  controller: RoutinesController;
}

export function RoutinesBrowser({ controller }: RoutinesBrowserProps) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  if (controller.status !== "ready") return null;
  const {
    activeFolder,
    activeTab,
    companyId,
    agentById,
    error,
    folderSelection,
    foldersLoading,
    handleRunNow,
    handleToggleArchived,
    handleToggleEnabled,
    hasRoutineFolders,
    moveRoutineToFolder,
    moveSelectedRoutines,
    openCreateFolder,
    openCreateRoutine,
    projectById,
    railFolderResult,
    routineSections,
    routineFolders,
    routineViewState,
    runningRoutineId,
    selectedRoutineIds,
    selectMode,
    setDeleteFolderTarget,
    setFolderDialogOpen,
    setFolderDialogTarget,
    setFolderSelection,
    setSelectMode,
    setSelectedRoutineIds,
    showFolderRail,
    sortedRoutines,
    statusMutationRoutineId,
    updateFolder,
    updateRoutineView,
    visibleRoutines,
  } = controller;

  return (
    <>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {error instanceof Error ? error.message : "Failed to load routines"}
          </AlertDescription>
        </Alert>
      ) : null}

      {activeTab === "routines" ? (
        <div className={cn(showFolderRail && "flex gap-4")}>
          {showFolderRail ? (
            <FolderRail
              result={railFolderResult}
              selection={folderSelection}
              allLabel="All routines"
              itemLabelPlural="routines"
              loading={foldersLoading}
              onSelect={setFolderSelection}
              onCreate={() => openCreateFolder()}
              onRename={(folder, name) => updateFolder.mutate({ folderId: folder.id, payload: { name } })}
              onEdit={(folder) => {
                setFolderDialogTarget(folder);
                setFolderDialogOpen(true);
              }}
              onDelete={setDeleteFolderTarget}
            />
          ) : null}
          <div className="min-w-0 flex-1">
            {routineViewState.groupBy === "folder" && hasRoutineFolders ? (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {folderSelection === "all" ? (
                  <FolderIconHeader label="All routines" count={sortedRoutines.length} />
                ) : (
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    <FolderSwatch color={activeFolder?.color} />
                    <span className="truncate font-medium">
                      {folderSelection === "unfiled" ? "Unfiled" : (activeFolder?.name ?? "Folder")}
                    </span>
                    <span className="text-muted-foreground">
                      {sortedRoutines.length} routine
                      {sortedRoutines.length === 1 ? "" : "s"}
                    </span>
                  </div>
                )}
              </div>
            ) : null}
            {routineViewState.groupBy === "folder" &&
            !hasRoutineFolders &&
            !foldersLoading &&
            visibleRoutines.length > 0 ? (
              <AllUnfiledBanner
                storageKey={`paperclip:routines-folder-nudge:${companyId}`}
                itemLabelPlural="routines"
                onCreateFolder={() => openCreateFolder()}
              />
            ) : null}
            {selectMode ? (
              <BulkBar
                selectedCount={selectedRoutineIds.length}
                folders={routineFolders?.folders ?? []}
                onMove={(folderId) => void moveSelectedRoutines(folderId)}
                onCreateAndMove={() => openCreateFolder(selectedRoutineIds)}
                onClear={() => setSelectedRoutineIds([])}
                onDone={() => {
                  setSelectMode(false);
                  setSelectedRoutineIds([]);
                }}
              />
            ) : null}
            {visibleRoutines.length === 0 ? (
              <Empty className="border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Repeat  data-icon="inline-start"/>
                  </EmptyMedia>
                  <EmptyTitle>No routines</EmptyTitle>
                  <EmptyDescription>
                    No active routines. Use Create routine to define the first recurring workflow.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : sortedRoutines.length === 0 ? (
              <Empty className="border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Repeat  data-icon="inline-start"/>
                  </EmptyMedia>
                  <EmptyTitle>No routines</EmptyTitle>
                  <EmptyDescription>
                    {folderSelection === "all" ? "No routines match this view." : "This folder is empty."}
                  </EmptyDescription>
                </EmptyHeader>
                {folderSelection !== "all" ? (
                  <EmptyContent>
                    <Button size="sm" onClick={openCreateRoutine}>
                      <Plus data-icon="inline-start" className="mr-2 h-3.5 w-3.5" />
                      New routine in this folder
                    </Button>
                  </EmptyContent>
                ) : null}
              </Empty>
            ) : (
              <div className="flex flex-col gap-3">
                {routineSections.map((group) => {
                  const isOpen = !routineViewState.collapsedGroups.includes(group.key);
                  return (
                    <Collapsible
                      key={group.key}
                      open={isOpen}
                      onOpenChange={(open) => {
                        updateRoutineView({
                          collapsedGroups: open
                            ? routineViewState.collapsedGroups.filter((item) => item !== group.key)
                            : [...routineViewState.collapsedGroups, group.key],
                        });
                      }}
                    >
                      {group.label ? (
                        <CollapsibleTrigger asChild>
                          <Button variant="outline" className={cn("w-full justify-start", isOpen && "mb-1")}>
                            <ChevronRight className="transition-transform [[data-state=open]_&]:rotate-90"  data-icon="inline-start"/>
                            {group.label}
                            <Badge variant="secondary">{group.items.length}</Badge>
                          </Button>
                        </CollapsibleTrigger>
                      ) : null}
                      <CollapsibleContent>
                        {group.items.map((routine) => (
                          <RoutineListRow
                            key={routine.id}
                            routine={routine}
                            projectById={projectById}
                            agentById={agentById}
                            runningRoutineId={runningRoutineId}
                            statusMutationRoutineId={statusMutationRoutineId}
                            runNowButton
                            divider={false}
                            onRunNow={handleRunNow}
                            onToggleEnabled={handleToggleEnabled}
                            onToggleArchived={handleToggleArchived}
                            selectMode={selectMode}
                            selected={selectedRoutineIds.includes(routine.id)}
                            onSelectChange={(selectedRoutine, selected) => {
                              setSelectedRoutineIds((current) =>
                                selected
                                  ? Array.from(new Set([...current, selectedRoutine.id]))
                                  : current.filter((id) => id !== selectedRoutine.id),
                              );
                            }}
                            extraMenuItems={
                              <MoveToMenu
                                folders={routineFolders?.folders ?? []}
                                currentFolderId={routine.folderId ?? null}
                                onMove={(folderId) => {
                                  const previousFolderId = routine.folderId ?? null;
                                  moveRoutineToFolder.mutate({
                                    itemId: routine.id,
                                    folderId,
                                  });
                                  toast.success("Routine moved", {
                                    description: folderId
                                      ? `Moved "${routine.title}" to ${routineFolders?.folders.find((folder) => folder.id === folderId)?.name ?? "folder"}.`
                                      : `Moved "${routine.title}" to Unfiled.`,
                                    action: {
                                      label: "Undo",
                                      onClick: () =>
                                        moveRoutineToFolder.mutate({
                                          itemId: routine.id,
                                          folderId: previousFolderId,
                                        }),
                                    },
                                  });
                                }}
                                onCreateAndMove={() => openCreateFolder([routine.id])}
                              />
                            }
                          />
                        ))}
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

function FolderIconHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <Repeat className="h-3.5 w-3.5 text-muted-foreground"  data-icon="inline-start"/>
      <span className="truncate font-medium">{label}</span>
      <span className="text-muted-foreground">
        {count} routine{count === 1 ? "" : "s"}
      </span>
    </div>
  );
}

export function RoutinesDialogs({ controller }: { controller: RoutinesController }) {
  if (controller.status !== "ready") return null;
  const {
    agents,
    createFolder,
    deleteFolder,
    deleteFolderTarget,
    folderDialogOpen,
    folderDialogTarget,
    folderSelection,
    mobileFoldersOpen,
    openCreateFolder,
    projects,
    railFolderResult,
    runDialogRoutine,
    runRoutine,
    setDeleteFolderTarget,
    setFolderDialogOpen,
    setMobileFoldersOpen,
    setRunDialogRoutine,
    setFolderSelection,
    updateFolder,
  } = controller;

  return (
    <>
      <FolderFormDialog
        open={folderDialogOpen}
        folder={folderDialogTarget}
        pending={createFolder.isPending || updateFolder.isPending}
        onOpenChange={setFolderDialogOpen}
        onSubmit={(payload) => {
          if (folderDialogTarget) updateFolder.mutate({ folderId: folderDialogTarget.id, payload });
          else createFolder.mutate(payload);
        }}
      />
      <DeleteFolderDialog
        open={deleteFolderTarget !== null}
        folder={deleteFolderTarget}
        itemLabelPlural="routines"
        pending={deleteFolder.isPending}
        onOpenChange={(open) => {
          if (!open) setDeleteFolderTarget(null);
        }}
        onConfirm={() => {
          if (!deleteFolderTarget) return;
          return deleteFolder.mutateAsync(deleteFolderTarget.id).then(() => undefined);
        }}
      />
      <MobileFolderSheet
        open={mobileFoldersOpen}
        onOpenChange={setMobileFoldersOpen}
        result={railFolderResult}
        selection={folderSelection}
        allLabel="All routines"
        itemLabelPlural="Routines"
        onSelect={setFolderSelection}
        onCreate={() => openCreateFolder()}
      />
      <RoutineRunVariablesDialog
        open={runDialogRoutine !== null}
        onOpenChange={(open) => {
          if (!open) setRunDialogRoutine(null);
        }}
        routineName={runDialogRoutine?.title ?? null}
        agents={agents ?? []}
        projects={projects ?? []}
        defaultProjectId={runDialogRoutine?.projectId ?? null}
        defaultAssigneeAgentId={runDialogRoutine?.assigneeAgentId ?? null}
        variables={runDialogRoutine?.variables ?? []}
        isPending={runRoutine.isPending}
        onSubmit={(data) => {
          if (runDialogRoutine) runRoutine.mutate({ id: runDialogRoutine.id, data });
        }}
      />
    </>
  );
}
