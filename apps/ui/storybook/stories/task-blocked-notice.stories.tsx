import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TaskRelationTaskSummary } from "@paperclipai/shared";
import { TaskBlockedNotice } from "@/routes/_authenticated/$companyId/tasks/-TaskBlockedNotice";

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
          "Blocked-task context with one explicit action model: use Update status for lifecycle changes and Notify owner when a response is needed.",
      },
    },
  },
} satisfies Meta<typeof TaskBlockedNotice>;

export default meta;

type Story = StoryObj<typeof meta>;

export const UnresolvedBlocker: Story = {
  name: "Unresolved blocker",
  render: () => (
    <Frame label="Blocked · one in-progress blocker">
      <TaskBlockedNotice
        taskStatus="blocked"
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

export const BlockedWithoutLinkedTask: Story = {
  name: "Blocked without linked task",
  render: () => (
    <Frame label="Blocked · no linked task">
      <TaskBlockedNotice taskStatus="blocked" blockers={[]} />
    </Frame>
  ),
};

export const InProgressWithBlocker: Story = {
  name: "In progress · blocker edge",
  render: () => (
    <Frame label="In progress · has a blocker edge">
      <TaskBlockedNotice
        taskStatus="in_progress"
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
