import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { GoalLevel, GoalStatus } from "@paperclipai/shared";
import { useDialog } from "@/context/DialogContext";
import { useCompany } from "@/context/CompanyContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { goalsApi } from "@/api/goals";
import { assetsApi } from "@/api/assets";
import { queryKeys } from "@/lib/queryKeys";
import { FormDialog } from "@/components/patterns/FormPatterns";
import { EntityCreationFields } from "@/features/entity-creation/EntityCreationFields";
import { EntityCombobox } from "@/components/patterns/EntityCombobox";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Layers, Target } from "lucide-react";
import type { EntityOption } from "@/lib/entity-selector";

const GOAL_STATUSES = ["planned", "active", "achieved", "cancelled"] as const satisfies readonly GoalStatus[];
const GOAL_LEVELS = ["company", "team", "agent", "task"] as const satisfies readonly GoalLevel[];

const levelLabels: Record<string, string> = {
  company: "Company",
  team: "Team",
  agent: "Agent",
  task: "Task",
};

export function NewGoalDialog() {
  const { newGoalOpen, newGoalDefaults, closeNewGoal } = useDialog();
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("planned");
  const [level, setLevel] = useState("task");
  const [parentId, setParentId] = useState("");
  const [expanded, setExpanded] = useState(false);

  // Apply defaults when dialog opens
  const appliedParentId = parentId || newGoalDefaults.parentId || "";

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
    enabled: newGoalOpen,
  });

  const createGoal = useMutation({
    mutationFn: (data: Record<string, unknown>) => goalsApi.create(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.list(companyId),
      });
      reset();
      closeNewGoal();
    },
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      return assetsApi.uploadImage(companyId, file, "goals/drafts");
    },
  });

  function reset() {
    setTitle("");
    setDescription("");
    setStatus("planned");
    setLevel("task");
    setParentId("");
    setExpanded(false);
  }

  function handleSubmit() {
    if (!title.trim()) return;
    createGoal.mutate({
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      level,
      ...(appliedParentId ? { parentId: appliedParentId } : {}),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const parentOptions: EntityOption[] = (goals ?? []).map((goal) => ({
    id: goal.id,
    label: goal.title,
    searchText: goal.description ?? "",
  }));

  return (
    <FormDialog
      open={newGoalOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewGoal();
        }
      }}
      expanded={expanded}
      onExpandedChange={setExpanded}
      contentProps={{ onKeyDown: handleKeyDown }}
      title={newGoalDefaults.parentId ? "New sub-goal" : "New goal"}
      description={selectedCompany ? `Create a goal for ${selectedCompany.name}.` : "Create a company goal."}
      footer={
        <>
          {createGoal.isError ? <FieldError>Couldn&apos;t create goal. Try again.</FieldError> : <span />}
          <Button size="sm" disabled={!title.trim() || createGoal.isPending} onClick={handleSubmit}>
            {createGoal.isPending ? <Spinner /> : null}
            {newGoalDefaults.parentId ? "Create sub-goal" : "Create goal"}
          </Button>
        </>
      }
    >
      <EntityCreationFields
        description={description}
        expanded={expanded}
        onDescriptionChange={setDescription}
        onTitleChange={setTitle}
        onUploadImage={async (file) => (await uploadDescriptionImage.mutateAsync(file)).contentPath}
        title={title}
        titleLabel="Goal title"
        titlePlaceholder="Goal title"
      />

      {/* Property chips */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
        {/* Status */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="xs" aria-label="Set goal status">
              {status.replaceAll("_", " ")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={status} onValueChange={setStatus}>
              {GOAL_STATUSES.map((option) => (
                <DropdownMenuRadioItem key={option} value={option}>
                  {option.replaceAll("_", " ")}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Level */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="xs" aria-label="Set goal level">
              <Layers className="h-3 w-3 text-muted-foreground" />
              {levelLabels[level] ?? level}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={level} onValueChange={setLevel}>
              {GOAL_LEVELS.map((option) => (
                <DropdownMenuRadioItem key={option} value={option}>
                  {levelLabels[option] ?? option}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Parent goal */}
        <EntityCombobox
          value={appliedParentId}
          options={parentOptions}
          type="parent goal"
          ariaLabel="Set parent goal"
          placeholder="Parent goal"
          noneLabel="No parent"
          openOnFocus={false}
          onValueChange={setParentId}
          searchPlaceholder="Search goals..."
          emptyMessage="No goals found."
          triggerClassName="w-auto max-w-56"
          triggerProps={{ size: "xs" }}
          contentClassName="!w-72"
          renderValue={(option) => (
            <>
              <Target className="h-3 w-3 text-muted-foreground" />
              <span className="truncate">{option?.label ?? "Parent goal"}</span>
            </>
          )}
        />
      </div>
    </FormDialog>
  );
}
