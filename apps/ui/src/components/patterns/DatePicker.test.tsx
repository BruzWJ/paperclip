// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Calendar } from "@/components/ui/calendar";
import { DatePicker, dateFromValue, dateToValue, joinDateTimeValue, splitDateTimeValue } from "./DatePicker";

describe("DatePicker", () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    container?.remove();
    container = undefined;
  });

  it("keeps YYYY-MM-DD values on their local calendar date", () => {
    const date = dateFromValue("2024-02-29");

    expect(date).toBeDefined();
    expect(date && dateToValue(date)).toBe("2024-02-29");
    expect(dateFromValue("2025-02-29")).toBeUndefined();
  });

  it("only joins complete valid date-time values", () => {
    expect(splitDateTimeValue("2026-06-26T09:30")).toEqual({ date: "2026-06-26", time: "09:30" });
    expect(splitDateTimeValue("2026-06-26T25:30")).toEqual({ date: "", time: "" });
    expect(joinDateTimeValue({ date: "2026-06-26", time: "09:30" })).toBe("2026-06-26T09:30");
    expect(joinDateTimeValue({ date: "2026-06-26", time: "" })).toBe("");
  });

  it("formats the selected date in the shadcn trigger", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(<DatePicker value="2026-06-26" onValueChange={() => undefined} ariaLabel="Target date" />);
    });

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Target date"]');
    expect(trigger?.textContent).toContain("June 26th, 2026");

    flushSync(() => root.unmount());
  });

  it("uses the shared Select primitive for month and year navigation", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(<Calendar mode="single" captionLayout="dropdown" />);
    });

    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.querySelectorAll('[data-slot="select-trigger"]')).toHaveLength(2);

    flushSync(() => root.unmount());
  });
});
