import { useEffect, useState, type FormEvent } from "react";
import { Clock3, RefreshCw, Save, Trash2, Webhook, Zap } from "lucide-react";
import type { RoutineTrigger } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getScheduleCronValidation, ScheduleEditor } from "./ScheduleEditor";
import { buildRoutineTriggerPatch } from "../lib/routine-trigger-patch";
import { describeCron } from "../lib/cron-readable";

const signingModes = ["bearer", "hmac_sha256", "github_hmac", "none"];
const SIGNING_MODES_WITHOUT_REPLAY_WINDOW = new Set(["github_hmac", "none"]);

function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * Single trigger card with its own field-edit + save state (§3.2). Extracted
 * from the previous inline `TriggerEditor` in `RoutineDetail.tsx` — same logic.
 */
export function RoutineTriggerCard({
  trigger,
  onSave,
  onRotate,
  onDelete,
  isPending = false,
}: {
  trigger: RoutineTrigger;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onRotate: (id: string) => void;
  onDelete: (id: string) => void;
  isPending?: boolean;
}) {
  const [draft, setDraft] = useState({
    label: trigger.label ?? "",
    cronExpression: trigger.cronExpression ?? "",
    signingMode: trigger.signingMode ?? "bearer",
    replayWindowSec: String(trigger.replayWindowSec ?? 300),
  });
  const [scheduleIsValid, setScheduleIsValid] = useState(
    () =>
      trigger.kind !== "schedule"
      || getScheduleCronValidation(trigger.cronExpression ?? "").valid,
  );

  useEffect(() => {
    setDraft({
      label: trigger.label ?? "",
      cronExpression: trigger.cronExpression ?? "",
      signingMode: trigger.signingMode ?? "bearer",
      replayWindowSec: String(trigger.replayWindowSec ?? 300),
    });
    setScheduleIsValid(
      trigger.kind !== "schedule"
      || getScheduleCronValidation(trigger.cronExpression ?? "").valid,
    );
  }, [trigger]);

  const KindIcon =
    trigger.kind === "schedule" ? Clock3 : trigger.kind === "webhook" ? Webhook : Zap;
  const humanCron = trigger.kind === "schedule" ? describeCron(draft.cronExpression) : null;
  const lastResultOk =
    trigger.lastResult != null &&
    /succeed|success|ok|200|delivered/i.test(String(trigger.lastResult));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending || !scheduleIsValid) return;
    onSave(trigger.id, buildRoutineTriggerPatch(trigger, draft, getLocalTimezone()));
  }

  return (
    <form
      aria-busy={isPending}
      aria-label={`Trigger: ${trigger.label ?? trigger.kind}`}
      className="space-y-4 rounded-lg border border-border p-4"
      onSubmit={handleSubmit}
    >
      <fieldset
        aria-label="Trigger settings"
        className="m-0 min-w-0 border-0 p-0"
        disabled={isPending}
      >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KindIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{trigger.label ?? trigger.kind}</span>
          </div>
          {humanCron ? (
            <p id={`cron-readable-${trigger.id}`} className="text-xs text-muted-foreground">
              {humanCron}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {trigger.lastResult ? (
            <Badge variant={lastResultOk ? "secondary" : "destructive"}>
              {String(trigger.lastResult)}
            </Badge>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {trigger.kind === "schedule" && trigger.nextRunAt
              ? `Next: ${new Date(trigger.nextRunAt).toLocaleString()}`
              : trigger.kind === "webhook"
                ? "Webhook"
                : "API"}
          </span>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`routine-trigger-${trigger.id}-label`} className="text-xs">Label</Label>
          <Input
            id={`routine-trigger-${trigger.id}-label`}
            value={draft.label}
            disabled={isPending}
            onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
          />
        </div>
        {trigger.kind === "schedule" && (
          <div className="space-y-1.5 md:col-span-2">
            <Label className="text-xs">Schedule</Label>
            <ScheduleEditor
              value={draft.cronExpression}
              onChange={(cronExpression) =>
                setDraft((current) => ({ ...current, cronExpression }))
              }
              onValidityChange={setScheduleIsValid}
            />
          </div>
        )}
        {trigger.kind === "webhook" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">Signing mode</Label>
              <Select
                value={draft.signingMode}
                onValueChange={(signingMode) =>
                  setDraft((current) => ({ ...current, signingMode }))
                }
                disabled={isPending}
              >
                <SelectTrigger aria-label="Signing mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {signingModes.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {mode}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!SIGNING_MODES_WITHOUT_REPLAY_WINDOW.has(draft.signingMode) && (
              <div className="space-y-1.5">
                <Label htmlFor={`routine-trigger-${trigger.id}-replay-window`} className="text-xs">
                  Replay window (seconds)
                </Label>
                <Input
                  id={`routine-trigger-${trigger.id}-replay-window`}
                  type="number"
                  min="0"
                  step="1"
                  value={draft.replayWindowSec}
                  disabled={isPending}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, replayWindowSec: event.target.value }))
                  }
                />
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mr-auto text-muted-foreground hover:text-destructive"
            disabled={isPending}
            onClick={() => onDelete(trigger.id)}
          >
            <Trash2 data-icon="inline-start" className="mr-1.5 h-3.5 w-3.5" />
            Delete
          </Button>
          {trigger.kind === "webhook" && (
            <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => onRotate(trigger.id)}>
              <RefreshCw data-icon="inline-start" className="mr-1.5 h-3.5 w-3.5" />
              Rotate secret
            </Button>
          )}
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={isPending || !scheduleIsValid}
          >
            <Save data-icon="inline-start" className="mr-1.5 h-3.5 w-3.5" />
            Save trigger
          </Button>
      </div>
      </fieldset>
      {isPending ? (
        <p aria-live="polite" role="status" className="mt-2 text-xs text-muted-foreground">
          Saving trigger…
        </p>
      ) : null}
    </form>
  );
}
