import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  formatActivityVerb,
  formatTaskActivityAction,
} from "./activity-format";

describe("activity formatting", () => {
  const agentMap = new Map<string, Agent>([
    ["agent-reviewer", { id: "agent-reviewer", name: "Reviewer Bot" } as Agent],
    ["agent-approver", { id: "agent-approver", name: "Approver Bot" } as Agent],
  ]);

  it("formats blocker activity using linked task identifiers", () => {
    const details = {
      addedBlockedByTasks: [
        { id: "task-2", identifier: "PAP-22", title: "Blocked task" },
      ],
      removedBlockedByTasks: [],
    };

    expect(formatActivityVerb("task.blockers_updated", details)).toBe(
      "added blocker PAP-22 to",
    );
    expect(formatTaskActivityAction("task.blockers_updated", details)).toBe(
      "added blocker PAP-22",
    );
  });

  it("formats reviewer activity using agent names", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [],
    };

    expect(
      formatActivityVerb("task.reviewers_updated", details, { agentMap }),
    ).toBe("added reviewer Reviewer Bot to");
    expect(
      formatTaskActivityAction("task.reviewers_updated", details, {
        agentMap,
      }),
    ).toBe("added reviewer Reviewer Bot");
  });

  it("formats approver removals using user-aware labels", () => {
    const details = {
      addedParticipants: [],
      removedParticipants: [
        { type: "user", agentId: null, userId: "user-123" },
      ],
    };

    expect(formatActivityVerb("task.approvers_updated", details)).toBe(
      "removed approver user user- from",
    );
    expect(formatTaskActivityAction("task.approvers_updated", details)).toBe(
      "removed approver user user-",
    );
  });

  it("falls back to updated wording when reviewers are both added and removed", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [
        { type: "agent", agentId: "agent-approver", userId: null },
      ],
    };

    expect(
      formatActivityVerb("task.reviewers_updated", details, { agentMap }),
    ).toBe("updated reviewers on");
    expect(
      formatTaskActivityAction("task.reviewers_updated", details, {
        agentMap,
      }),
    ).toBe("updated reviewers");
  });

});
