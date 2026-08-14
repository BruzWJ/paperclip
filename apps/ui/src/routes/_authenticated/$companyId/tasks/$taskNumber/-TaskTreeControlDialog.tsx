import { TaskRelatedWorkPanel } from "@/components/TaskRelatedWorkPanel";
import { PauseAffectsSummaryView } from "@/components/owner-transition/OwnerTransitionViews";
import { TaskLinkQuicklook } from "@/components/TaskLinkQuicklook";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { taskValueLabel } from "@/lib/task-blockers";
import { PluginSlotMount } from "@/plugins/slots";
import { Activity as ActivityIcon, ListTree, MessageSquare } from "lucide-react";
import { useTaskDetailPage } from "./-TaskDetailPageContext";
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
    <Dialog open={treeControlOpen} onOpenChange={setTreeControlOpen}>
      <DialogContent className="flex max-h-(--sz-calc-18) flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{taskTreeControlLabel(treeControlMode, treeControlScope)}</DialogTitle>
          <DialogDescription>{taskTreeControlHelpText(treeControlMode, treeControlScope)}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain">
          {treeControlMode === "cancel" ? (
            <Alert variant="destructive">
              <AlertDescription>
                Cancelling a subtree marks non-terminal tasks cancelled and interrupts running or queued work
                where possible.
              </AlertDescription>
            </Alert>
          ) : null}

          <Field>
            <FieldLabel htmlFor="tree-control-reason">Reason (optional)</FieldLabel>
            <Textarea
              id="tree-control-reason"
              value={treeControlReason}
              onChange={(event) => setTreeControlReason(event.target.value)}
              placeholder="Explain why this subtree control is being applied..."
            />
          </Field>

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
                {treePreviewDisplayTasks.map((candidate) => (
                  <div
                    key={candidate.id}
                    style={
                      candidate.depth > 0
                        ? {
                            paddingLeft: `${Math.min(candidate.depth, 6) * 14}px`,
                          }
                        : undefined
                    }
                  >
                    <TaskLinkQuicklook
                      taskId={candidate.id}
                      taskNumber={candidate.taskNumber}
                      className={cn(candidate.skipped && "opacity-60")}
                    >
                      <Badge variant="secondary">{taskValueLabel(candidate.boardPresentationStatus)}</Badge>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {candidate.identifier}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                      {candidate.skipped && candidate.skipReason === "terminal_status" ? (
                        <span className="shrink-0 text-xs text-muted-foreground">Complete</span>
                      ) : null}
                    </TaskLinkQuicklook>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Preview unavailable.</p>
          )}
        </div>
        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
