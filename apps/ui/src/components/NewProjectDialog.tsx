import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { isAbsoluteProjectFolder, isCanonicalProjectRepositoryUrl } from "@paperclipai/shared";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { accessApi } from "../api/access";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { assetsApi } from "../api/assets";
import { buildMarkdownMentionOptions } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Target, HelpCircle, Maximize2, Minimize2, Plus, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { ChoosePathButton } from "./PathInstructionsModal";

const projectStatuses = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

export function NewProjectDialog() {
  const { newProjectOpen, closeNewProject } = useDialog();
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("planned");
  const [goalIds, setGoalIds] = useState<string[]>([]);
  const [targetDate, setTargetDate] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [localFolder, setLocalFolder] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [codebaseError, setCodebaseError] = useState<string | null>(null);

  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
    enabled: newProjectOpen,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: newProjectOpen,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: newProjectOpen,
  });

  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      members: companyMembers?.users,
    });
  }, [agents, companyMembers?.users]);

  const createProject = useMutation({
    mutationFn: (data: Record<string, unknown>) => projectsApi.create(companyId, data),
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      return assetsApi.uploadImage(companyId, file, "projects/drafts");
    },
  });

  function reset() {
    setName("");
    setDescription("");
    setStatus("planned");
    setGoalIds([]);
    setTargetDate("");
    setExpanded(false);
    setLocalFolder("");
    setRepoUrl("");
    setCodebaseError(null);
  }

  async function handleSubmit() {
    if (!name.trim()) return;
    const exactLocalFolder = localFolder;
    const exactRepoUrl = repoUrl;

    if (exactLocalFolder && !isAbsoluteProjectFolder(exactLocalFolder)) {
      setCodebaseError("Local folder must be a full absolute path.");
      return;
    }
    if (exactRepoUrl && !isCanonicalProjectRepositoryUrl(exactRepoUrl)) {
      setCodebaseError("Repo must use its exact canonical HTTPS URL.");
      return;
    }
    setCodebaseError(null);

    try {
      const created = await createProject.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        status,
        // No color is sent — new projects persist color = null (neutral gray). See PAP-68.
        ...(goalIds.length > 0 ? { goalIds } : {}),
        ...(targetDate ? { targetDate } : {}),
        ...(exactLocalFolder || exactRepoUrl
          ? {
              codebase: {
                ...(exactLocalFolder ? { localFolder: exactLocalFolder } : {}),
                ...(exactRepoUrl ? { repoUrl: exactRepoUrl } : {}),
              },
            }
          : {}),
      });

      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.list(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(created.id),
      });
      reset();
      closeNewProject();
    } catch {
      // surface through createProject.isError
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const selectedGoals = (goals ?? []).filter((g) => goalIds.includes(g.id));
  const availableGoals = (goals ?? []).filter((g) => !goalIds.includes(g.id));

  return (
    <Dialog
      open={newProjectOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewProject();
        }
      }}
    >
      <DialogContent
        className={cn("gap-0 p-0", expanded ? "sm:max-w-2xl" : "sm:max-w-lg")}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="border-b p-4 pr-20">
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            {selectedCompany ? `Create a project for ${selectedCompany.name}.` : "Create a company project."}
          </DialogDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={expanded ? "Restore dialog size" : "Expand dialog"}
            onClick={() => setExpanded(!expanded)}
            className="absolute right-12 top-3"
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </DialogHeader>

        {/* Name */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <Input
            className="h-auto border-0 bg-transparent px-0 py-0 text-lg font-semibold shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0"
            placeholder="Project name"
            aria-label="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                descriptionEditorRef.current?.focus();
              }
            }}
            autoFocus
          />
        </div>

        {/* Description */}
        <div className="px-4 pb-2">
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder="Add description..."
            bordered={false}
            mentions={mentionOptions}
            contentClassName={cn(
              "text-sm text-muted-foreground",
              expanded ? "min-h-(--sz-220px)" : "min-h-(--sz-120px)",
            )}
            imageUploadHandler={async (file) => {
              const asset = await uploadDescriptionImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
        </div>

        <div className="space-y-3 border-t border-border px-4 pb-3 pt-3">
          <Field className="gap-1">
            <div className="mb-1 flex items-center gap-1.5">
              <FieldLabel
                htmlFor="new-project-repo-url"
                className="text-xs font-normal text-muted-foreground"
              >
                Repo URL
              </FieldLabel>
              <span className="text-xs text-muted-foreground/50">optional</span>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3 w-3 cursor-help text-muted-foreground/50" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-(--sz-240px) text-xs">
                  Record the HTTPS repository that owns this project&apos;s source code.
                </TooltipContent>
              </Tooltip>
            </div>
            <Input
              id="new-project-repo-url"
              className="h-7 px-2 text-xs"
              value={repoUrl}
              onChange={(event) => {
                setRepoUrl(event.target.value);
                setCodebaseError(null);
              }}
              placeholder="https://github.com/org/repo"
            />
          </Field>

          <Field className="gap-1">
            <div className="mb-1 flex items-center gap-1.5">
              <FieldLabel
                htmlFor="new-project-local-folder"
                className="text-xs font-normal text-muted-foreground"
              >
                Local folder
              </FieldLabel>
              <span className="text-xs text-muted-foreground/50">optional</span>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3 w-3 cursor-help text-muted-foreground/50" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-(--sz-240px) text-xs">
                  Set the absolute directory where agents assigned to this project run and write files.
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center gap-2">
              <Input
                id="new-project-local-folder"
                className="h-7 px-2 font-mono text-xs"
                value={localFolder}
                onChange={(event) => {
                  setLocalFolder(event.target.value);
                  setCodebaseError(null);
                }}
                placeholder="/absolute/path/to/project"
              />
              <ChoosePathButton />
            </div>
          </Field>

          {codebaseError ? <FieldError>{codebaseError}</FieldError> : null}
        </div>

        {/* Property chips */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
          {/* Status */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-auto gap-1.5 px-2 py-1 text-xs"
                aria-label="Set project status"
              >
                {projectStatuses.find((option) => option.value === status)?.label ?? status}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup value={status} onValueChange={setStatus}>
                {projectStatuses.map((s) => (
                  <DropdownMenuRadioItem key={s.value} value={s.value} className="text-xs">
                    {s.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {selectedGoals.map((goal) => (
            <Badge key={goal.id} variant="secondary" className="gap-1">
              <Target className="h-3 w-3 text-muted-foreground" />
              <span className="max-w-(--sz-160px) truncate">{goal.title}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-3 text-muted-foreground hover:text-foreground"
                onClick={() => setGoalIds((prev) => prev.filter((id) => id !== goal.id))}
                aria-label={`Remove goal ${goal.title}`}
                type="button"
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-auto gap-1.5 px-2 py-1 text-xs"
                disabled={selectedGoals.length > 0 && availableGoals.length === 0}
              >
                {selectedGoals.length > 0 ? (
                  <Plus className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <Target className="h-3 w-3 text-muted-foreground" />
                )}
                {selectedGoals.length > 0 ? "+ Goal" : "Goal"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56" align="start">
              {selectedGoals.length === 0 && (
                <DropdownMenuItem className="text-xs text-muted-foreground" disabled>
                  No goal
                </DropdownMenuItem>
              )}
              {availableGoals.map((g) => (
                <DropdownMenuItem
                  key={g.id}
                  className="text-xs"
                  onClick={() => setGoalIds((prev) => [...prev, g.id])}
                >
                  {g.title}
                </DropdownMenuItem>
              ))}
              {selectedGoals.length > 0 && availableGoals.length === 0 && (
                <DropdownMenuItem className="text-xs text-muted-foreground" disabled>
                  All goals already selected.
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Target date */}
          <Input
            type="date"
            value={targetDate}
            onChange={(event) => setTargetDate(event.target.value)}
            aria-label="Target date"
            className="h-7 w-auto px-2 text-xs"
          />
        </div>

        <DialogFooter className="items-center border-t p-4 sm:justify-between">
          {createProject.isError ? <FieldError>Failed to create project.</FieldError> : <span />}
          <Button size="sm" disabled={!name.trim() || createProject.isPending} onClick={handleSubmit}>
            {createProject.isPending ? <Spinner /> : null}
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
