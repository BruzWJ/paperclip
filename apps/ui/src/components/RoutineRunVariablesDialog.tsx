import { useEffect, useMemo, useState } from "react";
import { type Agent, type Project, type RoutineVariable } from "@paperclipai/shared";
import { AgentIcon } from "./AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "../lib/recent-projects";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

function buildInitialValues(variables: RoutineVariable[]) {
  return Object.fromEntries(variables.map((variable) => [variable.name, variable.defaultValue ?? ""]));
}

function buildInitialRunSelection(input: {
  defaultAssigneeAgentId?: string | null;
  defaultProjectId?: string | null;
}) {
  return {
    assigneeAgentId: input.defaultAssigneeAgentId ?? "",
    projectId: input.defaultProjectId ?? "",
  };
}

function isMissingRequiredValue(value: unknown) {
  return value == null || (typeof value === "string" && value.trim().length === 0);
}

function shouldUseDateInput(variable: RoutineVariable) {
  return variable.type === "date";
}

export function routineRunNeedsConfiguration(input: { variables: RoutineVariable[] }) {
  return input.variables.length > 0;
}

export interface RoutineRunDialogSubmitData {
  variables?: Record<string, string | number | boolean>;
  assigneeAgentId?: string | null;
  projectId?: string | null;
}

export function RoutineRunVariablesDialog({
  open,
  onOpenChange,
  routineName,
  projects,
  agents,
  defaultProjectId,
  defaultAssigneeAgentId,
  variables,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routineName?: string | null;
  projects: Project[];
  agents: Agent[];
  defaultProjectId?: string | null;
  defaultAssigneeAgentId?: string | null;
  variables: RoutineVariable[];
  isPending: boolean;
  onSubmit: (data: RoutineRunDialogSubmitData) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [selection, setSelection] = useState(() => buildInitialRunSelection({
    defaultAssigneeAgentId,
    defaultProjectId,
  }));
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selection.projectId) ?? null,
    [projects, selection.projectId],
  );
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [open]);
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [open]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency(
        agents.filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: `${agent.name} ${agent.title ?? ""}`,
      })),
    [agents, recentAssigneeIds],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () => projects.map((project) => ({
      id: project.id,
      label: project.name,
      searchText: project.description ?? "",
    })),
    [projects],
  );
  const currentAssignee = selection.assigneeAgentId
    ? agents.find((agent) => agent.id === selection.assigneeAgentId) ?? null
    : null;
  useEffect(() => {
    if (!open) return;
    setValues(buildInitialValues(variables));
    const nextSelection = buildInitialRunSelection({ defaultAssigneeAgentId, defaultProjectId });
    setSelection(nextSelection);
  }, [defaultAssigneeAgentId, defaultProjectId, open, variables]);

  const missingRequired = useMemo(
    () =>
      variables
        .filter((variable) => variable.required)
        .filter((variable) => isMissingRequiredValue(values[variable.name]))
        .map((variable) => variable.label || variable.name),
    [values, variables],
  );

  const canSubmit =
    selection.assigneeAgentId.trim().length > 0 &&
    missingRequired.length === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="flex h-(--sz-calc-18) max-h-(--sz-calc-18) max-w-xl flex-col gap-0 overflow-hidden p-0 sm:h-auto sm:max-h-(--sz-calc-20)">
        <DialogHeader className="shrink-0 border-b border-border/60 px-6 pb-4 pr-12 pt-6">
          {routineName && (
            <p className="text-muted-foreground text-sm">{routineName}</p>
          )}
          <DialogTitle>Run routine</DialogTitle>
          <DialogDescription>
            Choose the agent and optional project for this one run. Routine defaults are prefilled and won&apos;t be changed.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Agent *</Label>
              <InlineEntitySelector
                value={selection.assigneeAgentId}
                options={assigneeOptions}
                recentOptionIds={recentAssigneeIds}
                placeholder="Agent"
                noneLabel="Select an agent"
                searchPlaceholder="Search agents..."
                emptyMessage="No agents found."
                openOnFocus={false}
                onChange={(assigneeAgentId) => {
                  if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
                  setSelection((current) => ({ ...current, assigneeAgentId }));
                }}
                renderTriggerValue={(option) =>
                  option ? (
                    currentAssignee ? (
                      <>
                        <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <span className="truncate">{option.label}</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">Select an agent</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const assignee = agents.find((agent) => agent.id === option.id);
                  return (
                    <>
                      {assignee ? <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Project</Label>
              <InlineEntitySelector
                value={selection.projectId}
                options={projectOptions}
                recentOptionIds={recentProjectIds}
                placeholder="Project"
                noneLabel="No project"
                searchPlaceholder="Search projects..."
                emptyMessage="No projects found."
                openOnFocus={false}
                onChange={(projectId) => {
                  if (projectId) trackRecentProject(projectId);
                  setSelection((current) => ({ ...current, projectId }));
                }}
                renderTriggerValue={(option) =>
                  option && selectedProject ? (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: selectedProject.color ?? "var(--project-none)" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">No project</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const project = projects.find((entry) => entry.id === option.id);
                  return (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: project?.color ?? "var(--project-none)" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
            </div>
          </div>

          {variables.map((variable) => {
            const fieldLabel = variable.label || variable.name;
            const fieldId = `routine-variable-${variable.name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

            return (
              <div key={variable.name} className="space-y-1.5">
                <Label className="text-xs" htmlFor={fieldId}>
                  {fieldLabel}
                  {variable.required ? " *" : ""}
                </Label>
                {variable.type === "textarea" ? (
                  <Textarea
                    id={fieldId}
                    rows={4}
                    value={typeof values[variable.name] === "string" ? values[variable.name] as string : ""}
                    onChange={(event) => setValues((current) => ({ ...current, [variable.name]: event.target.value }))}
                  />
                ) : variable.type === "boolean" ? (
                  <Select
                    value={values[variable.name] === true ? "true" : values[variable.name] === false ? "false" : "__unset__"}
                    onValueChange={(next) => setValues((current) => ({
                      ...current,
                      [variable.name]: next === "__unset__" ? "" : next === "true",
                    }))}
                  >
                    <SelectTrigger id={fieldId} aria-label={fieldLabel}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__unset__">No value</SelectItem>
                      <SelectItem value="true">True</SelectItem>
                      <SelectItem value="false">False</SelectItem>
                    </SelectContent>
                  </Select>
                ) : variable.type === "select" ? (
                  <Select
                    value={typeof values[variable.name] === "string" && values[variable.name] ? values[variable.name] as string : "__unset__"}
                    onValueChange={(next) => setValues((current) => ({
                      ...current,
                      [variable.name]: next === "__unset__" ? "" : next,
                    }))}
                  >
                    <SelectTrigger id={fieldId} aria-label={fieldLabel}>
                      <SelectValue placeholder="Choose a value" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__unset__">No value</SelectItem>
                      {variable.options.map((option) => (
                        <SelectItem key={option} value={option}>{option}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : shouldUseDateInput(variable) ? (
                  <Input
                    id={fieldId}
                    type="date"
                    value={values[variable.name] == null ? "" : String(values[variable.name])}
                    onChange={(event) => setValues((current) => ({ ...current, [variable.name]: event.target.value }))}
                  />
                ) : (
                  <Input
                    id={fieldId}
                    type={variable.type === "number" ? "number" : "text"}
                    value={values[variable.name] == null ? "" : String(values[variable.name])}
                    onChange={(event) => setValues((current) => ({ ...current, [variable.name]: event.target.value }))}
                  />
                )}
              </div>
            );
          })}

        </div>

        <DialogFooter
          showCloseButton={false}
          className="shrink-0 border-t border-border/60 bg-background px-6 pb-(--sz-calc-19) pt-4"
        >
          {isPending ? (
            <p role="status" className="mr-auto text-xs text-muted-foreground">Starting routine run…</p>
          ) : !selection.assigneeAgentId ? (
            <p className="mr-auto text-xs text-amber-600">Default agent required for this run.</p>
          ) : missingRequired.length > 0 ? (
            <p className="mr-auto text-xs text-amber-600">
              Missing: {missingRequired.join(", ")}
            </p>
          ) : (
            <span className="mr-auto" />
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const nextVariables: Record<string, string | number | boolean> = {};
              for (const variable of variables) {
                const rawValue = values[variable.name];
                if (isMissingRequiredValue(rawValue)) continue;
                if (variable.type === "number") {
                  nextVariables[variable.name] = Number(rawValue);
                } else if (variable.type === "boolean") {
                  nextVariables[variable.name] = rawValue === true;
                } else {
                  nextVariables[variable.name] = String(rawValue);
                }
              }
              onSubmit({
                variables: nextVariables,
                assigneeAgentId: selection.assigneeAgentId,
                projectId: selection.projectId || null,
              });
            }}
            disabled={isPending || !canSubmit}
          >
            {isPending ? "Running..." : "Run routine"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
