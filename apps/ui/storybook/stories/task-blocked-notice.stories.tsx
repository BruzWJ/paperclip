import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TaskRelationTaskSummary } from "@paperclipai/shared";
import { TaskBlockedNotice } from "@/routes/_authenticated/$companyId/tasks/-TaskBlockedNotice";

// Rule C (PAP-13554): when a human comment on a `blocked` task does not reopen
// it, the blocked notice must state why and name the unresolved blocker leaf.
// These stories exercise the reopen-suppressed copy and its neighbours so the
// notice copy can be reviewed at a glance.

function blocker(
  overrides: Partial<TaskRelationTaskSummary> &
    Pick<
      TaskRelationTaskSummary,
      "id" | "identifier" | "title" | "boardPresentationStatus"
    >,
): TaskRelationTaskSummary {
  return {
    priority: "medium",
    ownerAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
    ownerUserId: null,
    ...overrides,
  } as TaskRelationTaskSummary;
}

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[640px] space-y-2 p-6">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

const meta = {
  title: "Product/Task/Blocked notice",
  component: TaskBlockedNotice,
  // Each story supplies its own props via `render`; this default satisfies the
  // component's one required prop (`blockers`) so the story args type-checks.
  args: { blockers: [] },
  parameters: {
    docs: {
      description: {
        component:
          "Blocked/recovery notice on the task thread. Rule C: a `blocked` task with a genuinely unresolved (not-done) blocker tells the human that a message won't reopen it yet and names the unresolved leaf with its status. Done-but-pending-finalize blockers are `done`, so they fall into the Rule B reopen path and are NOT shown as reopen-suppressed.",
      },
    },
  },
} satisfies Meta<typeof TaskBlockedNotice>;

export default meta;

type Story = StoryObj<typeof meta>;

export const RuleCSingleBlocker: Story = {
  name: "Rule C · single unresolved blocker",
  render: () => (
    <Frame label="Blocked · one in-progress blocker — a message won't reopen it yet">
      <TaskBlockedNotice
        taskStatus="blocked"
        agentName="CodexCoder"
        blockers={[
          blocker({
            id: "dddddddd-dddd-4ddd-8ddd-ddddddddd023",
            identifier: "PAP-500",
            title: "Server work still in flight",
            boardPresentationStatus: "in_progress",
          }),
        ]}
      />
    </Frame>
  ),
};

export const RuleCChainNamesLeaf: Story = {
  name: "Rule C · chain names the deepest leaf",
  render: () => (
    <Frame label="Blocked · direct blocker in review, ultimately waiting on an in-progress leaf">
      <TaskBlockedNotice
        taskStatus="blocked"
        agentName="CodexCoder"
        blockers={[
          blocker({
            id: "dddddddd-dddd-4ddd-8ddd-ddddddddd023",
            identifier: "PAP-600",
            title: "Waiting in review",
            boardPresentationStatus: "in_review",
            terminalBlockers: [
              blocker({
                id: "dddddddd-dddd-4ddd-8ddd-ddddddddd025",
                identifier: "PAP-777",
                title: "Actual work",
                boardPresentationStatus: "in_progress",
                ownerAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
              }),
            ],
          }),
        ]}
      />
    </Frame>
  ),
};

export const RuleCMultipleBlockers: Story = {
  name: "Rule C · several unresolved blockers",
  render: () => (
    <Frame label="Blocked · two unresolved blockers — count is summarized">
      <TaskBlockedNotice
        taskStatus="blocked"
        agentName="CodexCoder"
        blockers={[
          blocker({
            id: "dddddddd-dddd-4ddd-8ddd-ddddddddd023",
            identifier: "PAP-501",
            title: "First dependency",
            boardPresentationStatus: "in_progress",
          }),
          blocker({
            id: "dddddddd-dddd-4ddd-8ddd-ddddddddd024",
            identifier: "PAP-502",
            title: "Second dependency",
            boardPresentationStatus: "todo",
          }),
        ]}
      />
    </Frame>
  ),
};

export const BlockedNoUnresolvedBlockers: Story = {
  name: "Rule B path · blocked, no unresolved blockers",
  render: () => (
    <Frame label="Blocked · all blocker edges done/absent — a message WILL move it back to todo">
      <TaskBlockedNotice taskStatus="blocked" agentName="CodexCoder" blockers={[]} />
    </Frame>
  ),
};

export const InProgressWithBlocker: Story = {
  name: "In progress · blocker edge (not a reopen case)",
  render: () => (
    <Frame label="In progress · has a blocker edge — no reopen framing">
      <TaskBlockedNotice
        taskStatus="in_progress"
        agentName="CodexCoder"
        blockers={[
          blocker({
            id: "dddddddd-dddd-4ddd-8ddd-ddddddddd023",
            identifier: "PAP-800",
            title: "Dependency",
            boardPresentationStatus: "in_progress",
          }),
        ]}
      />
    </Frame>
  ),
};
