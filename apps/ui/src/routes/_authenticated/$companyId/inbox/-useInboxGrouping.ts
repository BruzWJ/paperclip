import {
  buildGroupedInboxSections,
  buildInboxKeyboardNavEntries,
  getInboxWorkItems,
  resolveInboxNestingEnabled,
  type InboxWorkItem,
  type InboxWorkItemGroupBy,
} from "@/lib/inbox";
import { collectSubtreeLiveCounts } from "@/lib/liveTaskIds";
import type { ParentedEntity } from "@/lib/presentation-contracts";
import type { Task } from "@paperclipai/shared";
import { useMemo, useRef } from "react";
import type { NavEntry } from "./-inbox-controller-model";

type InboxGrouping = Parameters<typeof buildGroupedInboxSections>[2];

export interface UseInboxGroupingOptions {
  filteredWorkItems: InboxWorkItem[];
  archivedSearchTasks: Task[];
  taskSearchSupplementResults: Task[];
  groupBy: InboxWorkItemGroupBy;
  inboxGrouping: InboxGrouping;
  nestingPreferenceEnabled: boolean;
  isMobile: boolean;
  collapsedGroupKeys: Set<string>;
  collapsedInboxParents: Set<string>;
  liveTaskIds: Set<string>;
}

/** Builds grouped inbox sections, flattened navigation, and live subtree counts. */
export function useInboxGrouping({
  filteredWorkItems,
  archivedSearchTasks,
  taskSearchSupplementResults,
  groupBy,
  inboxGrouping,
  nestingPreferenceEnabled,
  isMobile,
  collapsedGroupKeys,
  collapsedInboxParents,
  liveTaskIds,
}: UseInboxGroupingOptions) {
  const nestingEnabled = resolveInboxNestingEnabled(nestingPreferenceEnabled, isMobile);
  const groupedSections = useMemo(
    () => [
      ...buildGroupedInboxSections(filteredWorkItems, groupBy, inboxGrouping, {
        nestingEnabled,
      }),
      ...buildGroupedInboxSections(
        getInboxWorkItems({ tasks: archivedSearchTasks, approvals: [] }),
        groupBy,
        inboxGrouping,
        {
          keyPrefix: "archived-search:",
          searchSection: "archived" as const,
          nestingEnabled,
        },
      ),
      ...buildGroupedInboxSections(
        getInboxWorkItems({
          tasks: taskSearchSupplementResults,
          approvals: [],
        }),
        groupBy,
        inboxGrouping,
        {
          keyPrefix: "other-search:",
          searchSection: "other" as const,
          nestingEnabled,
        },
      ),
    ],
    [
      archivedSearchTasks,
      filteredWorkItems,
      groupBy,
      inboxGrouping,
      nestingEnabled,
      taskSearchSupplementResults,
    ],
  );
  const totalVisibleWorkItems = useMemo(
    () => groupedSections.reduce((count, group) => count + group.displayItems.length, 0),
    [groupedSections],
  );
  const flatNavItems = useMemo(
    (): NavEntry[] =>
      buildInboxKeyboardNavEntries(groupedSections, collapsedGroupKeys, collapsedInboxParents),
    [collapsedGroupKeys, collapsedInboxParents, groupedSections],
  );
  const flatNavItemsRef = useRef(flatNavItems);
  flatNavItemsRef.current = flatNavItems;
  const subtreeLiveCounts = useMemo(() => {
    const nodes: ParentedEntity[] = [];
    const seen = new Set<string>();
    const pushTask = (task: Task) => {
      if (seen.has(task.id)) return;
      seen.add(task.id);
      nodes.push({ id: task.id, parentId: task.parentId });
    };
    for (const group of groupedSections) {
      for (const item of group.displayItems) if (item.kind === "task") pushTask(item.task);
      for (const children of group.childrenByTaskId.values()) for (const child of children) pushTask(child);
    }
    return collectSubtreeLiveCounts(nodes, liveTaskIds);
  }, [groupedSections, liveTaskIds]);
  const topFlatIndex = useMemo(
    () => buildFlatIndex(flatNavItems, "top", (entry) => (entry.type === "top" ? entry.itemKey : "")),
    [flatNavItems],
  );
  const childFlatIndex = useMemo(
    () => buildFlatIndex(flatNavItems, "child", (entry) => (entry.type === "child" ? entry.taskId : "")),
    [flatNavItems],
  );
  const groupFlatIndex = useMemo(
    () => buildFlatIndex(flatNavItems, "group", (entry) => (entry.type === "group" ? entry.groupKey : "")),
    [flatNavItems],
  );

  return {
    nestingEnabled,
    groupedSections,
    totalVisibleWorkItems,
    flatNavItems,
    flatNavItemsRef,
    subtreeLiveCounts,
    topFlatIndex,
    childFlatIndex,
    groupFlatIndex,
  };
}

function buildFlatIndex(entries: NavEntry[], type: NavEntry["type"], key: (entry: NavEntry) => string) {
  const map = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.type === type) map.set(key(entry), index);
  });
  return map;
}
