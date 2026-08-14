import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import type { RoutineDetail as RoutineDetailType } from "@paperclipai/shared";
import { ArrowRight } from "lucide-react";
import { useId, useMemo } from "react";
import { nextCronFires, previewFirePolicies } from "../../lib/cron-fires";
import { useRoutineDetail } from "./context";

const concurrencyPolicyOptions = [
  {
    value: "coalesce_if_active",
    title: "Coalesce if active",
    description: "Keep one follow-up run queued while an active run is still working.",
  },
  {
    value: "always_enqueue",
    title: "Always enqueue",
    description: "Queue every trigger occurrence, even if several runs stack up.",
  },
  {
    value: "skip_if_active",
    title: "Skip if active",
    description: "Drop overlapping trigger occurrences while the routine is already active.",
  },
];

const catchUpPolicyOptions = [
  {
    value: "skip_missed",
    title: "Skip missed",
    description: "Ignore schedule windows that were missed while paused.",
  },
  {
    value: "enqueue_missed_with_cap",
    title: "Enqueue missed with cap",
    description:
      "Catch up missed schedule windows after recovery; sub-hourly schedules are combined into one catch-up run, slower schedules replay each missed window up to a cap.",
  },
];

export function DeliverySection() {
  const ctx = useRoutineDetail();
  const { editDraft, setEditDraft, routine } = ctx;
  const policyControlId = useId();

  return (
    <div className="space-y-6">
      <FieldSet>
        <FieldLegend variant="label">Concurrency</FieldLegend>
        <RadioGroup
          value={editDraft.concurrencyPolicy}
          onValueChange={(concurrencyPolicy) =>
            setEditDraft((current) => ({ ...current, concurrencyPolicy }))
          }
        >
          {concurrencyPolicyOptions.map((option) => (
            <FieldLabel key={option.value} htmlFor={`${policyControlId}-concurrency-${option.value}`}>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>{option.title}</FieldTitle>
                  <FieldDescription>{option.description}</FieldDescription>
                </FieldContent>
                <RadioGroupItem value={option.value} id={`${policyControlId}-concurrency-${option.value}`} />
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend variant="label">Catch-up</FieldLegend>
        <RadioGroup
          value={editDraft.catchUpPolicy}
          onValueChange={(catchUpPolicy) => setEditDraft((current) => ({ ...current, catchUpPolicy }))}
        >
          {catchUpPolicyOptions.map((option) => (
            <FieldLabel key={option.value} htmlFor={`${policyControlId}-catch-up-${option.value}`}>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>{option.title}</FieldTitle>
                  <FieldDescription>{option.description}</FieldDescription>
                </FieldContent>
                <RadioGroupItem value={option.value} id={`${policyControlId}-catch-up-${option.value}`} />
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </FieldSet>
      <NextFiresPreview triggers={routine.triggers} concurrencyPolicy={editDraft.concurrencyPolicy} />
    </div>
  );
}

export const dispositionToneClass: Record<string, string> = {
  queued: "text-foreground",
  coalesced: "text-muted-foreground",
  skipped: "text-muted-foreground",
};

/**
 * "Next 5 fires" preview (§3.5) — the strongest "what does this policy mean?"
 * surface. Picks the soonest-firing schedule trigger, computes its next fires
 * client-side, and annotates each with how the chosen concurrency policy would
 * treat it.
 */
export function NextFiresPreview({
  triggers,
  concurrencyPolicy,
}: {
  triggers: RoutineDetailType["triggers"];
  concurrencyPolicy: string;
}) {
  const preview = useMemo(() => {
    const schedule = triggers
      .filter((trigger) => trigger.kind === "schedule" && trigger.enabled && trigger.cronExpression)
      .map((trigger) => {
        const fires = nextCronFires(trigger.cronExpression, 5, {
          timeZone: trigger.timezone ?? "UTC",
        });
        return { trigger, fires };
      })
      .filter((entry) => entry.fires.length > 0)
      .sort((a, b) => a.fires[0]!.getTime() - b.fires[0]!.getTime())[0];
    if (!schedule) return null;
    return {
      timeZone: schedule.trigger.timezone ?? "UTC",
      entries: previewFirePolicies(schedule.fires, concurrencyPolicy),
    };
  }, [triggers, concurrencyPolicy]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Next 5 fires</CardTitle>
        <CardDescription>
          {preview
            ? `Preview assumes the previous run is still in flight. Times shown in ${preview.timeZone}.`
            : "Preview how the selected concurrency policy handles upcoming fires."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {preview ? (
          <ItemGroup className="font-mono">
            {preview.entries.map((entry, index) => (
              <Item key={index} variant="outline" size="sm">
                <ItemContent>
                  <ItemTitle className="tabular-nums">{formatFireTime(entry.at, preview.timeZone)}</ItemTitle>
                  {entry.note ? <ItemDescription>({entry.note})</ItemDescription> : null}
                </ItemContent>
                <ItemMedia>
                  <ArrowRight />
                </ItemMedia>
                <ItemActions>
                  <Badge variant="secondary" className={dispositionToneClass[entry.disposition]}>
                    {entry.label}
                  </Badge>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        ) : (
          <Empty className="p-4">
            <EmptyDescription>
              No enabled schedule trigger to preview. Add a schedule in Triggers to see how this policy treats
              upcoming fires.
            </EmptyDescription>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}

export function formatFireTime(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(date)
      .replace(",", "");
  } catch {
    return date.toISOString();
  }
}
