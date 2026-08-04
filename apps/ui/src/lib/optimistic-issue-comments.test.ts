import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BoardIssueComment,
  BoardIssueCommentGroupPage,
  Issue,
} from "@paperclipai/shared";
import {
  applyLocalQueuedIssueCommentState,
  applyOptimisticIssueFieldUpdate,
  applyOptimisticIssueFieldUpdateToCollection,
  createOptimisticIssueComment,
  flattenBoardIssueCommentGroupPages,
  isQueuedIssueComment,
  matchesIssueRef,
  mergeIssueComments,
  shouldAutoloadOlderIssueComments,
  takeOptimisticIssueComment,
  upsertIssueComment,
} from "./optimistic-issue-comments";
import {
  createTestExecutionWorkspace,
  createTestIssue,
} from "../test-utils/issue";

describe("optimistic issue comments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const boardComment = (
    id: string,
    canonicalSequence: number,
    body: string,
  ): BoardIssueComment => ({
    id,
    author: {
      type: "user",
      label: "Test User",
      agentId: null,
      userId: "user-1",
      pluginKey: null,
    },
    body,
    presentation: null,
    metadata: null,
    sourceTrust: null,
    runState: null,
    canonicalSequence,
    immediateParentDisplayReference: null,
    createdAt: new Date(`2026-03-28T14:00:0${canonicalSequence}.000Z`),
    updatedAt: new Date(`2026-03-28T14:00:0${canonicalSequence}.000Z`),
  });

  it("keeps independently paged replies inside their canonical root group", () => {
    const root = boardComment("root-1", 1, "Root");
    const firstReply = { kind: "comment" as const, ...boardComment("reply-1", 2, "First") };
    const laterReply = { kind: "comment" as const, ...boardComment("reply-2", 3, "Later") };
    const pages: BoardIssueCommentGroupPage[] = [{
      groups: [{
        root,
        replyCount: 2,
        runSegmentCount: 0,
        entries: [firstReply],
        entriesNextCursor: "thread-cursor-1",
      }],
      nextCursor: null,
    }];

    const collapsed = flattenBoardIssueCommentGroupPages(
      pages,
      { companyId: "company-1", issueId: "issue-1" },
    );
    expect(collapsed.map((comment) => comment.id)).toEqual(["root-1"]);
    expect(collapsed[0]).toMatchObject({
      boardGroupRootId: "root-1",
      boardGroupHasMore: true,
    });

    const flattened = flattenBoardIssueCommentGroupPages(
      pages,
      { companyId: "company-1", issueId: "issue-1" },
      new Map([[
        root.id,
        {
          entries: [firstReply, laterReply],
          nextCursor: null,
          expanded: true,
          loading: false,
          error: null,
        },
      ]]),
    );

    expect(flattened.map((comment) => comment.id)).toEqual([
      "root-1",
      "reply-1",
      "reply-2",
    ]);
    expect(flattened[1]?.boardGroupHasMore).toBeUndefined();
    expect(flattened[2]).toMatchObject({
      boardGroupRootId: "root-1",
    });
    expect(flattened[2]?.boardGroupHasMore).toBeUndefined();
  });

  it("creates a pending optimistic comment for the current user", () => {
    const comment = createOptimisticIssueComment({
      companyId: "company-1",
      issueId: "issue-1",
      body: "Working on it",
      authorUserId: "board-1",
    });

    expect(comment.id).toMatch(/^optimistic-/);
    expect(comment.clientId).toBe(comment.id);
    expect(comment.clientStatus).toBe("pending");
    expect(comment.authorUserId).toBe("board-1");
    expect(comment.authorAgentId).toBeNull();
  });

  it("falls back when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_746_000_000_000);
    const mathSpy = vi.spyOn(Math, "random").mockReturnValue(0.123456789);

    const comment = createOptimisticIssueComment({
      companyId: "company-1",
      issueId: "issue-1",
      body: "Working on it",
      authorUserId: "board-1",
    });

    expect(comment.id).toBe("optimistic-1746000000000-4fzzzxjy");
    expect(comment.clientId).toBe(comment.id);

    nowSpy.mockRestore();
    mathSpy.mockRestore();
  });

  it("supports queued optimistic comments for active-run follow-ups", () => {
    const comment = createOptimisticIssueComment({
      companyId: "company-1",
      issueId: "issue-1",
      body: "Queue this",
      authorUserId: "board-1",
      clientStatus: "queued",
      queueTargetRunId: "run-1",
    });

    expect(comment.clientStatus).toBe("queued");
    expect(comment.queueTargetRunId).toBe("run-1");
  });

  it("merges optimistic comments into the server thread in chronological order", () => {
    const merged = mergeIssueComments(
      [
        {
          id: "comment-2",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "board-1",
          body: "Second",
          authorType: "user",
          presentation: null,
          metadata: null,
          runId: null,
          canonicalSourceKind: "human_comment",
          canonicalSequence: 1,
          createdAt: new Date("2026-03-28T14:00:02.000Z"),
          updatedAt: new Date("2026-03-28T14:00:02.000Z"),
        },
      ],
      [
        {
          id: "optimistic-1",
          clientId: "optimistic-1",
          clientStatus: "pending",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "board-1",
          body: "First",
          authorType: "user",
          presentation: null,
          metadata: null,
          createdAt: new Date("2026-03-28T14:00:01.000Z"),
          updatedAt: new Date("2026-03-28T14:00:01.000Z"),
        },
      ],
    );

    expect(merged.map((comment) => comment.id)).toEqual(["optimistic-1", "comment-2"]);
  });

  it("can take one optimistic queued comment back out of the queue", () => {
    const first = createOptimisticIssueComment({
      companyId: "company-1",
      issueId: "issue-1",
      body: "First",
      authorUserId: "board-1",
      clientStatus: "queued",
      queueTargetRunId: "run-1",
    });
    const second = createOptimisticIssueComment({
      companyId: "company-1",
      issueId: "issue-1",
      body: "Second",
      authorUserId: "board-1",
      clientStatus: "queued",
      queueTargetRunId: "run-1",
    });

    const result = takeOptimisticIssueComment([first, second], first.clientId);

    expect(result.comment?.body).toBe("First");
    expect(result.comments.map((comment) => comment.clientId)).toEqual([second.clientId]);
  });

  it("upserts confirmed comments without creating duplicates", () => {
    const next = upsertIssueComment(
      [
        {
          id: "comment-1",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "board-1",
          body: "Original",
          authorType: "user",
          presentation: null,
          metadata: null,
          createdAt: new Date("2026-03-28T14:00:00.000Z"),
          updatedAt: new Date("2026-03-28T14:00:00.000Z"),
        },
      ],
      {
        id: "comment-1",
        companyId: "company-1",
        issueId: "issue-1",
        authorAgentId: null,
        authorUserId: "board-1",
        body: "Updated",
        authorType: "user",
        presentation: null,
        metadata: null,
        createdAt: new Date("2026-03-28T14:00:00.000Z"),
        updatedAt: new Date("2026-03-28T14:00:05.000Z"),
      },
    );

    expect(next).toHaveLength(1);
    expect(next[0]?.body).toBe("Updated");
  });

  it("autoloads older chat comments while the initial thread is still under the threshold", () => {
    expect(
      shouldAutoloadOlderIssueComments({
        activeDetailTab: "chat",
        hasOlderComments: true,
        loadedCommentCount: 50,
        initialPageLoading: false,
        olderPageLoading: false,
        autoLoadLimit: 150,
      }),
    ).toBe(true);
  });

  it("does not autoload older comments outside the chat tab", () => {
    expect(
      shouldAutoloadOlderIssueComments({
        activeDetailTab: "activity",
        hasOlderComments: true,
        loadedCommentCount: 50,
        initialPageLoading: false,
        olderPageLoading: false,
        autoLoadLimit: 150,
      }),
    ).toBe(false);
  });

  it("stops autoloading once the initial comment window reaches the cap", () => {
    expect(
      shouldAutoloadOlderIssueComments({
        activeDetailTab: "chat",
        hasOlderComments: true,
        loadedCommentCount: 150,
        initialPageLoading: false,
        olderPageLoading: false,
        autoLoadLimit: 150,
      }),
    ).toBe(false);
  });

  it("applies optimistic field updates for issue property edits", () => {
    const currentExecutionWorkspace = createTestExecutionWorkspace({
      id: "exec-1",
      projectId: "project-1",
      sourceIssueId: "issue-1",
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Execution workspace",
      cwd: "/tmp/paperclip",
      lastUsedAt: new Date("2026-03-28T14:00:00.000Z"),
      openedAt: new Date("2026-03-28T14:00:00.000Z"),
      createdAt: new Date("2026-03-28T14:00:00.000Z"),
      updatedAt: new Date("2026-03-28T14:00:00.000Z"),
    });
    const next = applyOptimisticIssueFieldUpdate(
      createTestIssue({
        id: "issue-1",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        ancestors: [
          {
            id: "issue-9",
            identifier: "PAP-9",
            title: "Old parent",
            request: "Parent request",
            boardPresentationStatus: "todo",
            priority: "medium",
            ownerAgentId: null,
            ownerUserId: null,
            projectId: null,
            goalId: null,
            project: null,
            goal: null,
          },
        ],
        title: "Fix property pane",
        request: "Update the issue properties",
        boardPresentationStatus: "todo",
        ownerKind: "agent",
        ownerAgentId: "agent-1",
        ownerUserId: null,
        creatorKind: "user/board",
        creatorUserId: "board-1",
        executionWorkspacePreference: "shared_workspace",
        labelIds: ["label-1", "label-2"],
        labels: [
          {
            id: "label-1",
            companyId: "company-1",
            name: "One",
            color: "#111111",
            createdAt: new Date("2026-03-28T14:00:00.000Z"),
            updatedAt: new Date("2026-03-28T14:00:00.000Z"),
          },
          {
            id: "label-2",
            companyId: "company-1",
            name: "Two",
            color: "#222222",
            createdAt: new Date("2026-03-28T14:00:00.000Z"),
            updatedAt: new Date("2026-03-28T14:00:00.000Z"),
          },
        ],
        blockedBy: [
          {
            id: "issue-2",
            identifier: "PAP-2",
            title: "First blocker",
            boardPresentationStatus: "todo",
            priority: "medium",
            ownerAgentId: null,
            ownerUserId: null,
          },
          {
            id: "issue-3",
            identifier: "PAP-3",
            title: "Second blocker",
            boardPresentationStatus: "todo",
            priority: "medium",
            ownerAgentId: null,
            ownerUserId: null,
          },
        ],
        blocks: [],
        project: {
          id: "project-1",
          companyId: "company-1",
          urlKey: "project-one",
          goalId: null,
          goalIds: [],
          goals: [],
          name: "Project one",
          description: null,
          status: "in_progress",
          leadAgentId: null,
          targetDate: null,
          color: null,
          icon: null,
          env: null,
          pauseReason: null,
          pausedAt: null,
          executionWorkspacePolicy: null,
          codebase: {
            workspaceId: null,
            repoUrl: null,
            repoRef: null,
            defaultRef: null,
            repoName: null,
            localFolder: null,
            managedFolder: "/tmp/paperclip",
            effectiveLocalFolder: "/tmp/paperclip",
            origin: "local_folder",
          },
          workspaces: [],
          primaryWorkspace: null,
          archivedAt: null,
          createdAt: new Date("2026-03-28T14:00:00.000Z"),
          updatedAt: new Date("2026-03-28T14:00:00.000Z"),
        },
        currentExecutionWorkspace,
        createdAt: new Date("2026-03-28T14:00:00.000Z"),
        updatedAt: new Date("2026-03-28T14:00:00.000Z"),
      }),
      {
        boardPresentationStatus: "in_review",
        ownerKind: "user",
        ownerAgentId: null,
        ownerUserId: "board-2",
        ownerAssignmentSource: null,
        ownershipEpoch: 2,
        labelIds: ["label-2"],
        blockedByIssueIds: ["issue-3"],
        parentId: "issue-4",
        projectId: "project-2",
        executionWorkspacePreference: "isolated_workspace",
      },
    );

    expect(next?.boardPresentationStatus).toBe("in_review");
    expect(next?.ownerKind).toBe("user");
    expect(next?.ownerAgentId).toBeNull();
    expect(next?.ownerUserId).toBe("board-2");
    expect(next?.ownershipEpoch).toBe(2);
    expect(next?.labelIds).toEqual(["label-2"]);
    expect(next?.labels?.map((label) => label.id)).toEqual(["label-2"]);
    expect(next?.blockedBy?.map((relation) => relation.id)).toEqual(["issue-3"]);
    expect(next?.parentId).toBe("issue-4");
    expect(next?.ancestors).toBeUndefined();
    expect(next?.projectId).toBe("project-2");
    expect(next?.project).toBeNull();
    expect(next?.executionWorkspacePreference).toBe("isolated_workspace");
    expect(next?.currentExecutionWorkspace).toBe(currentExecutionWorkspace);
  });

  it("matches issues by either uuid or identifier reference", () => {
    expect(matchesIssueRef({ id: "issue-1", identifier: "PAP-1" } as const, ["issue-1"])).toBe(true);
    expect(matchesIssueRef({ id: "issue-1", identifier: "PAP-1" } as const, ["PAP-1"])).toBe(true);
    expect(matchesIssueRef({ id: "issue-1", identifier: "PAP-1" } as const, ["issue-2", "PAP-2"])).toBe(false);
  });

  it("applies optimistic field updates across cached issue collections", () => {
    const issues: Issue[] = [
      createTestIssue({
        id: "issue-1",
        title: "Fix property pane",
        request: "Update the issue properties",
        ownerKind: "agent",
        ownerAgentId: "agent-1",
        ownerUserId: null,
        labelIds: [],
        labels: [],
        blockedBy: [],
        blocks: [],
        createdAt: new Date("2026-03-28T14:00:00.000Z"),
        updatedAt: new Date("2026-03-28T14:00:00.000Z"),
      }),
      createTestIssue({
        id: "issue-2",
        title: "Leave me alone",
        request: "Preserve this issue",
        issueNumber: 2,
        identifier: "PAP-2",
        ownerKind: "agent",
        ownerAgentId: "agent-2",
        ownerUserId: null,
        labelIds: [],
        labels: [],
        blockedBy: [],
        blocks: [],
        createdAt: new Date("2026-03-28T14:00:00.000Z"),
        updatedAt: new Date("2026-03-28T14:00:00.000Z"),
      }),
    ];

    const next = applyOptimisticIssueFieldUpdateToCollection(issues, ["PAP-1"], {
      ownerKind: "agent",
      ownerAgentId: "agent-9",
      ownerUserId: null,
      ownerAssignmentSource: null,
      ownershipEpoch: 2,
    });

    expect(next?.[0]?.ownerAgentId).toBe("agent-9");
    expect(next?.[1]?.ownerAgentId).toBe("agent-2");
  });

  it("treats comments without a run id as queued when they arrive during an active run", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          id: "comment-2",
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        activeRunWakeCommentId: "comment-1",
        runId: null,
      }),
    ).toBe(true);
  });

  it("does not mark the comment that triggered the active run as queued", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          id: "comment-1",
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        activeRunCommentId: "comment-1",
        activeRunWakeCommentId: "comment-1",
        runId: null,
      }),
    ).toBe(false);
  });

  it("does not mark the active run context comment as queued", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          id: "context-comment",
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        activeRunCommentId: "context-comment",
        activeRunWakeCommentId: "wake-comment",
        runId: null,
      }),
    ).toBe(false);
  });

  it("does not mark the active run wake comment as queued", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          id: "wake-comment",
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        activeRunCommentId: "context-comment",
        activeRunWakeCommentId: "wake-comment",
        runId: null,
      }),
    ).toBe(false);
  });

  it("does not mark comments with an associated run as queued", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        runId: "run-1",
      }),
    ).toBe(false);
  });

  it("does not mark interrupt comments as queued", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        interruptedRunId: "run-1",
      }),
    ).toBe(false);
  });

  it("does not mark comments from the active run agent as queued", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
          authorAgentId: "agent-1",
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        activeRunAgentId: "agent-1",
        runId: null,
      }),
    ).toBe(false);
  });

  it("keeps a confirmed queued comment queued while the target run is still live", () => {
    const comment = {
      id: "comment-1",
      companyId: "company-1",
      issueId: "issue-1",
      authorAgentId: null,
      authorUserId: "board-1",
      body: "Follow up after the active run",
      authorType: "user" as const,
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-03-28T16:20:05.000Z"),
      updatedAt: new Date("2026-03-28T16:20:05.000Z"),
    };

    const result = applyLocalQueuedIssueCommentState(comment, {
      queuedTargetRunId: "run-1",
      targetRunIsLive: true,
      runningRunId: "run-1",
    });

    expect(result).toMatchObject({
      id: "comment-1",
      clientStatus: "queued",
      queueState: "queued",
      queueTargetRunId: "run-1",
    });
  });

  it("does not keep local queued state after the target run is no longer live", () => {
    const comment = {
      id: "comment-1",
      companyId: "company-1",
      issueId: "issue-1",
      authorAgentId: null,
      authorUserId: "board-1",
      body: "Follow up after the active run",
      authorType: "user" as const,
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-03-28T16:20:05.000Z"),
      updatedAt: new Date("2026-03-28T16:20:05.000Z"),
    };

    const result = applyLocalQueuedIssueCommentState(comment, {
      queuedTargetRunId: "run-1",
      targetRunIsLive: false,
      runningRunId: null,
    });

    expect(result).toBe(comment);
  });

  it("does not keep local queued state when a different run is live", () => {
    const comment = {
      id: "comment-1",
      companyId: "company-1",
      issueId: "issue-1",
      authorAgentId: null,
      authorUserId: "board-1",
      body: "Follow up after the active run",
      authorType: "user" as const,
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-03-28T16:20:05.000Z"),
      updatedAt: new Date("2026-03-28T16:20:05.000Z"),
    };

    const result = applyLocalQueuedIssueCommentState(comment, {
      queuedTargetRunId: "run-1",
      targetRunIsLive: true,
      runningRunId: "run-2",
    });

    expect(result).toBe(comment);
  });
});
