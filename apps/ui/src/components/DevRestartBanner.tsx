import { useEffect, useState } from "react";
import { AlertTriangle, RotateCcw, TimerReset } from "lucide-react";
import { healthApi, type DevServerHealthStatus } from "../api/health";
import { Badge } from "@/components/ui/badge";

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
  const activeRunLabel = `${activeRunCount} live run${
    activeRunCount === 1 ? "" : "s"
  }`;

  async function requestRestartNow() {
    const warning =
      activeRunCount > 0
        ? `Restart Paperclip now? This may interrupt ${activeRunLabel}.`
        : "Restart Paperclip now?";
    if (!window.confirm(warning)) return;

    setRestartPending(true);
    try {
      await healthApi.requestDevServerRestart();
    } catch (error) {
      setRestartPending(false);
      window.alert(error instanceof Error ? error.message : "Failed to request restart");
    }
  }

  return (
    <div className="border-b border-border bg-muted/50 text-foreground">
      <div className="flex flex-col gap-3 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-(--tracking-caps)">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>Restart Required</span>
            {devServer.autoRestartEnabled ? (
              <Badge variant="ghost" className="bg-muted text-(length:--text-nano) tracking-(--tracking-eyebrow)">
                Auto-Restart On
              </Badge>
            ) : null}
          </div>
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

        <div className="flex flex-wrap items-center gap-2 text-xs font-medium md:justify-end">
          <div className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5">
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
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void requestRestartNow()}
            disabled={restartPending}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>{restartPending ? "Restart requested" : "Restart now"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
