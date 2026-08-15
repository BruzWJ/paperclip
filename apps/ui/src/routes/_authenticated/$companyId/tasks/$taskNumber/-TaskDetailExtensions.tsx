import { PluginLauncherOutlet } from "@/plugins/launchers";
import { PluginSlotOutlet } from "@/plugins/slots";

import { useTaskDetailPage } from "./-TaskDetailPageContext";

function useTaskPluginContext() {
  const { task } = useTaskDetailPage();
  return {
    companyId: task.companyId,
    projectId: task.projectId ?? null,
    entityId: task.id,
    entityType: "task" as const,
  };
}

export function TaskDetailExtensionToolbar() {
  const context = useTaskPluginContext();
  return (
    <>
      <PluginSlotOutlet
        slotTypes={["toolbarButton"]}
        entityType="task"
        context={context}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />
      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="task"
        context={context}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />
    </>
  );
}

export function TaskDetailExtensionViews() {
  const context = useTaskPluginContext();
  return (
    <PluginSlotOutlet
      slotTypes={["taskDetailView"]}
      entityType="task"
      context={context}
      className="space-y-3"
      itemClassName="rounded-lg border border-border p-3"
      missingBehavior="placeholder"
    />
  );
}
