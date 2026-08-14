import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  RoutineListRow,
  type RoutineListProjectSummary,
  type RoutineListRowItem,
} from "@/components/RoutineList";
import type { NamedAgentSummary } from "@/lib/presentation-contracts";

const projectById = new Map<string, RoutineListProjectSummary>([
  ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", { name: "Board UI", color: "#6366f1" }],
  ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6", { name: "Growth", color: "#10b981" }],
]);
const agentById = new Map<string, NamedAgentSummary>([
  ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", { name: "CodexCoder", icon: null }],
  ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7", { name: "Digest Bot", icon: null }],
]);

type Group = { key: string; label: string | null; items: RoutineListRowItem[] };

const GROUPS: Group[] = [
  {
    key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    label: "Board UI",
    items: [
      {
        id: "ffffffff-ffff-4fff-8fff-fffffffffff6",
        title: "Weekly digest",
        status: "active",
        projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
        assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7",
        lastRun: { triggeredAt: "2026-06-09T08:00:00Z", status: "succeeded" },
      },
      {
        id: "ffffffff-ffff-4fff-8fff-fffffffffff7",
        title: "Triage stale tasks",
        status: "active",
        projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
        assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        lastRun: { triggeredAt: "2026-06-08T08:00:00Z", status: "succeeded" },
      },
      {
        id: "ffffffff-ffff-4fff-8fff-fffffffffff8",
        title: "Nightly changelog draft",
        status: "paused",
        projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
        assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        lastRun: null,
      },
    ],
  },
  {
    key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6",
    label: "Growth",
    items: [
      {
        id: "ffffffff-ffff-4fff-8fff-fffffffffff9",
        title: "Lead enrichment sweep",
        status: "active",
        projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6",
        assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        lastRun: { triggeredAt: "2026-06-09T06:00:00Z", status: "running" },
      },
      {
        id: "ffffffff-ffff-4fff-8fff-fffffffffff0",
        title: "Outbound follow-ups",
        status: "active",
        projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6",
        assigneeAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7",
        lastRun: { triggeredAt: "2026-06-07T06:00:00Z", status: "failed" },
      },
    ],
  },
];

function GroupedList() {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="flex flex-col gap-3">
        {GROUPS.map((group) => {
          const isOpen = !collapsed.includes(group.key);
          return (
            <Collapsible
              key={group.key}
              open={isOpen}
              onOpenChange={(open) =>
                setCollapsed((prev) => (open ? prev.filter((k) => k !== group.key) : [...prev, group.key]))
              }
            >
              {group.label ? (
                <div
                  className={`flex items-center gap-2 rounded-lg border border-border px-3 py-2${isOpen ? " mb-1" : ""}`}
                >
                  <CollapsibleTrigger className="flex items-center gap-1.5">
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
                    <span className="text-sm font-semibold uppercase tracking-wide">{group.label}</span>
                  </CollapsibleTrigger>
                  <span className="text-xs text-muted-foreground">{group.items.length}</span>
                </div>
              ) : null}
              <CollapsibleContent>
                {group.items.map((routine) => (
                  <RoutineListRow
                    key={routine.id}
                    routine={routine}
                    projectById={projectById}
                    agentById={agentById}
                    runningRoutineId={null}
                    statusMutationRoutineId={null}
                    runNowButton
                    divider={false}
                    onRunNow={() => {}}
                    onToggleEnabled={() => {}}
                    onToggleArchived={() => {}}
                  />
                ))}
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}

const meta: Meta<typeof GroupedList> = {
  title: "Product/Routines · List (grouped cards)",
  component: GroupedList,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof GroupedList>;

export const GroupedCards: Story = {};
