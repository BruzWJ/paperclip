import { parseTaskNumber } from "@paperclipai/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, notFound, useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";

import { ApiError } from "@/api/client";
import { tasksApi } from "@/api/tasks";
import { ImageGalleryModal } from "@/components/ImageGalleryModal";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialogActions } from "@/context/DialogContext";
import { usePanel } from "@/context/PanelContext";
import { useSidebar } from "@/context/SidebarContext";
import { useNavigationAction } from "@/lib/navigation-action";
import { readTaskDetailHeaderSeed, readTaskDetailLocationState } from "@/lib/taskDetailBreadcrumb";
import { getTaskDetailQueryOptions, seedTaskDetailCache } from "@/lib/taskDetailCache";

import { TaskDetailHeader } from "./-TaskDetailHeader";
import { TaskDetailLoadingState } from "./-TaskDetailLoading";
import { TaskDetailPageProvider } from "./-TaskDetailPageContext";
import { TaskDetailStatusPanels } from "./-TaskDetailStatusPanels";
import { TaskDetailWorkProducts } from "./-TaskDetailWorkProducts";
import { TaskDetailPropertiesSheet } from "./-TaskDetailWorkProducts";
import { TaskDetailTabs, TaskTreeControlDialog } from "./-TaskTreeControlDialog";
import { taskDetailSourceRouteOptions } from "./-task-detail-model";
import { useTaskDetailActionMutations, useTaskDetailTreeMutation } from "./-useTaskDetailActionMutations";
import { useTaskDetailComments } from "./-useTaskDetailComments";
import { useTaskDetailCoreMutations } from "./-useTaskDetailCoreMutations";
import { useTaskDetailCacheActions, useTaskDetailEffects, useTaskDetailState } from "./-useTaskDetailEffects";
import { useTaskDetailInteractions } from "./-useTaskDetailInteractions";
import { useTaskDetailDerivedData, useTaskDetailQueries } from "./-useTaskDetailQueries";
import { useTaskDetailTreeDerived } from "./-useTaskDetailTreeDerived";

export { shouldScrollTaskDetailToTopOnNavigation } from "./-task-detail-model";
export type { AttributionActor } from "./-TaskAttribution";

export const Route = createFileRoute("/_authenticated/$companyId/tasks/$taskNumber/")({
  loader: async ({ abortController, context, params }) => {
    const taskNumber = parseTaskNumber(params.taskNumber);
    if (taskNumber === null) throw notFound();

    const task = await tasksApi
      .getByNumber(params.companyId, taskNumber, {
        signal: abortController.signal,
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) throw notFound();
        throw error;
      });
    if (task.companyId !== params.companyId || task.taskNumber !== taskNumber) {
      throw notFound();
    }
    return seedTaskDetailCache(context.queryClient, task);
  },
  component: TaskDetail,
});

function buildTaskDetailReadyController<T extends Record<string, unknown>>(input: T): T & { kind: "ready" } {
  return { kind: "ready", ...input };
}

export function useTaskDetailController() {
  const taskDetailRoute = getRouteApi("/_authenticated/$companyId/tasks/$taskNumber/");
  const { companyId } = taskDetailRoute.useParams();
  const routeTask = taskDetailRoute.useLoaderData();
  const taskId = routeTask.id;
  const { openNewTask } = useDialogActions();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs, setMobileToolbar } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const navigationType = useNavigationAction();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const localState = useTaskDetailState();
  const resolvedTaskDetailState = useMemo(
    () => readTaskDetailLocationState(location.state),
    [location.state],
  );
  const taskHeaderSeed = useMemo(
    () => readTaskDetailHeaderSeed(location.state) ?? readTaskDetailHeaderSeed(resolvedTaskDetailState),
    [location.state, resolvedTaskDetailState],
  );

  const taskQuery = useQuery({
    ...getTaskDetailQueryOptions(queryClient, taskId),
  });
  const task = taskQuery.data;
  const isLoading = taskQuery.isLoading;
  const error = taskQuery.error;
  const commentData = useTaskDetailComments({
    companyId,
    taskId,
    detailTab: localState.detailTab,
  });

  const queryData = useTaskDetailQueries({
    companyId,
    taskId,
    task,
    detailTab: localState.detailTab,
    treeControlOpen: localState.treeControlOpen,
    treeControlMode: localState.treeControlMode,
  });

  const taskDetailSource = resolvedTaskDetailState?.taskDetailSource ?? null;
  const navigateToTaskSource = useCallback(
    (replace = false) =>
      navigate({
        ...taskDetailSourceRouteOptions(taskDetailSource, companyId),
        replace,
      }),
    [companyId, navigate, taskDetailSource],
  );

  const cacheActions = useTaskDetailCacheActions(companyId, taskId);
  const actionMutations = useTaskDetailActionMutations({
    companyId,
    taskId,
    task,
    currentUserId: queryData.currentUserId,
    navigateToTaskSource,
    cacheActions,
  });
  useEffect(() => {
    if (!queryData.hasLiveRuns && actionMutations.locallyQueuedCommentRunIds.size > 0) {
      actionMutations.setLocallyQueuedCommentRunIds(new Map());
    }
  }, [
    actionMutations.locallyQueuedCommentRunIds.size,
    actionMutations.setLocallyQueuedCommentRunIds,
    queryData.hasLiveRuns,
  ]);

  const derivedData = useTaskDetailDerivedData({
    ...queryData,
    ...actionMutations,
    task,
    taskId,
    comments: commentData.comments,
    openNewTask,
  });

  const coreMutations = useTaskDetailCoreMutations({
    companyId,
    taskId,
    task,
    currentUserId: queryData.currentUserId,
    cacheActions,
  });
  const executeTreeControl = useTaskDetailTreeMutation({
    companyId,
    taskId,
    task,
    childTasks: derivedData.childTasks,
    treeControlMode: localState.treeControlMode,
    treeControlReason: localState.treeControlReason,
    treeControlState: queryData.treeControlState,
    setTreeControlOpen: localState.setTreeControlOpen,
    setTreeControlReason: localState.setTreeControlReason,
    setTreeControlCancelConfirmed: localState.setTreeControlCancelConfirmed,
  });

  const isFromInbox = resolvedTaskDetailState?.taskDetailSource === "inbox";
  const effectState = useTaskDetailEffects({
    ...queryData,
    ...derivedData,
    ...coreMutations,
    ...actionMutations,
    ...localState,
    companyId,
    taskId,
    task,
    taskDetailSource,
    setBreadcrumbs,
    navigationType,
    openPanel,
    closePanel,
    navigateToTaskSource,
    locationHash: location.hash,
    detailTab: localState.detailTab,
  });

  const interactions = useTaskDetailInteractions({
    ...queryData,
    ...derivedData,
    ...coreMutations,
    ...actionMutations,
    ...localState,
    companyId,
    taskId,
    task,
    isMobile,
    isFromInbox,
    setMobileToolbar,
    cacheActions,
  });

  const treeDerived = useTaskDetailTreeDerived({
    ...queryData,
    ...derivedData,
    ...actionMutations,
    ...coreMutations,
    ...localState,
    task,
    attachmentListLength: interactions.attachmentList.length,
    executeTreeControl,
  });

  if (isLoading) return { kind: "loading" as const, taskHeaderSeed };
  if (error) return { kind: "error" as const, error };
  if (!task) return { kind: "missing" as const };

  return buildTaskDetailReadyController({
    companyId,
    taskId,
    panelVisible,
    setPanelVisible,
    location,
    isMobile,
    ...localState,
    ...actionMutations,
    ...coreMutations,
    ...commentData,
    ...queryData,
    ...derivedData,
    ...cacheActions,
    ...effectState,
    ...interactions,
    ...treeDerived,
    resolvedTaskDetailState,
    task,
    isLoading,
    error,
    executeTreeControl,
    isFromInbox,
  });
}

export type TaskDetailController = Extract<ReturnType<typeof useTaskDetailController>, { kind: "ready" }>;

function TaskDetail() {
  const controller = useTaskDetailController();

  if (controller.kind === "loading") {
    return <TaskDetailLoadingState headerSeed={controller.taskHeaderSeed} />;
  }
  if (controller.kind === "error") {
    return (
      <Alert variant="destructive">
        <AlertDescription>{controller.error.message}</AlertDescription>
      </Alert>
    );
  }
  if (controller.kind === "missing") return null;

  return (
    <TaskDetailPageProvider value={controller}>
      <>
        <TaskDetailStatusPanels />
        <TaskDetailHeader />
        <TaskDetailWorkProducts />
        <ImageGalleryModal
          items={controller.mediaGalleryItems}
          initialIndex={controller.galleryIndex}
          open={controller.galleryOpen}
          onOpenChange={controller.setGalleryOpen}
        />
        <TaskDetailTabs />
        <TaskTreeControlDialog />
        <Dialog
          open={controller.reopenDialogOpen}
          onOpenChange={(open) => {
            controller.setReopenDialogOpen(open);
            if (!open) controller.setReopenReason("");
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reopen this task</DialogTitle>
              <DialogDescription>
                This audited command preserves the owner and execution session, clears the terminal
                disposition, and invokes the owner with the stored immutable request.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel>Reason</FieldLabel>
              <Textarea
                value={controller.reopenReason}
                onChange={(event) => controller.setReopenReason(event.target.value)}
                rows={4}
                placeholder="Why should this task be reopened?"
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => controller.setReopenDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!controller.reopenReason.trim() || controller.reopenTask.isPending}
                onClick={() => controller.reopenTask.mutate(controller.reopenReason)}
              >
                {controller.reopenTask.isPending ? "Reopening..." : "Reopen task"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <TaskDetailPropertiesSheet />
      </>
    </TaskDetailPageProvider>
  );
}
