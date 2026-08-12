import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AGENT_STATUSES, TASK_PRIORITIES, TASK_STATUSES } from "@paperclipai/shared";
import type {
  TaskBlockerAttention,
  TaskRelationTaskSummary,
} from "@paperclipai/shared";
import { Clock3, DollarSign, FolderKanban, Inbox, Users } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Identity } from "@/components/Identity";
import { TaskBlockedNotice } from "@/components/TaskBlockedNotice";
import { TaskRow } from "@/components/TaskRow";
import { MetricCard } from "@/components/MetricCard";
import { PriorityIcon } from "@/components/PriorityIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createTask } from "../fixtures/paperclipData";

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
      <div className="border-b border-border px-5 py-4">
        <div className="paperclip-story__label">{eyebrow}</div>
        <h2 className="mt-1 text-xl font-semibold">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

type CoveredBlockedCell = {
  label: string;
  status: string;
  blockerAttention: TaskBlockerAttention | null;
  expectedVisual: string;
  expectedCopy: string;
};

function attention(
  partial: Partial<TaskBlockerAttention> & Pick<TaskBlockerAttention, "state" | "reason">,
): TaskBlockerAttention {
  return {
    state: partial.state,
    reason: partial.reason,
    unresolvedBlockerCount: partial.unresolvedBlockerCount ?? 0,
    coveredBlockerCount: partial.coveredBlockerCount ?? 0,
    stalledBlockerCount: partial.stalledBlockerCount ?? 0,
    attentionBlockerCount: partial.attentionBlockerCount ?? 0,
    sampleBlockerIdentifier: partial.sampleBlockerIdentifier ?? null,
    sampleStalledBlockerIdentifier: partial.sampleStalledBlockerIdentifier ?? null,
  };
}

const coveredBlockedMatrix: CoveredBlockedCell[] = [
  {
    label: "Normal blocked",
    status: "blocked",
    blockerAttention: null,
    expectedVisual: "solid red ring",
    expectedCopy: "Blocked",
  },
  {
    label: "Covered by 1 active child",
    status: "blocked",
    blockerAttention: attention({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2175",
    }),
    expectedVisual: "cyan ring",
    expectedCopy: "Blocked · waiting on active sub-task PAP-2175",
  },
  {
    label: "Covered by N active children",
    status: "blocked",
    blockerAttention: attention({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 3,
      coveredBlockerCount: 3,
    }),
    expectedVisual: "cyan ring",
    expectedCopy: "Blocked · waiting on 3 active sub-tasks",
  },
  {
    label: "Covered by active dependency",
    status: "blocked",
    blockerAttention: attention({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-1918",
    }),
    expectedVisual: "cyan ring",
    expectedCopy: "Blocked · covered by active dependency PAP-1918",
  },
  {
    label: "Covered by N active dependencies",
    status: "blocked",
    blockerAttention: attention({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 2,
    }),
    expectedVisual: "cyan ring",
    expectedCopy: "Blocked · covered by 2 active dependencies",
  },
  {
    label: "Stalled review (single leaf)",
    status: "blocked",
    blockerAttention: attention({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 1,
      stalledBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2279",
      sampleStalledBlockerIdentifier: "PAP-2279",
    }),
    expectedVisual: "amber ring with dot",
    expectedCopy: "Blocked · review stalled on PAP-2279",
  },
  {
    label: "Stalled review (multiple leaves)",
    status: "blocked",
    blockerAttention: attention({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 2,
      stalledBlockerCount: 2,
      sampleStalledBlockerIdentifier: "PAP-2279",
    }),
    expectedVisual: "amber ring with dot",
    expectedCopy: "Blocked · 2 reviews stalled with no clear next step",
  },
  {
    label: "Mixed: 1 covered, 1 needs attention",
    status: "blocked",
    blockerAttention: attention({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 1,
      attentionBlockerCount: 1,
    }),
    expectedVisual: "solid red ring",
    expectedCopy: "Blocked · 2 unresolved blockers need attention",
  },
  {
    label: "Needs attention (single blocker)",
    status: "blocked",
    blockerAttention: attention({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-1042",
    }),
    expectedVisual: "solid red ring",
    expectedCopy: "Blocked · 1 unresolved blocker needs attention",
  },
  {
    label: "Non-blocked with prop ignored",
    status: "in_progress",
    blockerAttention: attention({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2175",
    }),
    expectedVisual: "yellow ring",
    expectedCopy: "In Progress",
  },
];

const coveredBlockedTask = createTask({
  id: "dddddddd-dddd-4ddd-8ddd-ddddddddd011",
  identifier: "PAP-2178",
  taskNumber: 2178,
  title: "Covered blocked visual state: final acceptance",
  boardPresentationStatus: "blocked",
  priority: "medium",
  blockerAttention: coveredBlockedMatrix[1]!.blockerAttention ?? undefined,
  lastActivityAt: new Date("2026-04-24T13:40:00.000Z"),
  updatedAt: new Date("2026-04-24T13:40:00.000Z"),
});

function summaryBlocker(
  partial: Partial<TaskRelationTaskSummary> &
    Pick<
      TaskRelationTaskSummary,
      "id" | "identifier" | "title" | "boardPresentationStatus"
    >,
): TaskRelationTaskSummary {
  return {
    id: partial.id,
    taskNumber:
      partial.taskNumber ?? Number(partial.identifier.split("-").at(-1)),
    identifier: partial.identifier,
    title: partial.title,
    boardPresentationStatus: partial.boardPresentationStatus,
    priority: partial.priority ?? "medium",
    ownerAgentId: partial.ownerAgentId ?? null,
    ownerUserId: partial.ownerUserId ?? null,
    terminalBlockers: partial.terminalBlockers,
  };
}

type BlockedNoticeStateLabel =
  | "Default covered"
  | "Stalled (single leaf)"
  | "Stalled (multiple leaves)";

type BlockedNoticeFixture = {
  label: BlockedNoticeStateLabel;
  caption: string;
  blockers: TaskRelationTaskSummary[];
  blockerAttention: TaskBlockerAttention;
};

const stalledLeafSingle = summaryBlocker({
  id: "dddddddd-dddd-4ddd-8ddd-ddddddddd01c",
  identifier: "PAP-2279",
  title: "Stage gate review for export pipeline",
  boardPresentationStatus: "in_review",
});

const stalledLeafMultiPrimary = summaryBlocker({
  id: "dddddddd-dddd-4ddd-8ddd-ddddddddd01a",
  identifier: "PAP-2284",
  title: "Approve schema migration",
  boardPresentationStatus: "in_review",
});

const stalledLeafMultiSecondary = summaryBlocker({
  id: "dddddddd-dddd-4ddd-8ddd-ddddddddd01b",
  identifier: "PAP-2291",
  title: "Sign off on rollout copy",
  boardPresentationStatus: "in_review",
});

const blockedNoticeFixtures: BlockedNoticeFixture[] = [
  {
    label: "Default covered",
    caption: "Active sub-task covers the chain — informational only.",
    blockers: [
      summaryBlocker({
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddd00f",
        identifier: "PAP-2175",
        title: "Wire export pipeline preview",
        boardPresentationStatus: "in_progress",
      }),
    ],
    blockerAttention: attention({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2175",
    }),
  },
  {
    label: "Stalled (single leaf)",
    caption: "Chain stalled on one leaf review — copy names the leaf and shows the chip strip.",
    blockers: [
      summaryBlocker({
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddd01f",
        identifier: "PAP-2278",
        title: "Ship rollout dashboard",
        boardPresentationStatus: "blocked",
        terminalBlockers: [stalledLeafSingle],
      }),
    ],
    blockerAttention: attention({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 1,
      stalledBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2279",
      sampleStalledBlockerIdentifier: "PAP-2279",
    }),
  },
  {
    label: "Stalled (multiple leaves)",
    caption: "Multiple stalled reviews — body uses plural agreement (\"reviews\"/\"them\") to match the chip strip.",
    blockers: [
      summaryBlocker({
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddd01d",
        identifier: "PAP-2283",
        title: "Coordinate billing change rollout",
        boardPresentationStatus: "blocked",
        terminalBlockers: [stalledLeafMultiPrimary],
      }),
      summaryBlocker({
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddd01e",
        identifier: "PAP-2290",
        title: "Coordinate marketing transfer",
        boardPresentationStatus: "blocked",
        terminalBlockers: [stalledLeafMultiSecondary],
      }),
    ],
    blockerAttention: attention({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 2,
      stalledBlockerCount: 2,
      sampleStalledBlockerIdentifier: "PAP-2284",
    }),
  },
];

function BlockedNoticeSurface({
  mode,
  size,
  fixture,
}: {
  mode: "light" | "dark";
  size: "desktop" | "mobile";
  fixture: BlockedNoticeFixture;
}) {
  const isDark = mode === "dark";
  const isMobile = size === "mobile";
  return (
    <div className={isDark ? "dark" : undefined}>
      <div className="rounded-lg border border-border bg-background text-foreground">
        <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          <span>{fixture.label}</span>
          <span className="font-mono">
            {size} · {mode}
          </span>
        </div>
        <div className={isMobile ? "max-w-[358px] px-3 py-3" : "min-w-[620px] px-4 py-3"}>
          <TaskBlockedNotice
            taskStatus="blocked"
            blockers={fixture.blockers}
            blockerAttention={fixture.blockerAttention}
          />
          <p className="text-[11px] text-muted-foreground">{fixture.caption}</p>
        </div>
      </div>
    </div>
  );
}

function CoveredBlockedSurface({ mode, size }: { mode: "light" | "dark"; size: "desktop" | "mobile" }) {
  const isDark = mode === "dark";
  const isMobile = size === "mobile";

  return (
    <div className={isDark ? "dark" : undefined}>
      <div className="rounded-lg border border-border bg-background text-foreground">
        <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          {size} · {mode}
        </div>
        <div className={isMobile ? "max-w-[340px]" : "min-w-[620px]"}>
          <TaskRow
            task={coveredBlockedTask}
            mobileMeta={<StatusBadge status={coveredBlockedTask.boardPresentationStatus} />}
            trailingMeta="waiting on PAP-2175"
          />
        </div>
      </div>
    </div>
  );
}

function StatusLanguage() {
  const [priority, setPriority] = useState("high");

  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">
        <section className="paperclip-story__frame p-6">
          <div className="paperclip-story__label">Language</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Status, priority, identity, and metrics</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            These components carry the operational vocabulary of the board: who is acting, what state work is in,
            how urgent it is, and whether capacity or spend needs attention.
          </p>
        </section>

        <Section eyebrow="Lifecycle" title="Task and agent statuses">
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Task statuses</CardTitle>
                <CardDescription>Every task transition state in the V1 task lifecycle.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {TASK_STATUSES.map((status) => (
                  <StatusBadge key={status} status={status} />
                ))}
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Agent statuses</CardTitle>
                <CardDescription>Runtime and governance states shown in org, sidebar, and detail surfaces.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {AGENT_STATUSES.map((status) => (
                  <StatusBadge key={status} status={status} />
                ))}
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section eyebrow="Covered blocked" title="Blocked attention state matrix">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {coveredBlockedMatrix.map((item) => (
              <div
                key={item.label}
                className="flex min-h-[136px] flex-col justify-between rounded-lg border border-border bg-background/70 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">{item.label}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{item.expectedVisual}</div>
                  </div>
                  <StatusIcon status={item.status} blockerAttention={item.blockerAttention} />
                </div>
                <div className="mt-4 rounded-md bg-muted/45 px-2.5 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
                  {item.expectedCopy}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Tooltip and aria-label copy begin with "Blocked · " for every cell after the first. Covered cells show a cyan
            ring with a small dot, stalled-review cells show an amber ring with a centered dot, and the needs-attention
            cells retain the solid red ring.
          </p>
        </Section>

        <Section eyebrow="Covered blocked" title="TaskRow desktop and mobile surfaces">
          <div className="grid gap-4 xl:grid-cols-2">
            <CoveredBlockedSurface mode="light" size="desktop" />
            <CoveredBlockedSurface mode="dark" size="desktop" />
            <CoveredBlockedSurface mode="light" size="mobile" />
            <CoveredBlockedSurface mode="dark" size="mobile" />
          </div>
        </Section>

        <Section eyebrow="Covered blocked" title="TaskBlockedNotice in chat thread">
          <div className="space-y-5">
            {blockedNoticeFixtures.map((fixture) => (
              <div key={fixture.label} className="grid gap-4 xl:grid-cols-2">
                <BlockedNoticeSurface mode="light" size="desktop" fixture={fixture} />
                <BlockedNoticeSurface mode="dark" size="desktop" fixture={fixture} />
                <BlockedNoticeSurface mode="light" size="mobile" fixture={fixture} />
                <BlockedNoticeSurface mode="dark" size="mobile" fixture={fixture} />
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Stalled-state copy switches to "stalled in review without a clear next step" and adds a "Stalled in review"
            chip strip beneath the regular blocker chips. The trailing imperative pluralizes when multiple stalled
            leaves are surfaced ("reviews"/"them") to match the chip strip.
          </p>
        </Section>

        <Section eyebrow="Priority" title="Static labels and editable popover trigger">
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className="grid gap-3 sm:grid-cols-2">
              {TASK_PRIORITIES.map((item) => (
                <div key={item} className="flex items-center justify-between rounded-lg border border-border bg-background/70 p-4">
                  <PriorityIcon priority={item} showLabel />
                  <span className="font-mono text-xs text-muted-foreground">{item}</span>
                </div>
              ))}
            </div>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Editable priority</CardTitle>
                <CardDescription>Click the control to inspect the same popover used in task rows.</CardDescription>
              </CardHeader>
              <CardContent>
                <PriorityIcon priority={priority} onChange={setPriority} showLabel />
                <div className="mt-3 text-xs text-muted-foreground">Current value: {priority}</div>
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section eyebrow="Identity" title="Agent and user chips">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>XS</CardTitle>
              </CardHeader>
              <CardContent>
                <Identity name="CodexCoder" size="xs" />
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Small</CardTitle>
              </CardHeader>
              <CardContent>
                <Identity name="Board User" size="sm" initials="BU" />
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Default</CardTitle>
              </CardHeader>
              <CardContent>
                <Identity name="DesignSystemCoder" />
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Long label</CardTitle>
              </CardHeader>
              <CardContent className="max-w-[220px]">
                <Identity name="Senior Product Engineering Reviewer" size="lg" />
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section eyebrow="Dashboard" title="Metrics, quota bars, empty states, and copy affordances">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                icon={Users}
                value={8}
                label="Agents"
                description="3 live runs"
                linkOptions={{
                  to: "/$companyId/agents/idle",
                  params: { companyId: "11111111-1111-4111-8111-111111111111" },
                }}
              />
              <MetricCard
                icon={FolderKanban}
                value={27}
                label="Open tasks"
                description="5 in review"
                linkOptions={{
                  to: "/$companyId/tasks",
                  params: { companyId: "11111111-1111-4111-8111-111111111111" },
                }}
              />
              <MetricCard
                icon={DollarSign}
                value="$675"
                label="MTD spend"
                description="27% of budget"
                linkOptions={{
                  to: "/$companyId/costs",
                  params: { companyId: "11111111-1111-4111-8111-111111111111" },
                }}
              />
              <MetricCard icon={Clock3} value="14m" label="P95 run age" description="last 24 hours" />
            </div>

          </div>

          <div className="mt-5 grid gap-5">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Empty state</CardTitle>
                <CardDescription>Used when a list has no meaningful rows yet.</CardDescription>
              </CardHeader>
              <CardContent>
                <EmptyState icon={Inbox} message="No assigned work is waiting in this queue." action="Create task" onAction={() => undefined} />
              </CardContent>
            </Card>
          </div>
        </Section>
      </main>
    </div>
  );
}

const meta = {
  title: "Foundations/Status Language",
  component: StatusLanguage,
  parameters: {
    docs: {
      description: {
        component:
          "Status-language stories show the reusable operational labels, identity chips, metrics, and capacity indicators used throughout the board.",
      },
    },
  },
} satisfies Meta<typeof StatusLanguage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FullMatrix: Story = {};
