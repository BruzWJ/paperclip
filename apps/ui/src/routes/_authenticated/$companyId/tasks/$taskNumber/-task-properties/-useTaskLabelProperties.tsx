import { useMemo } from "react";
import type { Task, TaskLabel } from "@paperclipai/shared";
import { Check, Plus } from "lucide-react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { HexColorPicker } from "@/components/patterns/BrandColorPicker";
import { cn } from "@/lib/utils";
import type { useTaskPropertiesData } from "./-useTaskPropertiesData";
import type { useTaskPropertiesState } from "./-useTaskPropertiesState";

export function useTaskLabelProperties({
  task,
  inline,
  state,
  data,
}: {
  task: Task;
  inline?: boolean;
  state: ReturnType<typeof useTaskPropertiesState>;
  data: ReturnType<typeof useTaskPropertiesData>;
}) {
  const selectedTaskLabels = useMemo(() => {
    const selectedIds = task.labelIds ?? [];
    if (selectedIds.length === 0) return task.labels ?? [];

    const labelById = new Map<string, TaskLabel>();
    for (const label of data.labels ?? []) labelById.set(label.id, label);
    for (const label of task.labels ?? []) labelById.set(label.id, label);

    return selectedIds.map((id) => labelById.get(id)).filter((label): label is TaskLabel => Boolean(label));
  }, [task.labelIds, task.labels, data.labels]);

  const labelsTrigger =
    selectedTaskLabels.length > 0 ? (
      <span className="flex flex-wrap items-center gap-1">
        {selectedTaskLabels.slice(0, 3).map((label) => (
          <Badge
            key={label.id}
            variant="outline"
            title={label.name}
            style={{
              borderColor: label.color,
              backgroundColor: `${label.color}22`,
              color: pickTextColorForPillBg(label.color, 0.13),
            }}
          >
            {label.name}
          </Badge>
        ))}
        {selectedTaskLabels.length > 3 && (
          <Badge variant="outline" className="border-border text-muted-foreground">
            +{selectedTaskLabels.length - 3} more
          </Badge>
        )}
      </span>
    ) : (
      <span className="text-sm text-muted-foreground">None</span>
    );
  const labelsExtra =
    (task.labelIds ?? []).length > 0 ? (
      <Button
        type="button"
        variant="outline"
        size={inline ? "default" : "xs"}
        className={inline ? "min-h-11" : undefined}
        onClick={() => state.setLabelsOpen(true)}
        aria-label="Add label"
        title="Add label"
      >
        <Plus className="h-3 w-3" data-icon="inline-start" />
        Add label
      </Button>
    ) : undefined;

  const labelsContent = (
    <>
      <Input
        aria-label="Search labels"
        className={cn("mb-1 text-xs", inline ? "min-h-11" : "h-8")}
        placeholder="Search labels..."
        value={state.labelSearch}
        onChange={(event) => state.setLabelSearch(event.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-44 overflow-y-auto overscroll-contain space-y-0.5">
        {(data.labels ?? [])
          .filter((label) => {
            if (!state.labelSearch.trim()) return true;
            return label.name.toLowerCase().includes(state.labelSearch.toLowerCase());
          })
          .map((label) => {
            const selected = (task.labelIds ?? []).includes(label.id);
            return (
              <Button
                type="button"
                key={label.id}
                variant={selected ? "secondary" : "ghost"}
                size={inline ? "default" : "sm"}
                className={cn("w-full justify-start text-xs", inline && "min-h-11")}
                onClick={() => data.toggleLabel(label.id)}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: label.color }}
                />
                <span className="flex-1 truncate text-left">{label.name}</span>
                {selected && (
                  <Check
                    className="h-3.5 w-3.5 shrink-0 text-foreground"
                    aria-hidden="true"
                    data-icon="inline-start"
                  />
                )}
              </Button>
            );
          })}
      </div>
      <div className="mt-2 space-y-2">
        <Separator />
        <div className="space-y-2">
          <HexColorPicker
            ariaLabel="New label color"
            value={state.newLabelColor}
            onChange={state.setNewLabelColor}
          />
          <Input
            aria-label="New label name"
            className={cn("flex-1 text-xs", inline ? "min-h-11" : "h-8")}
            placeholder="New label"
            value={state.newLabelName}
            onChange={(event) => state.setNewLabelName(event.target.value)}
          />
        </div>
        {data.createLabel.isPending ? (
          <p role="status" className="sr-only">
            Creating label…
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size={inline ? "default" : "sm"}
          className={cn("w-full text-xs", inline && "min-h-11")}
          disabled={!state.newLabelName.trim() || data.createLabel.isPending}
          onClick={() =>
            data.createLabel.mutate({
              name: state.newLabelName.trim(),
              color: state.newLabelColor,
            })
          }
        >
          <Plus className="h-3 w-3" data-icon="inline-start" />
          {data.createLabel.isPending ? "Creating…" : "Create label"}
        </Button>
      </div>
    </>
  );

  return { labelsTrigger, labelsExtra, labelsContent };
}
