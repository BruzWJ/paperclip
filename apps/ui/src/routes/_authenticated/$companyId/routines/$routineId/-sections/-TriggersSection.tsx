import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Clock3, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { RoutineTriggerCard } from "../-detail/-RoutineTriggerCard";
import { ScheduleEditor, getScheduleCronValidation } from "../-detail/-ScheduleEditor";
import { createDefaultNewTrigger, useRoutineDetail } from "./-context";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { RoutineSigningFields } from "@/routes/_authenticated/$companyId/routines/$routineId/-detail/-RoutineSigningFields";

const triggerKinds = ["schedule", "webhook"];

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
              {addOpen ? <X  data-icon="inline-start"/> : <Plus  data-icon="inline-start"/>}
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
              <LabeledFormField label="Kind" labelFor="new-trigger-kind">
                <Select
                  value={newTrigger.kind}
                  onValueChange={(kind) => setNewTrigger((current) => ({ ...current, kind }))}
                >
                  <SelectTrigger id="new-trigger-kind" aria-label="Trigger kind">
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
              </LabeledFormField>
              {newTrigger.kind === "schedule" && (
                <LabeledFormField className="md:col-span-2" label="Schedule">
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
                </LabeledFormField>
              )}
              {newTrigger.kind === "webhook" && (
                <RoutineSigningFields
                  describeMode
                  idPrefix="new-trigger"
                  signingMode={newTrigger.signingMode}
                  replayWindowSec={newTrigger.replayWindowSec}
                  onSigningModeChange={(signingMode) =>
                    setNewTrigger((current) => ({ ...current, signingMode }))
                  }
                  onReplayWindowChange={(replayWindowSec) =>
                    setNewTrigger((current) => ({ ...current, replayWindowSec }))
                  }
                />
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
              <Clock3  data-icon="inline-start"/>
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
