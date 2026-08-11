import { Flag } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";

interface TaskOwnerBacklogNoticeProps {
  taskStatus: string;
  ownerAgent: Agent | null;
  ownerUserId?: string | null;
  onResume?: () => void;
  resuming?: boolean;
}

export function TaskOwnerBacklogNotice({
  taskStatus,
  ownerAgent,
  ownerUserId,
  onResume,
  resuming,
}: TaskOwnerBacklogNoticeProps) {
  if (taskStatus !== "backlog") return null;
  if (!ownerAgent && !ownerUserId) return null;

  const ownerLabel = ownerAgent?.name ?? "the user owner";

  return (
    <div
      data-testid="task-owner-backlog-notice"
      data-task-status={taskStatus}
      className="mb-3 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2.5 text-sm text-amber-950 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <Flag className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="leading-5">
            <span className="font-medium">Parked</span> —{" "}
            <span className="font-medium">{ownerLabel}</span> will not receive status-driven dispatch until status changes to{" "}
            <code className="rounded bg-amber-100 px-1 py-0.5 text-xs dark:bg-amber-400/15">todo</code> or{" "}
            <code className="rounded bg-amber-100 px-1 py-0.5 text-xs dark:bg-amber-400/15">in_progress</code>.
          </p>
          {ownerAgent ? (
            <p className="text-xs leading-5 text-amber-800 dark:text-amber-200">
              An explicit @mention can queue the owner for questions or triage. Ordinary comments remain non-dispatching.
            </p>
          ) : null}
          {onResume ? (
            <div className="pt-0.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-amber-400/70 bg-background/80 text-amber-950 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15"
                onClick={onResume}
                disabled={resuming}
                data-testid="task-owner-backlog-resume"
              >
                {resuming ? "Resuming…" : "Resume now"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
