import { useCallback, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Pause,
  Play,
  Plus,
  MoreHorizontal,
  Copy,
  Trash2,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { AgentStatusBadge } from "./StatusBadge";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { agentRouteRef } from "../lib/utils";
import { useDialogActions } from "../context/DialogContext";
import { useToastActions } from "../context/ToastContext";
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
        <Play className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">Resume</span>
      </Button>
    );
  }

  return (
    <Button variant="outline" size={size} onClick={onPause} disabled={disabled}>
      <Pause className="h-3.5 w-3.5 sm:mr-1" />
      <span className="hidden sm:inline">Pause</span>
    </Button>
  );
}

export function ClearErrorButton({
  onClick,
  disabled,
  size = "sm",
}: {
  onClick: () => void;
  disabled?: boolean;
  size?: "sm" | "default";
}) {
  return (
    <Button
      variant="outline"
      size={size}
      onClick={onClick}
      disabled={disabled}
      className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/50"
      aria-label="Clear error and return agent to idle"
    >
      <CheckCircle2 className="h-3.5 w-3.5 sm:mr-1" />
      <span className="hidden sm:inline">Clear error</span>
    </Button>
  );
}

/**
 * Shared agent action cluster used by both the agent detail header and the
 * agents list rows. Provider work starts only from an issue-execution source;
 * this control therefore exposes configuration/lifecycle actions, not an
 * issueless invoke or an agent-wide session reset.
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
  const { openNewIssue } = useDialogActions();
  const { pushToast } = useToastActions();
  const [moreOpen, setMoreOpen] = useState(false);
  const [pauseConfirmOpen, setPauseConfirmOpen] = useState(false);

  const resolvedCompanyId = companyId ?? agent.companyId;
  const canonicalAgentRef = agentRouteRef(agent);
  const isPaused = agent.status === "paused";
  const isError = agent.status === "error";

  const reportError = useCallback(
    (message: string) => {
      if (onActionError) {
        onActionError(message);
      } else {
        pushToast({ title: "Action failed", body: message, tone: "error" });
      }
    },
    [onActionError, pushToast],
  );

  const invalidateAgent = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(canonicalAgentRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(agent.id) });
    if (resolvedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.runs(resolvedCompanyId) });
    }
  }, [agent.id, canonicalAgentRef, queryClient, resolvedCompanyId]);

  const agentAction = useMutation({
    mutationFn: async (action: "pause" | "resume" | "clear_error" | "terminate") => {
      switch (action) {
        case "pause": return agentsApi.pause(agent.id, resolvedCompanyId ?? undefined);
        case "resume": return agentsApi.resume(agent.id, resolvedCompanyId ?? undefined);
        case "clear_error": return agentsApi.clearError(agent.id, resolvedCompanyId ?? undefined);
        case "terminate": return agentsApi.terminate(agent.id, resolvedCompanyId ?? undefined);
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
    <div className={className ?? "flex items-center gap-1 sm:gap-2 shrink-0"}>
      <Button
        variant="outline"
        size={size}
        onClick={() => openNewIssue({ ownerAgentId: agent.id })}
        disabled={assignAndRunDisabled}
        title={workActionsDisabled ? workActionsDisabledReason : undefined}
      >
        <Plus className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">{assignLabel}</span>
      </Button>
      {isError ? (
        <ClearErrorButton
          onClick={() => agentAction.mutate("clear_error")}
          disabled={clearErrorDisabled}
          size={size}
        />
      ) : (
        <PauseResumeButton
          isPaused={isPaused}
          onPause={() => (pauseConfirm ? setPauseConfirmOpen(true) : agentAction.mutate("pause"))}
          onResume={() => agentAction.mutate("resume")}
          disabled={pauseResumeDisabled}
          size={size}
        />
      )}
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
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => agentAction.mutate("pause")}>
                Pause anyway
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {showStatus && (
        <span className="hidden sm:inline">
          <AgentStatusBadge status={agent.status} />
        </span>
      )}
      {children}
      <Popover open={moreOpen} onOpenChange={setMoreOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`Open actions for ${agent.name}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-44 p-1" align="end">
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
            onClick={() => {
              navigator.clipboard.writeText(agent.id);
              setMoreOpen(false);
            }}
          >
            <Copy className="h-3 w-3" />
            Copy Agent ID
          </button>
          {!hideTerminate && (
            <button
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
              onClick={() => {
                agentAction.mutate("terminate");
                setMoreOpen(false);
              }}
            >
              <Trash2 className="h-3 w-3" />
              Terminate
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
