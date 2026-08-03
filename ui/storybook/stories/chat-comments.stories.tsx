import type { Meta, StoryObj } from "@storybook/react-vite";
import type { FeedbackVote } from "@paperclipai/shared";
import { IssueChatThread } from "@/components/IssueChatThread";
import type { MarkdownExternalReferenceMap } from "@/components/MarkdownBody";
import type { InlineEntityOption } from "@/components/InlineEntitySelector";
import type { MentionOption } from "@/components/MarkdownEditor";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { IssueChatComment } from "@/lib/issue-chat-messages";
import type { IssueTimelineEvent } from "@/lib/issue-timeline-events";
import { storybookAgentMap, storybookAgents } from "../fixtures/paperclipData";

const companyId = "company-storybook";
const projectId = "project-board-ui";
const issueId = "issue-chat-comments";
const currentUserId = "user-board";

const codexAgent = storybookAgents.find((agent) => agent.id === "agent-codex") ?? storybookAgents[0]!;
const qaAgent = storybookAgents.find((agent) => agent.id === "agent-qa") ?? storybookAgents[1]!;
const ctoAgent = storybookAgents.find((agent) => agent.id === "agent-cto") ?? storybookAgents[2]!;

const boardUserLabels = new Map<string, string>([
  ["user-board", "Riley Board"],
  ["user-product", "Mara Product"],
]);

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="paperclip-story__frame overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <div className="paperclip-story__label">{eyebrow}</div>
          <h2 className="mt-1 text-xl font-semibold">{title}</h2>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function ScenarioCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function createComment(overrides: Partial<IssueChatComment>): IssueChatComment {
  const createdAt = overrides.createdAt ?? new Date("2026-04-20T14:00:00.000Z");
  const authorAgentId = overrides.authorAgentId ?? null;
  return {
    id: "comment-default",
    companyId,
    issueId,
    authorAgentId: null,
    authorUserId: currentUserId,
    body: "",
    authorType: authorAgentId ? "agent" : "user",
    presentation: null,
    metadata: null,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    ...overrides,
  };
}

function createSystemEvent(overrides: Partial<IssueTimelineEvent>): IssueTimelineEvent {
  return {
    id: "event-default",
    createdAt: new Date("2026-04-20T14:00:00.000Z"),
    actorType: "system",
    actorId: "paperclip",
    lifecycleStatusChange: {
      from: "todo",
      to: "in_progress",
    },
    ...overrides,
  };
}

const mentionOptions: MentionOption[] = [
  {
    id: `agent:${codexAgent.id}`,
    name: codexAgent.name,
    kind: "agent",
    agentId: codexAgent.id,
    agentIcon: codexAgent.icon,
  },
  {
    id: `agent:${qaAgent.id}`,
    name: qaAgent.name,
    kind: "agent",
    agentId: qaAgent.id,
    agentIcon: qaAgent.icon,
  },
  {
    id: `project:${projectId}`,
    name: "Board UI",
    kind: "project",
    projectId,
    projectColor: "#0f766e",
  },
];

const ownerOptions: InlineEntityOption[] = [
  {
    id: `agent:${codexAgent.id}`,
    label: codexAgent.name,
    searchText: `${codexAgent.name} engineer codex`,
  },
  {
    id: `agent:${qaAgent.id}`,
    label: qaAgent.name,
    searchText: `${qaAgent.name} qa browser review`,
  },
  {
    id: `agent:${ctoAgent.id}`,
    label: ctoAgent.name,
    searchText: `${ctoAgent.name} architecture review`,
  },
  {
    id: `user:${currentUserId}`,
    label: "Riley Board",
    searchText: "board operator",
  },
];

const singleComment = [
  createComment({
    id: "comment-single-board",
    body: "Please make the issue chat states reviewable in Storybook before the next UI pass.",
    createdAt: new Date("2026-04-20T13:12:00.000Z"),
  }),
];

const feedbackVotes: FeedbackVote[] = [
  {
    id: "feedback-chat-comment-01",
    companyId,
    issueId,
    targetType: "issue_comment",
    targetId: "comment-issue-agent",
    authorUserId: currentUserId,
    vote: "up",
    reason: null,
    sharedWithLabs: false,
    sharedAt: null,
    consentVersion: null,
    redactionSummary: null,
    createdAt: new Date("2026-04-20T13:52:00.000Z"),
    updatedAt: new Date("2026-04-20T13:52:00.000Z"),
  },
];

const issueChatComments: IssueChatComment[] = [
  createComment({
    id: "comment-issue-board",
    body: "Please turn the comment thread into a reviewable chat surface. I need to see operator messages, agent output, system events, and live run progress together.\n\nFollow-up tracked in https://github.com/acme/web/pull/241 (merged) and https://github.com/acme/web/pull/243 (review pending).",
    createdAt: new Date("2026-04-20T13:44:00.000Z"),
    boardEntryKind: "comment",
    boardGroupRootId: "comment-issue-board",
    boardIsRoot: true,
    boardOrder: 1,
  }),
  createComment({
    id: "comment-issue-progress",
    authorAgentId: codexAgent.id,
    authorUserId: null,
    body: "",
    presentation: {
      kind: "run_progress",
      tone: "neutral",
      detailsDefaultOpen: false,
    },
    runId: "run-issue-chat-01",
    runAgentId: codexAgent.id,
    runState: "working",
    boardEntryKind: "run_segment",
    boardGroupRootId: "comment-issue-board",
    boardOrder: 2,
    createdAt: new Date("2026-04-20T13:46:00.000Z"),
  }),
  createComment({
    id: "comment-issue-agent",
    authorAgentId: codexAgent.id,
    authorUserId: null,
    body: "I kept the existing component contracts and added fixtures with realistic Paperclip work: checkout, grouped comments, and review feedback.\n\nFlaky CI lives in https://github.com/acme/web/pull/242 — re-running. Plain control link: https://random.example.com/path stays undecorated.",
    createdAt: new Date("2026-04-20T13:50:00.000Z"),
    runId: "run-issue-chat-01",
    runAgentId: codexAgent.id,
    boardEntryKind: "comment",
    boardGroupRootId: "comment-issue-board",
    boardOrder: 3,
  }),
  createComment({
    id: "comment-issue-queued",
    body: "@QAChecker please do a quick visual pass after the Storybook build is green.",
    createdAt: new Date("2026-04-20T13:56:00.000Z"),
    clientId: "client-issue-queued",
    clientStatus: "queued",
    queueState: "queued",
    queueTargetRunId: "run-live-chat-01",
    boardEntryKind: "comment",
    boardGroupRootId: "comment-issue-board",
    boardOrder: 4,
  }),
];

const issueTimelineEvents: IssueTimelineEvent[] = [
  createSystemEvent({
    id: "event-issue-checkout",
    createdAt: new Date("2026-04-20T13:42:00.000Z"),
    actorType: "system",
    actorId: "paperclip",
    lifecycleStatusChange: {
      from: "todo",
      to: "in_progress",
    },
  }),
  createSystemEvent({
    id: "event-issue-owner",
    createdAt: new Date("2026-04-20T13:43:00.000Z"),
    actorType: "user",
    actorId: currentUserId,
    lifecycleStatusChange: undefined,
    ownerChange: {
      from: { ownerKind: "board", ownerAgentId: null, ownerUserId: null },
      to: { ownerKind: "agent", ownerAgentId: codexAgent.id, ownerUserId: null },
    },
  }),
];

const issueThreadNoticeReviewComments: IssueChatComment[] = [
  createComment({
    id: "comment-notice-board",
    body: "The issue thread needs to show workspace routing changes clearly.",
    createdAt: new Date("2026-04-20T13:44:00.000Z"),
  }),
];

const issueThreadNoticeReviewTimelineEvents: IssueTimelineEvent[] = [
  createSystemEvent({
    id: "event-notice-workspace-change",
    createdAt: new Date("2026-04-20T13:46:00.000Z"),
    lifecycleStatusChange: undefined,
    workspaceChange: {
      from: {
        label: "Project primary workspace",
        projectWorkspaceId: "workspace-primary",
        executionWorkspaceId: null,
        mode: "shared_workspace",
      },
      to: {
        label: "PAP-3660 issue-thread-notices",
        projectWorkspaceId: null,
        executionWorkspaceId: "execution-workspace-notices",
        mode: "isolated_workspace",
      },
    },
  }),
];

const externalReferences: MarkdownExternalReferenceMap = {
  "https://github.com/acme/web/pull/241": {
    providerKey: "github",
    objectType: "pull_request",
    statusCategory: "succeeded",
    liveness: "fresh",
    statusLabel: "Merged",
    displayTitle: "Add external refs",
  },
  "https://github.com/acme/web/pull/242": {
    providerKey: "github",
    objectType: "pull_request",
    statusCategory: "failed",
    liveness: "stale",
    statusLabel: "CI failed",
    displayTitle: "Flaky tests",
  },
  "https://github.com/acme/web/pull/243": {
    providerKey: "github",
    objectType: "pull_request",
    statusCategory: "waiting",
    liveness: "fresh",
    statusLabel: "Awaiting review",
    displayTitle: "Add liveness overlay",
  },
  "https://app.hubspot.com/leads/99": {
    providerKey: "hubspot",
    objectType: "lead",
    statusCategory: "auth_required",
    liveness: "auth_required",
    statusLabel: "Reconnect",
    displayTitle: "Acme deal",
  },
};

function IssueChatMatrix() {
  return (
    <Section eyebrow="IssueChatThread" title="Issue-specific chat with timeline events and grouped run progress">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="rounded-lg border border-border bg-background/70 p-4">
          <IssueChatThread
            comments={issueChatComments}
            timelineEvents={issueTimelineEvents}
            hasActiveRun
            feedbackVotes={feedbackVotes}
            feedbackDataSharingPreference="allowed"
            companyId={companyId}
            projectId={projectId}
            issueStatus="in_progress"
            agentMap={storybookAgentMap}
            currentUserId={currentUserId}
            userLabelMap={boardUserLabels}
            onAdd={async () => {}}
            onVote={async () => {}}
            onStopRun={async () => {}}
            enableOwnerChange
            ownerOptions={ownerOptions}
            currentOwnerValue={`agent:${codexAgent.id}`}
            suggestedOwnerValue={`agent:${codexAgent.id}`}
            mentions={mentionOptions}
            onInterruptQueued={async () => {}}
            onCancelQueued={() => undefined}
            externalReferences={externalReferences}
          />
        </div>
        <div className="space-y-5">
          <ScenarioCard title="Empty issue chat" description="The standalone empty state before an operator or agent posts.">
            <IssueChatThread
              comments={[]}
              timelineEvents={[]}
              companyId={companyId}
              projectId={projectId}
              agentMap={storybookAgentMap}
              currentUserId={currentUserId}
              onAdd={async () => {}}
              emptyMessage="No chat yet. The first operator note will start the issue conversation."
            />
          </ScenarioCard>
          <ScenarioCard title="Disabled composer" description="Review state where the conversation remains readable but input is paused.">
            <IssueChatThread
              comments={singleComment}
              timelineEvents={[]}
              companyId={companyId}
              projectId={projectId}
              agentMap={storybookAgentMap}
              currentUserId={currentUserId}
              onAdd={async () => {}}
              showJumpToLatest={false}
              composerDisabledReason="This issue is in review. Request changes or approve it from the review controls."
            />
          </ScenarioCard>
          <ScenarioCard
            title="Planning mode composer"
            description="Issue is in planning mode. The composer turns amber and surfaces a Planning chip next to the paperclip — clicking it stages a Standard submission without immediately changing the issue mode."
          >
            <IssueChatThread
              comments={[]}
              timelineEvents={[]}
              companyId={companyId}
              projectId={projectId}
              agentMap={storybookAgentMap}
              currentUserId={currentUserId}
              issueWorkMode="planning"
              onWorkModeChange={() => undefined}
              onAdd={async () => {}}
              emptyMessage="Planning mode reply box example."
            />
          </ScenarioCard>
        </div>
      </div>
    </Section>
  );
}

function IssueThreadWorkspaceReview() {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner max-w-4xl">
        <Section eyebrow="IssueChatThread" title="Workspace changes">
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <IssueChatThread
              comments={issueThreadNoticeReviewComments}
              timelineEvents={issueThreadNoticeReviewTimelineEvents}
              companyId={companyId}
              projectId={projectId}
              issueStatus="done"
              agentMap={storybookAgentMap}
              currentUserId={currentUserId}
              userLabelMap={boardUserLabels}
              onAdd={async () => {}}
              showJumpToLatest={false}
            />
          </div>
        </Section>
      </main>
    </div>
  );
}

function ChatCommentsStories() {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">
        <section className="paperclip-story__frame p-6">
          <div className="paperclip-story__label">Chat & Comments</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Threaded work conversations</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            Fixture-backed coverage for the canonical grouped issue chat surface. The scenarios use Paperclip
            operational content with mixed authors, system timeline events, markdown, @mentions, links, queued
            comments, replies, and grouped run-progress comments.
          </p>
        </section>

        <IssueChatMatrix />
      </main>
    </div>
  );
}

const meta = {
  title: "Product/Chat & Comments",
  component: ChatCommentsStories,
  parameters: {
    docs: {
      description: {
        component:
          "Chat and comments stories exercise the canonical IssueChatThread across empty, grouped run-progress, timeline, queued, reply, and planning states.",
      },
    },
  },
} satisfies Meta<typeof ChatCommentsStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FullSurfaceMatrix: Story = {};

export const IssueChatWithTimeline: Story = {
  render: () => (
    <div className="paperclip-story">
      <main className="paperclip-story__inner">
        <IssueChatMatrix />
      </main>
    </div>
  ),
};

export const IssueThreadNotices: Story = {
  render: () => <IssueThreadWorkspaceReview />,
};
