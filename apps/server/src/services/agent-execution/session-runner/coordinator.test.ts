import { describe, expect, it } from "vitest";
import { createTargetLaneRunCoordinator } from "./coordinator.js";

describe("target-lane run coordinator", () => {
  it("runs one successor drain when a direct run joins an active lane", async () => {
    let drainCount = 0;
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const coordinator = createTargetLaneRunCoordinator<
      { readonly laneId: string },
      string
    >({
      keyOf: (scope) => scope.laneId,
      async drain() {
        drainCount += 1;
        if (drainCount === 1) {
          enterFirst();
          await firstReleased;
        }
      },
    });

    coordinator.wake({ laneId: "lane-a" });
    await firstEntered;
    const joined = coordinator.run({ laneId: "lane-a" });
    releaseFirst();
    await joined;

    expect(drainCount).toBe(2);
    expect(coordinator.active()).toEqual(new Set());
  });
});
