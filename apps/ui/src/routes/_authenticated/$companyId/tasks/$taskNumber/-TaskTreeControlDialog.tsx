import { TaskRelatedWorkPanel } from "@/components/TaskRelatedWorkPanel";
import { PauseAffectsSummaryView } from "@/components/owner-transition/OwnerTransitionViews";
import { DomainTree, type DomainTreeNode } from "@/components/patterns/DomainTree";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { TaskLinkQuicklook } from "@/components/TaskLinkQuicklook";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { taskValueLabel } from "@/lib/task-blockers";
import { PluginSlotMount } from "@/plugins/slots";
import type { TaskTreePreviewTask } from "@paperclipai/shared";
import { Activity as ActivityIcon, ListTree, MessageSquare } from "lucide-react";
import { useMemo, useState } from "react";
import { useTaskDetailPage } from "./-TaskDetailPageContext";
import { FormDialog, LabeledFormField } from "@/components/patterns/FormPatterns";
import { TaskDetailActivityTab, TaskDetailChatTab } from "./-TaskDetailChatTab";
import {
  taskTreeControlHelpText,
  taskTreeControlLabel,
  treeControlPreviewErrorCopy,
} from "./-task-detail-model";

export function TaskDetailTabs() {
  const { activePluginTab, detailTab, setDetailTab, task, taskPluginTabItems } = useTaskDetailPage();
  return (
    <Tabs value={detailTab} onValueChange={setDetailTab} className="space-y-3">
      <TabsList variant="line" className="w-full justify-start gap-1">
        <TabsTrigger value="chat" className="gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" />
          Chat
        </TabsTrigger>
        <TabsTrigger value="activity" className="gap-1.5">
          <ActivityIcon className="h-3.5 w-3.5" />
          Activity
        </TabsTrigger>
        <TabsTrigger value="related-work" className="gap-1.5">
          <ListTree className="h-3.5 w-3.5" />
          Related work
        </TabsTrigger>
        {taskPluginTabItems.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="chat">{detailTab === "chat" ? <TaskDetailChatTab /> : null}</TabsContent>

      <TabsContent value="activity">
        {detailTab === "activity" ? <TaskDetailActivityTab /> : null}
      </TabsContent>

      <TabsContent value="related-work">
        <TaskRelatedWorkPanel relatedWork={task.relatedWork} />
      </TabsContent>

      {activePluginTab && (
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
      )}
    </Tabs>
  );
}

function taskPreviewNodes(tasks: TaskTreePreviewTask[]): DomainTreeNode<TaskTreePreviewTask>[] {
  const nodeById = new Map<string, DomainTreeNode<TaskTreePreviewTask>>();
  for (const task of tasks) {
    nodeById.set(task.id, { id: task.id, value: task, children: [] });
  }

  const roots: DomainTreeNode<TaskTreePreviewTask>[] = [];
  for (const task of tasks) {
    const node = nodeById.get(task.id);
    if (!node) continue;
    const parent = task.parentId ? nodeById.get(task.parentId) : undefined;
    if (parent && parent !== node) parent.children?.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Read-only tree-control preview mapped onto the shared Kibo Tree adapter. */
export function TaskTreeControlPreviewTree({ tasks }: { tasks: TaskTreePreviewTask[] }) {
  const nodes = useMemo(() => taskPreviewNodes(tasks), [tasks]);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const expandedIds = useMemo(
    () =>
      new Set(
        nodes
          .flatMap(function collect(node): string[] {
            return node.children?.length ? [node.id, ...node.children.flatMap(collect)] : [];
          })
          .filter((id) => !collapsedIds.has(id)),
      ),
    [collapsedIds, nodes],
  );

  return (
    <DomainTree
      nodes={nodes}
      expandedIds={expandedIds}
      onToggle={({ id }) => {
        setCollapsedIds((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }}
      ariaLabel="Affected tasks"
      showIcons={false}
      animateExpand={false}
      rowClassName={({ node }) => cn(node.value.skipped && "opacity-60")}
      renderLabel={({ node }) => {
        const candidate = node.value;
        return (
          <TaskLinkQuicklook
            taskId={candidate.id}
            taskNumber={candidate.taskNumber}
            className="flex min-w-0 flex-1 items-center gap-2"
            onClick={(event) => event.stopPropagation()}
          >
            <DomainStatus status={candidate.boardPresentationStatus}>
              {taskValueLabel(candidate.boardPresentationStatus)}
            </DomainStatus>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{candidate.identifier}</span>
            <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
            {candidate.skipped && candidate.skipReason === "terminal_status" ? (
              <span className="shrink-0 text-xs text-muted-foreground">Complete</span>
            ) : null}
          </TaskLinkQuicklook>
        );
      }}
    />
  );
}

export function TaskTreeControlDialog() {
  const {
    canApplyTreeControl,
    executeTreeControl,
    pauseAffectsSummary,
    previewAffectedTaskCount,
    refetchTreeControlPreview,
    setTreeControlCancelConfirmed,
    setTreeControlOpen,
    setTreeControlReason,
    treeControlCancelConfirmed,
    treeControlMode,
    treeControlOpen,
    treeControlPreview,
    treeControlPreviewError,
    treeControlPreviewLoading,
    treeControlPrimaryButtonLabel,
    treeControlReason,
    treeControlScope,
    treePreviewDisplayTasks,
    treePreviewWarnings,
  } = useTaskDetailPage();
  return (
    <FormDialog
      open={treeControlOpen}
      onOpenChange={setTreeControlOpen}
      contentClassName="flex max-h-(--sz-calc-18) flex-col overflow-hidden"
      title={taskTreeControlLabel(treeControlMode, treeControlScope)}
      description={taskTreeControlHelpText(treeControlMode, treeControlScope)}
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => setTreeControlOpen(false)}
            disabled={executeTreeControl.isPending}
          >
            Close
          </Button>
          <Button
            onClick={() => executeTreeControl.mutate()}
            disabled={executeTreeControl.isPending || !canApplyTreeControl}
            variant={treeControlMode === "cancel" ? "destructive" : "default"}
          >
            {executeTreeControl.isPending ? "Applying..." : treeControlPrimaryButtonLabel}
          </Button>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain">
        {treeControlMode === "cancel" ? (
          <Alert variant="destructive">
            <AlertDescription>
              Cancelling a subtree marks non-terminal tasks cancelled and interrupts running or queued work
              where possible.
            </AlertDescription>
          </Alert>
        ) : null}

        <LabeledFormField label="Reason (optional)" labelFor="tree-control-reason">
          <Textarea
            id="tree-control-reason"
            value={treeControlReason}
            onChange={(event) => setTreeControlReason(event.target.value)}
            placeholder="Explain why this subtree control is being applied..."
          />
        </LabeledFormField>

        {treeControlMode === "cancel" ? (
          <Field orientation="horizontal">
            <Checkbox
              id="tree-control-confirm"
              checked={treeControlCancelConfirmed}
              onCheckedChange={(checked) => setTreeControlCancelConfirmed(checked === true)}
            />
            <FieldLabel htmlFor="tree-control-confirm">
              I understand this will cancel {previewAffectedTaskCount} tasks.
            </FieldLabel>
          </Field>
        ) : null}

        {treeControlPreviewLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : treeControlPreviewError ? (
          <Alert variant="destructive">
            <AlertDescription>{treeControlPreviewErrorCopy(treeControlPreviewError)}</AlertDescription>
            <Button variant="outline" size="sm" onClick={() => void refetchTreeControlPreview()}>
              Retry preview
            </Button>
          </Alert>
        ) : treeControlPreview ? (
          <div className="space-y-2">
            {treeControlMode === "pause" ? <PauseAffectsSummaryView summary={pauseAffectsSummary} /> : null}
            {treePreviewWarnings.map((warning) => (
              <Alert key={warning.code}>
                <AlertDescription>{warning.message}</AlertDescription>
              </Alert>
            ))}
            <div className="max-h-56 overflow-y-auto overscroll-contain">
              <TaskTreeControlPreviewTree tasks={treePreviewDisplayTasks} />
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Preview unavailable.</p>
        )}
      </div>
    </FormDialog>
  );
}
