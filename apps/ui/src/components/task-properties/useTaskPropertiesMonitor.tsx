import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Task } from "@paperclipai/shared";
import { Clock } from "lucide-react";
import { tasksApi } from "../../api/tasks";
import { queryKeys } from "../../lib/queryKeys";
import { invalidateInboxTaskQueries } from "../../lib/inboxArchiveCache";
import { buildExecutionPolicy } from "../../lib/task-execution-policy";
import {
  formatMonitorAbsolute,
  formatMonitorAbsoluteFull,
  formatMonitorEta,
  formatMonitorEtaLabel,
  useMonitorCountdown,
} from "../../lib/task-monitor";
import { timeAgo } from "../../lib/timeAgo";
import { cn } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { TaskPropertiesData } from "./useTaskPropertiesData";
import type { TaskPropertiesState } from "./useTaskPropertiesState";
import { FormDialog, LabeledFormField } from "@/components/patterns/FormPatterns";

interface UseTaskPropertiesMonitorOptions {
  task: Task;
  onUpdate: (data: Record<string, unknown>) => void;
  state: TaskPropertiesState;
  data: TaskPropertiesData;
}

interface ExecutionStageDecision {
  outcome: "approved" | "changes_requested";
  body: string;
}

export function useTaskPropertiesMonitor({ task, onUpdate, state, data }: UseTaskPropertiesMonitorOptions) {
  const [executionDecision, setExecutionDecision] = useState<ExecutionStageDecision | null>(null);
  const currentExecutionLabel = (() => {
    if (!task.executionState?.currentStageType) return null;
    const stageLabel = task.executionState.currentStageType === "review" ? "Review" : "Approval";
    const participant = task.executionState.currentParticipant;
    const participantLabel = participant
      ? participant.type === "agent"
        ? data.agentName(participant.agentId ?? null)
        : data.userLabel(participant.userId ?? null)
      : null;
    if (task.executionState.status === "changes_requested") {
      return `${stageLabel} requested changes${participantLabel ? ` by ${participantLabel}` : ""}`;
    }
    return `${stageLabel} pending${participantLabel ? ` with ${participantLabel}` : ""}`;
  })();

  const decideExecutionStage = useMutation({
    mutationFn: (input: ExecutionStageDecision) =>
      tasksApi.decideExecutionStage(task.id, {
        ...input,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: ({ task: updatedTask }) => {
      data.queryClient.setQueryData<Task>(queryKeys.tasks.detail(task.id), updatedTask);
      void data.queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(task.id),
      });
      void data.queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.activity(task.id),
      });
      if (data.companyId) {
        void data.queryClient.invalidateQueries({
          queryKey: queryKeys.tasks.list(data.companyId),
        });
        invalidateInboxTaskQueries(data.queryClient, data.companyId);
      }
    },
  });
  const canCurrentUserDecideExecutionStage =
    task.executionState?.status === "pending" &&
    task.executionState.currentParticipant?.type === "user" &&
    task.executionState.currentParticipant.userId === data.currentUserId;
  const requestExecutionStageDecision = (outcome: "approved" | "changes_requested") => {
    setExecutionDecision({ outcome, body: outcome === "approved" ? "Approved" : "" });
  };
  const submitExecutionStageDecision = () => {
    const decision = executionDecision;
    const body = decision?.body.trim();
    if (!decision || !body) return;
    decideExecutionStage.mutate({ outcome: decision.outcome, body });
    setExecutionDecision(null);
  };
  const updateMonitor = (
    nextMonitor: Task["executionPolicy"] extends infer T
      ? T extends { monitor?: infer M | null } | null | undefined
        ? M | null
        : never
      : never,
  ) => {
    const basePolicy = buildExecutionPolicy({
      existingPolicy: task.executionPolicy ?? null,
      reviewerValues: data.reviewerValues,
      approverValues: data.approverValues,
    });
    if (!basePolicy && !nextMonitor) {
      onUpdate({ executionPolicy: null });
      return;
    }
    onUpdate({
      executionPolicy: {
        mode: basePolicy?.mode ?? task.executionPolicy?.mode ?? "normal",
        commentRequired: true,
        stages: basePolicy?.stages ?? [],
        ...(nextMonitor ? { monitor: nextMonitor } : {}),
        ...(basePolicy?.reviewPreset ? { reviewPreset: basePolicy.reviewPreset } : {}),
        ...(basePolicy?.authorizationPolicy ? { authorizationPolicy: basePolicy.authorizationPolicy } : {}),
      },
    });
  };
  const saveMonitor = () => {
    if (!state.monitorAtInput) return;
    const nextCheckAt = new Date(state.monitorAtInput);
    if (Number.isNaN(nextCheckAt.getTime())) return;
    const serviceName = state.monitorServiceInput.trim() || null;
    updateMonitor({
      nextCheckAt: nextCheckAt.toISOString(),
      notes: state.monitorNotesInput.trim() || null,
      scheduledBy: "board",
      kind: serviceName ? "external_service" : null,
      serviceName,
      externalRef: null,
    });
    state.setMonitorOpen(false);
  };
  const clearMonitor = () => {
    updateMonitor(null);
    state.setMonitorOpen(false);
  };
  const monitorState = task.executionState?.monitor ?? null;
  const monitorNextCheckAt =
    monitorState?.nextCheckAt ??
    task.monitorNextCheckAt ??
    task.executionPolicy?.monitor?.nextCheckAt ??
    null;
  const monitorAttemptCount = task.monitorAttemptCount ?? monitorState?.attemptCount ?? 0;
  const monitorLastTriggeredAt = task.monitorLastTriggeredAt ?? monitorState?.lastTriggeredAt ?? null;
  const monitorServiceName = task.executionPolicy?.monitor?.serviceName ?? monitorState?.serviceName ?? null;
  const monitorNotes = task.executionPolicy?.monitor?.notes ?? monitorState?.notes ?? null;
  const monitorNow = useMonitorCountdown(monitorNextCheckAt);
  const monitorRelative = monitorNextCheckAt ? formatMonitorEta(monitorNextCheckAt, monitorNow) : null;
  const monitorIsDueNow = monitorRelative === "due now";
  const monitorIsOverdue = Boolean(monitorRelative?.startsWith("overdue by "));
  const monitorPrimary = monitorNextCheckAt
    ? formatMonitorEtaLabel(monitorNextCheckAt, monitorNow)
    : monitorState?.status === "cleared"
      ? "Cleared"
      : "None";
  const monitorSecondary = monitorNextCheckAt
    ? monitorIsDueNow
      ? "review reminder"
      : `${formatMonitorAbsolute(monitorNextCheckAt, {}, monitorNow)}${monitorIsOverdue ? " · reminder overdue" : monitorAttemptCount > 0 ? ` · Attempt ${monitorAttemptCount}` : ""}`
    : monitorState?.status === "cleared"
      ? [
          monitorLastTriggeredAt ? `last checked ${timeAgo(monitorLastTriggeredAt)}` : null,
          monitorAttemptCount > 0 ? `after attempt ${monitorAttemptCount}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;

  const monitorTrigger = (
    <TooltipProvider>
      <Tooltip open={state.monitorDetailsOpen} onOpenChange={state.setMonitorDetailsOpen}>
        <TooltipTrigger asChild>
          <span
            className="inline-flex min-w-0 items-start gap-1.5 border-0 bg-transparent p-0 text-left font-inherit text-inherit"
            data-testid="monitor-row-trigger"
            onClick={() => state.setMonitorDetailsOpen(false)}
          >
            {monitorNextCheckAt ? (
              <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : null}
            <span className="flex min-w-0 flex-col items-start">
              <span
                className={cn(
                  "text-sm",
                  monitorNextCheckAt ? "font-semibold text-foreground" : "text-muted-foreground",
                )}
              >
                {monitorPrimary}
              </span>
              {monitorSecondary ? (
                <span className="text-xs text-muted-foreground">{monitorSecondary}</span>
              ) : null}
            </span>
          </span>
        </TooltipTrigger>
        {monitorNextCheckAt ? (
          <TooltipContent
            side="left"
            className="w-80 border border-border bg-popover p-0 text-popover-foreground shadow-md"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm font-semibold">Monitor</span>
              {monitorAttemptCount > 0 ? (
                <span className="text-xs text-muted-foreground">Attempt {monitorAttemptCount}</span>
              ) : null}
            </div>
            <div className="space-y-3 px-4 py-3 text-left">
              <div>
                <div className="text-xs text-muted-foreground">Reminder time</div>
                <div className="text-sm">{formatMonitorAbsoluteFull(monitorNextCheckAt)}</div>
                <div className="text-xs text-muted-foreground">{monitorRelative}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Watching</div>
                <div className="text-sm">{monitorServiceName ?? "—"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Notes</div>
                <div className="whitespace-normal text-sm">{monitorNotes ?? "—"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Last recorded trigger</div>
                <div className="text-sm">
                  {monitorLastTriggeredAt
                    ? formatMonitorAbsoluteFull(monitorLastTriggeredAt)
                    : "— not yet triggered"}
                </div>
              </div>
            </div>
            <div className="flex gap-2 border-t border-border px-4 py-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  state.setMonitorDetailsOpen(false);
                  state.setMonitorOpen(true);
                }}
              >
                Edit
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  state.setMonitorDetailsOpen(false);
                  clearMonitor();
                }}
              >
                Clear
              </Button>
            </div>
          </TooltipContent>
        ) : null}
      </Tooltip>
    </TooltipProvider>
  );

  const monitorContent = (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-col gap-2 md:flex-row">
        <Input
          aria-label="Schedule monitor reminder"
          type="datetime-local"
          className="h-8 text-xs"
          value={state.monitorAtInput}
          onChange={(event) => state.setMonitorAtInput(event.target.value)}
        />
        <Input
          aria-label="Monitor reminder notes"
          type="text"
          className="h-8 min-w-0 flex-1 text-xs"
          placeholder="What should be reviewed?"
          value={state.monitorNotesInput}
          onChange={(event) => state.setMonitorNotesInput(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2 md:flex-row">
        <Input
          aria-label="External service to monitor"
          type="text"
          className="h-8 min-w-0 flex-1 text-xs"
          placeholder="External service"
          value={state.monitorServiceInput}
          onChange={(event) => state.setMonitorServiceInput(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={!state.monitorAtInput}
            onClick={saveMonitor}
          >
            Schedule
          </Button>
          {task.executionPolicy?.monitor ? (
            <Button type="button" variant="outline" size="xs" onClick={clearMonitor}>
              Clear
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
  const executionDecisionDialog = (
    <FormDialog
      open={executionDecision !== null}
      onOpenChange={(open) => {
        if (!open && !decideExecutionStage.isPending) setExecutionDecision(null);
      }}
      title={
        executionDecision?.outcome === "approved"
          ? "Record the approval decision"
          : "Describe the changes requested"
      }
      description="This note is recorded with the execution-stage decision."
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={decideExecutionStage.isPending}
            onClick={() => setExecutionDecision(null)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!executionDecision?.body.trim() || decideExecutionStage.isPending}
            onClick={submitExecutionStageDecision}
          >
            {decideExecutionStage.isPending ? "Recording…" : "Record decision"}
          </Button>
        </>
      }
    >
      <LabeledFormField label="Decision note">
        <Textarea
          aria-label="Execution decision note"
          value={executionDecision?.body ?? ""}
          onChange={(event) =>
            setExecutionDecision((current) => (current ? { ...current, body: event.target.value } : current))
          }
          autoFocus
        />
      </LabeledFormField>
    </FormDialog>
  );

  return {
    currentExecutionLabel,
    decideExecutionStage,
    canCurrentUserDecideExecutionStage,
    requestExecutionStageDecision,
    executionDecisionDialog,
    monitorTrigger,
    monitorContent,
  };
}
