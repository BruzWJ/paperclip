import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { GoalLevel, GoalStatus } from "@paperclipai/shared";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { goalsApi } from "../api/goals";
import { assetsApi } from "../api/assets";
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
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Layers, Maximize2, Minimize2, Target } from "lucide-react";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";

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

  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

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

  const currentParent = (goals ?? []).find((g) => g.id === appliedParentId);

  return (
    <Dialog
      open={newGoalOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewGoal();
        }
      }}
    >
      <DialogContent
        className={cn("gap-0 p-0", expanded ? "sm:max-w-2xl" : "sm:max-w-lg")}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="border-b p-4 pr-20">
          <DialogTitle>{newGoalDefaults.parentId ? "New sub-goal" : "New goal"}</DialogTitle>
          <DialogDescription>
            {selectedCompany ? `Create a goal for ${selectedCompany.name}.` : "Create a company goal."}
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

        {/* Title */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <Input
            className="h-auto border-0 px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
            placeholder="Goal title"
            aria-label="Goal title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
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
        <div className="px-4 pb-2 overflow-y-auto max-h-(--sz-50vh)">
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder="Add description..."
            bordered={false}
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="xs" aria-label="Set parent goal">
                <Target className="h-3 w-3 text-muted-foreground" />
                {currentParent ? currentParent.title : "Parent goal"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
              <DropdownMenuRadioGroup value={appliedParentId} onValueChange={setParentId}>
                <DropdownMenuRadioItem value="">No parent</DropdownMenuRadioItem>
                {(goals ?? []).map((goal) => (
                  <DropdownMenuRadioItem key={goal.id} value={goal.id}>
                    <span className="truncate">{goal.title}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <DialogFooter className="items-center border-t p-4 sm:justify-between">
          {createGoal.isError ? <FieldError>Couldn&apos;t create goal. Try again.</FieldError> : <span />}
          <Button size="sm" disabled={!title.trim() || createGoal.isPending} onClick={handleSubmit}>
            {createGoal.isPending ? <Spinner /> : null}
            {newGoalDefaults.parentId ? "Create sub-goal" : "Create goal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
