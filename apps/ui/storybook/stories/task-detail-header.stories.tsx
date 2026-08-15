import type { Task } from "@paperclipai/shared";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { TaskDetailHeader } from "@/routes/_authenticated/$companyId/tasks/$taskNumber/-TaskDetailHeader";
import { TaskDetailPageProvider } from "@/routes/_authenticated/$companyId/tasks/$taskNumber/-TaskDetailPageContext";
import type { TaskDetailController } from "@/routes/_authenticated/$companyId/tasks/$taskNumber";
import { storybookAgents, storybookTasks } from "../fixtures/paperclipData";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const BOARD_USER_ID = "a7000000-0000-4000-8000-000000000002";

function taskForScenario(mobile: boolean): Task {
  if (!mobile) {
    return {
      ...storybookTasks[0]!,
      title: "Create a dependable task detail experience for operators",
      request:
        "Rework the task header so operators can scan state, ownership, origin, and available controls without decoding an undifferentiated metadata row.",
      workMode: "planning",
    };
  }

  return {
    ...storybookTasks[2]!,
    title: "Verify task ownership and controls on narrow screens without losing context",
    request:
      "Keep the title, current state, owner, originator, and core task actions readable on a mobile viewport.",
    creatorKind: "agent-execution",
    creatorAuthorityId: storybookAgents[1]!.id,
    creatorAdapterConfigRevisionId: "storybook-revision",
    creatorUserId: null,
    workMode: "ask",
  } as Task;
}

function TaskDetailHeaderScenario({ mobile = false }: { mobile?: boolean }) {
  const [task, setTask] = useState<Task>(() => taskForScenario(mobile));
  const [moreOpen, setMoreOpen] = useState(false);
  const [panelVisible, setPanelVisible] = useState(false);
  const agentMap = new Map(storybookAgents.map((agent) => [agent.id, agent]));
  const userLabelMap = new Map([[BOARD_USER_ID, "Board Operator"]]);
  const userProfileMap = new Map([[BOARD_USER_ID, { label: "Board Operator", image: null }]]);

  const controller = {
    kind: "ready",
    task,
    companyId: COMPANY_ID,
    agentMap,
    userLabelMap,
    userProfileMap,
    hasLiveRuns: !mobile,
    isMobile: mobile,
    isFromInbox: false,
    copied: false,
    copyTaskToClipboard: () => undefined,
    panelVisible,
    setPanelVisible,
    setMobileInspectorOpen: () => undefined,
    moreOpen,
    setMoreOpen,
    canArchiveFromInbox: false,
    archivePending: false,
    archiveFromInbox: { mutate: () => undefined },
    canPauseLeafWork: true,
    canResumeLeafWork: false,
    canShowSubtreeControls: false,
    canResumeSubtree: false,
    canRestoreSubtree: false,
    setReopenDialogOpen: () => undefined,
    setTreeControlMode: () => undefined,
    setTreeControlCancelConfirmed: () => undefined,
    setTreeControlOpen: () => undefined,
    updateTaskTitle: {
      mutateAsync: async (title: string | null) => {
        setTask((current) => ({ ...current, title }));
        return { ...task, title };
      },
    },
  } as unknown as TaskDetailController;

  return (
    <TaskDetailPageProvider value={controller}>
      <TaskDetailHeader />
    </TaskDetailPageProvider>
  );
}

const meta: Meta = {
  title: "Tasks/Task Detail Header",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Task-detail hierarchy with title-first scanning, operational state, visible owner/originator attribution, and responsive task controls.",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

export const Desktop: Story = {
  render: () => (
    <div className="min-h-dvh bg-background p-6">
      <div className="mx-auto max-w-3xl">
        <TaskDetailHeaderScenario />
      </div>
    </div>
  ),
};

export const Mobile: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile" },
  },
  render: () => (
    <div className="min-h-dvh bg-background p-4">
      <TaskDetailHeaderScenario mobile />
    </div>
  ),
};
