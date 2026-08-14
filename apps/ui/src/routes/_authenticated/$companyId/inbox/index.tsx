import { compareMoneyAmounts } from "@paperclipai/shared";
import { createFileRoute, Link } from "@tanstack/react-router";
import { createElement, useCallback, useEffect } from "react";

import { BlockedInboxView } from "@/components/BlockedInboxView";
import { Banner, BannerClose, BannerIcon, BannerTitle } from "@/components/kibo-ui/banner";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Skeleton } from "@/components/ui/skeleton";
import { TaskFiltersPopover } from "@/components/TaskFiltersPopover";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialogActions } from "@/context/DialogContext";
import { useGeneralSettings } from "@/context/GeneralSettingsContext";
import { useSidebar } from "@/context/SidebarContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import {
  buildInboxTaskGroupCreateDefaults,
  normalizeInboxTaskColumns,
  saveInboxFilterPreferences,
  saveInboxTaskColumns,
  saveInboxWorkItemGroupBy,
  shouldShowCompanyAlerts,
  shouldShowInboxSection,
  type InboxApprovalFilter,
  type InboxCategoryFilter,
  type InboxFilterPreferences,
  type InboxGroupedSection,
  type InboxTab,
  type InboxTaskColumn,
  type InboxWorkItemGroupBy,
} from "@/lib/inbox";
import { countActiveTaskFilters as countTaskFilters, type TaskFilterState } from "@/lib/task-filters";
import { AlertTriangle, Inbox as InboxIcon, Search } from "lucide-react";

import { INBOX_TASK_DETAIL_LOCATION_STATE, type SectionKey } from "./-inbox-controller-model";
import { InboxPageProvider, useInboxPage } from "./-InboxPageContext";
import { ZERO_AMOUNT } from "./-inbox-row-model";
import { InboxAllFilters, InboxToolbar } from "./-InboxToolbar";
import { InboxWorkItems } from "./-InboxWorkItems";
import { useInboxKeyboardNavigation } from "./-useInboxKeyboardNavigation";
import { useInboxMutations } from "./-useInboxMutations";
import { useInboxQueries } from "./-useInboxQueries";
import { useInboxState } from "./-useInboxState";
import { useInboxWorkItems } from "./-useInboxWorkItems";

export { FailedRunInboxRow } from "./-FailedRunInboxRow";
export { formatJoinRequestInboxLabel } from "./-inbox-row-model";

export const Route = createFileRoute("/_authenticated/$companyId/inbox/")({
  component: MineInboxIndexRoute,
});

function MineInboxIndexRoute() {
  return <Inbox tab="mine" />;
}

export {
  INBOX_HOT_PATH_STALE_MS,
  INBOX_RUN_LIMIT,
  INBOX_TASK_DETAIL_LOCATION_STATE,
  INBOX_TASK_LIST_LIMIT,
  navEntryKey,
} from "./-inbox-controller-model";
export type { NavEntry, SectionKey } from "./-inbox-controller-model";

export function useInboxController(tab: InboxTab) {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewTask } = useDialogActions();
  const { isMobile } = useSidebar();
  const companyId = useCompanyRouteId();
  const { keyboardShortcutsEnabled } = useGeneralSettings();
  const taskLinkState = INBOX_TASK_DETAIL_LOCATION_STATE;
  const state = useInboxState(companyId, tab);
  const queries = useInboxQueries({
    companyId,
    normalizedSearchQuery: state.normalizedSearchQuery,
  });
  const workItems = useInboxWorkItems({ tab, isMobile, queries, state });
  const mutations = useInboxMutations({ companyId, tab, state });
  const navigation = useInboxKeyboardNavigation({
    companyId,
    keyboardShortcutsEnabled,
    taskLinkState,
    state,
    workItems,
    mutations,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Inbox" }]);
  }, [setBreadcrumbs]);

  const openCreateTaskForGroup = useCallback(
    (group: InboxGroupedSection) => {
      const defaults = buildInboxTaskGroupCreateDefaults(group.key, state.groupBy, group.displayItems);
      if (defaults) openNewTask(defaults);
    },
    [openNewTask, state.groupBy],
  );
  const setTaskColumns = useCallback(
    (next: InboxTaskColumn[]) => {
      const normalized = normalizeInboxTaskColumns(next);
      state.setVisibleTaskColumns(normalized);
      saveInboxTaskColumns(normalized);
    },
    [state.setVisibleTaskColumns],
  );
  const toggleTaskColumn = useCallback(
    (column: InboxTaskColumn, enabled: boolean) => {
      setTaskColumns(
        enabled
          ? [...state.visibleTaskColumns, column]
          : state.visibleTaskColumns.filter((value) => value !== column),
      );
    },
    [setTaskColumns, state.visibleTaskColumns],
  );
  const updateFilterPreferences = useCallback(
    (updater: (previous: InboxFilterPreferences) => InboxFilterPreferences) => {
      state.setFilterPreferences((previous) => {
        const next = updater(previous);
        saveInboxFilterPreferences(companyId, next);
        return next;
      });
    },
    [companyId, state.setFilterPreferences],
  );
  const updateTaskFilters = useCallback(
    (patch: Partial<TaskFilterState>) => {
      updateFilterPreferences((previous) => ({
        ...previous,
        taskFilters: { ...previous.taskFilters, ...patch },
      }));
    },
    [updateFilterPreferences],
  );
  const updateAllCategoryFilter = useCallback(
    (value: InboxCategoryFilter) => {
      updateFilterPreferences((previous) => ({
        ...previous,
        allCategoryFilter: value,
      }));
    },
    [updateFilterPreferences],
  );
  const updateAllApprovalFilter = useCallback(
    (value: InboxApprovalFilter) => {
      updateFilterPreferences((previous) => ({
        ...previous,
        allApprovalFilter: value,
      }));
    },
    [updateFilterPreferences],
  );
  const updateGroupBy = useCallback(
    (nextGroupBy: InboxWorkItemGroupBy) => {
      state.setGroupBy(nextGroupBy);
      saveInboxWorkItemGroupBy(nextGroupBy);
    },
    [state.setGroupBy],
  );

  const hasRunFailures = workItems.failedRuns.length > 0;
  const showCompanyAlerts = shouldShowCompanyAlerts(tab) && workItems.showAlertsCategory;
  const showAggregateAgentError =
    showCompanyAlerts &&
    Boolean(queries.dashboard) &&
    queries.dashboard!.agents.error > 0 &&
    !hasRunFailures &&
    !state.dismissedAlerts.has("alert:agent-errors");
  const showBudgetAlert =
    showCompanyAlerts &&
    Boolean(queries.dashboard) &&
    compareMoneyAmounts(queries.dashboard!.costs.monthBudgetAmount, ZERO_AMOUNT) > 0 &&
    queries.dashboard!.costs.monthUtilizationPercent >= 80 &&
    !state.dismissedAlerts.has("alert:budget");
  const hasAlerts = showAggregateAgentError || showBudgetAlert;
  const showWorkItemsSection = workItems.totalVisibleWorkItems > 0;
  const showAlertsSection = shouldShowInboxSection({
    tab,
    hasItems: hasAlerts,
    showOnMine: false,
    showOnRecent: false,
    showOnUnread: false,
    showOnAll: hasAlerts,
  });
  const visibleSections = [
    showAlertsSection ? "alerts" : null,
    showWorkItemsSection ? "work_items" : null,
  ].filter((key): key is SectionKey => key !== null);
  const allLoaded =
    !queries.isJoinRequestsLoading &&
    !queries.isApprovalsLoading &&
    !queries.isDashboardLoading &&
    !queries.isTasksLoading &&
    !queries.isMineTasksLoading &&
    !queries.isTouchedTasksLoading &&
    !queries.isRunsLoading;
  const showSeparatorBefore = (key: SectionKey) => visibleSections.indexOf(key) > 0;
  const markAllReadTasks = (
    tab === "mine" ? workItems.visibleMineTasks : workItems.unreadTouchedTasks
  ).filter(
    (task) =>
      task.isUnreadForMe && !state.fadingOutTasks.has(task.id) && !state.archivingTaskIds.has(task.id),
  );
  const unreadTaskIds = markAllReadTasks.map((task) => task.id);
  const canMarkAllRead = unreadTaskIds.length > 0;
  const activeTaskFilterCount = countTaskFilters(state.taskFilters, true);
  const showGeneralTaskToolbarControls = tab !== "blocked";
  const taskFiltersPopover = createElement(TaskFiltersPopover, {
    state: state.taskFilters,
    onChange: updateTaskFilters,
    activeFilterCount: activeTaskFilterCount,
    agents: queries.agents,
    creators: workItems.creatorOptions,
    projects: queries.projects?.map((project) => ({
      id: project.id,
      name: project.name,
    })),
    labels: queries.labels?.map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color,
    })),
    currentUserId: queries.currentUserId,
    enableRoutineVisibilityFilter: true,
    buttonVariant: "outline",
    iconOnly: true,
  });

  return {
    tab,
    setBreadcrumbs,
    openNewTask,
    isMobile,
    companyId,
    keyboardShortcutsEnabled,
    taskLinkState,
    ...state,
    ...queries,
    ...workItems,
    ...mutations,
    ...navigation,
    openCreateTaskForGroup,
    setTaskColumns,
    toggleTaskColumn,
    updateFilterPreferences,
    updateTaskFilters,
    updateAllCategoryFilter,
    updateAllApprovalFilter,
    updateGroupBy,
    hasRunFailures,
    showCompanyAlerts,
    showAggregateAgentError,
    showBudgetAlert,
    hasAlerts,
    showWorkItemsSection,
    showAlertsSection,
    visibleSections,
    allLoaded,
    showSeparatorBefore,
    markAllReadTasks,
    unreadTaskIds,
    canMarkAllRead,
    activeTaskFilterCount,
    showGeneralTaskToolbarControls,
    taskFiltersPopover,
  };
}

export type InboxController = ReturnType<typeof useInboxController>;

export function Inbox({ tab }: { tab: InboxTab }) {
  const controller = useInboxController(tab);
  return (
    <InboxPageProvider value={controller}>
      <InboxView />
    </InboxPageProvider>
  );
}

export function InboxView() {
  return (
    <div className="space-y-6">
      <InboxToolbar />
      <InboxAllFilters />
      <InboxStates />
      <InboxWorkItems />
      <InboxAlerts />
    </div>
  );
}

function InboxStates() {
  const controller = useInboxPage();
  const {
    tab,
    companyId,
    actionError,
    searchQuery,
    blockedGroupBy,
    blockedSortBy,
    taskFilters,
    taskLinkState,
    approvalsError,
    liveTaskIds,
    companyUserLabelMap,
    agentById,
    visibleTaskColumnSet,
    availableTaskColumnSet,
    subtreeLiveCounts,
    visibleSections,
    allLoaded,
  } = controller;
  return (
    <>
      {approvalsError ? (
        <Alert variant="destructive">
          <AlertDescription>{approvalsError.message}</AlertDescription>
        </Alert>
      ) : null}
      {actionError ? (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      {tab === "blocked" ? (
        <BlockedInboxView
          companyId={companyId}
          searchQuery={searchQuery}
          agentNameById={agentById}
          userLabelById={companyUserLabelMap}
          taskLinkState={taskLinkState}
          groupBy={blockedGroupBy}
          sortBy={blockedSortBy}
          taskFilters={taskFilters}
          liveTaskIds={liveTaskIds}
          subtreeLiveCounts={subtreeLiveCounts}
          showStatusColumn={visibleTaskColumnSet.has("status") && availableTaskColumnSet.has("status")}
          showIdentifierColumn={visibleTaskColumnSet.has("id") && availableTaskColumnSet.has("id")}
          showUpdatedColumn={visibleTaskColumnSet.has("updated") && availableTaskColumnSet.has("updated")}
        />
      ) : null}
      {tab !== "blocked" && !allLoaded && visibleSections.length === 0 ? (
        <Skeleton className="h-32 w-full" />
      ) : null}
      {tab !== "blocked" && allLoaded && visibleSections.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">{searchQuery.trim() ? <Search /> : <InboxIcon />}</EmptyMedia>
            <EmptyTitle>
              {searchQuery.trim()
                ? "No inbox items match your search."
                : tab === "mine"
                  ? "Inbox zero."
                  : tab === "unread"
                    ? "No new inbox items."
                    : tab === "recent"
                      ? "No recent inbox items."
                      : "No inbox items match these filters."}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
    </>
  );
}

function InboxAlerts() {
  const {
    companyId,
    dismissAlert,
    dashboard,
    showAggregateAgentError,
    showBudgetAlert,
    showAlertsSection,
    showSeparatorBefore,
  } = useInboxPage();
  if (!showAlertsSection) return null;
  return (
    <>
      {showSeparatorBefore("alerts") ? <Separator /> : null}
      <section>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Alerts</h3>
        <div className="space-y-2">
          {showAggregateAgentError ? (
            <Banner visible inset onClose={() => dismissAlert("alert:agent-errors")}>
              <BannerIcon icon={AlertTriangle} />
              <BannerTitle>
                <Link to="/$companyId/agents" params={{ companyId }}>
                  {dashboard!.agents.error} agent
                  {dashboard!.agents.error === 1 ? " has" : "s have"} errors
                </Link>
              </BannerTitle>
              <DomainStatus status="failed">Needs attention</DomainStatus>
              <BannerClose aria-label="Dismiss" />
            </Banner>
          ) : null}
          {showBudgetAlert ? (
            <Banner visible inset onClose={() => dismissAlert("alert:budget")}>
              <BannerIcon icon={AlertTriangle} />
              <BannerTitle>
                <Link to="/$companyId/costs" params={{ companyId }}>
                  Budget at {dashboard!.costs.monthUtilizationPercent}% utilization this month
                </Link>
              </BannerTitle>
              <DomainStatus status="warning">Budget warning</DomainStatus>
              <BannerClose aria-label="Dismiss" />
            </Banner>
          ) : null}
        </div>
      </section>
    </>
  );
}
