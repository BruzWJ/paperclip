import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Agent, Approval } from "@paperclipai/shared";

import { TaskChatThread } from "@/routes/_authenticated/$companyId/tasks/$taskNumber/-task-chat/-TaskChatThread";
import { TaskChatConfirmation } from "@/routes/_authenticated/$companyId/tasks/$taskNumber/-task-chat/-TaskChatConfirmation";
import type { TaskChatComment } from "@/lib/task-chat-messages";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_AGENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_USER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TASK_ID = "22222222-2222-4222-8222-222222222222";

const agent = {
  id: AGENT_ID,
  name: "Research agent",
  icon: "search",
  status: "active",
} as unknown as Agent;

const secondAgent = {
  id: SECOND_AGENT_ID,
  name: "Deployment reliability and infrastructure agent",
  icon: "shield",
  status: "active",
} as unknown as Agent;

const agentMap = new Map([
  [AGENT_ID, agent],
  [SECOND_AGENT_ID, secondAgent],
]);
const userProfileMap = new Map([
  [USER_ID, { label: "Avery Stone", image: null }],
  [OTHER_USER_ID, { label: "Maya Chen", image: null }],
]);

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
  metadata: null,
  presentation: null,
  sourceTrust: null,
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
    boardOrder: 1,
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
    id: "comment-teammate",
    authorType: "user",
    authorAgentId: null,
    authorUserId: OTHER_USER_ID,
    body: "I confirmed the legacy flag is still present in the production template.",
    createdAt: "2026-08-14T17:58:30.000Z",
    boardEntryKind: "comment",
    boardGroupRootId: "comment-human",
    boardOrder: 2,
    immediateParentDisplayReference: {
      authorLabel: "Research agent",
      excerpt: "Update the deployment template before the next rollout.",
    },
  },
  {
    ...baseComment,
    id: "comment-plugin",
    authorType: "plugin",
    authorLabel: "Deployment automation",
    authorAgentId: null,
    authorUserId: null,
    body: "Preview environment pap-2048 is ready and passed its health check.",
    createdAt: "2026-08-14T17:58:45.000Z",
    boardEntryKind: "comment",
    boardGroupRootId: "comment-plugin",
    boardOrder: 3,
  },
  {
    ...baseComment,
    id: "comment-second-agent",
    authorType: "agent",
    authorAgentId: SECOND_AGENT_ID,
    authorUserId: null,
    body: "I can update the health-check default after the approval is recorded.",
    createdAt: "2026-08-14T17:58:50.000Z",
    boardEntryKind: "comment",
    boardGroupRootId: "comment-second-agent",
    boardOrder: 4,
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
    boardOrder: 5,
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
    boardOrder: 6,
    clientStatus: "queued",
  },
];

const meta = {
  title: "Product/Task/AI Elements chat",
  component: TaskChatThread,
  parameters: {
    docs: {
      description: {
        component:
          "Native AI Elements task conversation: human messages, agent reasoning and tools, system notices, queued work, attachments, and PromptInput composition.",
      },
    },
  },
  args: {
    comments,
    taskId: TASK_ID,
    mentionIsResponseOnly: false,
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
        taskId={TASK_ID}
        agentMap={agentMap}
        currentUserId={USER_ID}
        userProfileMap={userProfileMap}
        composerAccessory={
          <TaskChatConfirmation approval={approval} requesterAgent={agent} onDecision={() => undefined} />
        }
        ownerAgentId={AGENT_ID}
        mentionTarget={{
          targetAgentId: AGENT_ID,
          ownershipEpoch: 1,
          name: agent.name,
          icon: agent.icon ?? null,
        }}
        mentionIsResponseOnly={false}
        onAdd={async () => undefined}
      />
    </div>
  ),
};

export const EmptyConversation: Story = {
  render: () => (
    <div className="mx-auto max-w-4xl p-6">
      <TaskChatThread
        comments={[]}
        taskId={TASK_ID}
        mentionIsResponseOnly={false}
        onAdd={async () => undefined}
      />
    </div>
  ),
};
