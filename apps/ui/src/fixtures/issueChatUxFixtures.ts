import { canonicalizeMoneyAmount, type Agent } from "@paperclipai/shared";
import type { InlineEntityOption } from "../components/InlineEntitySelector";
import type { MentionOption } from "../components/MarkdownEditor";
import type { IssueChatComment } from "../lib/issue-chat-messages";
import type { IssueTimelineEvent } from "../lib/issue-timeline-events";

function createAgent(
  id: string,
  name: string,
  icon: string,
  urlKey: string,
): Agent {
  const now = new Date("2026-04-06T12:00:00.000Z");
  return {
    id,
    companyId: "company-ux",
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

function createComment(overrides: Partial<IssueChatComment>): IssueChatComment {
  const merged: IssueChatComment = {
    id: "comment-default",
    companyId: "company-ux",
    issueId: "issue-ux",
    authorType: overrides.authorAgentId ? "agent" : "user",
    authorAgentId: null,
    authorUserId: "user-1",
    body: "",
    presentation: null,
    metadata: null,
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    ...overrides,
  };
  return merged;
}

const primaryAgent = createAgent("agent-1", "CodexCoder", "code", "codexcoder");
const reviewAgent = createAgent("agent-2", "ClaudeFixer", "sparkles", "claudefixer");

export const issueChatUxAgentMap = new Map<string, Agent>([
  [primaryAgent.id, primaryAgent],
  [reviewAgent.id, reviewAgent],
]);

export const issueChatUxMentions: MentionOption[] = [
  {
    id: "mention-agent-1",
    name: primaryAgent.name,
    kind: "agent",
    agentId: primaryAgent.id,
    agentIcon: primaryAgent.icon,
  },
  {
    id: "mention-agent-2",
    name: reviewAgent.name,
    kind: "agent",
    agentId: reviewAgent.id,
    agentIcon: reviewAgent.icon,
  },
  {
    id: "mention-project-1",
    name: "Paperclip Board UI",
    kind: "project",
    projectId: "project-1",
    projectColor: "#0f766e",
  },
];

export const issueChatUxOwnerOptions: InlineEntityOption[] = [
  {
    id: `agent:${primaryAgent.id}`,
    label: primaryAgent.name,
    searchText: `${primaryAgent.name} codex engineer`,
  },
  {
    id: `agent:${reviewAgent.id}`,
    label: reviewAgent.name,
    searchText: `${reviewAgent.name} claude reviewer`,
  },
  {
    id: "user:user-1",
    label: "Board",
    searchText: "board user",
  },
];

export const issueChatUxLiveComments: IssueChatComment[] = [
  createComment({
    id: "comment-live-user",
    body: "Ship the issue page as a real chat. Keep the activity feed, but make the assistant flow feel conversational.",
    createdAt: new Date("2026-04-06T11:55:00.000Z"),
    updatedAt: new Date("2026-04-06T11:55:00.000Z"),
  }),
  createComment({
    id: "comment-live-agent",
    authorAgentId: primaryAgent.id,
    authorUserId: null,
    body: "I swapped the old comment stack for the new assistant-ui thread and kept the existing issue mutations intact.",
    createdAt: new Date("2026-04-06T12:01:00.000Z"),
    updatedAt: new Date("2026-04-06T12:01:00.000Z"),
    runId: "run-history-1",
    runAgentId: primaryAgent.id,
  }),
  createComment({
    id: "comment-live-progress",
    authorAgentId: primaryAgent.id,
    authorUserId: null,
    body: "",
    presentation: {
      kind: "run_progress",
      tone: "neutral",
      detailsDefaultOpen: false,
    },
    runId: "run-live-1",
    runAgentId: primaryAgent.id,
    runState: "working",
    createdAt: new Date("2026-04-06T12:04:00.000Z"),
    updatedAt: new Date("2026-04-06T12:04:00.000Z"),
  }),
  createComment({
    id: "comment-live-queued",
    body: "Can you also make a dedicated review page that shows every chat state side by side?",
    createdAt: new Date("2026-04-06T12:05:30.000Z"),
    updatedAt: new Date("2026-04-06T12:05:30.000Z"),
    clientId: "client-queued-1",
    clientStatus: "queued",
    queueState: "queued",
    queueTargetRunId: "run-live-1",
  }),
];

export const issueChatUxLiveEvents: IssueTimelineEvent[] = [
  {
    id: "event-live-1",
    createdAt: new Date("2026-04-06T11:54:00.000Z"),
    actorType: "user",
    actorId: "user-1",
    lifecycleStatusChange: {
      from: "done",
      to: "todo",
    },
  },
  {
    id: "event-live-2",
    createdAt: new Date("2026-04-06T11:54:30.000Z"),
    actorType: "user",
    actorId: "user-1",
    ownerChange: {
      from: { ownerKind: "board", ownerAgentId: null, ownerUserId: null },
      to: { ownerKind: "agent", ownerAgentId: primaryAgent.id, ownerUserId: null },
    },
  },
];

export const issueChatUxSubmittingComments: IssueChatComment[] = [
  createComment({
    id: "comment-submitting-user-settled",
    body: "Let me know once the thread layout is locked down.",
    createdAt: new Date("2026-04-06T12:40:00.000Z"),
    updatedAt: new Date("2026-04-06T12:40:00.000Z"),
  }),
  createComment({
    id: "comment-submitting-pending",
    body: "Looks good — go ahead and ship it when you're ready.",
    createdAt: new Date("2026-04-06T12:42:00.000Z"),
    updatedAt: new Date("2026-04-06T12:42:00.000Z"),
    clientId: "client-pending-1",
    clientStatus: "pending",
  }),
];

export const issueChatUxReviewComments: IssueChatComment[] = [
  createComment({
    id: "comment-review-user",
    body: "This looks close. Tighten the spacing and keep the composer grounded to the chat surface.",
    createdAt: new Date("2026-04-06T12:28:00.000Z"),
    updatedAt: new Date("2026-04-06T12:28:00.000Z"),
  }),
  createComment({
    id: "comment-review-agent",
    authorAgentId: reviewAgent.id,
    authorUserId: null,
    body: [
      "Adjusted the treatment to feel more like a product conversation.",
      "",
      "- Removed the count from the heading",
      "- Let the page own scrolling",
      "- Added a dedicated `/tests/ux/chat` review page",
    ].join("\n"),
    createdAt: new Date("2026-04-06T12:34:00.000Z"),
    updatedAt: new Date("2026-04-06T12:34:00.000Z"),
    runId: "run-review-1",
    runAgentId: reviewAgent.id,
  }),
  createComment({
    id: "comment-review-user-followup",
    body: "Perfect. I also want to see an empty state and a blocked composer state before we merge.",
    createdAt: new Date("2026-04-06T12:36:00.000Z"),
    updatedAt: new Date("2026-04-06T12:36:00.000Z"),
  }),
];

export const issueChatUxReviewEvents: IssueTimelineEvent[] = [
  {
    id: "event-review-1",
    createdAt: new Date("2026-04-06T12:27:00.000Z"),
    actorType: "user",
    actorId: "user-1",
    ownerChange: {
      from: { ownerKind: "agent", ownerAgentId: primaryAgent.id, ownerUserId: null },
      to: { ownerKind: "agent", ownerAgentId: reviewAgent.id, ownerUserId: null },
    },
  },
];
