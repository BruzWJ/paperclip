import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProjectCodebase } from "@paperclipai/shared";
import { isCanonicalProjectRepositoryUrl } from "@paperclipai/shared";
import { ExternalLink, Github, Trash2 } from "lucide-react";
import { formatProjectRepositoryUrl } from "../lib/project-codebase";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { ChoosePathButton } from "./PathInstructionsModal";

export interface ProjectCodebaseSectionProps {
  codebase: ProjectCodebase | undefined;
  loading: boolean;
  loadError: boolean;
  mutationError: boolean;
  pending: boolean;
  editor: "local" | "repo" | null;
  localFolderDraft: string;
  repoUrlDraft: string;
  validationError: string | null;
  onEditLocal: () => void;
  onEditRepo: () => void;
  onLocalFolderDraftChange: (value: string) => void;
  onRepoUrlDraftChange: (value: string) => void;
  onSubmitLocalFolder: () => void;
  onSubmitRepoUrl: () => void;
  onClearLocalFolder: () => void;
  onClearRepoUrl: () => void;
  onCancel: () => void;
}

export function ProjectCodebaseSection({
  codebase,
  loading,
  loadError,
  mutationError,
  pending,
  editor,
  localFolderDraft,
  repoUrlDraft,
  validationError,
  onEditLocal,
  onEditRepo,
  onLocalFolderDraftChange,
  onRepoUrlDraftChange,
  onSubmitLocalFolder,
  onSubmitRepoUrl,
  onClearLocalFolder,
  onClearRepoUrl,
  onCancel,
}: ProjectCodebaseSectionProps) {
  return (
    <div className="space-y-2 py-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>Codebase</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className="rounded-full text-(length:--text-nano) text-muted-foreground hover:text-foreground"
              aria-label="Codebase help"
            >
              ?
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            The local folder is the working directory for agents on this project. The repo URL records source
            provenance.
          </TooltipContent>
        </Tooltip>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Spinner /> Loading codebase…
        </div>
      ) : loadError || !codebase ? (
        <Alert variant="destructive">
          <AlertDescription>Failed to load project codebase.</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
                Repo
              </div>
              <div className="flex items-center justify-between gap-2">
                {codebase.repoUrl ? (
                  isCanonicalProjectRepositoryUrl(codebase.repoUrl) ? (
                    <a
                      href={codebase.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      <Github className="h-3 w-3 shrink-0" />
                      <span className="min-w-0 break-all">
                        {formatProjectRepositoryUrl(codebase.repoUrl)}
                      </span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    <span className="min-w-0 break-all text-xs text-muted-foreground">
                      {codebase.repoUrl}
                    </span>
                  )
                ) : (
                  <span className="text-xs text-muted-foreground">Not set.</span>
                )}
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 px-2"
                    disabled={pending}
                    onClick={onEditRepo}
                  >
                    {codebase.repoUrl ? "Change repo" : "Set repo"}
                  </Button>
                  {codebase.repoUrl ? (
                    <ConfirmActionDialog
                      triggerAsChild
                      trigger={
                        <Button variant="ghost" size="icon-xs" disabled={pending} aria-label="Clear repo">
                          <Trash2 />
                        </Button>
                      }
                      title="Clear repository URL?"
                      description="This removes the source repository URL from the project."
                      confirmLabel="Clear repository"
                      variant="destructive"
                      onConfirm={onClearRepoUrl}
                    />
                  ) : null}
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
                Local folder
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  {codebase.localFolder ? (
                    <div className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                      {codebase.localFolder}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      Not set. Runs use an instance-managed task folder.
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 px-2"
                    disabled={pending}
                    onClick={onEditLocal}
                  >
                    {codebase.localFolder ? "Change local folder" : "Set local folder"}
                  </Button>
                  {codebase.localFolder ? (
                    <ConfirmActionDialog
                      triggerAsChild
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={pending}
                          aria-label="Clear local folder"
                        >
                          <Trash2 />
                        </Button>
                      }
                      title="Clear local execution folder?"
                      description="Runs will return to an instance-managed task folder."
                      confirmLabel="Clear local folder"
                      variant="destructive"
                      onConfirm={onClearLocalFolder}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {editor === "local" ? (
        <Card className="gap-2 p-2">
          <InputGroup className="h-7">
            <InputGroupInput
              aria-label="Local project folder"
              className="px-2 font-mono text-xs"
              value={localFolderDraft}
              onChange={(event) => onLocalFolderDraftChange(event.target.value)}
              placeholder="/absolute/path/to/project"
            />
            <InputGroupAddon align="inline-end">
              <ChoosePathButton />
            </InputGroupAddon>
          </InputGroup>
          <CardFooter className="gap-2 px-0">
            <Button
              variant="outline"
              size="xs"
              className="h-6 px-2"
              disabled={pending}
              onClick={onSubmitLocalFolder}
            >
              Save
            </Button>
            <Button variant="ghost" size="xs" className="h-6 px-2" onClick={onCancel}>
              Cancel
            </Button>
          </CardFooter>
        </Card>
      ) : null}

      {editor === "repo" ? (
        <Card className="gap-2 p-2">
          <InputGroup className="h-7">
            <InputGroupInput
              aria-label="Project repository URL"
              className="px-2 text-xs"
              value={repoUrlDraft}
              onChange={(event) => onRepoUrlDraftChange(event.target.value)}
              placeholder="https://github.com/org/repo"
            />
          </InputGroup>
          <CardFooter className="gap-2 px-0">
            <Button
              variant="outline"
              size="xs"
              className="h-6 px-2"
              disabled={pending}
              onClick={onSubmitRepoUrl}
            >
              Save
            </Button>
            <Button variant="ghost" size="xs" className="h-6 px-2" onClick={onCancel}>
              Cancel
            </Button>
          </CardFooter>
        </Card>
      ) : null}

      {pending ? (
        <p className="text-xs text-muted-foreground" role="status">
          Saving codebase…
        </p>
      ) : null}
      <FieldError className="text-xs">{validationError}</FieldError>
      <FieldError className="text-xs">{mutationError ? "Failed to save project codebase." : null}</FieldError>
    </div>
  );
}
