import { useEffect, useState } from "react";
import { AlertTriangle, RotateCcw, TimerReset } from "lucide-react";
import { healthApi, type DevServerHealthStatus } from "../api/health";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const RESTART_PENDING_RESET_MS = 30_000;

function formatRelativeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "just now";
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  return `${Math.round(deltaHours / 24)}d ago`;
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  const [restartPending, setRestartPending] = useState(false);

  useEffect(() => {
    if (!restartPending) return;
    const timeout = window.setTimeout(() => {
      setRestartPending(false);
    }, RESTART_PENDING_RESET_MS);
    return () => window.clearTimeout(timeout);
  }, [restartPending]);

  if (!devServer?.enabled || !devServer.restartRequired) return null;

  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt);
  const sample = devServer.changedPathsSample.slice(0, 3);
  const activeRunCount = devServer.activeRunCount;
  const activeRunLabel = `${activeRunCount} live run${activeRunCount === 1 ? "" : "s"}`;
  const restartWarning =
    activeRunCount > 0
      ? `Restarting may interrupt ${activeRunLabel}.`
      : "The local development server will restart to apply backend changes.";

  async function requestRestartNow() {
    setRestartPending(true);
    try {
      await healthApi.requestDevServerRestart();
    } catch (error) {
      setRestartPending(false);
      toast.error("Restart request failed", {
        description: error instanceof Error ? error.message : "Failed to request restart",
      });
    }
  }

  return (
    <Alert className="rounded-none border-x-0 border-t-0">
      <AlertTriangle />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        Restart required
        {devServer.autoRestartEnabled ? <Badge variant="secondary">Auto-restart on</Badge> : null}
      </AlertTitle>
      <AlertDescription className="w-full">
        <div className="flex w-full flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <p className="mt-1 text-sm">
              Backend files changed since this server booted
              {changedAt ? ` · updated ${changedAt}` : ""}
            </p>
            {sample.length > 0 ? (
              <div className="mt-2 text-xs text-muted-foreground">
                Changed: {sample.join(", ")}
                {devServer.changedPathCount > sample.length
                  ? ` +${devServer.changedPathCount - sample.length} more`
                  : ""}
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <Badge variant="secondary">
              {devServer.waitingForIdle ? (
                <>
                  <TimerReset className="h-3.5 w-3.5" />
                  <span>Waiting for {activeRunLabel} to finish</span>
                </>
              ) : devServer.autoRestartEnabled ? (
                <>
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Auto-restart will trigger when the instance is idle</span>
                </>
              ) : (
                <>
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Restart after active work is safe to interrupt</span>
                </>
              )}
            </Badge>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" className="h-auto gap-2 px-3 py-1.5 text-xs" disabled={restartPending}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>{restartPending ? "Restart requested" : "Restart now"}</span>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Restart Paperclip now?</AlertDialogTitle>
                  <AlertDialogDescription>{restartWarning}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void requestRestartNow()}>Restart now</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </AlertDescription>
    </Alert>
  );
}
