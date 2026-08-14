import { unprocessable } from "../errors.js";

export const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// Constructing an Intl.DateTimeFormat costs ~1ms of ICU work, and
// computeNextRun calls getZonedMinuteParts once per minute-step (up to
// 366*24*60*5 iterations for sparse schedules), which can block the event
// loop for minutes per scheduler tick. Formatter instances are immutable,
// so cache one per timezone. See #8033.
const zonedMinuteFormatterCache = new Map<string, Intl.DateTimeFormat>();

export function getZonedMinuteFormatter(timeZone: string) {
  let formatter = zonedMinuteFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    zonedMinuteFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function assertTimeZone(timeZone: string) {
  try {
    getZonedMinuteFormatter(timeZone).format(new Date());
  } catch {
    throw unprocessable(`Invalid timezone: ${timeZone}`);
  }
}

export function floorToMinute(date: Date) {
  const copy = new Date(date.getTime());
  copy.setUTCSeconds(0, 0);
  return copy;
}
