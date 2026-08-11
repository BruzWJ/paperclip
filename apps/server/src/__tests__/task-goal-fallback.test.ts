import { describe, expect, it } from "vitest";
import { resolveNextTaskGoalId } from "../services/task-goal-fallback.ts";

describe("task goal fallback", () => {
  it("assigns the company goal to an unscoped task without an explicit goal", () => {
    expect(
      resolveNextTaskGoalId({
        currentProjectId: null,
        currentGoalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-1");
  });

  it("does not infer a goal from a newly selected project", () => {
    expect(
      resolveNextTaskGoalId({
        currentProjectId: null,
        currentGoalId: "goal-1",
        projectId: "project-1",
        goalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBeNull();
  });

  it("keeps a project-linked task goal empty when none is explicit", () => {
    expect(
      resolveNextTaskGoalId({
        currentProjectId: "project-1",
        currentGoalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBeNull();
  });

  it("preserves an explicit goal across project changes", () => {
    expect(
      resolveNextTaskGoalId({
        currentProjectId: "project-1",
        currentGoalId: "goal-explicit",
        projectId: "project-2",
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-explicit");
  });
});
