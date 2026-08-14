import { useCallback, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Plus, MoreHorizontal, Copy, Trash2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { useDialogActions } from "../context/DialogContext";
import { toast } from "sonner";
import type { Agent } from "@paperclipai/shared";

export function PauseResumeButton({
  isPaused,
  onPause,
  onResume,
  disabled,
  size = "sm",
}: {
  isPaused: boolean;
  onPause: () => void;
  onResume: () => void;
  disabled?: boolean;
  size?: "sm" | "default";
}) {
  if (isPaused) {
    return (
      <Button variant="outline" size={size} onClick={onResume} disabled={disabled}>
        <Play data-icon="inline-start" className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">Resume</span>
      </Button>
    );
  }

  return (
    <Button variant="outline" size={size} onClick={onPause} disabled={disabled}>
      <Pause data-icon="inline-start" className="h-3.5 w-3.5 sm:mr-1" />
      <span className="hidden sm:inline">Pause</span>
    </Button>
  );
}

/**
 * Shared agent action cluster used by both the agent detail header and the
 * agents list rows. Provider work starts only from a task-execution source;
 * this control therefore exposes configuration/lifecycle actions, not an
 * taskless invoke or an agent-wide session reset.
 */
export function AgentActionButtons({
  agent,
  companyId,
  size = "sm",
  assignLabel = "Assign Task",
  showStatus = true,
  actionsDisabled = false,
  workActionsDisabled = false,
  workActionsDisabledReason,
  onActionError,
  pauseConfirm,
  hideTerminate = false,
  children,
  className,
}: {
  agent: Agent;
  companyId?: string | null;
  size?: "sm" | "default";
  assignLabel?: string;
  showStatus?: boolean;
  actionsDisabled?: boolean;
  workActionsDisabled?: boolean;
  workActionsDisabledReason?: string;
  /**
   * When set, pausing prompts a confirmation dialog first (for example when an
   * agent powers a feature). Omit for the immediate-pause default.
   */
  pauseConfirm?: { title: string; description: ReactNode };
  /** Hide the Terminate action when lifecycle ownership lives on another surface. */
  hideTerminate?: boolean;
  /**
   * Optional inline error reporter. When provided it is used instead of a toast
   * for action failures (preserves the detail page's inline error banner). When
   * omitted, failures surface as toasts (used by the list view).
   */
  onActionError?: (message: string | null) => void;
  /** Extra content rendered just before the overflow menu (e.g. live-run link). */
  children?: React.ReactNode;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const { openNewTask } = useDialogActions();
  const [pauseConfirmOpen, setPauseConfirmOpen] = useState(false);

  const resolvedCompanyId = companyId ?? agent.companyId;
  const isPaused = agent.status === "paused";
  const isError = agent.status === "error";

  const reportError = useCallback(
    (message: string) => {
      if (onActionError) {
        onActionError(message);
      } else {
        toast.error("Action failed", { description: message });
      }
    },
    [onActionError],
  );

  const invalidateAgent = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.agents.detail(agent.id),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.agents.runtimeState(agent.id),
    });
    if (resolvedCompanyId) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(resolvedCompanyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.runs(resolvedCompanyId),
      });
    }
  }, [agent.id, queryClient, resolvedCompanyId]);

  const agentAction = useMutation({
    mutationFn: async (action: "pause" | "resume" | "clear_error" | "terminate") => {
      switch (action) {
        case "pause":
          return agentsApi.pause(agent.id);
        case "resume":
          return agentsApi.resume(agent.id);
        case "clear_error":
          return agentsApi.clearError(agent.id);
        case "terminate":
          return agentsApi.terminate(agent.id);
      }
    },
    onSuccess: () => {
      onActionError?.(null);
      invalidateAgent();
    },
    onError: (err) => {
      reportError(err instanceof Error ? err.message : "Action failed");
    },
  });

  const isPendingApproval = agent.status === "pending_approval";
  const disabled = actionsDisabled || agentAction.isPending;
  const assignAndRunDisabled = disabled || isPendingApproval || workActionsDisabled;
  const pauseResumeDisabled = disabled || isPendingApproval || (isPaused && workActionsDisabled);
  const clearErrorDisabled = disabled;

  return (
    <div
      className={className ?? "flex items-center gap-1 sm:gap-2 shrink-0"}
      aria-busy={agentAction.isPending}
    >
      <ButtonGroup>
        <Button
          variant="outline"
          size={size}
          onClick={() => openNewTask({ ownerAgentId: agent.id })}
          disabled={assignAndRunDisabled || agentAction.isPending}
          title={workActionsDisabled ? workActionsDisabledReason : undefined}
        >
          <Plus data-icon="inline-start" className="h-3.5 w-3.5 sm:mr-1" />
          <span className="hidden sm:inline">{assignLabel}</span>
        </Button>
        {isError ? (
          <Button
            variant="outline"
            size={size}
            onClick={() => agentAction.mutate("clear_error")}
            disabled={clearErrorDisabled}
            aria-label="Clear error and return agent to idle"
          >
            <CheckCircle2 data-icon="inline-start" className="h-3.5 w-3.5 sm:mr-1" />
            <span className="hidden sm:inline">Clear error</span>
          </Button>
        ) : (
          <PauseResumeButton
            isPaused={isPaused}
            onPause={() => (pauseConfirm ? setPauseConfirmOpen(true) : agentAction.mutate("pause"))}
            onResume={() => agentAction.mutate("resume")}
            disabled={pauseResumeDisabled}
            size={size}
          />
        )}
      </ButtonGroup>
      {pauseConfirm && (
        <AlertDialog open={pauseConfirmOpen} onOpenChange={setPauseConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{pauseConfirm.title}</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div>{pauseConfirm.description}</div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={disabled}>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={disabled} onClick={() => agentAction.mutate("pause")}>
                Pause anyway
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {showStatus && (
        <span className="hidden sm:inline">
          <Badge variant="secondary" className="capitalize">
            {agent.status.replaceAll("_", " ")}
          </Badge>
        </span>
      )}
      {children}
      {agentAction.isPending ? (
        <span role="status" className="text-xs text-muted-foreground">
          Updating agent…
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Open actions for ${agent.name}`}
            disabled={disabled}
          >
            <MoreHorizontal data-icon="inline-start" className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-44" align="end">
          <DropdownMenuItem
            className="text-xs"
            onClick={() => {
              navigator.clipboard.writeText(agent.id);
            }}
          >
            <Copy data-icon="inline-start" className="h-3 w-3" />
            Copy Agent ID
          </DropdownMenuItem>
          {!hideTerminate && (
            <DropdownMenuItem
              className="text-xs"
              variant="destructive"
              onClick={() => agentAction.mutate("terminate")}
              disabled={disabled}
            >
              <Trash2 data-icon="inline-start" className="h-3 w-3" />
              Terminate
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
