import { TaskOutputSection } from "@/components/task-output/TaskOutputSection";
import { TaskAttachmentsSection } from "@/components/TaskAttachmentsSection";
import { TaskDocumentsSection } from "@/components/TaskDocumentsSection";
import { TaskProperties } from "@/components/task-properties/TaskProperties";
import { AccessibleDropzone } from "@/components/patterns/AccessibleDropzone";
import { TasksList } from "@/components/TasksList";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { buildSubTaskDefaultsForViewer } from "@/lib/subTaskDefaults";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { PluginSlotOutlet } from "@/plugins/slots";
import { Plus } from "lucide-react";
import { TaskSectionSkeleton } from "./-TaskDetailLoading";
import { useTaskDetailPage } from "./-TaskDetailPageContext";

export function TaskDetailWorkProducts() {
  const {
    agentMap,
    agents,
    attachmentError,
    attachmentList,
    attachmentUploadPending,
    attachmentsInitialLoading,
    childPauseBadgeById,
    childTasks,
    childTasksLoading,
    deleteAttachment,
    handleAttachmentFiles,
    hasAttachments,
    liveTaskIds,
    location,
    mediaGalleryItems,
    mentionOptions,
    mutedChildTaskIds,
    openNewSubTask,
    projects,
    resolvedTaskDetailState,
    session,
    setGalleryIndex,
    setGalleryOpen,
    showRichSubTasksSection,
    task,
    uploadAttachment,
    userProfileMap,
    workProducts,
  } = useTaskDetailPage();
  return (
    <>
      <PluginSlotOutlet
        slotTypes={["toolbarButton"]}
        entityType="task"
        context={{
          companyId: task.companyId,
          projectId: task.projectId ?? null,
          entityId: task.id,
          entityType: "task",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />
      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="task"
        context={{
          companyId: task.companyId,
          projectId: task.projectId ?? null,
          entityId: task.id,
          entityType: "task",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />
      <PluginSlotOutlet
        slotTypes={["taskDetailView"]}
        entityType="task"
        context={{
          companyId: task.companyId,
          projectId: task.projectId ?? null,
          entityId: task.id,
          entityType: "task",
        }}
        className="space-y-3"
        itemClassName="rounded-lg border border-border p-3"
        missingBehavior="placeholder"
      />
      {showRichSubTasksSection ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">Sub-tasks</h3>
          </div>
          <TasksList
            tasks={childTasks}
            isLoading={childTasksLoading}
            agents={agents}
            projects={projects}
            liveTaskIds={liveTaskIds}
            mutedTaskIds={mutedChildTaskIds}
            taskBadgeById={childPauseBadgeById}
            projectId={task.projectId ?? undefined}
            viewStateKey={`paperclip:task-detail:${task.id}:subtasks-view`}
            taskLinkState={resolvedTaskDetailState ?? location.state}
            searchFilters={{ descendantOf: task.id, includeBlockedBy: true }}
            searchWithinLoadedTasks
            baseCreateTaskDefaults={buildSubTaskDefaultsForViewer(task)}
            createTaskLabel="Sub-task"
            defaultSortField="workflow"
            showProgressSummary
            parentTaskIdForCostSummary={task.id}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
          <Button variant="outline" size="sm" onClick={openNewSubTask} className="shrink-0 shadow-none">
            <Plus data-icon="inline-start" className="mr-1.5 h-3.5 w-3.5" />
            New Sub-task
          </Button>
        </div>
      )}
      <TaskDocumentsSection
        task={task}
        canDeleteDocuments={Boolean(session?.user?.id)}
        canManageDocumentLocks={Boolean(session?.user?.id)}
        mentions={mentionOptions}
        imageUploadHandler={async (file) => {
          const attachment = await uploadAttachment.mutateAsync(file);
          return attachment.contentPath;
        }}
        agentMap={agentMap}
        userProfileMap={userProfileMap}
      />
      <div aria-busy={attachmentUploadPending}>
        <AccessibleDropzone
          ariaLabel="Upload task attachments"
          maxFiles={100}
          disabled={attachmentUploadPending}
          onDrop={(files) => void handleAttachmentFiles(files)}
        />
        {attachmentUploadPending ? (
          <span className="sr-only" role="status">
            Uploading attachment.
          </span>
        ) : null}
      </div>
      <TaskOutputSection
        workProducts={workProducts}
        onMediaClick={(item) => {
          const meta = item.metadata;
          if (!meta) return;
          const idx = mediaGalleryItems.findIndex(
            (galleryItem) =>
              galleryItem.contentPath === meta.contentPath ||
              galleryItem.id === `work-product-${item.id}` ||
              galleryItem.id === meta.attachmentId,
          );
          setGalleryIndex(idx >= 0 ? idx : 0);
          setGalleryOpen(true);
        }}
      />
      {attachmentsInitialLoading ? (
        <TaskSectionSkeleton titleWidth="w-24" rows={2} />
      ) : hasAttachments ? (
        <TaskAttachmentsSection
          attachments={attachmentList}
          error={attachmentError}
          deletePending={deleteAttachment.isPending}
          onDelete={(attachmentId) => deleteAttachment.mutate(attachmentId)}
          onImageClick={(attachment) => {
            const idx = mediaGalleryItems.findIndex((a) => a.id === attachment.id);
            setGalleryIndex(idx >= 0 ? idx : 0);
            setGalleryOpen(true);
          }}
        />
      ) : null}
    </>
  );
}

export function TaskDetailPropertiesSheet() {
  const {
    mobilePropsOpen,
    setMobilePropsOpen,
    task,
    childTasks,
    openNewSubTask,
    handleTaskPropertiesUpdate,
    resolvedHasActiveRun,
  } = useTaskDetailPage();

  return (
    <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
      <SheetContent side="bottom" className="max-h-(--sz-85dvh) pb-(--sz-safe-bottom)">
        <SheetHeader>
          <SheetTitle>Properties</SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1 overflow-y-auto">
          <div className="px-4 pb-4">
            <TaskProperties
              task={task}
              childTasks={childTasks}
              onAddSubTask={openNewSubTask}
              onUpdate={handleTaskPropertiesUpdate}
              inline
              hasActiveRun={resolvedHasActiveRun}
            />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
