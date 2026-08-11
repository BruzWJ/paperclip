import { describe, expect, it } from "vitest";
import { resolveNextIssueGoalId } from "../services/issue-goal-fallback.ts";

describe("issue goal fallback", () => {
  it("assigns the company goal to an unscoped issue without an explicit goal", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-1");
  });

  it("does not infer a goal from a newly selected project", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: "goal-1",
        projectId: "project-1",
        goalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBeNull();
  });

  it("keeps a project-linked issue goal empty when none is explicit", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: "project-1",
        currentGoalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBeNull();
  });

  it("preserves an explicit goal across project changes", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: "project-1",
        currentGoalId: "goal-explicit",
        projectId: "project-2",
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-explicit");
  });
});
