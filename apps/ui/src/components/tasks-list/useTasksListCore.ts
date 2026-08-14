import { useDeferredValue, useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { useDialogActions } from "@/context/DialogContext";
import { useNavigate } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { tasksApi } from "@/api/tasks";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { formatOwnerUserLabel } from "@/lib/task-owners";
import { buildCompanyUserLabelMap, buildCompanyUserProfileMap } from "@/lib/company-members";
import { inboxTaskColumns, type InboxTaskColumn } from "@/lib/inbox";
import { collectSubtreeLiveCounts } from "@/lib/liveTaskIds";
import { taskDisplayTitle } from "@/lib/task-display";
import { taskTrailingColumns } from "../TaskColumns";
import { useGeneralSettings } from "@/context/GeneralSettingsContext";
import { deriveOriginatingActor, type Task } from "@paperclipai/shared";
import { TASK_SEARCH_RESULT_LIMIT, TASK_BOARD_COLUMN_RESULT_LIMIT, INITIAL_TASK_ROW_RENDER_LIMIT, boardTaskStatuses, getInitialViewState, loadTaskColumns, saveViewState, type CreatorOption, type TasksListProps, type TaskViewState } from "./model";

export type TasksListCoreInput = TasksListProps & {
  searchWithinLoadedTasks: boolean;
  showProgressSummary: boolean;
  enableRoutineVisibilityFilter: boolean;
  hasMoreTasks: boolean;
  isLoadingMoreTasks: boolean;
};

export function useTasksListCore(m: TasksListCoreInput) {
  const { tasks, agents, projects, liveTaskIds, projectId, viewStateKey, initialOwners, initialSearch, searchFilters, searchWithinLoadedTasks, defaultSortField, enableRoutineVisibilityFilter } = m;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const companyId = useCompanyRouteId();
  const { keyboardShortcutsEnabled } = useGeneralSettings();
  // Keyboard selection for the list view (mirrors the inbox). Hover moves the
  // selection only after real pointer movement, so keyboard-driven scrolling
  // doesn't hand the selection to whatever row lands under the cursor.
  const [selectedNavKey, setSelectedNavKey] = useState<string | null>(null);
  const pointerMovedSinceKeyNavRef = useRef(true);
  useEffect(() => {
    const handlePointerMove = () => {
      pointerMovedSinceKeyNavRef.current = true;
    };
    window.addEventListener("mousemove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("mousemove", handlePointerMove);
  }, []);
  // Which entry the cursor is over, tracked WITHOUT React state so scrubbing the
  // list costs zero re-renders (hover paints via CSS `:hover`). Keyboard nav
  // reads this to continue from the hovered row. Key-based, so it self-heals if
  // the entry disappears (findIndex → -1).
  const hoveredNavKeyRef = useRef<string | null>(null);
  const setNavSelectionFromPointer = useCallback((navKey: string) => {
    if (!pointerMovedSinceKeyNavRef.current) return;
    hoveredNavKeyRef.current = navKey;
    // Drop any keyboard selection band the moment the mouse takes over, so we
    // never show two identical highlights at once. React bails when already
    // null, so continuous hovering triggers no re-render.
    setSelectedNavKey((prev) => (prev === null ? prev : null));
  }, []);
  const { openNewTask } = useDialogActions();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });
  const currentUserId = session?.user.id ?? null;

  // Scope the storage key per company so folding/view state is independent across companies.
  const scopedKey = `${viewStateKey}:${companyId}`;
  const initialOwnersKey = JSON.stringify(initialOwners ?? []);

  const [viewState, setViewState] = useState<TaskViewState>(() =>
    getInitialViewState(scopedKey, initialOwners, defaultSortField),
  );
  const [taskSearch, setTaskSearch] = useState(initialSearch ?? "");
  const [renderedTaskRowLimit, setRenderedTaskRowLimit] = useState(
    INITIAL_TASK_ROW_RENDER_LIMIT,
  );
  const [visibleTaskColumns, setVisibleTaskColumns] = useState<
    InboxTaskColumn[]
  >(() => loadTaskColumns(scopedKey));
  const renderedTaskIdsRef = useRef("");
  const initialServerFillRequestedRef = useRef(false);
  const deferredTaskSearch = useDeferredValue(taskSearch);
  const normalizedTaskSearch = deferredTaskSearch.trim().toLowerCase();

  useEffect(() => {
    setTaskSearch(initialSearch ?? "");
  }, [initialSearch]);

  // Reload view state whenever the persisted context changes.
  const prevViewStateContextKey = useRef(`${scopedKey}::${initialOwnersKey}`);
  useEffect(() => {
    const nextContextKey = `${scopedKey}::${initialOwnersKey}`;
    if (prevViewStateContextKey.current !== nextContextKey) {
      prevViewStateContextKey.current = nextContextKey;
      setViewState(
        getInitialViewState(scopedKey, initialOwners, defaultSortField),
      );
    }
  }, [scopedKey, initialOwners, initialOwnersKey, defaultSortField]);

  const prevColumnsScopedKey = useRef(scopedKey);
  useEffect(() => {
    if (prevColumnsScopedKey.current !== scopedKey) {
      prevColumnsScopedKey.current = scopedKey;
      setVisibleTaskColumns(loadTaskColumns(scopedKey));
    }
  }, [scopedKey]);

  const updateView = useCallback(
    (patch: Partial<TaskViewState>) => {
      setViewState((prev) => {
        const next = { ...prev, ...patch };
        saveViewState(scopedKey, next);
        return next;
      });
    },
    [scopedKey],
  );

  // Prune stale IDs from collapsedParents whenever the task list changes.
  // Deleted or reassigned tasks leave orphan IDs in localStorage; this keeps
  // the stored array bounded to only current parent IDs.
  useEffect(() => {
    const parentIds = new Set(
      tasks.map((i: Task) => i.parentId).filter(Boolean) as string[],
    );
    const pruned = viewState.collapsedParents.filter((id) => parentIds.has(id));
    if (pruned.length !== viewState.collapsedParents.length) {
      updateView({ collapsedParents: pruned });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const { data: searchedTasks = [] } = useQuery({
    queryKey: [
      ...queryKeys.tasks.search(companyId, normalizedTaskSearch, projectId),
      searchFilters ?? {},
      "compact",
      TASK_SEARCH_RESULT_LIMIT,
      enableRoutineVisibilityFilter
        ? "with-routine-executions"
        : "without-routine-executions",
    ],
    queryFn: ({ signal }) =>
      tasksApi
        .listCompact(
          companyId,
          {
            q: normalizedTaskSearch,
            projectId,
            limit: TASK_SEARCH_RESULT_LIMIT,
            ...searchFilters,
          },
          { signal },
        )
        .then((rows) => rows as Task[]),
    enabled: normalizedTaskSearch.length > 0 && !searchWithinLoadedTasks,
    placeholderData: (previousData) => previousData,
  });
  const boardTaskQueries = useQueries({
    queries: boardTaskStatuses.map((status) => ({
      queryKey: [
        ...queryKeys.tasks.list(companyId),
        "board-column",
        status,
        normalizedTaskSearch,
        projectId ?? "__all-projects__",
        searchFilters ?? {},
        "compact",
        TASK_BOARD_COLUMN_RESULT_LIMIT,
        enableRoutineVisibilityFilter
          ? "with-routine-executions"
          : "without-routine-executions",
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        tasksApi
          .listCompact(
            companyId,
            {
              ...searchFilters,
              ...(normalizedTaskSearch.length > 0
                ? { q: normalizedTaskSearch }
                : {}),
              projectId,
              status: [status],
              limit: TASK_BOARD_COLUMN_RESULT_LIMIT,
            },
            { signal },
          )
          .then((rows) => rows as Task[]),
      enabled: viewState.viewMode === "board" && !searchWithinLoadedTasks,
      placeholderData: (previousData: Task[] | undefined) => previousData,
    })),
  });
  const agentName = useCallback(
    (id: string | null) => {
      if (!id || !agents) return null;
      return agents.find((a: { id: string; name: string }) => a.id === id)?.name ?? null;
    },
    [agents],
  );

  const companyUserLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const companyUserProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const ownerUserOptions = useMemo(
    () =>
      (companyMembers?.users ?? []).map((member) => ({
        id: member.principalId,
        name:
          member.principalId === currentUserId
            ? "Me"
            : (companyUserLabelMap.get(member.principalId) ??
              member.principalId.slice(0, 5)),
      })),
    [companyMembers?.users, companyUserLabelMap, currentUserId],
  );

  const projectById = useMemo(() => {
    const map = new Map<string, { name: string; color: string | null }>();
    for (const project of projects ?? []) {
      map.set(project.id, { name: project.name, color: project.color ?? null });
    }
    return map;
  }, [projects]);

  const creatorOptions = useMemo<CreatorOption[]>(() => {
    const options = new Map<string, CreatorOption>();
    const knownAgentIds = new Set<string>();

    if (currentUserId) {
      options.set(`user:${currentUserId}`, {
        id: `user:${currentUserId}`,
        label: "Me",
        kind: "user",
        searchText: `me user ${currentUserId}`,
      });
    }

    for (const task of tasks) {
      const creator = deriveOriginatingActor(task);
      if (creator?.kind === "user") {
        const id = `user:${creator.id}`;
        if (!options.has(id)) {
          options.set(id, {
            id,
            label:
              formatOwnerUserLabel(creator.id, currentUserId) ??
              creator.id.slice(0, 5),
            kind: "user",
            searchText: `${creator.id} board user`,
          });
        }
      }
    }

    for (const agent of agents ?? []) {
      knownAgentIds.add(agent.id);
      const id = `agent:${agent.id}`;
      if (!options.has(id)) {
        options.set(id, {
          id,
          label: agent.name,
          kind: "agent",
          searchText: `${agent.name} ${agent.id} agent`,
        });
      }
    }

    for (const task of tasks) {
      const creator = deriveOriginatingActor(task);
      if (creator?.kind === "agent" && !knownAgentIds.has(creator.id)) {
        const id = `agent:${creator.id}`;
        if (!options.has(id)) {
          options.set(id, {
            id,
            label: creator.id.slice(0, 8),
            kind: "agent",
            searchText: `${creator.id} agent`,
          });
        }
      }
    }

    return [...options.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "user" ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [agents, currentUserId, tasks]);

  const visibleTaskColumnSet = useMemo(
    () => new Set(visibleTaskColumns),
    [visibleTaskColumns],
  );
  const availableTaskColumns = inboxTaskColumns;
  const availableTaskColumnSet = useMemo(
    () => new Set(availableTaskColumns),
    [availableTaskColumns],
  );
  const subtreeLiveCounts = useMemo(
    () => collectSubtreeLiveCounts(tasks, liveTaskIds ?? new Set<string>()),
    [tasks, liveTaskIds],
  );
  const visibleTrailingTaskColumns = useMemo(
    () =>
      taskTrailingColumns.filter(
        (column) =>
          visibleTaskColumnSet.has(column) &&
          availableTaskColumnSet.has(column),
      ),
    [availableTaskColumnSet, visibleTaskColumnSet],
  );

  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of tasks) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);

  const taskTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) {
      const title = taskDisplayTitle(task);
      map.set(
        task.id,
        task.identifier && task.identifier !== title
          ? `${task.identifier}: ${title}`
          : title,
      );
    }
    return map;
  }, [tasks]);

  const boardTasks = useMemo(() => {
    if (viewState.viewMode !== "board" || searchWithinLoadedTasks) return null;
    const merged = new Map<string, Task>();
    let isPending = false;
    for (const query of boardTaskQueries) {
      isPending ||= query.isPending;
      for (const task of query.data ?? []) {
        merged.set(task.id, task);
      }
    }
    if (merged.size > 0) return [...merged.values()];
    return isPending ? tasks : [];
  }, [boardTaskQueries, tasks, searchWithinLoadedTasks, viewState.viewMode]);

  return { rootRef, navigate, companyId, keyboardShortcutsEnabled, selectedNavKey, setSelectedNavKey, pointerMovedSinceKeyNavRef, hoveredNavKeyRef, setNavSelectionFromPointer, openNewTask, currentUserId, scopedKey, viewState, taskSearch, setTaskSearch, renderedTaskRowLimit, setRenderedTaskRowLimit, visibleTaskColumns, setVisibleTaskColumns, renderedTaskIdsRef, initialServerFillRequestedRef, normalizedTaskSearch, updateView, searchedTasks, boardTaskQueries, agentName, companyUserLabelMap, companyUserProfileMap, ownerUserOptions, projectById, creatorOptions, visibleTaskColumnSet, availableTaskColumns, availableTaskColumnSet, subtreeLiveCounts, visibleTrailingTaskColumns, taskById, taskTitleMap, boardTasks };
}
