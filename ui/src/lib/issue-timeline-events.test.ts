import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";
import { extractIssueTimelineEvents } from "./issue-timeline-events";

describe("extractIssueTimelineEvents", () => {
  it("extracts and sorts lifecycle and owner changes from issue updates", () => {
    const events = extractIssueTimelineEvents([
      {
        id: "evt-2",
        companyId: "company-1",
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-1",
        agentId: null,
        runId: null,
        createdAt: new Date("2026-03-31T12:02:00.000Z"),
        details: {
          ownerKind: "agent",
          ownerAgentId: "agent-2",
          ownerUserId: null,
          _previous: {
            ownerKind: "agent",
            ownerAgentId: "agent-1",
            ownerUserId: null,
          },
        },
      },
      {
        id: "evt-1",
        companyId: "company-1",
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-1",
        agentId: null,
        runId: null,
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        details: {
          lifecycleStatus: "open",
          _previous: {
            lifecycleStatus: "blocked",
          },
        },
      },
      {
        id: "evt-ignored",
        companyId: "company-1",
        actorType: "user",
        actorId: "user-1",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: "issue-1",
        agentId: null,
        runId: null,
        createdAt: new Date("2026-03-31T12:03:00.000Z"),
        details: {
          commentId: "comment-1",
        },
      },
    ] satisfies ActivityEvent[]);

    expect(events).toEqual([
      {
        id: "evt-1",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        actorType: "user",
        actorId: "user-1",
        runId: null,
        lifecycleStatusChange: {
          from: "blocked",
          to: "open",
        },
      },
      {
        id: "evt-2",
        createdAt: new Date("2026-03-31T12:02:00.000Z"),
        actorType: "user",
        actorId: "user-1",
        runId: null,
        ownerChange: {
          from: {
            ownerKind: "agent",
            ownerAgentId: "agent-1",
            ownerUserId: null,
          },
          to: {
            ownerKind: "agent",
            ownerAgentId: "agent-2",
            ownerUserId: null,
          },
        },
      },
    ]);
  });

  it("extracts a canonical lifecycle reopen transition", () => {
    const events = extractIssueTimelineEvents([
      {
        id: "evt-reopen",
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        details: {
          lifecycleStatus: "open",
          _previous: {
            lifecycleStatus: "done",
          },
          source: "comment",
        },
      },
    ] satisfies ActivityEvent[]);

    expect(events).toEqual([
      {
        id: "evt-reopen",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        actorType: "agent",
        actorId: "agent-1",
        runId: "run-1",
        lifecycleStatusChange: {
          from: "done",
          to: "open",
        },
      },
    ]);
  });

  it("marks explicit follow-up timeline updates", () => {
    const events = extractIssueTimelineEvents([
      {
        id: "evt-follow-up",
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        details: {
          lifecycleStatus: "open",
          _previous: {
            lifecycleStatus: "done",
          },
          source: "comment",
          commentId: "comment-1",
          resumeIntent: true,
          followUpRequested: true,
        },
      },
    ] satisfies ActivityEvent[]);

    expect(events).toEqual([
      {
        id: "evt-follow-up",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        actorType: "agent",
        actorId: "agent-1",
        runId: "run-1",
        commentId: "comment-1",
        followUpRequested: true,
        lifecycleStatusChange: {
          from: "done",
          to: "open",
        },
      },
    ]);
  });

  it("extracts workspace changes from issue update activity", () => {
    const events = extractIssueTimelineEvents([
      {
        id: "evt-workspace",
        companyId: "company-1",
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-1",
        agentId: null,
        runId: null,
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        details: {
          projectWorkspaceId: "workspace-2",
          workspaceChange: {
            from: {
              label: "Main workspace",
              projectWorkspaceId: "workspace-1",
              executionWorkspaceId: null,
              mode: "shared_workspace",
            },
            to: {
              label: "Feature branch",
              projectWorkspaceId: "workspace-2",
              executionWorkspaceId: null,
              mode: "shared_workspace",
            },
          },
          _previous: {
            projectWorkspaceId: "workspace-1",
          },
        },
      },
    ] satisfies ActivityEvent[]);

    expect(events).toEqual([
      {
        id: "evt-workspace",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        actorType: "user",
        actorId: "user-1",
        runId: null,
        workspaceChange: {
          from: {
            label: "Main workspace",
            projectWorkspaceId: "workspace-1",
            executionWorkspaceId: null,
            mode: "shared_workspace",
          },
          to: {
            label: "Feature branch",
            projectWorkspaceId: "workspace-2",
            executionWorkspaceId: null,
            mode: "shared_workspace",
          },
        },
      },
    ]);
  });

  it("synthesizes non-status follow-up rows from comment activity", () => {
    const events = extractIssueTimelineEvents([
      {
        id: "evt-comment-follow-up",
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: "issue-1",
        agentId: "agent-1",
        runId: "run-1",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        details: {
          commentId: "comment-1",
          resumeIntent: true,
          followUpRequested: true,
        },
      },
    ] satisfies ActivityEvent[]);

    expect(events).toEqual([
      {
        id: "evt-comment-follow-up",
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        actorType: "agent",
        actorId: "agent-1",
        runId: "run-1",
        commentId: "comment-1",
        followUpRequested: true,
      },
    ]);
  });

  it("ignores issue updates without visible status, assignee, or workspace transitions", () => {
    const events = extractIssueTimelineEvents([
      {
        id: "evt-title",
        companyId: "company-1",
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-1",
        agentId: null,
        runId: null,
        createdAt: new Date("2026-03-31T12:01:00.000Z"),
        details: {
          title: "New title",
          _previous: {
            title: "Old title",
          },
        },
      },
    ] satisfies ActivityEvent[]);

    expect(events).toEqual([]);
  });
});
