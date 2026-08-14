import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Clock3, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { RoutineTriggerCard } from "../RoutineTriggerCard";
import { ScheduleEditor, getScheduleCronValidation } from "../ScheduleEditor";
import { createDefaultNewTrigger, useRoutineDetail } from "./context";

const triggerKinds = ["schedule", "webhook"];

const signingModes = ["bearer", "hmac_sha256", "github_hmac", "none"];

const signingModeDescriptions: Record<string, string> = {
  bearer: "Expect a shared bearer token in the Authorization header.",
  hmac_sha256: "Expect an HMAC SHA-256 signature over the request using the shared secret.",
  github_hmac: "Accept X-Paperclip-Signature: sha256=<hex> (HMAC over raw body, no timestamp).",
  none: "No authentication — the webhook URL itself acts as a shared secret.",
};

const SIGNING_MODES_WITHOUT_REPLAY_WINDOW = new Set(["github_hmac", "none"]);

export function TriggersSection() {
  const ctx = useRoutineDetail();
  const { routine, newTrigger, setNewTrigger, createTrigger, updateTrigger, deleteTrigger, rotateTrigger } =
    ctx;
  const [addOpen, setAddOpen] = useState(false);
  const [newScheduleEditorValid, setNewScheduleEditorValid] = useState(true);
  const newScheduleValidation = useMemo(
    () => (newTrigger.kind === "schedule" ? getScheduleCronValidation(newTrigger.cronExpression) : null),
    [newTrigger.cronExpression, newTrigger.kind],
  );
  const addDisabled =
    createTrigger.isPending ||
    (newScheduleValidation ? !newScheduleValidation.valid || !newScheduleEditorValid : false);

  useEffect(() => {
    if (newTrigger.kind !== "schedule") setNewScheduleEditorValid(true);
  }, [newTrigger.kind]);

  return (
    <div className="space-y-4">
      <Collapsible open={addOpen} onOpenChange={setAddOpen}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-muted-foreground">
            {routine.triggers.length === 0
              ? "No triggers yet"
              : `${routine.triggers.length} trigger${routine.triggers.length === 1 ? "" : "s"}`}
          </p>
          <CollapsibleTrigger asChild>
            <Button size="sm" variant={addOpen ? "secondary" : "default"}>
              {addOpen ? <X /> : <Plus />}
              {addOpen ? "Cancel" : "New trigger"}
            </Button>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent className="pt-4">
          <Card className="gap-4 py-4">
            <CardHeader className="px-4">
              <CardTitle>Add trigger</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 px-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="new-trigger-kind">Kind</FieldLabel>
                <Select
                  value={newTrigger.kind}
                  onValueChange={(kind) => setNewTrigger((current) => ({ ...current, kind }))}
                >
                  <SelectTrigger id="new-trigger-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {triggerKinds.map((kind) => (
                      <SelectItem key={kind} value={kind} disabled={kind === "webhook"}>
                        {kind}
                        {kind === "webhook" ? " — COMING SOON" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {newTrigger.kind === "schedule" && (
                <Field className="md:col-span-2">
                  <FieldLabel>Schedule</FieldLabel>
                  <ScheduleEditor
                    value={newTrigger.cronExpression}
                    onChange={(cronExpression) =>
                      setNewTrigger((current) => ({
                        ...current,
                        cronExpression,
                      }))
                    }
                    onValidityChange={setNewScheduleEditorValid}
                  />
                </Field>
              )}
              {newTrigger.kind === "webhook" && (
                <>
                  <Field>
                    <FieldLabel htmlFor="new-trigger-signing-mode">Signing mode</FieldLabel>
                    <Select
                      value={newTrigger.signingMode}
                      onValueChange={(signingMode) =>
                        setNewTrigger((current) => ({
                          ...current,
                          signingMode,
                        }))
                      }
                    >
                      <SelectTrigger id="new-trigger-signing-mode">
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
                    <FieldDescription>{signingModeDescriptions[newTrigger.signingMode]}</FieldDescription>
                  </Field>
                  {!SIGNING_MODES_WITHOUT_REPLAY_WINDOW.has(newTrigger.signingMode) && (
                    <Field>
                      <FieldLabel htmlFor="new-trigger-replay-window">Replay window (seconds)</FieldLabel>
                      <Input
                        id="new-trigger-replay-window"
                        type="number"
                        min="0"
                        step="1"
                        value={newTrigger.replayWindowSec}
                        onChange={(event) =>
                          setNewTrigger((current) => ({
                            ...current,
                            replayWindowSec: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  )}
                </>
              )}
            </CardContent>
            <CardFooter className="justify-end gap-2 px-4">
              {createTrigger.isPending ? (
                <p role="status" className="mr-auto text-xs text-muted-foreground">
                  Adding trigger…
                </p>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  createTrigger.mutate(undefined, {
                    onSuccess: () => {
                      setNewTrigger(createDefaultNewTrigger());
                      setAddOpen(false);
                    },
                  })
                }
                disabled={addDisabled}
              >
                {createTrigger.isPending ? "Adding..." : "Add trigger"}
              </Button>
            </CardFooter>
          </Card>
        </CollapsibleContent>
      </Collapsible>

      {routine.triggers.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Clock3 />
            </EmptyMedia>
            <EmptyTitle>No triggers yet</EmptyTitle>
          </EmptyHeader>
          <Button onClick={() => setAddOpen(true)}>Add a schedule</Button>
        </Empty>
      ) : (
        <div className="space-y-3">
          {routine.triggers.map((trigger) => (
            <RoutineTriggerCard
              key={trigger.id}
              trigger={trigger}
              onSave={(id, patch) => updateTrigger.mutate({ id, patch })}
              onRotate={(id) => rotateTrigger.mutate(id)}
              onDelete={(id) => deleteTrigger.mutate(id)}
              isPending={updateTrigger.isPending || rotateTrigger.isPending || deleteTrigger.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}
