import { describe, expect, it } from "vitest";
import { buildProjectListMetricMaps } from "../services/projects.ts";

describe("buildProjectListMetricMaps", () => {
  it("maps task counts by project, coercing string counts to numbers", () => {
    const { issueCountByProjectId } = buildProjectListMetricMaps(
      [
        { projectId: "p1", count: 24 },
        { projectId: "p2", count: 11 as unknown as number },
      ],
      [],
    );

    expect(issueCountByProjectId.get("p1")).toBe(24);
    expect(issueCountByProjectId.get("p2")).toBe(11);
  });

  it("ignores task-count rows with a null project id", () => {
    const { issueCountByProjectId } = buildProjectListMetricMaps(
      [{ projectId: null, count: 5 }],
      [],
    );

    expect(issueCountByProjectId.size).toBe(0);
  });

  it("maps positive budgets with their window kind", () => {
    const { budgetByProjectId } = buildProjectListMetricMaps(
      [],
      [
        { scopeId: "p1", limitAmount: "1200", windowKind: "calendar_month_utc" },
        { scopeId: "p2", limitAmount: "500", windowKind: "lifetime" },
      ],
    );

    expect(budgetByProjectId.get("p1")).toEqual({ limitAmount: "1200", windowKind: "calendar_month_utc" });
    expect(budgetByProjectId.get("p2")).toEqual({ limitAmount: "500", windowKind: "lifetime" });
  });

  it("omits zero/negative budgets so they do not surface as 'set'", () => {
    const { budgetByProjectId } = buildProjectListMetricMaps(
      [],
      [
        { scopeId: "p1", limitAmount: "0", windowKind: "lifetime" },
      ],
    );

    expect(budgetByProjectId.size).toBe(0);
  });
});
