import { FolderOpen, SlidersHorizontal } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { UpdateTaskStatus } from "@paperclipai/shared";

import { useTaskDetailPage } from "./-TaskDetailPageContext";
import { TaskResources, type TaskResourcesProps } from "./-TaskResources";
import { TaskProperties, type TaskPropertiesUpdate } from "./-task-properties/-TaskProperties";

export type TaskInspectorTab = "details" | "resources";

export interface TaskInspectorProps extends TaskResourcesProps {
  activeTab: TaskInspectorTab;
  onTabChange: (tab: TaskInspectorTab) => void;
  onUpdateTask: (data: TaskPropertiesUpdate) => void;
  onStatusUpdate: (input: UpdateTaskStatus) => Promise<unknown>;
  statusUpdatePending: boolean;
  hasActiveRun: boolean;
  inline?: boolean;
}

export function TaskInspector({
  activeTab,
  onTabChange,
  onUpdateTask,
  onStatusUpdate,
  statusUpdatePending,
  hasActiveRun,
  inline = false,
  ...resourceProps
}: TaskInspectorProps) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => onTabChange(value as TaskInspectorTab)}
      className="min-h-full gap-0"
    >
      <div
        className={cn("sticky top-0 z-10 border-b border-border bg-background px-4 py-2", inline && "pr-12")}
      >
        <TabsList variant="line" className="w-full justify-start" aria-label="Task details sections">
          <TabsTrigger value="details">
            <SlidersHorizontal className="size-3.5" data-icon="inline-start" />
            Details
          </TabsTrigger>
          <TabsTrigger value="resources">
            <FolderOpen className="size-3.5" data-icon="inline-start" />
            Resources
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="details" className="p-4">
        <TaskProperties
          task={resourceProps.task}
          childTasks={resourceProps.childTasks}
          onUpdate={onUpdateTask}
          onStatusUpdate={onStatusUpdate}
          statusUpdatePending={statusUpdatePending}
          inline={inline}
          hasActiveRun={hasActiveRun}
        />
      </TabsContent>

      <TabsContent value="resources" className="p-4">
        <TaskResources {...resourceProps} />
      </TabsContent>
    </Tabs>
  );
}

export function TaskDetailInspectorSheet() {
  const {
    attachmentError,
    attachmentList,
    attachmentUploadPending,
    attachmentsInitialLoading,
    childPauseBadgeById,
    childTasks,
    childTasksLoading,
    deleteAttachment,
    handleAttachmentFiles,
    handleTaskPropertiesUpdate,
    inspectorTab,
    liveTaskIds,
    location,
    mobileInspectorOpen,
    mutedChildTaskIds,
    openAttachmentInGallery,
    openDocumentsWorkspace,
    openNewSubTask,
    openOutputInGallery,
    resolvedHasActiveRun,
    resolvedTaskDetailState,
    setInspectorTab,
    setMobileInspectorOpen,
    task,
    updateTaskStatus,
    workProducts,
  } = useTaskDetailPage();

  return (
    <Sheet open={mobileInspectorOpen} onOpenChange={setMobileInspectorOpen}>
      <SheetContent
        side="bottom"
        className="min-h-0 max-h-(--sz-85dvh) gap-0 overflow-hidden pb-(--sz-safe-bottom) [&>[data-slot=sheet-close]]:z-20"
      >
        <SheetTitle className="sr-only">Task details</SheetTitle>
        <ScrollArea className="min-h-0 flex-1">
          <TaskInspector
            key={task.id}
            activeTab={inspectorTab}
            onTabChange={setInspectorTab}
            task={task}
            childTasks={childTasks}
            childTasksLoading={childTasksLoading}
            liveTaskIds={liveTaskIds}
            mutedChildTaskIds={mutedChildTaskIds}
            childPauseBadgeById={childPauseBadgeById}
            taskLinkState={resolvedTaskDetailState ?? location.state}
            onAddSubTask={openNewSubTask}
            attachments={attachmentList}
            attachmentsLoading={attachmentsInitialLoading}
            attachmentError={attachmentError}
            attachmentUploadPending={attachmentUploadPending}
            onUploadFiles={handleAttachmentFiles}
            attachmentDeletePending={deleteAttachment.isPending}
            onDeleteAttachment={deleteAttachment.mutate}
            onPreviewAttachment={openAttachmentInGallery}
            workProducts={workProducts}
            onPreviewOutput={openOutputInGallery}
            onOpenDocuments={() => {
              openDocumentsWorkspace();
              setMobileInspectorOpen(false);
            }}
            onUpdateTask={handleTaskPropertiesUpdate}
            onStatusUpdate={updateTaskStatus.mutateAsync}
            statusUpdatePending={updateTaskStatus.isPending}
            hasActiveRun={resolvedHasActiveRun}
            inline
          />
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
