import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Agent, Approval } from "@paperclipai/shared";

import { TaskChatThread } from "@/components/TaskChatThread";
import { TaskChatConfirmation } from "@/components/task-chat/TaskChatConfirmation";
import type { TaskChatComment } from "@/lib/task-chat-messages";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const agent = {
  id: AGENT_ID,
  name: "Research agent",
  icon: null,
  status: "active",
} as unknown as Agent;

const approval: Approval = {
  id: "33333333-3333-4333-8333-333333333333",
  companyId: "11111111-1111-4111-8111-111111111111",
  type: "request_board_approval",
  requestedByAgentId: AGENT_ID,
  requestedByUserId: null,
  status: "pending",
  payload: { title: "Publish the deployment template update" },
  decisionNote: null,
  decidedByUserId: null,
  decidedAt: null,
  createdAt: new Date("2026-08-14T17:59:00.000Z"),
  updatedAt: new Date("2026-08-14T17:59:00.000Z"),
};

const baseComment = {
  companyId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  metadata: null,
  presentation: null,
  sourceTrust: null,
  updatedAt: "2026-08-14T18:00:00.000Z",
} as const;

const comments: TaskChatComment[] = [
  {
    ...baseComment,
    id: "comment-human",
    authorType: "user",
    authorAgentId: null,
    authorUserId: USER_ID,
    body: "Check the release notes and call out anything that changes our deployment plan.",
    createdAt: "2026-08-14T17:57:00.000Z",
    boardEntryKind: "comment",
    boardGroupRootId: "comment-human",
    boardIsRoot: true,
    boardOrder: 0,
  },
  {
    ...baseComment,
    id: "segment-agent",
    authorType: "agent",
    authorAgentId: AGENT_ID,
    authorUserId: null,
    body: "",
    createdAt: "2026-08-14T17:58:00.000Z",
    boardEntryKind: "run_segment",
    boardGroupRootId: "comment-human",
    boardIsRoot: false,
    boardOrder: 1,
    boardRunSegmentStatus: "complete",
    runState: "terminal",
    boardRunSegmentParts: [
      {
        type: "reasoning",
        text: "I should compare the release notes with the current deployment constraints before summarizing.",
      },
      { type: "tool", name: "read_release_notes", status: "completed" },
      {
        type: "text",
        text: "The release changes the health-check default and deprecates the legacy build flag. Update the deployment template before the next rollout.",
      },
    ],
  },
  {
    ...baseComment,
    id: "comment-system",
    authorType: "system",
    authorAgentId: null,
    authorUserId: null,
    body: "A deployment approval is required before this task can continue.",
    createdAt: "2026-08-14T17:59:00.000Z",
    presentation: {
      kind: "system_notice",
      tone: "warning",
      title: "Approval required",
      detailsDefaultOpen: false,
    },
    boardEntryKind: "comment",
    boardGroupRootId: "comment-system",
    boardIsRoot: true,
    boardOrder: 2,
  },
  {
    ...baseComment,
    id: "comment-queued",
    authorType: "user",
    authorAgentId: null,
    authorUserId: USER_ID,
    body: "After the current run, prepare the deployment template patch.",
    createdAt: "2026-08-14T18:00:00.000Z",
    boardEntryKind: "comment",
    boardGroupRootId: "comment-queued",
    boardIsRoot: true,
    boardOrder: 3,
    clientStatus: "queued",
    queueState: "queued",
    queueTargetRunId: "run-active",
  },
];

const meta = {
  title: "Product/Task/AI Elements chat",
  component: TaskChatThread,
  parameters: {
    docs: {
      description: {
        component:
          "Native AI Elements task conversation: human messages, agent reasoning and tools, system notices, queued work, attachments, routing controls, and PromptInput composition.",
      },
    },
  },
  args: {
    comments,
    onAdd: async () => undefined,
  },
} satisfies Meta<typeof TaskChatThread>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FullConversation: Story = {
  render: () => (
    <div className="mx-auto max-w-4xl p-6">
      <TaskChatThread
        comments={comments}
        taskId={baseComment.taskId}
        companyId={baseComment.companyId}
        timelineEvents={[]}
        agentMap={new Map([[AGENT_ID, agent]])}
        currentUserId={USER_ID}
        userLabelMap={new Map([[USER_ID, "You"]])}
        composerAccessory={
          <TaskChatConfirmation approval={approval} requesterAgent={agent} onDecision={() => undefined} />
        }
        hasActiveRun
        activeRunIds={new Set(["run-active"])}
        enableOwnerChange
        ownerOptions={[{ id: `agent:${AGENT_ID}`, label: agent.name }]}
        currentOwnerValue={`agent:${AGENT_ID}`}
        mentions={[
          {
            id: `agent:${AGENT_ID}`,
            kind: "agent",
            agentId: AGENT_ID,
            name: agent.name,
            agentIcon: null,
          },
        ]}
        onAdd={async () => undefined}
        onInterruptQueued={async () => undefined}
        onCancelQueued={() => undefined}
      />
    </div>
  ),
};

export const EmptyConversation: Story = {
  render: () => (
    <div className="mx-auto max-w-4xl p-6">
      <TaskChatThread
        comments={[]}
        taskId={baseComment.taskId}
        companyId={baseComment.companyId}
        timelineEvents={[]}
        onAdd={async () => undefined}
      />
    </div>
  ),
};
