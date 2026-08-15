import { AlarmClock } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";

const HOUR_MS = 60 * 60 * 1000;

const DAY_MS = 24 * HOUR_MS;

/** Tomorrow at 9am local time. */
export function tomorrowMorningIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/** Snooze presets, resolved to a future ISO timestamp at click time. */
export const SNOOZE_PRESETS: ReadonlyArray<{
  label: string;
  resolve: () => string;
}> = [
  {
    label: "1 hour",
    resolve: () => new Date(Date.now() + HOUR_MS).toISOString(),
  },
  {
    label: "4 hours",
    resolve: () => new Date(Date.now() + 4 * HOUR_MS).toISOString(),
  },
  { label: "Tomorrow morning", resolve: tomorrowMorningIso },
  {
    label: "Next week",
    resolve: () => new Date(Date.now() + 7 * DAY_MS).toISOString(),
  },
];

/** Snooze submenu: presets + a custom date-time (plan §6). */
export function SnoozeSubmenu({ onSnooze }: { onSnooze: (snoozedUntil: string) => void }) {
  const [customDate, setCustomDate] = useState("");
  const [customTime, setCustomTime] = useState("");
  const applyCustom = () => {
    if (!customDate || !customTime) return;
    const ts = new Date(`${customDate}T${customTime}`);
    if (Number.isNaN(ts.getTime())) return;
    onSnooze(ts.toISOString());
  };
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <AlarmClock className="h-4 w-4" />
        Snooze
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {SNOOZE_PRESETS.map((preset) => (
          <DropdownMenuItem key={preset.label} onClick={() => onSnooze(preset.resolve())}>
            {preset.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <LabeledFormField className="gap-1.5 px-2 py-1.5" label="Custom">
          <div className="flex flex-col gap-1.5">
            <Input
              type="date"
              value={customDate}
              onChange={(event) => setCustomDate(event.target.value)}
              aria-label="Snooze date"
              className="w-full"
            />
            <Input
              id="attention-snooze-time"
              type="time"
              value={customTime}
              onChange={(e) => setCustomTime(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="h-auto rounded-sm bg-background px-2 py-1 text-xs shadow-none"
            />
            <Button
              type="button"
              size="xs"
              disabled={!customDate || !customTime}
              onClick={(event) => {
                event.stopPropagation();
                applyCustom();
              }}
            >
              Snooze until…
            </Button>
          </div>
        </LabeledFormField>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Compact "when does this snooze end" label, e.g. `in 2h`, `in 3d`. */
export function reappearLabel(snoozedUntil: string): string {
  const diffMs = new Date(snoozedUntil).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "soon";
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `in ${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  return `in ${diffDay}d`;
}
