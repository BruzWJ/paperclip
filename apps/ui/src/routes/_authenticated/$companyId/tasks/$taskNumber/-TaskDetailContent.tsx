import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PluginSlotMount } from "@/plugins/slots";
import { MessageSquare } from "lucide-react";
import { useEffect } from "react";

import { TaskDetailChat } from "./-TaskDetailChat";
import { useTaskDetailPage } from "./-TaskDetailPageContext";

/** Keeps the built-in task surface chat-only while preserving contributed plugin tabs. */
export function TaskDetailContent() {
  const { activePluginTab, detailTab, setDetailTab, task, taskPluginTabItems } = useTaskDetailPage();

  useEffect(() => {
    if (detailTab !== "chat" && !activePluginTab) setDetailTab("chat");
  }, [activePluginTab, detailTab, setDetailTab]);

  if (taskPluginTabItems.length === 0) {
    return <TaskDetailChat />;
  }

  const resolvedTab = activePluginTab?.value ?? "chat";
  return (
    <Tabs value={resolvedTab} onValueChange={setDetailTab} className="space-y-3">
      <TabsList variant="line" className="w-full justify-start gap-1">
        <TabsTrigger value="chat" className="gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" />
          Chat
        </TabsTrigger>
        {taskPluginTabItems.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="chat">{resolvedTab === "chat" ? <TaskDetailChat /> : null}</TabsContent>

      {activePluginTab ? (
        <TabsContent value={activePluginTab.value}>
          <PluginSlotMount
            slot={activePluginTab.slot}
            context={{
              companyId: task.companyId,
              projectId: task.projectId ?? null,
              entityId: task.id,
              entityType: "task",
            }}
            missingBehavior="placeholder"
          />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
