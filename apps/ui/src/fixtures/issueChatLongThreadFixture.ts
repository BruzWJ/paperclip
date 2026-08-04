import { canonicalizeMoneyAmount, type Agent } from "@paperclipai/shared";
import type { IssueChatComment } from "../lib/issue-chat-messages";
import type { IssueTimelineEvent } from "../lib/issue-timeline-events";

export const LONG_THREAD_COMMENT_COUNT = 469;
export const LONG_THREAD_MARKDOWN_COMMENT_COUNT = 150;
export const LONG_THREAD_EVENT_COUNT = 12;

const baseTime = new Date("2026-04-28T14:00:00.000Z").getTime();

function atMinute(offset: number) {
  return new Date(baseTime + offset * 60_000);
}

function createAgent(id: string, name: string, icon: string, urlKey: string): Agent {
  const now = new Date("2026-04-28T14:00:00.000Z");
  return {
    id,
    companyId: "company-long-thread",
    name,
    urlKey,
    title: null,
    icon,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex",
    adapterConfig: {},
    currentAdapterConfigRevisionId: null,
    runtimeConfig: {},
    budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
    knownSpendAmount: canonicalizeMoneyAmount("0"),
    metadata: null,
    createdAt: now,
    updatedAt: now,
    pauseReason: null,
    pausedAt: null,
    governance: {},
  };
}

const primaryAgent = createAgent("agent-perf-codex", "CodexCoder", "code", "codexcoder");
const reviewerAgent = createAgent("agent-perf-reviewer", "ReviewBot", "sparkles", "reviewbot");

export const issueChatLongThreadAgentMap = new Map<string, Agent>([
  [primaryAgent.id, primaryAgent],
  [reviewerAgent.id, reviewerAgent],
]);

function markdownBody(index: number) {
  return [
    `## Baseline note ${index}`,
    "",
    `This assistant update captures a deterministic markdown-heavy row for long-thread rendering. It references [PAP-${2600 + index}](/PAP/issues/PAP-${2600 + index}) and includes enough structure to exercise markdown parsing.`,
    "",
    "- Parsed checklist item one with inline `code`",
    "- Parsed checklist item two with **bold** and _italic_ text",
    "- Parsed checklist item three with a link to [Paperclip](/PAP/dashboard)",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Fixture row | ${index} |`,
    `| Synthetic tokens | ${1200 + index} |`,
    "",
    "```ts",
    `const fixtureRow${index} = { markdown: true, deterministic: true };`,
    "```",
  ].join("\n");
}

function plainUserBody(index: number) {
  return `Board checkpoint ${index}: keep the issue-detail page responsive while the thread is full of historical comments.`;
}

function plainAssistantBody(index: number) {
  return `Processed checkpoint ${index}. The current direct-render path should keep this row mounted with the rest of the thread.`;
}

function createComment(index: number): IssueChatComment {
  const isMarkdown = index < LONG_THREAD_MARKDOWN_COMMENT_COUNT;
  const isAssistant = isMarkdown || index % 4 === 1 || index % 4 === 2;
  const authorAgentId = isAssistant
    ? (index % 7 === 0 ? reviewerAgent.id : primaryAgent.id)
    : null;

  return {
    id: `long-thread-comment-${String(index + 1).padStart(3, "0")}`,
    companyId: "company-long-thread",
    issueId: "issue-long-thread",
    authorType: authorAgentId ? "agent" : "user",
    authorAgentId,
    authorUserId: authorAgentId ? null : "user-board",
    body: isMarkdown
      ? markdownBody(index + 1)
      : authorAgentId
        ? plainAssistantBody(index + 1)
        : plainUserBody(index + 1),
    presentation: null,
    metadata: null,
    createdAt: atMinute(index),
    updatedAt: atMinute(index),
  };
}

export const issueChatLongThreadComments: IssueChatComment[] = Array.from(
  { length: LONG_THREAD_COMMENT_COUNT },
  (_, index) => createComment(index),
);

export const issueChatLongThreadMarkdownCommentIds = new Set(
  issueChatLongThreadComments
    .slice(0, LONG_THREAD_MARKDOWN_COMMENT_COUNT)
    .map((comment) => comment.id),
);

export const issueChatLongThreadEvents: IssueTimelineEvent[] = Array.from(
  { length: LONG_THREAD_EVENT_COUNT },
  (_, index) => ({
    id: `long-thread-event-${index + 1}`,
    createdAt: atMinute(index * 36 + 18),
    actorType: index % 3 === 0 ? "user" : "agent",
    actorId: index % 3 === 0 ? "user-board" : primaryAgent.id,
    lifecycleStatusChange: index % 2 === 0
      ? { from: index === 0 ? "todo" : "in_progress", to: "in_progress" }
      : undefined,
    ownerChange: index % 2 === 1
      ? {
          from: { ownerKind: "board", ownerAgentId: null, ownerUserId: null },
          to: { ownerKind: "agent", ownerAgentId: index % 4 === 1 ? primaryAgent.id : reviewerAgent.id, ownerUserId: null },
        }
      : undefined,
  }),
);

export const issueChatLongThreadFixtureContext = {
  issue: {
    identifier: "PAP-PERF",
    title: "Long-thread rendering baseline fixture",
    boardPresentationStatus: "in_progress",
    priority: "medium",
    projectName: "Paperclip App",
  },
  documents: [
    "Implementation Plan",
    "Profiler Notes",
    "Release Checklist",
    "QA Readout",
  ],
  subIssues: [
    "Phase 1: Add long-thread perf fixture and baseline",
    "Phase 2: Isolate issue-thread row rendering and Markdown work",
    "Phase 3: Apply virtualization and guard scroll behavior",
    "Phase 4: Verify production issue profile improvement",
  ],
  sidebarStats: [
    ["Comments", String(LONG_THREAD_COMMENT_COUNT)],
    ["Markdown bodies", String(LONG_THREAD_MARKDOWN_COMMENT_COUNT)],
    ["Timeline events", String(LONG_THREAD_EVENT_COUNT)],
    ["Grouped comments", String(LONG_THREAD_COMMENT_COUNT)],
  ],
} as const;
