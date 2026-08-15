// Empty collections render dedicated UI when data.length === 0.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { isAbsoluteProjectFolder, isCanonicalProjectRepositoryUrl } from "@paperclipai/shared";
import { useDialog } from "@/context/DialogContext";
import { useCompany } from "@/context/CompanyContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { accessApi } from "@/api/access";
import { projectsApi } from "@/api/projects";
import { agentsApi } from "@/api/agents";
import { goalsApi } from "@/api/goals";
import { assetsApi } from "@/api/assets";
import { buildMarkdownMentionOptions } from "@/lib/company-members";
import { queryKeys } from "@/lib/queryKeys";
import { FormDialog, LabeledFormField } from "@/components/patterns/FormPatterns";
import { DatePicker } from "@/components/patterns/DatePicker";
import { EntityCreationFields } from "@/routes/_authenticated/$companyId/-shell/-EntityCreationFields";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/kibo-ui/combobox";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Target, HelpCircle, Plus, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MentionOption } from "../-markdown/-MarkdownEditor";
import { ChoosePathButton } from "../../../../components/patterns/PathInstructionsModal";

const projectStatuses = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

function OptionalCodebaseFieldLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="mb-1 flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
      <span>{label}</span>
      <span className="text-xs text-muted-foreground/50">optional</span>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <HelpCircle className="h-3 w-3 cursor-help text-muted-foreground/50" data-icon="inline-start" />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-(--sz-240px) text-xs">
          {help}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

export function NewProjectDialog() {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
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
    <FormDialog
      open={newProjectOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewProject();
        }
      }}
      expanded={expanded}
      onExpandedChange={setExpanded}
      contentProps={{ onKeyDown: handleKeyDown }}
      title="New project"
      description={
        selectedCompany ? `Create a project for ${selectedCompany.name}.` : "Create a company project."
      }
      footer={
        <>
          {createProject.isError ? <FieldError>Failed to create project.</FieldError> : <span />}
          <Button size="sm" disabled={!name.trim() || createProject.isPending} onClick={handleSubmit}>
            {createProject.isPending ? <Spinner /> : null}
            Create project
          </Button>
        </>
      }
    >
      <EntityCreationFields
        description={description}
        expanded={expanded}
        mentions={mentionOptions}
        onDescriptionChange={setDescription}
        onTitleChange={setName}
        onUploadImage={async (file) => (await uploadDescriptionImage.mutateAsync(file)).contentPath}
        title={name}
        titleLabel="Project name"
        titlePlaceholder="Project name"
      />

      <div className="space-y-3 border-t border-border px-4 pb-3 pt-3">
        <LabeledFormField
          className="gap-1"
          labelFor="new-project-repo-url"
          label={
            <OptionalCodebaseFieldLabel
              label="Repo URL"
              help="Record the HTTPS repository that owns this project's source code."
            />
          }
        >
          <Input
            id="new-project-repo-url"
            aria-label="Repo URL"
            className="h-7 px-2 text-xs"
            value={repoUrl}
            onChange={(event) => {
              setRepoUrl(event.target.value);
              setCodebaseError(null);
            }}
            placeholder="https://github.com/org/repo"
          />
        </LabeledFormField>

        <LabeledFormField
          className="gap-1"
          labelFor="new-project-local-folder"
          label={
            <OptionalCodebaseFieldLabel
              label="Local folder"
              help="Set the absolute directory where agents assigned to this project run and write files."
            />
          }
        >
          <div className="flex items-center gap-2">
            <Input
              id="new-project-local-folder"
              aria-label="Local folder"
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
        </LabeledFormField>

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
            <Target className="h-3 w-3 text-muted-foreground" data-icon="inline-start" />
            <span className="max-w-(--sz-160px) truncate">{goal.title}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-3 text-muted-foreground hover:text-foreground"
              onClick={() => setGoalIds((prev) => prev.filter((id) => id !== goal.id))}
              aria-label={`Remove goal ${goal.title}`}
              type="button"
            >
              <X className="h-3 w-3" data-icon="inline-start" />
            </Button>
          </Badge>
        ))}

        <Combobox
          data={availableGoals.map((goal) => ({ label: goal.title, value: goal.id }))}
          type="goal"
          value=""
        >
          <ComboboxTrigger
            type="button"
            variant="outline"
            size="xs"
            className="h-auto gap-1.5 px-2 py-1 text-xs"
            disabled={selectedGoals.length > 0 && availableGoals.length === 0}
            aria-label="Add goal"
          >
            {selectedGoals.length > 0 ? (
              <Plus className="h-3 w-3 text-muted-foreground" data-icon="inline-start" />
            ) : (
              <Target className="h-3 w-3 text-muted-foreground" data-icon="inline-start" />
            )}
            {selectedGoals.length > 0 ? "+ Goal" : "Goal"}
          </ComboboxTrigger>
          <ComboboxContent className="!w-56" popoverOptions={{ align: "start" }}>
            <ComboboxInput placeholder="Search goals..." />
            <ComboboxList>
              <ComboboxEmpty>
                {selectedGoals.length > 0 ? "All goals already selected." : "No goals found."}
              </ComboboxEmpty>
              {availableGoals.map((g) => (
                <ComboboxItem
                  key={g.id}
                  value={g.id}
                  keywords={[g.title, g.description ?? ""]}
                  className="text-xs"
                  onSelect={() => setGoalIds((prev) => [...prev, g.id])}
                >
                  {g.title}
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>

        {/* Target date */}
        <DatePicker
          value={targetDate}
          onValueChange={setTargetDate}
          ariaLabel="Target date"
          size="xs"
          className="h-7 w-auto px-2 text-xs"
        />
      </div>
    </FormDialog>
  );
}
