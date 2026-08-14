// @vitest-environment jsdom
import { computeLayout } from "@/lib/timeline/layout";
import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import "./WorkTimelineChart.test-support";
import {
  container,
  flushTimelineEffects,
  renderChart,
  timelineSample,
} from "./WorkTimelineChart.test-support";
describe("WorkTimelineChart", () => {
  it("renders date-aware AM/PM labels on the header axis", () => {
    renderChart(timelineSample());
    const timeAxis = container.querySelector<HTMLElement>("[data-testid='work-timeline-time-axis']");
    expect(timeAxis?.textContent).toContain("Jul 2");
    expect(timeAxis?.textContent).toContain("AM");
    expect(timeAxis?.textContent).not.toContain("09:00");
  });
  it("freezes the time axis over vertical scrolling while preserving horizontal alignment", async () => {
    renderChart(timelineSample());
    const scroller = container.querySelector<HTMLElement>("[data-testid='work-timeline-scroll']")!;
    const timeAxis = container.querySelector<HTMLElement>("[data-testid='work-timeline-time-axis']")!;
    const axisSvg = timeAxis.querySelector<SVGSVGElement>("svg")!;
    expect(timeAxis.getAttribute("class")).toContain("absolute");
    expect(timeAxis.getAttribute("class")).toContain("top-0");
    expect(timeAxis.style.height).toBe("32px");
    await flushTimelineEffects();
    expect(axisSvg.style.transform).toBe(`translateX(${-scroller.scrollLeft}px)`);
    flushSync(() => {
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        value: 400,
      });
      Object.defineProperty(scroller, "scrollLeft", {
        configurable: true,
        value: 240,
      });
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timeAxis.textContent).toContain("Jul 2");
    expect(axisSvg.style.transform).toBe("translateX(-240px)");
  });
  it("renders actor labels in a sticky gutter outside the horizontally scrolling SVG", () => {
    renderChart(timelineSample());
    const scroller = container.querySelector<HTMLElement>("[data-testid='work-timeline-scroll']");
    const gutter = container.querySelector<SVGSVGElement>("[data-testid='work-timeline-actor-gutter']");
    const chartSvg = container.querySelector<SVGSVGElement>("svg.absolute");
    expect(scroller).not.toBeNull();
    expect(gutter).not.toBeNull();
    expect(chartSvg).not.toBeNull();
    expect(gutter?.getAttribute("class")).toContain("sticky");
    expect(gutter?.getAttribute("class")).toContain("left-0");
    expect(gutter?.getAttribute("class")).not.toContain("top-0");
    expect(gutter?.getAttribute("width")).toBe("176");
    expect(chartSvg?.getAttribute("width")).not.toBe(gutter?.getAttribute("width"));
    expect(gutter?.textContent).toContain("CodexCoder");
    expect(gutter?.textContent).not.toContain("agent");
    expect(gutter?.textContent).not.toContain("×");
    flushSync(() => {
      scroller!.scrollLeft = 10_000;
      scroller!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(container.querySelector("[data-testid='work-timeline-actor-gutter']")?.textContent).toContain(
      "CodexCoder",
    );
  });
  it("reports the currently visible time window when the chart scrolls", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    const onVisibleWindowChange = vi.fn();
    const data = timelineSample();
    renderChart(data, { onVisibleWindowChange });
    await flushTimelineEffects();
    const scroller = container.querySelector<HTMLElement>("[data-testid='work-timeline-scroll']")!;
    expect(onVisibleWindowChange).toHaveBeenCalled();
    flushSync(() => {
      scroller.scrollLeft = 0;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await flushTimelineEffects();
    const lastCall = onVisibleWindowChange.mock.calls.at(-1)?.[0];
    expect(lastCall?.fromMs).toBe(new Date(data.window.from).getTime());
    expect(lastCall?.toMs).toBeCloseTo(new Date("2026-07-02T01:00:00.000Z").getTime(), -3);
  });
  it("renders configured agent icons in the actor gutter instead of generated initials", () => {
    renderChart(timelineSample());
    const gutter = container.querySelector<SVGSVGElement>("[data-testid='work-timeline-actor-gutter']");
    expect(gutter?.querySelector(".lucide-code")).not.toBeNull();
    expect(gutter?.querySelector(".lucide-shield")).not.toBeNull();
    expect(gutter?.textContent).not.toContain("CC");
  });
  it("does not render created diamonds or comment bubbles from instant events", () => {
    const data = timelineSample();
    data.actors.push({ id: "user:dotta", type: "user", name: "Dotta" });
    data.events = [
      {
        actorId: "user:dotta",
        kind: "created",
        taskId: "task-1",
        at: "2026-07-02T08:30:00.000Z",
      },
      {
        actorId: "user:dotta",
        kind: "commented",
        taskId: "task-2",
        at: "2026-07-02T09:15:00.000Z",
      },
      {
        actorId: "user:dotta",
        kind: "approved",
        taskId: "task-1",
        at: "2026-07-02T10:05:00.000Z",
      },
    ];
    renderChart(data);
    const gutter = container.querySelector<SVGSVGElement>("[data-testid='work-timeline-actor-gutter']");
    expect(gutter?.textContent).not.toContain("Dotta");
    expect(container.querySelectorAll("[data-testid='timeline-event-marker']")).toHaveLength(0);
    expect(container.querySelectorAll("[data-testid='timeline-comment-marker']")).toHaveLength(0);
  });
  it("keeps connectors hidden until hover, renders them orthogonally, and highlights the connected graph", async () => {
    const data = timelineSample();
    data.actors.push({
      id: "agent:architect",
      type: "agent",
      name: "Architect",
    });
    data.spans.push(
      {
        actorId: "agent:architect",
        runId: "run-3",
        kind: "productive",
        taskId: "task-3",
        taskNumber: 12427,
        taskIdentifier: "PAP-12427",
        taskTitle: "Follow-up validation",
        start: "2026-07-02T11:45:00.000Z",
        end: "2026-07-02T12:00:00.000Z",
        status: "succeeded",
        retryOfRunId: null,
      },
      {
        actorId: "agent:codex",
        runId: "run-4",
        kind: "productive",
        taskId: "task-4",
        taskNumber: 12428,
        taskIdentifier: "PAP-12428",
        taskTitle: "Unrelated work",
        start: "2026-07-02T13:00:00.000Z",
        end: "2026-07-02T14:00:00.000Z",
        status: "succeeded",
        retryOfRunId: null,
      },
    );
    data.edges = [
      {
        fromActorId: "agent:codex",
        toActorId: "agent:qa",
        taskId: "task-2",
        at: "2026-07-02T10:45:00.000Z",
        kind: "delegation",
      },
      {
        fromActorId: "agent:qa",
        toActorId: "agent:architect",
        taskId: "task-3",
        at: "2026-07-02T11:35:00.000Z",
        kind: "delegation",
      },
    ];
    renderChart(data);
    expect(container.querySelectorAll("[data-testid='timeline-connector']")).toHaveLength(0);
    const hovered = container.querySelector<SVGGElement>("[data-run-id='run-2']")!;
    flushSync(() => {
      hovered.dispatchEvent(
        new MouseEvent("mouseover", {
          bubbles: true,
          clientX: 100,
          clientY: 100,
        }),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelectorAll("[data-testid='timeline-connector']")).toHaveLength(2);
    const connectorStrokePaths = Array.from(
      container.querySelectorAll<SVGPathElement>("[data-testid='timeline-connector'] path[fill='none']"),
    );
    expect(connectorStrokePaths.map((path) => path.getAttribute("d"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/ V.+ H/)]),
    );
    expect(container.querySelector("[data-run-id='run-1']")?.getAttribute("data-connected-state")).toBe(
      "connected",
    );
    expect(container.querySelector("[data-run-id='run-2']")?.getAttribute("data-connected-state")).toBe(
      "connected",
    );
    expect(container.querySelector("[data-run-id='run-3']")?.getAttribute("data-connected-state")).toBe(
      "connected",
    );
    expect(container.querySelector("[data-run-id='run-4']")?.getAttribute("data-connected-state")).toBe(
      "faded",
    );
    const layout = computeLayout(data, {
      gutter: 176,
      rowH: 34,
      barH: 15,
      laneGap: 4,
      pxPerMinute: 8,
      nowMs: new Date("2026-07-02T12:00:00.000Z").getTime(),
    });
    expect(layout.connectors).toMatchObject([
      { sourceRunId: "run-1", targetRunId: "run-2", dashed: false },
      { sourceRunId: "run-2", targetRunId: "run-3", dashed: false },
    ]);
    const bars = new Map(layout.rows.flatMap((row) => row.bars.map((bar) => [bar.span.runId, bar])));
    expect(layout.connectors[0].x1).toBe(bars.get("run-1")?.x2);
    expect(layout.connectors[0].x2).toBe(bars.get("run-2")?.x1);
  });
  it("renders kickoff chips with human avatar images but not delegating agents", () => {
    const data = timelineSample();
    data.actors.push({
      id: "user:dotta",
      type: "user",
      name: "Dotta",
      avatar: "/api/assets/dotta-avatar/content",
    });
    data.edges = [
      {
        fromActorId: "user:dotta",
        toActorId: "agent:codex",
        taskId: "task-1",
        at: "2026-07-02T08:45:00.000Z",
        kind: "delegation",
      },
      {
        fromActorId: "agent:codex",
        toActorId: "agent:qa",
        taskId: "task-2",
        at: "2026-07-02T10:45:00.000Z",
        kind: "delegation",
      },
    ];
    renderChart(data);
    const kickoffChips = container.querySelectorAll("[data-testid='timeline-kickoff-chip']");
    expect(kickoffChips).toHaveLength(1);
    expect(kickoffChips[0].querySelector("image")?.getAttribute("href")).toBe(
      "/api/assets/dotta-avatar/content",
    );
    expect(kickoffChips[0].textContent).not.toContain("DO");
  });
});
