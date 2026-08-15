import { foldersApi } from "@/api/folders";
import { routinesApi } from "@/api/routines";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { tasksApi } from "@/api/tasks";
import {
  folderSearchValue,
  normalizeFolderSelection,
  selectedFolderFromList,
  type FolderSelection,
} from "@/routes/_authenticated/$companyId/routines/-folders/-FolderControls";
import type { MarkdownEditorRef, MentionOption } from "@/features/markdown/MarkdownEditor";
import { nextRoutineStatus } from "@/features/routines/list/RoutineList";
import {
  useRoutineAssignmentPresentation,
  useRoutineDirectoryData,
} from "@/routes/_authenticated/$companyId/routines/-useRoutinePresentationData";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { toast } from "sonner";
import { useSidebar } from "@/context/SidebarContext";
import { buildMarkdownMentionOptions } from "@/lib/company-members";
import { collectLiveTaskIds } from "@/lib/liveTaskIds";
import { queryKeys } from "@/lib/queryKeys";
import { autoResizeTextarea } from "@/lib/textarea";
import { trackRecentAssignee } from "@/lib/recent-assignees";
import { trackRecentProject } from "@/lib/recent-projects";
import type { FolderListItem, RoutineListItem } from "@paperclipai/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import {
  buildRoutineFolderRail,
  buildRoutineSections,
  getRoutineViewState,
  RECENT_RUNS_TASK_DETAIL_LOCATION_STATE,
  saveRoutineViewState,
  sortRoutines,
  type RoutinesTab,
  type RoutineComposerDraft,
  type RoutineViewState,
} from "./-routines-list-data";
import { moveRoutineSelection, useRoutinesMutations } from "./-useRoutinesMutations";

export function useRoutinesController() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const route = getRouteApi("/_authenticated/$companyId/routines/");
  const { companyId } = route.useParams();
  const search = route.useSearch();
  const routeNavigate = route.useNavigate();
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderDialogTarget, setFolderDialogTarget] = useState<FolderListItem | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<FolderListItem | null>(null);
  const [mobileFoldersOpen, setMobileFoldersOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedRoutineIds, setSelectedRoutineIds] = useState<string[]>([]);
  const [moveAfterCreateIds, setMoveAfterCreateIds] = useState<string[]>([]);
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);
  const [statusMutationRoutineId, setStatusMutationRoutineId] = useState<string | null>(null);
  const [runDialogRoutine, setRunDialogRoutine] = useState<RoutineListItem | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const activeTab: RoutinesTab = search.tab === "runs" ? "runs" : "routines";
  const [draft, setDraft] = useState<RoutineComposerDraft>({
    title: "",
    description: "",
    projectId: "",
    folderId: null,
    assigneeAgentId: "",
    priority: "medium",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
  });
  const routineViewStateKey = `paperclip:routines-view:${companyId}`;
  const [routineViewState, setRoutineViewState] = useState<RoutineViewState>(() =>
    getRoutineViewState(routineViewStateKey),
  );
  const folderSelection = normalizeFolderSelection(search.folder ?? null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Routines" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setRoutineViewState(getRoutineViewState(routineViewStateKey));
  }, [routineViewStateKey]);

  const {
    data: routines,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
  });
  const { data: routineFolders, isLoading: foldersLoading } = useQuery({
    queryKey: queryKeys.folders.list(companyId, "routine"),
    queryFn: () => foldersApi.list(companyId, "routine"),
    enabled: activeTab === "routines",
  });
  const { agents, projects, companyMembers } = useRoutineDirectoryData(companyId);
  const {
    data: routineExecutionTasks,
    isLoading: recentRunsLoading,
    error: recentRunsError,
  } = useQuery({
    queryKey: [...queryKeys.tasks.list(companyId), "routine-executions"],
    queryFn: () => tasksApi.list(companyId, { originKind: "routine_execution" }),
    enabled: activeTab === "runs",
  });
  const activeRunsQueryKey = queryKeys.runs(companyId, {
    status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
  });
  const { data: activeRunPage } = useQuery({
    queryKey: activeRunsQueryKey,
    queryFn: () =>
      runsApi.listForCompany(companyId, {
        status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
        limit: 200,
      }),
    enabled: activeTab === "runs",
  });

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [draft.title, composerOpen]);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      projects,
      members: companyMembers?.users,
    });
  }, [agents, companyMembers?.users, projects]);

  const {
    createRoutine,
    createFolder,
    updateFolder,
    deleteFolder,
    moveRoutineToFolder,
    updateRoutineStatus,
    runRoutine,
  } = useRoutinesMutations({
    companyId,
    queryClient,
    draft,
    setDraft,
    setComposerOpen,
    setAdvancedOpen,
    navigate,
    setFolderDialogOpen,
    setFolderDialogTarget,
    moveAfterCreateIds,
    setMoveAfterCreateIds,
    setFolderSelection,
    folderSelection,
    setDeleteFolderTarget,
    setStatusMutationRoutineId,
    setRunningRoutineId,
    setRunDialogRoutine,
  });

  const { agentById, assigneeOptions, projectById, projectOptions, recentAssigneeIds, recentProjectIds } =
    useRoutineAssignmentPresentation({ agents, projects, recencyKey: composerOpen });
  const liveTaskIds = useMemo(() => collectLiveTaskIds(activeRunPage?.items), [activeRunPage]);
  const visibleRoutines = useMemo(
    () => (routines ?? []).filter((routine) => routine.status !== "archived"),
    [routines],
  );
  const folderFilteredRoutines = useMemo(() => {
    if (routineViewState.groupBy !== "folder") return visibleRoutines;
    if (folderSelection === "all") return visibleRoutines;
    if (folderSelection === "unfiled") return visibleRoutines.filter((routine) => !routine.folderId);
    return visibleRoutines.filter((routine) => routine.folderId === folderSelection);
  }, [folderSelection, routineViewState.groupBy, visibleRoutines]);
  // Rail counts reflect the page's visible scope (archived hidden), not raw DB
  // counts (ux-spec §5.3).
  const railFolderResult = useMemo(
    () => buildRoutineFolderRail(routineFolders, visibleRoutines),
    [routineFolders, visibleRoutines],
  );
  const sortedRoutines = useMemo(
    () => sortRoutines(folderFilteredRoutines, routineViewState.sortField, routineViewState.sortDir),
    [folderFilteredRoutines, routineViewState.sortDir, routineViewState.sortField],
  );
  const routineSections = useMemo(
    () => buildRoutineSections(sortedRoutines, routineViewState.groupBy, projectById, agentById),
    [agentById, projectById, routineViewState.groupBy, sortedRoutines],
  );
  const recentRunsTaskLinkState = RECENT_RUNS_TASK_DETAIL_LOCATION_STATE;
  const currentAssignee = draft.assigneeAgentId ? (agentById.get(draft.assigneeAgentId) ?? null) : null;
  const currentProject = draft.projectId ? (projectById.get(draft.projectId) ?? null) : null;
  const activeFolder = selectedFolderFromList(routineFolders?.folders ?? [], folderSelection);
  const hasRoutineFolders = (routineFolders?.folders.length ?? 0) > 0;
  const showFolderRail =
    activeTab === "routines" && routineViewState.groupBy === "folder" && hasRoutineFolders;

  function updateRoutineView(patch: Partial<RoutineViewState>) {
    setRoutineViewState((current) => {
      const next = { ...current, ...patch };
      saveRoutineViewState(routineViewStateKey, next);
      return next;
    });
  }

  function handleTabChange(tab: string) {
    startTransition(() => {
      void routeNavigate({
        search: (previous) => ({
          ...previous,
          tab: tab === "runs" ? "runs" : undefined,
        }),
      });
    });
  }

  function setFolderSelection(selection: FolderSelection) {
    const value = folderSearchValue(selection);
    void routeNavigate({
      search: (previous) => ({
        ...previous,
        folder: value || undefined,
      }),
    });
  }

  function openCreateFolder(moveItemIds: string[] = []) {
    setMoveAfterCreateIds(moveItemIds);
    setFolderDialogTarget(null);
    setFolderDialogOpen(true);
  }

  function openCreateRoutine() {
    setDraft((current) => ({
      ...current,
      folderId: folderSelection === "all" || folderSelection === "unfiled" ? null : folderSelection,
    }));
    setComposerOpen(true);
  }
  const moveSelectedRoutines = (folderId: string | null) =>
    moveRoutineSelection({
      companyId,
      folderId,
      selectedRoutineIds,
      setSelectedRoutineIds,
      setSelectMode,
      queryClient,
    });

  function handleRunNow(routine: RoutineListItem) {
    setRunDialogRoutine(routine);
  }

  function handleToggleEnabled(routine: RoutineListItem, enabled: boolean) {
    if (!enabled && !routine.assigneeAgentId) {
      toast.warning("Default agent required", {
        description: "Set a default agent before enabling routine automation.",
      });
      return;
    }
    if (!routine.latestRevisionId) {
      toast.error("Routine cannot be updated", {
        description: "This routine has no canonical revision.",
      });
      return;
    }
    updateRoutineStatus.mutate({
      id: routine.id,
      status: nextRoutineStatus(routine.status, !enabled),
      baseRevisionId: routine.latestRevisionId,
    });
  }

  function handleToggleArchived(routine: RoutineListItem) {
    if (!routine.latestRevisionId) {
      toast.error("Routine cannot be updated", {
        description: "This routine has no canonical revision.",
      });
      return;
    }
    updateRoutineStatus.mutate({
      id: routine.id,
      status: routine.status === "archived" ? "active" : "archived",
      baseRevisionId: routine.latestRevisionId,
    });
  }

  if (isLoading) {
    return { status: "loading" as const };
  }

  return {
    status: "ready" as const,
    activeFolder,
    activeTab,
    advancedOpen,
    agentById,
    agents,
    assigneeOptions,
    assigneeSelectorRef,
    composerOpen,
    companyId,
    createFolder,
    createRoutine,
    currentAssignee,
    currentProject,
    deleteFolder,
    deleteFolderTarget,
    descriptionEditorRef,
    draft,
    error,
    folderDialogOpen,
    folderDialogTarget,
    folderSelection,
    foldersLoading,
    handleRunNow,
    handleTabChange,
    handleToggleArchived,
    handleToggleEnabled,
    hasRoutineFolders,
    liveTaskIds,
    mentionOptions,
    isMobile,
    mobileFoldersOpen,
    moveRoutineToFolder,
    moveSelectedRoutines,
    openCreateFolder,
    openCreateRoutine,
    projectById,
    projectOptions,
    projectSelectorRef,
    projects,
    railFolderResult,
    recentAssigneeIds,
    recentProjectIds,
    recentRunsError,
    recentRunsLoading,
    recentRunsTaskLinkState,
    routineExecutionTasks,
    routineFolders,
    routineSections,
    routineViewState,
    runDialogRoutine,
    runRoutine,
    runningRoutineId,
    selectedRoutineIds,
    selectMode,
    setAdvancedOpen,
    setComposerOpen,
    setDeleteFolderTarget,
    setDraft,
    setFolderDialogOpen,
    setFolderDialogTarget,
    setFolderSelection,
    setMobileFoldersOpen,
    setRunDialogRoutine,
    setSelectMode,
    setSelectedRoutineIds,
    showFolderRail,
    sortedRoutines,
    statusMutationRoutineId,
    titleInputRef,
    updateFolder,
    updateRoutineView,
    visibleRoutines,
    trackRecentAssignee,
    trackRecentProject,
  };
}

export type RoutinesController = ReturnType<typeof useRoutinesController>;
