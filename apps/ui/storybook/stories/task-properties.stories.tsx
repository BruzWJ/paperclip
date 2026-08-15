import { TASK_PRIORITIES, TASK_STATUSES, type Task } from "@paperclipai/shared";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { TaskProperties } from "@/routes/_authenticated/$companyId/tasks/$taskNumber/-task-properties/-TaskProperties";
import { Card } from "@/components/ui/card";
import { queryKeys } from "@/lib/queryKeys";
import {
  storybookAgents,
  storybookAuthSession,
  storybookProjects,
  storybookTaskLabels,
  storybookTasks,
} from "../fixtures/paperclipData";
import { StorySection, StoryShell } from "./story-layout";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

function seedTaskPropertiesData(queryClient: QueryClient) {
  queryClient.setQueryData(queryKeys.auth.session, storybookAuthSession);
  queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), storybookAgents);
  queryClient.setQueryData(
    queryKeys.agents.taskOwnerCatalog(COMPANY_ID),
    storybookAgents.map(({ id, name, title, icon }) => ({ id, name, title, icon })),
  );
  queryClient.setQueryData(queryKeys.projects.list(COMPANY_ID), storybookProjects);
  queryClient.setQueryData(queryKeys.tasks.labels(COMPANY_ID), storybookTaskLabels);
  queryClient.setQueryData(queryKeys.tasks.list(COMPANY_ID), storybookTasks);
  queryClient.setQueryData(queryKeys.access.companyUserDirectory(COMPANY_ID), {
    users: [
      {
        principalId: "a7000000-0000-4000-8000-000000000002",
        status: "active",
        user: {
          id: "a7000000-0000-4000-8000-000000000002",
          email: "board@paperclip.local",
          name: "Board Operator",
          image: null,
        },
      },
      {
        principalId: "a7000000-0000-4000-8000-000000000004",
        status: "active",
        user: {
          id: "a7000000-0000-4000-8000-000000000004",
          email: "product@paperclip.local",
          name: "Product Lead",
          image: null,
        },
      },
    ],
  });
}

function isTaskStatus(value: unknown): value is Task["boardPresentationStatus"] {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

function isTaskPriority(value: unknown): value is Task["priority"] {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
}

function applyTaskPatch(current: Task, patch: Record<string, unknown>): Task {
  const next = { ...current };
  if (isTaskStatus(patch.status)) {
    next.boardPresentationStatus = patch.status;
  }
  if (isTaskPriority(patch.priority)) {
    next.priority = patch.priority;
  }
  if (typeof patch.ownerAgentId === "string") {
    next.ownerKind = "agent";
    next.ownerAgentId = patch.ownerAgentId;
    next.ownerUserId = null;
  }
  if (typeof patch.projectId === "string" || patch.projectId === null) {
    next.projectId = patch.projectId;
  }
  if (Array.isArray(patch.labelIds) && patch.labelIds.every((value) => typeof value === "string")) {
    next.labelIds = patch.labelIds;
  }
  if (typeof patch.parentId === "string" || patch.parentId === null) {
    next.parentId = patch.parentId;
  }
  return next;
}

function TaskPropertiesScenario({ inline = false }: { inline?: boolean }) {
  const queryClient = useQueryClient();
  useState(() => {
    seedTaskPropertiesData(queryClient);
    return true;
  });
  const [task, setTask] = useState<Task>(() => storybookTasks[1]!);
  const childTasks = storybookTasks.slice(3, 5);

  return (
    <TaskProperties
      task={task}
      childTasks={childTasks}
      inline={inline}
      hasActiveRun
      onUpdate={(patch) => setTask((current) => applyTaskPatch(current, patch))}
    />
  );
}

const meta: Meta = {
  title: "Tasks/Task Properties",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

export const Panel: Story = {
  render: () => (
    <StoryShell>
      <StorySection eyebrow="Task detail" title="Properties panel">
        <Card className="w-full max-w-sm gap-0 p-4 shadow-none">
          <TaskPropertiesScenario />
        </Card>
      </StorySection>
    </StoryShell>
  ),
};

export const MobileInline: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile" },
  },
  render: () => (
    <div className="min-h-dvh bg-background p-4">
      <TaskPropertiesScenario inline />
    </div>
  ),
};
