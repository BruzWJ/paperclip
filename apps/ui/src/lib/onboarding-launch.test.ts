import { describe, expect, it } from "vitest";
import {
  buildOnboardingIssuePayload,
  buildOnboardingProjectPayload,
  selectDefaultCompanyGoalId,
  selectReusableOnboardingProject,
} from "./onboarding-launch";

describe("selectDefaultCompanyGoalId", () => {
  it("prefers the earliest active root company goal", () => {
    expect(
      selectDefaultCompanyGoalId([
        {
          id: "team-goal",
          companyId: "company-1",
          title: "Nested",
          description: null,
          level: "team",
          status: "active",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-04T00:00:00Z"),
          updatedAt: new Date("2026-03-04T00:00:00Z"),
        },
        {
          id: "goal-2",
          companyId: "company-1",
          title: "Later active root",
          description: null,
          level: "company",
          status: "active",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-03T00:00:00Z"),
          updatedAt: new Date("2026-03-03T00:00:00Z"),
        },
        {
          id: "goal-1",
          companyId: "company-1",
          title: "Earliest active root",
          description: null,
          level: "company",
          status: "active",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-02T00:00:00Z"),
          updatedAt: new Date("2026-03-02T00:00:00Z"),
        },
      ]),
    ).toBe("goal-1");
  });

  it("falls back to the earliest root company goal when none are active", () => {
    expect(
      selectDefaultCompanyGoalId([
        {
          id: "goal-2",
          companyId: "company-1",
          title: "Cancelled root",
          description: null,
          level: "company",
          status: "cancelled",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-03T00:00:00Z"),
          updatedAt: new Date("2026-03-03T00:00:00Z"),
        },
        {
          id: "goal-1",
          companyId: "company-1",
          title: "Earliest root",
          description: null,
          level: "company",
          status: "planned",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-02T00:00:00Z"),
          updatedAt: new Date("2026-03-02T00:00:00Z"),
        },
      ]),
    ).toBe("goal-1");
  });
});

describe("onboarding launch payloads", () => {
  it("reuses a non-cancelled Onboarding project by name", () => {
    expect(
      selectReusableOnboardingProject([
        { id: "cancelled", name: "Onboarding", status: "cancelled" },
        { id: "active", name: " onboarding ", status: "in_progress" },
      ]),
    ).toEqual({ id: "active", name: " onboarding ", status: "in_progress" });

    expect(
      selectReusableOnboardingProject([
        { id: "cancelled", name: "Onboarding", status: "cancelled" },
        { id: "other", name: "Roadmap", status: "in_progress" },
      ]),
    ).toBeNull();
  });

  it("links the onboarding project and first issue to the selected goal", () => {
    expect(buildOnboardingProjectPayload("goal-1")).toEqual({
      name: "Onboarding",
      status: "in_progress",
      goalIds: ["goal-1"],
    });

    expect(
      buildOnboardingIssuePayload({
        title: "  Hire your first engineer  ",
        request: "  Kick off the hiring plan  ",
        ownerAgentId: "agent-1",
        projectId: "project-1",
        goalId: "goal-1",
      }),
    ).toEqual({
      title: "Hire your first engineer",
      request: "  Kick off the hiring plan  ",
      ownerAgentId: "agent-1",
      idempotencyKey: "onboarding:project-1:agent-1",
      projectId: "project-1",
      goalId: "goal-1",
    });
  });

  it("omits goal links and blank optional titles without synthesizing provider input", () => {
    expect(buildOnboardingProjectPayload(null)).toEqual({
      name: "Onboarding",
      status: "in_progress",
    });

    expect(
      buildOnboardingIssuePayload({
        title: "   ",
        request: "The exact ordinary issue request",
        ownerAgentId: "agent-1",
        projectId: "project-1",
        goalId: null,
      }),
    ).toEqual({
      request: "The exact ordinary issue request",
      ownerAgentId: "agent-1",
      idempotencyKey: "onboarding:project-1:agent-1",
      projectId: "project-1",
    });
  });

  it("rejects blank requests even when display title metadata is present", () => {
    for (const request of ["", " \n\t "]) {
      expect(() =>
        buildOnboardingIssuePayload({
          title: "A display title cannot become provider input",
          request,
          ownerAgentId: "agent-1",
          projectId: "project-1",
          goalId: null,
        }),
      ).toThrow(/request must contain non-whitespace text/i);
    }
  });

  it("preserves request bytes independently of title changes and retry", () => {
    const request = "  Keep the leading space.\n\nKeep the trailing space.  ";
    const base = {
      request,
      ownerAgentId: "agent-1",
      projectId: "project-1",
      goalId: null,
    };

    const first = buildOnboardingIssuePayload({
      ...base,
      title: "First display title",
    });
    const retry = buildOnboardingIssuePayload({
      ...base,
      title: "Changed display title",
    });

    expect(first.request).toBe(request);
    expect(retry.request).toBe(request);
    expect(first.idempotencyKey).toBe(retry.idempotencyKey);
    expect(first.title).toBe("First display title");
    expect(retry.title).toBe("Changed display title");
  });

});
