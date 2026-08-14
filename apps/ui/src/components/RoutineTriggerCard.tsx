import { useEffect, useState, type FormEvent } from "react";
import { Clock3, RefreshCw, Save, Trash2, Webhook, Zap } from "lucide-react";
import type { RoutineTrigger } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getScheduleCronValidation, ScheduleEditor } from "./ScheduleEditor";
import { buildRoutineTriggerPatch } from "../lib/routine-trigger-patch";
import { describeCron } from "../lib/cron-readable";
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
    () => trigger.kind !== "schedule" || getScheduleCronValidation(trigger.cronExpression ?? "").valid,
  );

  useEffect(() => {
    setDraft({
      label: trigger.label ?? "",
      cronExpression: trigger.cronExpression ?? "",
      signingMode: trigger.signingMode ?? "bearer",
      replayWindowSec: String(trigger.replayWindowSec ?? 300),
    });
    setScheduleIsValid(
      trigger.kind !== "schedule" || getScheduleCronValidation(trigger.cronExpression ?? "").valid,
    );
  }, [trigger]);

  const KindIcon = trigger.kind === "schedule" ? Clock3 : trigger.kind === "webhook" ? Webhook : Zap;
  const humanCron = trigger.kind === "schedule" ? describeCron(draft.cronExpression) : null;
  const lastResultOk =
    trigger.lastResult != null && /succeed|success|ok|200|delivered/i.test(String(trigger.lastResult));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending || !scheduleIsValid) return;
    onSave(trigger.id, buildRoutineTriggerPatch(trigger, draft, getLocalTimezone()));
  }

  return (
    <form
      aria-busy={isPending}
      aria-label={`Trigger: ${trigger.label ?? trigger.kind}`}
      onSubmit={handleSubmit}
    >
      <Card>
        <FieldSet aria-label="Trigger settings" className="gap-6" disabled={isPending}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KindIcon className="size-4" />
              <span className="truncate">{trigger.label ?? trigger.kind}</span>
            </CardTitle>
            <CardDescription id={`cron-readable-${trigger.id}`}>
              {humanCron ?? "Trigger settings"}
            </CardDescription>
            <CardAction className="flex items-center gap-2">
              {trigger.lastResult ? (
                <Badge variant={lastResultOk ? "secondary" : "destructive"}>
                  {String(trigger.lastResult)}
                </Badge>
              ) : null}
              <span className="text-sm text-muted-foreground">
                {trigger.kind === "schedule" && trigger.nextRunAt
                  ? `Next: ${new Date(trigger.nextRunAt).toLocaleString()}`
                  : trigger.kind === "webhook"
                    ? "Webhook"
                    : "API"}
              </span>
            </CardAction>
          </CardHeader>

          <CardContent>
            <FieldGroup className="grid gap-3 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`routine-trigger-${trigger.id}-label`}>Label</FieldLabel>
                <Input
                  id={`routine-trigger-${trigger.id}-label`}
                  value={draft.label}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      label: event.target.value,
                    }))
                  }
                />
              </Field>
              {trigger.kind === "schedule" && (
                <Field className="md:col-span-2">
                  <FieldLabel>Schedule</FieldLabel>
                  <ScheduleEditor
                    value={draft.cronExpression}
                    onChange={(cronExpression) => setDraft((current) => ({ ...current, cronExpression }))}
                    onValidityChange={setScheduleIsValid}
                  />
                </Field>
              )}
              {trigger.kind === "webhook" && (
                <>
                  <Field>
                    <FieldLabel>Signing mode</FieldLabel>
                    <Select
                      value={draft.signingMode}
                      onValueChange={(signingMode) => setDraft((current) => ({ ...current, signingMode }))}
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
                  </Field>
                  {!SIGNING_MODES_WITHOUT_REPLAY_WINDOW.has(draft.signingMode) && (
                    <Field>
                      <FieldLabel htmlFor={`routine-trigger-${trigger.id}-replay-window`}>
                        Replay window (seconds)
                      </FieldLabel>
                      <Input
                        id={`routine-trigger-${trigger.id}-replay-window`}
                        type="number"
                        min="0"
                        step="1"
                        value={draft.replayWindowSec}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            replayWindowSec: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  )}
                </>
              )}
            </FieldGroup>
          </CardContent>

          <CardFooter className="gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="mr-auto">
                  <Trash2 data-icon="inline-start" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete trigger?</AlertDialogTitle>
                  <AlertDialogDescription>This removes the trigger from the routine.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={isPending}
                    onClick={() => onDelete(trigger.id)}
                  >
                    Delete trigger
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {trigger.kind === "webhook" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isPending}
                onClick={() => onRotate(trigger.id)}
              >
                <RefreshCw data-icon="inline-start" />
                Rotate secret
              </Button>
            )}
            <Button type="submit" variant="outline" size="sm" disabled={isPending || !scheduleIsValid}>
              {isPending ? <Spinner /> : <Save data-icon="inline-start" />}
              {isPending ? "Saving…" : "Save trigger"}
            </Button>
          </CardFooter>
        </FieldSet>
      </Card>
    </form>
  );
}
