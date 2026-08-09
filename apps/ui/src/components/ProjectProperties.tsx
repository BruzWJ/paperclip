import { useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { StatusBadge } from "./StatusBadge";
import { cn, formatDate } from "../lib/utils";
import { goalsApi } from "../api/goals";
import { secretsApi } from "../api/secrets";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AlertCircle, Archive, ArchiveRestore, Check, Loader2, Plus, X } from "lucide-react";
import { DraftInput } from "./agent-config-primitives";
import { InlineEditor } from "./InlineEditor";
import { EnvironmentVariablesEditor } from "./environment-variables-editor";

const PROJECT_STATUSES = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

interface ProjectPropertiesProps {
  project: Project;
  onUpdate?: (data: Record<string, unknown>) => void;
  onFieldUpdate?: (field: ProjectConfigFieldKey, data: Record<string, unknown>) => void;
  getFieldSaveState?: (field: ProjectConfigFieldKey) => ProjectFieldSaveState;
  onArchive?: (archived: boolean) => void;
  archivePending?: boolean;
}

export type ProjectFieldSaveState = "idle" | "saving" | "saved" | "error";
export type ProjectConfigFieldKey =
  | "name"
  | "description"
  | "status"
  | "goals"
  | "env";

function SaveIndicator({ state }: { state: ProjectFieldSaveState }) {
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-green-600 dark:text-green-400">
        <Check className="h-3 w-3" />
        Saved
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-destructive">
        <AlertCircle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  return null;
}

function FieldLabel({
  label,
  state,
}: {
  label: string;
  state: ProjectFieldSaveState;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <SaveIndicator state={state} />
    </div>
  );
}

function PropertyRow({
  label,
  children,
  alignStart = false,
  valueClassName = "",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  alignStart?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className={cn("flex gap-3 py-1.5 items-start")}>
      <div className="shrink-0 w-20 mt-0.5">{label}</div>
      <div className={cn("min-w-0 flex-1", alignStart ? "pt-0.5" : "flex items-center gap-1.5 flex-wrap", valueClassName)}>
        {children}
      </div>
    </div>
  );
}

function ProjectStatusPicker({ status, onChange }: { status: string; onChange: (status: string) => void }) {
  const colorClass = statusBadge[status] ?? statusBadgeDefault;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer hover:opacity-80 transition-opacity",
            colorClass,
          )}
        >
          {status.replace("_", " ")}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={status} onValueChange={onChange}>
          {PROJECT_STATUSES.map((s) => (
            <DropdownMenuRadioItem key={s.value} value={s.value} className="text-xs">
              {s.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArchiveDangerZone({
  project,
  onArchive,
  archivePending,
}: {
  project: Project;
  onArchive: (archived: boolean) => void;
  archivePending?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const isArchive = !project.archivedAt;
  const action = isArchive ? "Archive" : "Unarchive";

  return (
    <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
      <p className="text-sm text-muted-foreground">
        {isArchive
          ? "Archive this project to hide it from the sidebar and project selectors."
          : "Unarchive this project to restore it in the sidebar and project selectors."}
      </p>
      {archivePending ? (
        <Button size="sm" variant="destructive" disabled>
          <Loader2 className="h-3 w-3 animate-spin mr-1" />
          {isArchive ? "Archiving..." : "Unarchiving..."}
        </Button>
      ) : confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-destructive font-medium">
            {action} &ldquo;{project.name}&rdquo;?
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setConfirming(false);
              onArchive(isArchive);
            }}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => setConfirming(true)}
        >
          {isArchive ? (
            <><Archive className="h-3 w-3 mr-1" />{action} project</>
          ) : (
            <><ArchiveRestore className="h-3 w-3 mr-1" />{action} project</>
          )}
        </Button>
      )}
    </div>
  );
}

export function ProjectProperties({ project, onUpdate, onFieldUpdate, getFieldSaveState, onArchive, archivePending }: ProjectPropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const commitField = (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
    if (onFieldUpdate) {
      onFieldUpdate(field, data);
      return;
    }
    onUpdate?.(data);
  };
  const fieldState = (field: ProjectConfigFieldKey): ProjectFieldSaveState => getFieldSaveState?.(field) ?? "idle";

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: availableSecrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const { data: userSecretDefinitions = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.userDefinitions(selectedCompanyId)
      : ["user-secret-definitions", "none"],
    queryFn: () => secretsApi.listUserSecretDefinitions(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });
  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!selectedCompanyId) throw new Error("Select a company to create secrets");
      return secretsApi.create(selectedCompanyId, input);
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    },
  });

  const linkedGoalIds = project.goalIds.length > 0
    ? project.goalIds
    : project.goalId
      ? [project.goalId]
      : [];

  const linkedGoals = project.goals.length > 0
    ? project.goals
    : linkedGoalIds.map((id) => ({
        id,
        title: allGoals?.find((g) => g.id === id)?.title ?? id.slice(0, 8),
      }));

  const availableGoals = (allGoals ?? []).filter((g) => !linkedGoalIds.includes(g.id));

  const removeGoal = (goalId: string) => {
    if (!onUpdate && !onFieldUpdate) return;
    commitField("goals", { goalIds: linkedGoalIds.filter((id) => id !== goalId) });
  };

  return (
    <div>
      <div className="space-y-1 pb-4">
        <PropertyRow label={<FieldLabel label="Name" state={fieldState("name")} />}>
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
        </PropertyRow>
        <PropertyRow
          label={<FieldLabel label="Description" state={fieldState("description")} />}
          alignStart
          valueClassName="space-y-0.5"
        >
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
        </PropertyRow>
        <PropertyRow label={<FieldLabel label="Status" state={fieldState("status")} />}>
          {onUpdate || onFieldUpdate ? (
            <ProjectStatusPicker
              status={project.status}
              onChange={(status) => commitField("status", { status })}
            />
          ) : (
            <StatusBadge status={project.status} />
          )}
        </PropertyRow>
        <PropertyRow
          label={<FieldLabel label="Goals" state={fieldState("goals")} />}
          alignStart
          valueClassName="space-y-2"
        >
          {linkedGoals.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {linkedGoals.map((goal) => (
                <span
                  key={goal.id}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
                >
                  <Link to={`/goals/${goal.id}`} className="hover:underline break-words min-w-0">
                    {goal.title}
                  </Link>
                  {(onUpdate || onFieldUpdate) && (
                    <button
                      className="text-muted-foreground hover:text-foreground"
                      type="button"
                      onClick={() => removeGoal(goal.id)}
                      aria-label={`Remove goal ${goal.title}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
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
                        commitField("goals", { goalIds: [...linkedGoalIds, goal.id] });
                      }}
                    >
                      {goal.title}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </PropertyRow>
        {project.leadAgentId && (
          <PropertyRow label="Lead">
            <span className="text-sm font-mono">{project.leadAgentId.slice(0, 8)}</span>
          </PropertyRow>
        )}
        <PropertyRow
          label={<FieldLabel label="Env" state={fieldState("env")} />}
          alignStart
          valueClassName="space-y-2"
        >
          <div className="space-y-2">
            <EnvironmentVariablesEditor
              value={project.env ?? {}}
              secrets={availableSecrets}
              userSecretDefinitions={userSecretDefinitions}
              onCreateSecret={async (name, value) => {
                const created = await createSecret.mutateAsync({ name, value });
                return created;
              }}
              onChange={(env) => commitField("env", { env: env ?? null })}
            />
            <p className="text-(length:--text-micro) text-muted-foreground">
              Applied to all runs for tasks in this project. Project values override agent env on key conflicts.
            </p>
          </div>
        </PropertyRow>
        <PropertyRow label={<FieldLabel label="Created" state="idle" />}>
          <span className="text-sm">{formatDate(project.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label={<FieldLabel label="Updated" state="idle" />}>
          <span className="text-sm">{formatDate(project.updatedAt)}</span>
        </PropertyRow>
        {project.targetDate && (
          <PropertyRow label={<FieldLabel label="Target Date" state="idle" />}>
            <span className="text-sm">{formatDate(project.targetDate)}</span>
          </PropertyRow>
        )}
      </div>

      {onArchive && (
        <>
          <Separator className="my-4" />
          <div className="space-y-4 py-4">
            <div className="text-xs font-medium text-destructive uppercase tracking-wide">
              Danger Zone
            </div>
            <ArchiveDangerZone
              project={project}
              onArchive={onArchive}
              archivePending={archivePending}
            />
          </div>
        </>
      )}
    </div>
  );
}
