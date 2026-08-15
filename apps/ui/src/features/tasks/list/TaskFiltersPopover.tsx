// Empty collections render dedicated UI when data.length === 0.
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/kibo-ui/combobox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Bot, Check, Filter, User, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
  defaultTaskFilterState,
  hasTaskOwnerFilter,
  taskFilterArraysEqual,
  taskFilterLabel,
  taskPriorityOrder,
  taskQuickFilterPresets,
  taskStatusOrder,
  toggleTaskFilterValue,
  toggleTaskOwnerFilter,
  type TaskFilterState,
} from "@/lib/task-filters";
import { formatOwnerUserLabel } from "@/lib/task-owners";
import type { ColoredNamedEntity, CreatorOption, NamedEntity } from "@/lib/presentation-contracts";

export function TaskFiltersPopover({
  state,
  onChange,
  activeFilterCount,
  agents,
  users,
  projects,
  labels,
  currentUserId,
  enableRoutineVisibilityFilter = false,
  buttonVariant = "ghost",
  iconOnly = false,
  creators,
}: {
  state: TaskFilterState;
  onChange: (patch: Partial<TaskFilterState>) => void;
  activeFilterCount: number;
  agents?: NamedEntity[];
  users?: NamedEntity[];
  projects?: NamedEntity[];
  labels?: ColoredNamedEntity[];
  currentUserId?: string | null;
  enableRoutineVisibilityFilter?: boolean;
  buttonVariant?: "ghost" | "outline";
  iconOnly?: boolean;
  creators?: CreatorOption[];
}) {
  const filterControlId = useId();
  const [creatorComboboxOpen, setCreatorComboboxOpen] = useState(false);
  const creatorOptions = creators ?? [];
  const creatorOptionById = useMemo(
    () => new Map(creatorOptions.map((option) => [option.id, option])),
    [creatorOptions],
  );
  const selectedCreatorOptions = useMemo(
    () =>
      state.creators.map((creatorId) => {
        const knownOption = creatorOptionById.get(creatorId);
        if (knownOption) return knownOption;
        if (creatorId.startsWith("agent:")) {
          const agentId = creatorId.slice("agent:".length);
          return {
            id: creatorId,
            label: agentId.slice(0, 8),
            kind: "agent" as const,
          };
        }
        const userId = creatorId.startsWith("user:") ? creatorId.slice("user:".length) : creatorId;
        return {
          id: creatorId,
          label: formatOwnerUserLabel(userId, currentUserId) ?? userId.slice(0, 5),
          kind: "user" as const,
        };
      }),
    [creatorOptionById, currentUserId, state.creators],
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={buttonVariant}
          size={iconOnly ? "icon-sm" : "sm"}
          title={iconOnly ? "Filter" : undefined}
        >
          <Filter  data-icon="inline-start"/>
          {!iconOnly ? "Filter" : null}
          {activeFilterCount > 0 ? <Badge variant="secondary">{activeFilterCount}</Badge> : null}
          {!iconOnly && activeFilterCount > 0 ? (
            <X
              aria-label="Clear filters"
              data-icon="inline-start"
              onClick={(event) => {
                event.stopPropagation();
                onChange(defaultTaskFilterState);
              }}
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-(--sz-calc-10) max-h-(--sz-calc-9) overflow-y-auto overscroll-contain p-0"
      >
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Filters</span>
            {activeFilterCount > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onChange(defaultTaskFilterState)}
              >
                Clear
              </Button>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Quick filters</span>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={1}
              value={
                taskQuickFilterPresets.find((preset) =>
                  taskFilterArraysEqual(state.statuses, preset.statuses),
                )?.label ?? ""
              }
              onValueChange={(value) => {
                const preset = taskQuickFilterPresets.find((option) => option.label === value);
                onChange({ statuses: preset ? [...preset.statuses] : [] });
              }}
            >
              {taskQuickFilterPresets.map((preset) => (
                <ToggleGroupItem key={preset.label} value={preset.label}>
                  {preset.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <Separator />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="min-w-0 space-y-3">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Status</span>
                <div className="space-y-0.5">
                  {taskStatusOrder.map((status) => (
                    <Field key={status} orientation="horizontal" className="gap-2">
                      <Checkbox
                        id={`${filterControlId}-status-${status}`}
                        checked={state.statuses.includes(status)}
                        onCheckedChange={() =>
                          onChange({
                            statuses: toggleTaskFilterValue(state.statuses, status),
                          })
                        }
                      />
                      <FieldLabel htmlFor={`${filterControlId}-status-${status}`} className="min-w-0 gap-2">
                        <Badge variant="secondary">{taskFilterLabel(status)}</Badge>
                      </FieldLabel>
                    </Field>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Priority</span>
                <div className="space-y-0.5">
                  {taskPriorityOrder.map((priority) => (
                    <Field key={priority} orientation="horizontal" className="gap-2">
                      <Checkbox
                        id={`${filterControlId}-priority-${priority}`}
                        checked={state.priorities.includes(priority)}
                        onCheckedChange={() =>
                          onChange({
                            priorities: toggleTaskFilterValue(state.priorities, priority),
                          })
                        }
                      />
                      <FieldLabel
                        htmlFor={`${filterControlId}-priority-${priority}`}
                        className="min-w-0 gap-2"
                      >
                        <Badge variant="secondary">{taskFilterLabel(priority)}</Badge>
                      </FieldLabel>
                    </Field>
                  ))}
                </div>
              </div>
            </div>

            <div className="min-w-0 space-y-3">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Owner</span>
                <div className="max-h-32 space-y-0.5 overflow-y-auto">
                  <Field orientation="horizontal" className="gap-2">
                    <Checkbox
                      id={`${filterControlId}-owner-board`}
                      checked={hasTaskOwnerFilter(state.owners, {
                        ownerKind: "board",
                      })}
                      onCheckedChange={() =>
                        onChange({
                          owners: toggleTaskOwnerFilter(state.owners, {
                            ownerKind: "board",
                          }),
                        })
                      }
                    />
                    <FieldLabel htmlFor={`${filterControlId}-owner-board`} className="min-w-0 gap-2">
                      Board escalation
                    </FieldLabel>
                  </Field>
                  {(users ?? []).map((user) => (
                    <Field key={user.id} orientation="horizontal" className="gap-2">
                      <Checkbox
                        id={`${filterControlId}-owner-user-${user.id}`}
                        checked={hasTaskOwnerFilter(state.owners, {
                          ownerKind: "user",
                          ownerUserId: user.id,
                        })}
                        onCheckedChange={() =>
                          onChange({
                            owners: toggleTaskOwnerFilter(state.owners, {
                              ownerKind: "user",
                              ownerUserId: user.id,
                            }),
                          })
                        }
                      />
                      <FieldLabel
                        htmlFor={`${filterControlId}-owner-user-${user.id}`}
                        className="min-w-0 gap-2"
                      >
                        <User className="h-3.5 w-3.5 text-muted-foreground"  data-icon="inline-start"/>
                        {user.id === currentUserId ? "Me" : user.name}
                      </FieldLabel>
                    </Field>
                  ))}
                  {(agents ?? []).map((agent) => (
                    <Field key={agent.id} orientation="horizontal" className="gap-2">
                      <Checkbox
                        id={`${filterControlId}-owner-agent-${agent.id}`}
                        checked={hasTaskOwnerFilter(state.owners, {
                          ownerKind: "agent",
                          ownerAgentId: agent.id,
                        })}
                        onCheckedChange={() =>
                          onChange({
                            owners: toggleTaskOwnerFilter(state.owners, {
                              ownerKind: "agent",
                              ownerAgentId: agent.id,
                            }),
                          })
                        }
                      />
                      <FieldLabel
                        htmlFor={`${filterControlId}-owner-agent-${agent.id}`}
                        className="min-w-0 gap-2"
                      >
                        {agent.name}
                      </FieldLabel>
                    </Field>
                  ))}
                </div>
              </div>

              {creatorOptions.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Creator</span>
                  {selectedCreatorOptions.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {selectedCreatorOptions.map((creator) => (
                        <Badge key={creator.id} variant="secondary" className="gap-1 pr-1">
                          {creator.kind === "agent" ? (
                            <Bot className="h-3 w-3"  data-icon="inline-start"/>
                          ) : (
                            <User className="h-3 w-3"  data-icon="inline-start"/>
                          )}
                          <span>{creator.label}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            onClick={() =>
                              onChange({
                                creators: state.creators.filter((value) => value !== creator.id),
                              })
                            }
                            aria-label={`Remove creator ${creator.label}`}
                          >
                            <X  data-icon="inline-start"/>
                          </Button>
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <Combobox
                    data={creatorOptions.map((creator) => ({
                      label: creator.label,
                      value: creator.id,
                    }))}
                    type="creator"
                    value=""
                    open={creatorComboboxOpen}
                    onOpenChange={setCreatorComboboxOpen}
                  >
                    <ComboboxTrigger className="w-full" aria-label="Choose creators" />
                    <ComboboxContent>
                      <ComboboxInput placeholder="Search creators..." aria-label="Search creators" />
                      <ComboboxList className="max-h-32">
                        <ComboboxEmpty>No creators match.</ComboboxEmpty>
                        <ComboboxGroup>
                          {creatorOptions.map((creator) => {
                            const selected = state.creators.includes(creator.id);
                            return (
                              <ComboboxItem
                                key={creator.id}
                                value={creator.id}
                                keywords={[creator.label, creator.searchText ?? ""]}
                                onSelect={() =>
                                  onChange({
                                    creators: toggleTaskFilterValue(state.creators, creator.id),
                                  })
                                }
                              >
                                {creator.kind === "agent" ? (
                                  <Bot className="h-3.5 w-3.5"  data-icon="inline-start"/>
                                ) : (
                                  <User className="h-3.5 w-3.5"  data-icon="inline-start"/>
                                )}
                                <span className="min-w-0 flex-1 truncate">{creator.label}</span>
                                {selected ? <Check  data-icon="inline-start"/> : null}
                              </ComboboxItem>
                            );
                          })}
                        </ComboboxGroup>
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                </div>
              ) : null}

              {projects && projects.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Project</span>
                  <div className="max-h-32 space-y-0.5 overflow-y-auto">
                    {projects.map((project) => (
                      <Field key={project.id} orientation="horizontal" className="gap-2">
                        <Checkbox
                          id={`${filterControlId}-project-${project.id}`}
                          checked={state.projects.includes(project.id)}
                          onCheckedChange={() =>
                            onChange({
                              projects: toggleTaskFilterValue(state.projects, project.id),
                            })
                          }
                        />
                        <FieldLabel
                          htmlFor={`${filterControlId}-project-${project.id}`}
                          className="min-w-0 gap-2"
                        >
                          {project.name}
                        </FieldLabel>
                      </Field>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="min-w-0 space-y-3">
              {labels && labels.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Labels</span>
                  <div className="max-h-32 space-y-0.5 overflow-y-auto">
                    {labels.map((label) => (
                      <Field key={label.id} orientation="horizontal" className="gap-2">
                        <Checkbox
                          id={`${filterControlId}-label-${label.id}`}
                          checked={state.labels.includes(label.id)}
                          onCheckedChange={() =>
                            onChange({
                              labels: toggleTaskFilterValue(state.labels, label.id),
                            })
                          }
                        />
                        <FieldLabel
                          htmlFor={`${filterControlId}-label-${label.id}`}
                          className="min-w-0 gap-2"
                        >
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: label.color }}
                          />
                          {label.name}
                        </FieldLabel>
                      </Field>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Visibility</span>
                <Field orientation="horizontal" className="gap-2">
                  <Checkbox
                    id={`${filterControlId}-live-only`}
                    checked={state.liveOnly ?? false}
                    onCheckedChange={(checked) => onChange({ liveOnly: checked === true })}
                  />
                  <FieldLabel htmlFor={`${filterControlId}-live-only`} className="min-w-0 gap-2">
                    Live runs only
                  </FieldLabel>
                </Field>
                {enableRoutineVisibilityFilter ? (
                  <Field orientation="horizontal" className="gap-2">
                    <Checkbox
                      id={`${filterControlId}-hide-routine-runs`}
                      checked={state.hideRoutineExecutions ?? false}
                      onCheckedChange={(checked) => onChange({ hideRoutineExecutions: checked === true })}
                    />
                    <FieldLabel htmlFor={`${filterControlId}-hide-routine-runs`} className="min-w-0 gap-2">
                      Hide routine runs
                    </FieldLabel>
                  </Field>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
