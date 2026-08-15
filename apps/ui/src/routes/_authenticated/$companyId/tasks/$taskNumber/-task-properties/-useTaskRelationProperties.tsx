import { useMemo } from "react";
import type { Task } from "@paperclipai/shared";
import { ArrowUpRight, Check, Plus } from "lucide-react";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { taskDisplayTitle } from "@/lib/task-display";
import { cn } from "@/lib/utils";
import { TaskLinkQuicklook } from "../../../../../../features/tasks/shared/TaskLinkQuicklook";
import type { TaskPropertiesData } from "./-useTaskPropertiesData";
import type { TaskPropertiesState } from "./-useTaskPropertiesState";

const TASK_PROPERTY_RELATION_PREVIEW_COUNT = 5;

interface UseTaskRelationPropertiesOptions {
  task: Task;
  inline?: boolean;
  onUpdate: (data: Record<string, unknown>) => void;
  state: TaskPropertiesState;
  data: TaskPropertiesData;
}

export function useTaskRelationProperties({
  task,
  inline,
  onUpdate,
  state,
  data,
}: UseTaskRelationPropertiesOptions) {
  const {
    relatedTasks,
    allTasks,
    searchedBlockedByTasks,
    isFetchingTaskPickerTasks,
    isFetchingSearchedBlockedByTasks,
    normalizedBlockedBySearch,
  } = data;
  const {
    blockedByOpen,
    setBlockedByOpen,
    blockedBySearch,
    setBlockedBySearch,
    blockedByExpanded,
    blockingExpanded,
    relatedTasksExpanded,
    parentSearch,
    setParentSearch,
    setParentOpen,
  } = state;
  const blockedByIds = task.blockedBy?.map((relation) => relation.id) ?? [];
  const blockedByRelations = task.blockedBy ?? [];
  const visibleBlockedByRelations = blockedByExpanded
    ? blockedByRelations
    : blockedByRelations.slice(0, TASK_PROPERTY_RELATION_PREVIEW_COUNT);
  const hiddenBlockedByCount = blockedByRelations.length - visibleBlockedByRelations.length;
  const blockingTasks = task.blocks ?? [];
  const visibleBlockingTasks = blockingExpanded
    ? blockingTasks
    : blockingTasks.slice(0, TASK_PROPERTY_RELATION_PREVIEW_COUNT);
  const hiddenBlockingTaskCount = blockingTasks.length - visibleBlockingTasks.length;
  const visibleRelatedTasks = relatedTasksExpanded
    ? relatedTasks
    : relatedTasks.slice(0, TASK_PROPERTY_RELATION_PREVIEW_COUNT);
  const hiddenRelatedTaskCount = relatedTasks.length - visibleRelatedTasks.length;
  const descendantTaskIds = useMemo(() => {
    if (!allTasks?.length) return new Set<string>();
    const childrenByParentId = new Map<string, string[]>();
    for (const candidate of allTasks) {
      if (!candidate.parentId) continue;
      const children = childrenByParentId.get(candidate.parentId) ?? [];
      children.push(candidate.id);
      childrenByParentId.set(candidate.parentId, children);
    }
    const descendants = new Set<string>();
    const stack = [...(childrenByParentId.get(task.id) ?? [])];
    while (stack.length > 0) {
      const candidateId = stack.pop();
      if (!candidateId || descendants.has(candidateId)) continue;
      descendants.add(candidateId);
      stack.push(...(childrenByParentId.get(candidateId) ?? []));
    }
    return descendants;
  }, [allTasks, task.id]);
  const currentParentTask = useMemo(() => {
    if (!task.parentId) return null;
    return allTasks?.find((candidate) => candidate.id === task.parentId) ?? null;
  }, [allTasks, task.parentId]);
  const parentIdentifier = task.ancestors?.[0]?.identifier ?? currentParentTask?.identifier;
  const parentTaskId = task.ancestors?.[0]?.id ?? currentParentTask?.id ?? task.parentId;
  const parentTaskNumber = task.ancestors?.[0]?.taskNumber ?? currentParentTask?.taskNumber ?? null;
  const parentTitle = task.ancestors?.[0]
    ? taskDisplayTitle(task.ancestors[0])
    : currentParentTask
      ? taskDisplayTitle(currentParentTask)
      : task.parentId
        ? "Parent task unavailable"
        : undefined;
  const parentTrigger = task.parentId ? (
    <span
      className="text-sm truncate min-w-0"
      title={`${parentIdentifier ? `${parentIdentifier} ` : ""}${parentTitle ?? ""}`.trim()}
    >
      {parentIdentifier ? `${parentIdentifier} ` : ""}
      {parentTitle}
    </span>
  ) : (
    <span className="text-sm text-muted-foreground">None</span>
  );
  const parentLink = parentTaskId ? (
    <Button
      asChild
      variant="ghost"
      size={inline ? "icon-lg" : "icon-xs"}
      className={inline ? "size-11!" : undefined}
      aria-label="Open parent task"
    >
      <TaskLinkQuicklook
        taskId={parentTaskId}
        taskNumber={parentTaskNumber}
        onClick={(event) => event.stopPropagation()}
        aria-label="Open parent task"
      >
        <ArrowUpRight data-icon="inline-end" />
      </TaskLinkQuicklook>
    </Button>
  ) : undefined;
  const parentOptions = (allTasks ?? [])
    .filter((candidate) => candidate.id !== task.id)
    .filter((candidate) => !descendantTaskIds.has(candidate.id))
    .filter((candidate) => {
      if (!parentSearch.trim()) return true;
      const query = parentSearch.toLowerCase();
      return (
        candidate.identifier?.toLowerCase().includes(query) || candidate.title?.toLowerCase().includes(query)
      );
    })
    .sort((left, right) => taskDisplayTitle(left).localeCompare(taskDisplayTitle(right)));
  const parentContent = (
    <>
      <Input
        aria-label="Search parent tasks"
        className={cn("mb-1 text-xs", inline ? "min-h-11" : "h-8")}
        placeholder="Search tasks..."
        value={parentSearch}
        onChange={(event) => setParentSearch(event.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <Button
          type="button"
          variant={!task.parentId ? "secondary" : "ghost"}
          size={inline ? "default" : "sm"}
          className={cn("w-full justify-start text-xs", inline && "min-h-11")}
          onClick={() => {
            onUpdate({ parentId: null });
            setParentOpen(false);
          }}
        >
          No parent
        </Button>
        {parentOptions.map((candidate) => (
          <Button
            type="button"
            key={candidate.id}
            variant={candidate.id === task.parentId ? "secondary" : "ghost"}
            size={inline ? "default" : "sm"}
            className={cn("w-full justify-start text-xs", inline && "min-h-11")}
            onClick={() => {
              onUpdate({ parentId: candidate.id });
              setParentOpen(false);
            }}
          >
            <DomainStatus
              status={candidate.boardPresentationStatus}
              className="px-1 py-0 text-(length:--text-nano)"
            />
            <span className="truncate">
              {candidate.identifier ? `${candidate.identifier} ` : ""}
              {candidate.title}
            </span>
          </Button>
        ))}
      </div>
    </>
  );
  const blockerSearchActive = normalizedBlockedBySearch.length > 0;
  const blockerSourceTasks = blockerSearchActive ? searchedBlockedByTasks : allTasks;
  const blockerOptions = (blockerSourceTasks ?? []).filter((candidate) => candidate.id !== task.id);
  if (!blockerSearchActive) {
    blockerOptions.sort((left, right) => taskDisplayTitle(left).localeCompare(taskDisplayTitle(right)));
  }
  const blockerOptionsLoading =
    blockedByOpen && (blockerSearchActive ? isFetchingSearchedBlockedByTasks : isFetchingTaskPickerTasks);
  const toggleBlockedBy = (blockedByTaskId: string) => {
    const nextBlockedByIds = blockedByIds.includes(blockedByTaskId)
      ? blockedByIds.filter((candidate) => candidate !== blockedByTaskId)
      : [...blockedByIds, blockedByTaskId];
    onUpdate({ blockedByTaskIds: nextBlockedByIds });
    setBlockedByOpen(false);
    setBlockedBySearch("");
  };
  const removeBlockedBy = (blockedByTaskId: string) => {
    onUpdate({
      blockedByTaskIds: blockedByIds.filter((candidate) => candidate !== blockedByTaskId),
    });
  };
  const blockedByContent = (
    <>
      <Input
        className={cn("mb-1 text-xs", inline ? "min-h-11" : "h-8")}
        placeholder="Search tasks..."
        value={blockedBySearch}
        onChange={(event) => setBlockedBySearch(event.target.value)}
        autoFocus={!inline}
        aria-label="Search tasks to add as blockers"
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <Button
          type="button"
          variant={blockedByIds.length === 0 ? "secondary" : "ghost"}
          size={inline ? "default" : "sm"}
          className={cn("w-full justify-start text-xs", inline && "min-h-11")}
          onClick={() => {
            onUpdate({ blockedByTaskIds: [] });
            setBlockedByOpen(false);
            setBlockedBySearch("");
          }}
        >
          No blockers
        </Button>
        {blockerOptions.map((candidate) => {
          const selected = blockedByIds.includes(candidate.id);
          return (
            <Button
              type="button"
              key={candidate.id}
              variant={selected ? "secondary" : "ghost"}
              size={inline ? "default" : "sm"}
              className={cn("w-full justify-start text-xs", inline && "min-h-11")}
              onClick={() => toggleBlockedBy(candidate.id)}
            >
              <DomainStatus
                status={candidate.boardPresentationStatus}
                className="px-1 py-0 text-(length:--text-nano)"
              />
              <span className="truncate">
                {candidate.identifier ? `${candidate.identifier} ` : ""}
                {candidate.title}
              </span>
              {selected && (
                <Check
                  className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground"
                  aria-hidden="true"
                  data-icon="inline-start"
                />
              )}
            </Button>
          );
        })}
        {blockerOptionsLoading ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">Searching tasks...</div>
        ) : blockerOptions.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No matching tasks.</div>
        ) : null}
      </div>
    </>
  );
  const renderAddBlockedByButton = (onClick?: () => void) => (
    <Button
      type="button"
      variant="outline"
      size={inline ? "default" : "xs"}
      className={inline ? "min-h-11" : undefined}
      onClick={onClick}
    >
      <Plus className="h-3 w-3" data-icon="inline-start" />
      Add blocker
    </Button>
  );

  return {
    visibleBlockedByRelations,
    hiddenBlockedByCount,
    blockingTasks,
    visibleBlockingTasks,
    hiddenBlockingTaskCount,
    visibleRelatedTasks,
    hiddenRelatedTaskCount,
    parentTrigger,
    parentLink,
    parentContent,
    removeBlockedBy,
    blockedByContent,
    renderAddBlockedByButton,
  };
}
