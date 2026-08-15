import * as React from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const DATE_VALUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const TIME_VALUE_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export interface DateRangeValue {
  from: string;
  to: string;
}

function isDateValue(value: string): boolean {
  return DATE_VALUE_PATTERN.test(value);
}

/** Parses a YYYY-MM-DD value as a local calendar date without a UTC offset shift. */
export function dateFromValue(value: string | null | undefined): Date | undefined {
  if (!value || !isDateValue(value)) return undefined;

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return format(date, "yyyy-MM-dd") === value ? date : undefined;
}

/** Formats a calendar date for the API's YYYY-MM-DD date-only fields. */
export function dateToValue(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

export function splitDateTimeValue(value: string | null | undefined) {
  const [date = "", rawTime = ""] = value?.split("T") ?? [];
  const time = rawTime.slice(0, 5);

  if (!dateFromValue(date) || !TIME_VALUE_PATTERN.test(time)) {
    return { date: "", time: "" };
  }

  return { date, time };
}

export function joinDateTimeValue(value: { date: string; time: string }): string {
  return dateFromValue(value.date) && TIME_VALUE_PATTERN.test(value.time)
    ? `${value.date}T${value.time}`
    : "";
}

type PickerButtonSize = React.ComponentProps<typeof Button>["size"];
type PickerPopoverAlign = React.ComponentProps<typeof PopoverContent>["align"];

export interface DatePickerProps {
  value?: string | null;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  id?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  size?: PickerButtonSize;
  align?: PickerPopoverAlign;
}

/** Native shadcn composition of Popover, Button, and Calendar for YYYY-MM-DD values. */
export function DatePicker({
  value,
  onValueChange,
  ariaLabel,
  id,
  placeholder = "Select date",
  className,
  disabled,
  size,
  align = "start",
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const selectedDate = dateFromValue(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          size={size}
          disabled={disabled}
          aria-label={ariaLabel}
          data-empty={!selectedDate}
          className={cn(
            "w-full justify-start text-left font-normal data-[empty=true]:text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon aria-hidden="true" />
          <span className="truncate">{selectedDate ? format(selectedDate, "PPP") : placeholder}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto overflow-hidden p-0" align={align}>
        <Calendar
          mode="single"
          selected={selectedDate}
          defaultMonth={selectedDate}
          captionLayout="dropdown"
          onSelect={(nextDate: Date | undefined) => {
            onValueChange(nextDate ? dateToValue(nextDate) : "");
            if (nextDate) setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface DateRangePickerProps {
  value: DateRangeValue;
  onValueChange: (value: DateRangeValue) => void;
  ariaLabel: string;
  id?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  size?: PickerButtonSize;
  align?: PickerPopoverAlign;
}

/** Native shadcn Calendar range composition for paired YYYY-MM-DD values. */
export function DateRangePicker({
  value,
  onValueChange,
  ariaLabel,
  id,
  placeholder = "Select date range",
  className,
  disabled,
  size,
  align = "start",
}: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false);
  const from = dateFromValue(value.from);
  const to = dateFromValue(value.to);
  const selectedRange = from ? { from, ...(to ? { to } : {}) } : undefined;
  const label = from
    ? to
      ? `${format(from, "LLL d, y")} – ${format(to, "LLL d, y")}`
      : `${format(from, "LLL d, y")} – Select end date`
    : placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          size={size}
          disabled={disabled}
          aria-label={ariaLabel}
          data-empty={!from}
          className={cn(
            "w-full justify-start text-left font-normal data-[empty=true]:text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon aria-hidden="true" />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto overflow-hidden p-0" align={align}>
        <Calendar
          mode="range"
          selected={selectedRange}
          defaultMonth={from ?? to}
          captionLayout="dropdown"
          onSelect={(nextRange: DateRange | undefined) => {
            const nextValue = {
              from: nextRange?.from ? dateToValue(nextRange.from) : "",
              to: nextRange?.to ? dateToValue(nextRange.to) : "",
            };
            onValueChange(nextValue);
            if (nextRange?.from && nextRange.to) setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface TimePickerProps extends Omit<
  React.ComponentProps<typeof Input>,
  "type" | "value" | "onChange" | "aria-label"
> {
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
}

/** Native shadcn Input time field, kept consistent with the date-picker time composition. */
export function TimePicker({ value, onValueChange, ariaLabel, ...props }: TimePickerProps) {
  return (
    <Input
      {...props}
      type="time"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      aria-label={ariaLabel}
    />
  );
}

export interface DateTimePickerProps {
  value?: string | null;
  onValueChange: (value: string) => void;
  dateAriaLabel: string;
  timeAriaLabel: string;
  id?: string;
  className?: string;
  datePickerClassName?: string;
  timeInputClassName?: string;
  disabled?: boolean;
  size?: PickerButtonSize;
}

/** Native shadcn date picker paired with the documented shadcn Input time field. */
export function DateTimePicker({
  value,
  onValueChange,
  dateAriaLabel,
  timeAriaLabel,
  id,
  className,
  datePickerClassName,
  timeInputClassName,
  disabled,
  size,
}: DateTimePickerProps) {
  const [draft, setDraft] = React.useState(() => splitDateTimeValue(value));

  React.useEffect(() => {
    setDraft(splitDateTimeValue(value));
  }, [value]);

  const updateDraft = (nextDraft: { date: string; time: string }) => {
    setDraft(nextDraft);
    onValueChange(joinDateTimeValue(nextDraft));
  };

  return (
    <div className={cn("flex min-w-0 flex-1 flex-col gap-2 sm:flex-row", className)}>
      <DatePicker
        id={id}
        value={draft.date}
        onValueChange={(date) => updateDraft({ ...draft, date })}
        ariaLabel={dateAriaLabel}
        disabled={disabled}
        size={size}
        className={cn("min-w-0 flex-1", datePickerClassName)}
      />
      <TimePicker
        id={id ? `${id}-time` : undefined}
        value={draft.time}
        onValueChange={(time) => updateDraft({ ...draft, time })}
        ariaLabel={timeAriaLabel}
        disabled={disabled}
        className={cn("w-full sm:w-(--sz-150px)", timeInputClassName)}
      />
    </div>
  );
}
