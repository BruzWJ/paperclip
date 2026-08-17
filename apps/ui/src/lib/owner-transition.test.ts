import { describe, expect, it } from "vitest";
import {
  computePauseAffectsSummary,
  describeOwnerChangeInterrupt,
} from "./owner-transition";

describe("owner transition helpers", () => {
  it("summarizes live, queued, and inactive pause effects", () => {
    const summary = computePauseAffectsSummary([
      { activeRun: { status: "running" } },
      { activeRun: { status: "queued" } },
      { activeRun: null },
      { activeRun: null, skipped: true },
    ]);
    expect(summary.affectedTaskCount).toBe(3);
    expect(summary.buckets.map(({ key, count }) => ({ key, count }))).toEqual([
      { key: "live_runs", count: 1 },
      { key: "queued_runs", count: 1 },
      { key: "inactive", count: 1 },
    ]);
  });

  it("uses owner language for the live-run confirmation", () => {
    expect(describeOwnerChangeInterrupt({ runningAgentName: "ClaudeCoder" })).toMatchObject({
      banner: "ClaudeCoder is running — changing the owner will interrupt this run.",
      confirmAction: "Interrupt & change owner",
    });
  });
});
