import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { ListTree, Maximize2, Minimize2 } from "lucide-react";
import { MissingUserSecretsBanner } from "@/components/secrets/MissingUserSecretsBanner";
import { AccessibleDropzone } from "@/components/patterns/AccessibleDropzone";
import { NewTaskAssignmentSelectors } from "./NewTaskAssignmentSelectors";
import { TaskRequestEditor, TaskTitleTextarea } from "./NewTaskTextEditors";
import { NewTaskStagedFiles } from "./NewTaskStagedFiles";
import { useNewTaskDialogViewModel } from "./context";
import { STAGED_FILE_ACCEPT } from "./model";

export function NewTaskEditorContent() {
  const model = useNewTaskDialogViewModel();
  const { isSubTaskMode, parentTaskLabel, newTaskDefaults, closeNewTask } = model.dialog;
  const { companyId, selectedCompany, currentUserId } = model.company;
  const { title, request, ownerAgentId, projectId, expanded } = model.values;
  const { setExpanded } = model.setters;
  const { requestEditorRef, ownerSelectorRef, projectSelectorRef } = model.refs;
  const { mentionOptions } = model.options;
  const { neededUserSecretKeys } = model.derived;
  const { createTask, uploadRequestImageHandler } = model.creation;
  const { handleTitleChange, handleRequestChange, stageFiles } = model.actions;
  return (
    <>
      <DialogTitle className="sr-only">Create a task</DialogTitle>
      <DialogHeader className="shrink-0 flex-row items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">{(selectedCompany?.name ?? "").slice(0, 3).toUpperCase()}</Badge>
          <span className="text-muted-foreground/60">&rsaquo;</span>
          <span>{isSubTaskMode ? "New sub-task" : "New task"}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => setExpanded(!expanded)}
            disabled={createTask.isPending}
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => closeNewTask()}
            disabled={createTask.isPending}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* Title */}
        <div className="px-4 pt-4 pb-2">
          <TaskTitleTextarea
            value={title}
            pending={createTask.isPending}
            ownerAgentId={ownerAgentId}
            projectId={projectId}
            requestEditorRef={requestEditorRef}
            ownerSelectorRef={ownerSelectorRef}
            projectSelectorRef={projectSelectorRef}
            onChange={handleTitleChange}
          />
        </div>

        <div className="px-4 pb-2">
          {neededUserSecretKeys.length > 0 ? (
            <MissingUserSecretsBanner
              companyId={companyId}
              userId={currentUserId}
              definitionKeys={neededUserSecretKeys}
            />
          ) : null}
        </div>

        <NewTaskAssignmentSelectors />
        {isSubTaskMode ? (
          <div className="px-4 pb-2">
            <Item variant="muted" size="sm">
              <ItemMedia>
                <ListTree />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Sub-task of {parentTaskLabel}</ItemTitle>
                {newTaskDefaults.parentTitle ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {newTaskDefaults.parentTitle}
                  </span>
                ) : null}
              </ItemContent>
            </Item>
          </div>
        ) : null}

        {/* Immutable request */}
        <Separator />
        <div className="px-4 pb-2 pt-3">
          <Card className="gap-0 py-0 shadow-none">
            <TaskRequestEditor
              value={request}
              expanded={expanded}
              mentions={mentionOptions}
              requestEditorRef={requestEditorRef}
              imageUploadHandler={uploadRequestImageHandler}
              onChange={handleRequestChange}
            />
          </Card>
          <NewTaskStagedFiles />
          <AccessibleDropzone
            ariaLabel="Upload task attachments"
            accept={STAGED_FILE_ACCEPT}
            maxFiles={100}
            disabled={createTask.isPending}
            className="mt-2"
            onDrop={(files) => stageFiles(files)}
          />
        </div>
      </div>
    </>
  );
}
