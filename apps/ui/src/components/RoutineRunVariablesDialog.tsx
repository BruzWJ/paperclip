import { useEffect, useMemo, useState } from "react";
import { type Agent, type Project, type RoutineVariable } from "@paperclipai/shared";
import { AgentIcon } from "./AgentIconPicker";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "../lib/recent-projects";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  ENTITY_NONE_VALUE,
  entityOptionMatchesSearch,
  type EntityOption,
  useEntitySelectorState,
} from "@/lib/entity-selector";
import { cn } from "@/lib/utils";

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
  const [selection, setSelection] = useState(() =>
    buildInitialRunSelection({
      defaultAssigneeAgentId,
      defaultProjectId,
    }),
  );
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selection.projectId) ?? null,
    [projects, selection.projectId],
  );
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [open]);
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [open]);
  const assigneeOptions = useMemo<EntityOption[]>(
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
  const projectOptions = useMemo<EntityOption[]>(
    () =>
      projects.map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [projects],
  );
  const currentAssignee = selection.assigneeAgentId
    ? (agents.find((agent) => agent.id === selection.assigneeAgentId) ?? null)
    : null;
  useEffect(() => {
    if (!open) return;
    setValues(buildInitialValues(variables));
    const nextSelection = buildInitialRunSelection({
      defaultAssigneeAgentId,
      defaultProjectId,
    });
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

  const canSubmit = selection.assigneeAgentId.trim().length > 0 && missingRequired.length === 0;
  const assigneeSelector = useEntitySelectorState({
    value: selection.assigneeAgentId,
    options: assigneeOptions,
    noneLabel: "Select an agent",
    recentOptionIds: recentAssigneeIds,
    onChange: (assigneeAgentId) => {
      if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
      setSelection((current) => ({ ...current, assigneeAgentId }));
    },
  });
  const projectSelector = useEntitySelectorState({
    value: selection.projectId,
    options: projectOptions,
    noneLabel: "No project",
    recentOptionIds: recentProjectIds,
    onChange: (projectId) => {
      if (projectId) trackRecentProject(projectId);
      setSelection((current) => ({ ...current, projectId }));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="flex h-(--sz-calc-18) max-h-(--sz-calc-18) max-w-xl flex-col gap-0 overflow-hidden p-0 sm:h-auto sm:max-h-(--sz-calc-20)">
        <DialogHeader className="shrink-0 border-b border-border/60 px-6 pb-4 pr-12 pt-6">
          {routineName && <p className="text-muted-foreground text-sm">{routineName}</p>}
          <DialogTitle>Run routine</DialogTitle>
          <DialogDescription>
            Choose the agent and optional project for this one run. Routine defaults are prefilled and
            won&apos;t be changed.
          </DialogDescription>
        </DialogHeader>

        <FieldSet disabled={isPending} aria-label="Routine run settings" className="min-h-0 flex-1 gap-0">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-4">
            <FieldGroup className="grid gap-4 md:grid-cols-2">
              <Field data-invalid={!selection.assigneeAgentId}>
                <FieldLabel>Agent *</FieldLabel>
                <Popover open={assigneeSelector.open} onOpenChange={assigneeSelector.setOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      role="combobox"
                      aria-expanded={assigneeSelector.open}
                      aria-label="Agent"
                      className="w-full justify-between overflow-hidden"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-left">
                        {currentAssignee ? (
                          <AgentIcon icon={currentAssignee.icon} className="size-3.5" />
                        ) : null}
                        {assigneeSelector.currentOption?.label ?? (
                          <span className="text-muted-foreground">Select an agent</span>
                        )}
                      </span>
                      <ChevronsUpDown className="size-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-72 p-0">
                    <Command
                      filter={(optionValue, search) =>
                        entityOptionMatchesSearch(
                          assigneeSelector.orderedOptions.find(
                            (option) => (option.id || ENTITY_NONE_VALUE) === optionValue,
                          ),
                          search,
                        )
                      }
                    >
                      <CommandInput autoFocus placeholder="Search agents..." />
                      <CommandList>
                        <CommandEmpty>No agents found.</CommandEmpty>
                        {assigneeSelector.orderedOptions.map((option) => {
                          const assignee = agents.find((agent) => agent.id === option.id);
                          return (
                            <CommandItem
                              key={option.id || ENTITY_NONE_VALUE}
                              value={option.id || ENTITY_NONE_VALUE}
                              onSelect={() => assigneeSelector.select(option)}
                            >
                              {assignee ? <AgentIcon icon={assignee.icon} className="size-3.5" /> : null}
                              <span className="truncate">{option.label}</span>
                              <Check
                                className={cn(
                                  "ml-auto size-4",
                                  option.id === selection.assigneeAgentId ? "opacity-100" : "opacity-0",
                                )}
                              />
                            </CommandItem>
                          );
                        })}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </Field>
              <Field>
                <FieldLabel>Project</FieldLabel>
                <Popover open={projectSelector.open} onOpenChange={projectSelector.setOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      role="combobox"
                      aria-expanded={projectSelector.open}
                      aria-label="Project"
                      className="w-full justify-between overflow-hidden"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-left">
                        {selectedProject ? (
                          <span
                            className="size-3.5 shrink-0 rounded-sm"
                            style={{ backgroundColor: selectedProject.color ?? "var(--project-none)" }}
                          />
                        ) : null}
                        {projectSelector.currentOption?.label ?? (
                          <span className="text-muted-foreground">No project</span>
                        )}
                      </span>
                      <ChevronsUpDown className="size-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-72 p-0">
                    <Command
                      filter={(optionValue, search) =>
                        entityOptionMatchesSearch(
                          projectSelector.orderedOptions.find(
                            (option) => (option.id || ENTITY_NONE_VALUE) === optionValue,
                          ),
                          search,
                        )
                      }
                    >
                      <CommandInput autoFocus placeholder="Search projects..." />
                      <CommandList>
                        <CommandEmpty>No projects found.</CommandEmpty>
                        {projectSelector.orderedOptions.map((option) => {
                          const project = projects.find((entry) => entry.id === option.id);
                          return (
                            <CommandItem
                              key={option.id || ENTITY_NONE_VALUE}
                              value={option.id || ENTITY_NONE_VALUE}
                              onSelect={() => projectSelector.select(option)}
                            >
                              {option.id ? (
                                <span
                                  className="size-3.5 shrink-0 rounded-sm"
                                  style={{ backgroundColor: project?.color ?? "var(--project-none)" }}
                                />
                              ) : null}
                              <span className="truncate">{option.label}</span>
                              <Check
                                className={cn(
                                  "ml-auto size-4",
                                  option.id === selection.projectId ? "opacity-100" : "opacity-0",
                                )}
                              />
                            </CommandItem>
                          );
                        })}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </Field>
            </FieldGroup>

            {variables.map((variable) => {
              const fieldLabel = variable.label || variable.name;
              const fieldId = `routine-variable-${variable.name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

              return (
                <Field
                  key={variable.name}
                  data-invalid={variable.required && isMissingRequiredValue(values[variable.name])}
                >
                  <FieldLabel htmlFor={fieldId}>
                    {fieldLabel}
                    {variable.required ? " *" : ""}
                  </FieldLabel>
                  {variable.type === "textarea" ? (
                    <Textarea
                      id={fieldId}
                      rows={4}
                      value={
                        typeof values[variable.name] === "string" ? (values[variable.name] as string) : ""
                      }
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [variable.name]: event.target.value,
                        }))
                      }
                    />
                  ) : variable.type === "boolean" ? (
                    <Select
                      value={
                        values[variable.name] === true
                          ? "true"
                          : values[variable.name] === false
                            ? "false"
                            : "__unset__"
                      }
                      onValueChange={(next) =>
                        setValues((current) => ({
                          ...current,
                          [variable.name]: next === "__unset__" ? "" : next === "true",
                        }))
                      }
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
                      value={
                        typeof values[variable.name] === "string" && values[variable.name]
                          ? (values[variable.name] as string)
                          : "__unset__"
                      }
                      onValueChange={(next) =>
                        setValues((current) => ({
                          ...current,
                          [variable.name]: next === "__unset__" ? "" : next,
                        }))
                      }
                    >
                      <SelectTrigger id={fieldId} aria-label={fieldLabel}>
                        <SelectValue placeholder="Choose a value" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__unset__">No value</SelectItem>
                        {variable.options.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : shouldUseDateInput(variable) ? (
                    <Input
                      type="date"
                      value={values[variable.name] == null ? "" : String(values[variable.name])}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [variable.name]: event.target.value,
                        }))
                      }
                      aria-label={fieldLabel}
                    />
                  ) : (
                    <Input
                      id={fieldId}
                      type={variable.type === "number" ? "number" : "text"}
                      value={values[variable.name] == null ? "" : String(values[variable.name])}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [variable.name]: event.target.value,
                        }))
                      }
                    />
                  )}
                </Field>
              );
            })}
          </div>

          <DialogFooter
            showCloseButton={false}
            className="shrink-0 border-t border-border/60 bg-background px-6 pb-(--sz-calc-19) pt-4"
          >
            {!isPending && !selection.assigneeAgentId ? (
              <FieldError className="mr-auto">Default agent required for this run.</FieldError>
            ) : !isPending && missingRequired.length > 0 ? (
              <FieldError className="mr-auto">Missing: {missingRequired.join(", ")}</FieldError>
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
              {isPending ? <Spinner /> : null}
              {isPending ? "Running…" : "Run routine"}
            </Button>
          </DialogFooter>
        </FieldSet>
      </DialogContent>
    </Dialog>
  );
}
