import { FolderOpen, SlidersHorizontal } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useTaskDetailPage } from "./-TaskDetailPageContext";
import { TaskResources, type TaskResourcesProps } from "./-TaskResources";
import { TaskProperties } from "./-task-properties/-TaskProperties";

export type TaskInspectorTab = "details" | "resources";

export interface TaskInspectorProps extends TaskResourcesProps {
  activeTab: TaskInspectorTab;
  onTabChange: (tab: TaskInspectorTab) => void;
  onUpdateTask: (data: Record<string, unknown>) => void;
  hasActiveRun: boolean;
  inline?: boolean;
}

export function TaskInspector({
  activeTab,
  onTabChange,
  onUpdateTask,
  hasActiveRun,
  inline = false,
  ...resourceProps
}: TaskInspectorProps) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => onTabChange(value as TaskInspectorTab)}
      className="space-y-4"
    >
      <TabsList variant="line" className="w-full justify-start gap-1" aria-label="Task details sections">
        <TabsTrigger value="details" className="gap-1.5">
          <SlidersHorizontal className="size-3.5" data-icon="inline-start" />
          Details
        </TabsTrigger>
        <TabsTrigger value="resources" className="gap-1.5">
          <FolderOpen className="size-3.5" data-icon="inline-start" />
          Resources
        </TabsTrigger>
      </TabsList>

      <TabsContent value="details">
        <TaskProperties
          task={resourceProps.task}
          childTasks={resourceProps.childTasks}
          onUpdate={onUpdateTask}
          inline={inline}
          hasActiveRun={hasActiveRun}
        />
      </TabsContent>

      <TabsContent value="resources">
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
    workProducts,
  } = useTaskDetailPage();

  return (
    <Sheet open={mobileInspectorOpen} onOpenChange={setMobileInspectorOpen}>
      <SheetContent side="bottom" className="max-h-(--sz-85dvh) pb-(--sz-safe-bottom)">
        <SheetHeader>
          <SheetTitle>Task details</SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1 overflow-y-auto">
          <div className="px-4 pb-4">
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
              hasActiveRun={resolvedHasActiveRun}
              inline
            />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
