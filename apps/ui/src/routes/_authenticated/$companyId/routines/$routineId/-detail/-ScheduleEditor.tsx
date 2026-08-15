import { useEffect, useId, useMemo, useState } from "react";
import { FieldDescription, FieldError, FieldGroup } from "@/components/ui/field";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { nextCronFires, parseCronExpression } from "@/lib/cron-fires";
import type { LabeledValue } from "@/lib/presentation-contracts";

export type SchedulePreset =
  "every_minute" | "every_hour" | "every_day" | "weekdays" | "weekly" | "monthly" | "custom";

const presetLabels: Record<SchedulePreset, string> = {
  every_minute: "Every minute",
  every_hour: "Every hour",
  every_day: "Every day",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom (cron)",
};
const schedulePresets = Object.entries(presetLabels).map(([value, label]) => ({
  value: value as SchedulePreset,
  label,
}));
const scheduleHours = Array.from({ length: 24 }, (_, index) => ({
  value: String(index),
  label: index === 0 ? "12 AM" : index < 12 ? `${index} AM` : index === 12 ? "12 PM" : `${index - 12} PM`,
}));
const scheduleMinutes = Array.from({ length: 12 }, (_, index) => ({
  value: String(index * 5),
  label: String(index * 5).padStart(2, "0"),
}));
const scheduleDaysOfWeek = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label, index) => ({
  value: String((index + 1) % 7),
  label,
}));
const scheduleDaysOfMonth = Array.from({ length: 31 }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
}));
const hasOption = (options: Array<{ value: string }>, value: string) =>
  options.some((option) => option.value === value);

function ScheduleSelect({
  ariaLabel,
  className,
  onValueChange,
  optionPrefix = "",
  options,
  value,
}: {
  ariaLabel: string;
  className: string;
  onValueChange: (value: string) => void;
  optionPrefix?: string;
  options: LabeledValue[];
  value: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={className} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {optionPrefix}
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function parseCronToPreset(cron: string): {
  preset: SchedulePreset;
  hour: string;
  minute: string;
  dayOfWeek: string;
  dayOfMonth: string;
} {
  const defaults = { hour: "10", minute: "0", dayOfWeek: "1", dayOfMonth: "1" };
  const trimmed = cron.trim();
  if (!trimmed) return { preset: "every_day", ...defaults };
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return { preset: "custom", ...defaults };

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const selectableMinute = hasOption(scheduleMinutes, minute);
  const selectableTime = hasOption(scheduleHours, hour) && selectableMinute;

  if (trimmed === "* * * * *") return { preset: "every_minute", ...defaults };
  if (`${hour} ${dayOfMonth} ${month} ${dayOfWeek}` === "* * * *" && selectableMinute)
    return { preset: "every_hour", ...defaults, minute };
  if (`${dayOfMonth} ${month} ${dayOfWeek}` === "* * *" && selectableTime)
    return { preset: "every_day", ...defaults, hour, minute };
  if (`${dayOfMonth} ${month} ${dayOfWeek}` === "* * 1-5" && selectableTime)
    return { preset: "weekdays", ...defaults, hour, minute };
  if (`${dayOfMonth} ${month}` === "* *" && hasOption(scheduleDaysOfWeek, dayOfWeek) && selectableTime)
    return { preset: "weekly", ...defaults, hour, minute, dayOfWeek };
  if (`${month} ${dayOfWeek}` === "* *" && hasOption(scheduleDaysOfMonth, dayOfMonth) && selectableTime)
    return { preset: "monthly", ...defaults, hour, minute, dayOfMonth };
  return { preset: "custom", ...defaults };
}

export function buildCron(
  preset: SchedulePreset,
  hour: string,
  minute: string,
  dayOfWeek: string,
  dayOfMonth: string,
): string {
  return {
    every_minute: "* * * * *",
    every_hour: `${minute} * * * *`,
    every_day: `${minute} ${hour} * * *`,
    weekdays: `${minute} ${hour} * * 1-5`,
    weekly: `${minute} ${hour} * * ${dayOfWeek}`,
    monthly: `${minute} ${hour} ${dayOfMonth} * *`,
    custom: "",
  }[preset];
}

export function getScheduleCronValidation(cron: string): {
  valid: boolean;
  message: string;
  nextFires: Date[];
} {
  const invalid = (message: string) => ({
    valid: false,
    message,
    nextFires: [],
  });
  const trimmed = cron.trim();
  if (!trimmed) return invalid("Enter a 5-field cron expression.");
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return invalid(`Use exactly 5 fields; this has ${fields.length}.`);
  if (!parseCronExpression(trimmed))
    return invalid("Cron fields must use valid numbers, ranges, lists, wildcards, or steps.");

  const nextFires = nextCronFires(trimmed, 3, { timeZone: "UTC" });
  return {
    valid: true,
    message: nextFires.length > 0 ? "Valid cron." : "Valid cron, but no upcoming fires were found.",
    nextFires,
  };
}

export function ScheduleEditor({
  value,
  onChange,
  onValidityChange,
}: {
  value: string;
  onChange: (cron: string) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const customCronId = useId();
  const customCronValidationId = useId();
  const parsed = useMemo(() => parseCronToPreset(value), [value]);
  const [schedule, setSchedule] = useState(parsed);
  const { preset, hour, minute, dayOfWeek, dayOfMonth } = schedule;
  const [customCron, setCustomCron] = useState(preset === "custom" ? value : "");
  const customValidation = useMemo(() => getScheduleCronValidation(customCron), [customCron]);

  useEffect(() => {
    onValidityChange?.(preset !== "custom" || customValidation.valid);
  }, [customValidation.valid, onValidityChange, preset]);

  // Sync from external value changes
  useEffect(() => {
    const p = parseCronToPreset(value);
    setSchedule(p);
    if (p.preset === "custom") setCustomCron(value);
  }, [value]);

  const updateSchedule = (patch: Partial<typeof schedule>) => {
    const next = { ...schedule, ...patch };
    setSchedule(next);
    if (next.preset !== "custom") {
      onChange(buildCron(next.preset, next.hour, next.minute, next.dayOfWeek, next.dayOfMonth));
    }
  };

  const handlePresetChange = (newPreset: SchedulePreset) => {
    if (newPreset === "custom") {
      setSchedule((current) => ({ ...current, preset: newPreset }));
      setCustomCron(value);
    } else {
      updateSchedule({ preset: newPreset });
    }
  };

  return (
    <FieldGroup className="gap-3">
      <LabeledFormField label="Frequency">
        <Select value={preset} onValueChange={(v) => handlePresetChange(v as SchedulePreset)}>
          <SelectTrigger className="w-full" aria-label="Schedule frequency">
            <SelectValue placeholder="Choose frequency..." />
          </SelectTrigger>
          <SelectContent>
            {schedulePresets.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </LabeledFormField>

      {preset === "custom" ? (
        <LabeledFormField
          data-invalid={!customValidation.valid}
          label="Cron expression"
          labelFor={customCronId}
        >
          <Input
            id={customCronId}
            value={customCron}
            onChange={(e) => {
              const nextCron = e.target.value;
              setCustomCron(nextCron);
              // Report validity synchronously with the keystroke so consumers can gate
              // their submit affordance in the same render. Relying solely on the
              // effect below leaves a one-tick window where an invalid draft still
              // reads as valid to the parent.
              const nextValidation = getScheduleCronValidation(nextCron);
              onValidityChange?.(nextValidation.valid);
              if (nextValidation.valid) {
                onChange(nextCron);
              }
            }}
            placeholder="0 10 * * *"
            aria-label="Cron expression"
            aria-invalid={!customValidation.valid}
            aria-describedby={customCronValidationId}
            className="font-mono text-sm"
          />
          <FieldDescription>Five fields: minute hour day-of-month month day-of-week</FieldDescription>
          {customValidation.valid ? (
            <FieldDescription id={customCronValidationId} aria-live="polite">
              {customValidation.message}
              {customValidation.nextFires.length > 0
                ? ` Next: ${customValidation.nextFires.map((fire) => fire.toLocaleString()).join(", ")}.`
                : null}
            </FieldDescription>
          ) : (
            <FieldError id={customCronValidationId} aria-live="polite">
              {customValidation.message}
            </FieldError>
          )}
        </LabeledFormField>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {preset !== "every_minute" && preset !== "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">at</span>
              <ScheduleSelect
                ariaLabel="Hour"
                className="w-(--sz-120px)"
                value={hour}
                options={scheduleHours}
                onValueChange={(next) => updateSchedule({ hour: next })}
              />
              <span className="text-sm text-muted-foreground">:</span>
              <ScheduleSelect
                ariaLabel="Minute"
                className="w-(--sz-80px)"
                value={minute}
                options={scheduleMinutes}
                onValueChange={(next) => updateSchedule({ minute: next })}
              />
            </>
          )}

          {preset === "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">at minute</span>
              <ScheduleSelect
                ariaLabel="Minute"
                className="w-(--sz-80px)"
                value={minute}
                options={scheduleMinutes}
                optionPrefix=":"
                onValueChange={(next) => updateSchedule({ minute: next })}
              />
            </>
          )}

          {preset === "weekly" && (
            <>
              <span className="text-sm text-muted-foreground">on</span>
              <ToggleGroup
                type="single"
                value={dayOfWeek}
                onValueChange={(value) => {
                  if (!value) return;
                  updateSchedule({ dayOfWeek: value });
                }}
                variant="outline"
                aria-label="Day of week"
              >
                {scheduleDaysOfWeek.map((d) => (
                  <ToggleGroupItem key={d.value} value={d.value} className="text-xs">
                    {d.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </>
          )}

          {preset === "monthly" && (
            <>
              <span className="text-sm text-muted-foreground">on day</span>
              <ScheduleSelect
                ariaLabel="Day of month"
                className="w-(--sz-80px)"
                value={dayOfMonth}
                options={scheduleDaysOfMonth}
                onValueChange={(next) => updateSchedule({ dayOfMonth: next })}
              />
            </>
          )}
        </div>
      )}
    </FieldGroup>
  );
}
