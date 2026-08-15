import { useEffect, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { useTaskDetailPage } from "./-TaskDetailPageContext";
import { TaskDocumentsSectionView } from "./-task-documents/-TaskDocumentsSection";
import { useTaskDocumentsSectionController } from "./-task-documents/-useTaskDocumentsController";

function MountedTaskDocumentWorkspace() {
  const {
    agentMap,
    documentsWorkspaceOpen,
    mentionOptions,
    session,
    setDocumentsWorkspaceOpen,
    task,
    uploadAttachment,
    userProfileMap,
  } = useTaskDetailPage();
  const controller = useTaskDocumentsSectionController({
    task,
    canDeleteDocuments: Boolean(session?.user?.id),
    canManageDocumentLocks: Boolean(session?.user?.id),
    mentions: mentionOptions,
    imageUploadHandler: async (file) => {
      const attachment = await uploadAttachment.mutateAsync(file);
      return attachment.contentPath;
    },
    agentMap,
    userProfileMap,
    presentationActive: documentsWorkspaceOpen,
  });

  return (
    <Dialog open={documentsWorkspaceOpen} onOpenChange={setDocumentsWorkspaceOpen}>
      <DialogContent className="flex max-h-(--sz-85vh) w-full !max-w-(--pct-90) flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Task documents</DialogTitle>
          <DialogDescription>
            Review and edit durable Markdown records associated with this task.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-2">
          <TaskDocumentsSectionView {...controller} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Lazily mounts the document controller once, then preserves drafts between workspace openings. */
export function TaskDocumentWorkspaceDialog() {
  const { documentsWorkspaceOpen, task } = useTaskDetailPage();
  const [mountedTaskId, setMountedTaskId] = useState<string | null>(() =>
    documentsWorkspaceOpen ? task.id : null,
  );

  useEffect(() => {
    if (documentsWorkspaceOpen) setMountedTaskId(task.id);
  }, [documentsWorkspaceOpen, task.id]);

  if (mountedTaskId !== task.id) return null;
  return <MountedTaskDocumentWorkspace />;
}
