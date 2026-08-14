import { useMemo } from "react";
import type { Task, TaskLabel } from "@paperclipai/shared";
import { Check, Plus } from "lucide-react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { HexColorPicker } from "@/components/patterns/BrandColorPicker";
import type { useTaskPropertiesData } from "./useTaskPropertiesData";
import type { useTaskPropertiesState } from "./useTaskPropertiesState";

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
      <div className="flex items-center gap-1 flex-wrap">
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
      </div>
    ) : (
      <span className="text-sm text-muted-foreground">None</span>
    );
  const labelsExtra =
    (task.labelIds ?? []).length > 0 ? (
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => state.setLabelsOpen(true)}
        aria-label="Add label"
        title="Add label"
      >
        <Plus className="h-3 w-3" />
        Add label
      </Button>
    ) : undefined;

  const labelsContent = (
    <>
      <Input
        aria-label="Search labels"
        className="mb-1 h-8 text-xs"
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
                size="sm"
                className="w-full justify-start text-xs"
                onClick={() => data.toggleLabel(label.id)}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: label.color }}
                />
                <span className="truncate flex-1">{label.name}</span>
                {selected && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />}
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
            className="h-8 flex-1 text-xs"
            placeholder="New label"
            value={state.newLabelName}
            onChange={(event) => state.setNewLabelName(event.target.value)}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full text-xs"
          disabled={!state.newLabelName.trim() || data.createLabel.isPending}
          onClick={() =>
            data.createLabel.mutate({
              name: state.newLabelName.trim(),
              color: state.newLabelColor,
            })
          }
        >
          <Plus className="h-3 w-3" />
          {data.createLabel.isPending ? "Creating…" : "Create label"}
        </Button>
      </div>
    </>
  );

  return { labelsTrigger, labelsExtra, labelsContent };
}
