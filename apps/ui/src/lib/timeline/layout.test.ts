import { describe, expect, it } from "vitest";
import type { TaskExecutionRunStatus, WorkTimelineResult } from "@paperclipai/shared";
import { chooseTickStepMs, computeLayout, taskColor, shortLabel, type LayoutOptions } from "./layout";

const DAY = "2026-07-02";
const t = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

// A trimmed version of the board's locked-design sample (PAP-12422), expressed
// in the real endpoint contract: actor→actor edges rather than run→run.
function sample(): WorkTimelineResult {
  const actors = [
    { id: "user:dotta", type: "user" as const, name: "dotta" },
    { id: "agent:lead", type: "agent" as const, name: "Lead" },
    { id: "agent:architect", type: "agent" as const, name: "Systems Architect" },
    { id: "agent:ux", type: "agent" as const, name: "UXDesigner" },
    { id: "agent:senior", type: "agent" as const, name: "SeniorEngineer" },
    { id: "agent:codex", type: "agent" as const, name: "CodexCoder" },
    { id: "agent:qa", type: "agent" as const, name: "QA" },
    { id: "system:routine", type: "system" as const, name: "Circleback" },
  ];
  const span = (
    runId: string,
    actorId: string,
    taskId: string,
    identifier: string,
    start: string,
    end: string | null,
    status: TaskExecutionRunStatus,
    retryOfRunId: string | null = null,
  ): WorkTimelineResult["spans"][number] => ({
    actorId,
    runId,
    kind: "productive",
    taskId,
    taskNumber: Number(identifier.split("-").at(-1)),
    taskIdentifier: identifier,
    taskTitle: `${identifier} title`,
    start: t(start),
    end: end ? t(end) : null,
    status,
    retryOfRunId,
  });
  const spans = [
    span("r1", "agent:lead", "i-405", "PAP-12405", "09:02", "09:10", "succeeded"),
    span("r2", "agent:architect", "i-405", "PAP-12405", "09:14", "09:52", "succeeded"),
    span("r3", "agent:senior", "i-075", "PAP-12075", "09:58", "10:20", "succeeded"),
    span("r4", "agent:ux", "i-422", "PAP-12422", "10:10", "11:34", "running"),
    span("r5", "agent:codex", "i-423", "PAP-12423", "10:10", "10:56", "succeeded"),
    span("r6", "agent:codex", "i-075", "PAP-12075", "10:22", "11:08", "succeeded"), // overlaps r5 → sub-lane
    span("r7", "agent:qa", "i-423", "PAP-12423", "11:40", "12:12", "succeeded"),
    span("r8", "agent:codex", "i-423", "PAP-12423", "12:20", "12:38", "succeeded", "r5"), // retry
    span("r9", "system:routine", "i-286", "PAP-12286", "20:00", "20:04", "succeeded"),
  ];
  const edge = (from: string, to: string, taskId: string, at: string): WorkTimelineResult["edges"][number] => ({
    fromActorId: from,
    toActorId: to,
    taskId,
    at: t(at),
    kind: "delegation",
  });
  const edges = [
    edge("user:dotta", "agent:lead", "i-405", "09:01"), // human kickoff → chip only, no line
    edge("agent:lead", "agent:architect", "i-405", "09:13"),
    edge("agent:architect", "agent:ux", "i-422", "10:09"),
    edge("agent:architect", "agent:codex", "i-423", "10:09"),
    edge("agent:senior", "agent:codex", "i-075", "10:21"),
    edge("agent:codex", "agent:qa", "i-423", "11:39"),
    edge("agent:qa", "agent:codex", "i-423", "12:19"), // → retry r8 (dashed)
  ];
  return {
    actors,
    spans,
    events: [],
    edges,
    pagination: { limit: 200, offset: 0, totalTasks: 6, hasMore: false },
    window: { from: t("09:00"), to: t("20:15"), capped: false },
  };
}

const OPTS: LayoutOptions = {
  pxPerMinute: 1.7,
  gutter: 172,
  rowH: 34,
  barH: 15,
  laneGap: 4,
  nowMs: new Date(t("13:00")).getTime(),
};

describe("computeLayout", () => {
  it("excludes humans from rows but keeps agents and system actors", () => {
    const layout = computeLayout(sample(), OPTS);
    const rowActorTypes = layout.rows.map((r) => r.actor.type);
    expect(rowActorTypes).not.toContain("user");
    expect(layout.rows.map((r) => r.actor.id)).toContain("system:routine");
    expect(layout.rows).toHaveLength(7); // 6 agents + 1 system
  });

  it("orders rows by first activity", () => {
    const layout = computeLayout(sample(), OPTS);
    expect(layout.rows[0].actor.id).toBe("agent:lead");
    expect(layout.rows[layout.rows.length - 1].actor.id).toBe("system:routine");
  });

  it("packs overlapping runs into concurrency sub-lanes", () => {
    const layout = computeLayout(sample(), OPTS);
    const codex = layout.rows.find((r) => r.actor.id === "agent:codex")!;
    expect(codex.laneCount).toBe(2); // r5 and r6 overlap
    const lanesTop = new Set(codex.bars.map((b) => b.yTop));
    expect(lanesTop.size).toBeGreaterThan(1);
  });

  it("derives the kickoff actor for a run (incl. human) from edges", () => {
    const layout = computeLayout(sample(), OPTS);
    const codexApi = layout.rows
      .find((r) => r.actor.id === "agent:codex")!
      .bars.find((b) => b.span.runId === "r5")!;
    expect(codexApi.kickoff?.id).toBe("agent:architect");

    const ceoRun = layout.rows.find((r) => r.actor.id === "agent:lead")!.bars[0];
    expect(ceoRun.kickoff?.id).toBe("user:dotta"); // human kickoff shown as chip
  });

  it("does not reuse a board-created assignment edge on later automation runs", () => {
    const data = sample();
    data.spans.push({
      actorId: "agent:lead",
      runId: "r1-later-automation",
      kind: "productive",
      taskId: "i-405",
      taskNumber: 12405,
      taskIdentifier: "PAP-12405",
      taskTitle: "PAP-12405 title",
      start: t("10:30"),
      end: t("10:36"),
      status: "succeeded",
      retryOfRunId: null,
    });

    const layout = computeLayout(data, OPTS);
    const ceoRuns = layout.rows.find((r) => r.actor.id === "agent:lead")!.bars;
    expect(ceoRuns.find((b) => b.span.runId === "r1")?.kickoff?.id).toBe("user:dotta");
    expect(ceoRuns.find((b) => b.span.runId === "r1-later-automation")?.kickoff).toBeNull();
  });

  it("prefers the nearest post-start kickoff edge when no prior edge exists", () => {
    const data = sample();
    data.spans.push({
      actorId: "agent:ux",
      runId: "late-edge-run",
      kind: "productive",
      taskId: "i-late",
      taskNumber: 99999,
      taskIdentifier: "PAP-99999",
      taskTitle: "Late kickoff fallback",
      start: t("14:00"),
      end: t("14:10"),
      status: "succeeded",
      retryOfRunId: null,
    });
    data.edges.push(
      { fromActorId: "agent:qa", toActorId: "agent:ux", taskId: "i-late", at: t("14:30"), kind: "delegation" },
      { fromActorId: "agent:architect", toActorId: "agent:ux", taskId: "i-late", at: t("14:02"), kind: "delegation" },
    );

    const layout = computeLayout(data, OPTS);
    const lateRun = layout.rows
      .find((r) => r.actor.id === "agent:ux")!
      .bars.find((b) => b.span.runId === "late-edge-run")!;
    expect(lateRun.kickoff?.id).toBe("agent:architect");
  });

  it("draws agent→agent connectors only, dashing retries, never from a human", () => {
    const layout = computeLayout(sample(), OPTS);
    // 6 agent→agent edges resolve to bars; the dotta→lead human edge draws no line.
    expect(layout.connectors.length).toBe(6);
    const dashed = layout.connectors.filter((c) => c.dashed);
    expect(dashed).toHaveLength(1); // only the QA→codex retry hop
    // every connector is left-to-right (source trailing edge → target leading edge)
    for (const c of layout.connectors) expect(c.x2).toBeGreaterThanOrEqual(c.x1 - 1);
  });

  it("extends in-progress runs to now and clamps sub-minute bars", () => {
    const layout = computeLayout(sample(), OPTS);
    const running = layout.rows
      .find((r) => r.actor.id === "agent:ux")!
      .bars.find((b) => b.span.runId === "r4")!;
    expect(running.running).toBe(true);
    expect(running.x2).toBeGreaterThan(running.x1 + 3);
  });

  it("produces a deterministic task hue + legend", () => {
    const layout = computeLayout(sample(), OPTS);
    expect(layout.tasks.length).toBe(5); // i-405, i-075, i-422, i-423, i-286
    expect(taskColor("i-405")).toBe(taskColor("i-405"));
  });
});

describe("human activity markers", () => {
  const withUserEvents = (): WorkTimelineResult => ({
    ...sample(),
    events: [
      { actorId: "user:dotta", kind: "created", taskId: "i-405", at: t("09:00") },
      { actorId: "user:dotta", kind: "commented", taskId: "i-422", at: t("11:00") },
      { actorId: "user:dotta", kind: "approved", taskId: "i-423", at: t("12:15") },
    ],
  });

  it("does not create a marker-only human row from instant events", () => {
    const layout = computeLayout(withUserEvents(), OPTS);
    const dotta = layout.rows.find((r) => r.actor.id === "user:dotta");
    expect(dotta).toBeUndefined();
  });

  it("does not plot instant markers on run rows", () => {
    const layout = computeLayout(withUserEvents(), OPTS);
    expect(layout.rows.flatMap((r) => r.markers)).toHaveLength(0);
  });

  it("keeps human events visual-only as kickoff chips, not connector targets", () => {
    const layout = computeLayout(withUserEvents(), OPTS);
    // dotta→lead human kickoff still draws no line; agent→agent count unchanged.
    expect(layout.connectors.length).toBe(6);
  });

  it("still excludes a human with no in-window events", () => {
    const layout = computeLayout(sample(), OPTS); // events: []
    expect(layout.rows.map((r) => r.actor.type)).not.toContain("user");
  });
});

describe("helpers", () => {
  it("shortLabel builds 2-char initials", () => {
    expect(shortLabel("CodexCoder")).toBe("CO");
    expect(shortLabel("Systems Architect")).toBe("SA");
  });

  it("chooseTickStepMs grows the step as the view zooms out", () => {
    expect(chooseTickStepMs(6)).toBeLessThan(chooseTickStepMs(0.4));
  });
});
