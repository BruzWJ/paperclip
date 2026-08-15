import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Field, FieldContent, FieldGroup, FieldLabel } from "@/components/ui/field";
import type { Project } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Plus, X } from "lucide-react";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { cn, formatDate } from "@/lib/utils";
import { DraftInput } from "@/components/patterns/DraftFields";
import { EnvironmentVariablesEditor } from "../../../../../../features/environment-variables-editor";
import { InlineEditor } from "../../../../../../features/markdown/InlineEditor";

import { ProjectCodebaseSection } from "./-ProjectCodebaseSection";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  useProjectPropertiesFields,
  type ProjectConfigFieldKey,
  type ProjectFieldSaveState,
} from "./-useProjectPropertiesFields";

interface ProjectPropertiesProps {
  project: Project;
  onUpdate?: (data: Record<string, unknown>) => void;
  onFieldUpdate?: (field: ProjectConfigFieldKey, data: Record<string, unknown>) => void;
  getFieldSaveState?: (field: ProjectConfigFieldKey) => ProjectFieldSaveState;
  onArchive?: (archived: boolean) => void;
  archivePending?: boolean;
}

export type { ProjectConfigFieldKey } from "./-useProjectPropertiesFields";
export type { ProjectFieldSaveState } from "./-useProjectPropertiesFields";

const projectStatuses = ["backlog", "planned", "in_progress", "completed", "cancelled"];

export function ProjectProperties({
  project,
  onUpdate,
  onFieldUpdate,
  getFieldSaveState,
  onArchive,
  archivePending,
}: ProjectPropertiesProps) {
  const {
    availableGoals,
    availableSecrets,
    codebaseEditor,
    codebaseQuery,
    codebaseValidationError,
    commitField,
    createSecret,
    fieldState,
    linkedGoalIds,
    linkedGoals,
    localFolderDraft,
    removeGoal,
    repoUrlDraft,
    resetCodebaseEditor,
    setCodebaseEditor,
    setCodebaseValidationError,
    setLocalFolderDraft,
    setRepoUrlDraft,
    submitLocalFolder,
    submitRepoUrl,
    updateCodebase,
    userSecretDefinitions,
    clearLocalFolder,
    clearRepoUrl,
  } = useProjectPropertiesFields({
    project,
    onUpdate,
    onFieldUpdate,
    getFieldSaveState,
  });

  return (
    <div>
      <FieldGroup className="pb-4">
        <Field orientation="horizontal">
          <FieldLabel>
            Name
            {fieldState("name") !== "idle" ? (
              <DomainStatus status={fieldState("name")} role="status">
                {fieldState("name")}
              </DomainStatus>
            ) : null}
          </FieldLabel>
          <FieldContent>
            {onUpdate || onFieldUpdate ? (
              <DraftInput
                value={project.name}
                onCommit={(name) => commitField("name", { name })}
                immediate
                className="w-full rounded border border-border bg-transparent px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Project name"
              />
            ) : (
              <span className="text-sm">{project.name}</span>
            )}
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <FieldLabel>
            Description
            {fieldState("description") !== "idle" ? (
              <DomainStatus status={fieldState("description")} role="status">
                {fieldState("description")}
              </DomainStatus>
            ) : null}
          </FieldLabel>
          <FieldContent>
            {onUpdate || onFieldUpdate ? (
              <InlineEditor
                value={project.description ?? ""}
                onSave={(description) => commitField("description", { description })}
                nullable
                as="p"
                className="text-sm text-muted-foreground"
                placeholder="Add a description..."
                multiline
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {project.description?.trim() || "No description"}
              </p>
            )}
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <FieldLabel>
            Status
            {fieldState("status") !== "idle" ? (
              <DomainStatus status={fieldState("status")} role="status">
                {fieldState("status")}
              </DomainStatus>
            ) : null}
          </FieldLabel>
          <FieldContent>
            {onUpdate || onFieldUpdate ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    {project.status.replace(/[_-]/g, " ")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup
                    value={project.status}
                    onValueChange={(status) => commitField("status", { status })}
                  >
                    {projectStatuses.map((status) => (
                      <DropdownMenuRadioItem key={status} value={status}>
                        {status.replace(/_/g, " ")}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <DomainStatus status={project.status} />
            )}
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <FieldLabel>
            Goals
            {fieldState("goals") !== "idle" ? (
              <DomainStatus status={fieldState("goals")} role="status">
                {fieldState("goals")}
              </DomainStatus>
            ) : null}
          </FieldLabel>
          <FieldContent>
            {linkedGoals.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {linkedGoals.map((goal) => (
                  <Badge key={goal.id} variant="outline" className="rounded-md py-1 font-normal">
                    <Link
                      to="/$companyId/goals/$goalId"
                      params={{ companyId: project.companyId, goalId: goal.id }}
                      className="hover:underline break-words min-w-0"
                    >
                      {goal.title}
                    </Link>
                    {(onUpdate || onFieldUpdate) && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        type="button"
                        onClick={() => removeGoal(goal.id)}
                        aria-label={`Remove goal ${goal.title}`}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </Badge>
                ))}
              </div>
            )}
            {(onUpdate || onFieldUpdate) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="xs"
                    className={cn("h-6 w-fit px-2", linkedGoals.length > 0 && "ml-1")}
                    disabled={availableGoals.length === 0}
                  >
                    <Plus data-icon="inline-start" className="h-3 w-3 mr-1" />
                    Goal
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" align="start">
                  {availableGoals.length === 0 ? (
                    <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                      All goals linked.
                    </DropdownMenuItem>
                  ) : (
                    availableGoals.map((goal) => (
                      <DropdownMenuItem
                        key={goal.id}
                        className="text-xs"
                        onClick={() => {
                          if (linkedGoalIds.includes(goal.id)) return;
                          commitField("goals", {
                            goalIds: [...linkedGoalIds, goal.id],
                          });
                        }}
                      >
                        {goal.title}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </FieldContent>
        </Field>
        {project.leadAgentId && (
          <Field orientation="horizontal">
            <FieldLabel>Lead</FieldLabel>
            <FieldContent>
              <span className="text-sm font-mono">{project.leadAgentId.slice(0, 8)}</span>
            </FieldContent>
          </Field>
        )}
        <Field orientation="horizontal">
          <FieldLabel>
            Env
            {fieldState("env") !== "idle" ? (
              <DomainStatus status={fieldState("env")} role="status">
                {fieldState("env")}
              </DomainStatus>
            ) : null}
          </FieldLabel>
          <FieldContent>
            <div className="space-y-2">
              <EnvironmentVariablesEditor
                value={project.env ?? {}}
                secrets={availableSecrets}
                userSecretDefinitions={userSecretDefinitions}
                onCreateSecret={async (name, value) => {
                  const created = await createSecret.mutateAsync({
                    name,
                    value,
                  });
                  return created;
                }}
                onChange={(env) => commitField("env", { env: env ?? null })}
              />
              <p className="text-(length:--text-micro) text-muted-foreground">
                Applied to all runs for tasks in this project. Project values override agent env on key
                conflicts.
              </p>
            </div>
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <FieldLabel>Created</FieldLabel>
          <FieldContent>
            <span className="text-sm">{formatDate(project.createdAt)}</span>
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <FieldLabel>Updated</FieldLabel>
          <FieldContent>
            <span className="text-sm">{formatDate(project.updatedAt)}</span>
          </FieldContent>
        </Field>
        {project.targetDate && (
          <Field orientation="horizontal">
            <FieldLabel>Target date</FieldLabel>
            <FieldContent>
              <span className="text-sm">{formatDate(project.targetDate)}</span>
            </FieldContent>
          </Field>
        )}
      </FieldGroup>

      <Separator className="my-4" />

      <ProjectCodebaseSection
        codebase={codebaseQuery.data}
        loading={codebaseQuery.isLoading}
        loadError={codebaseQuery.isError}
        mutationError={updateCodebase.isError}
        pending={updateCodebase.isPending}
        editor={codebaseEditor}
        localFolderDraft={localFolderDraft}
        repoUrlDraft={repoUrlDraft}
        validationError={codebaseValidationError}
        onEditLocal={() => {
          setCodebaseEditor("local");
          setLocalFolderDraft(codebaseQuery.data?.localFolder ?? "");
          setCodebaseValidationError(null);
        }}
        onEditRepo={() => {
          setCodebaseEditor("repo");
          setRepoUrlDraft(codebaseQuery.data?.repoUrl ?? "");
          setCodebaseValidationError(null);
        }}
        onLocalFolderDraftChange={(value) => {
          setLocalFolderDraft(value);
          setCodebaseValidationError(null);
        }}
        onRepoUrlDraftChange={(value) => {
          setRepoUrlDraft(value);
          setCodebaseValidationError(null);
        }}
        onSubmitLocalFolder={submitLocalFolder}
        onSubmitRepoUrl={submitRepoUrl}
        onClearLocalFolder={clearLocalFolder}
        onClearRepoUrl={clearRepoUrl}
        onCancel={resetCodebaseEditor}
      />

      {onArchive && (
        <>
          <Separator className="my-4" />
          <div className="space-y-4 py-4">
            <div className="text-xs font-medium text-destructive uppercase tracking-wide">Danger Zone</div>
            <Card>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {project.archivedAt
                    ? "Unarchive this project to restore it in the sidebar and project selectors."
                    : "Archive this project to hide it from the sidebar and project selectors."}
                </p>
                <ConfirmActionDialog
                  title={`${project.archivedAt ? "Unarchive" : "Archive"} “${project.name}”?`}
                  description={
                    project.archivedAt
                      ? "Restore this project in the sidebar and project selectors."
                      : "Hide this project from the sidebar and project selectors."
                  }
                  confirmLabel={`${project.archivedAt ? "Unarchive" : "Archive"} project`}
                  pending={archivePending}
                  variant="destructive"
                  onConfirm={() => onArchive(!project.archivedAt)}
                  triggerAsChild
                  trigger={
                    <Button size="sm" variant="destructive" disabled={archivePending}>
                      {archivePending ? <Spinner /> : project.archivedAt ? <ArchiveRestore /> : <Archive />}
                      {project.archivedAt ? "Unarchive project" : "Archive project"}
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
