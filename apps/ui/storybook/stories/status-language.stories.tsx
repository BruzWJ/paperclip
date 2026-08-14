import { useState } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import { AGENT_STATUSES, TASK_PRIORITIES, TASK_STATUSES } from "@paperclipai/shared";

import { Clock3, DollarSign, FolderKanban, Inbox, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { TaskBlockedNotice } from "@/components/TaskBlockedNotice";

import { TaskRow } from "@/components/TaskRow";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { deriveInitials } from "@/lib/identity";
import { taskStatusAccessibleLabel, taskValueLabel } from "@/lib/task-blockers";
import { DomainStatus } from "@/components/patterns/DomainStatus";

import type { BlockedNoticeFixture } from "./status-language-fixtures";
import { blockedNoticeFixtures, coveredBlockedMatrix, coveredBlockedTask } from "./status-language-fixtures";
import { StorySection as Section } from "./story-layout";

const metricExamples: Array<{
  icon: LucideIcon;
  value: string | number;
  label: string;
  description: string;
}> = [
  { icon: Users, value: 8, label: "Agents", description: "3 live runs" },
  {
    icon: FolderKanban,
    value: 27,
    label: "Open tasks",
    description: "5 in review",
  },
  {
    icon: DollarSign,
    value: "$675",
    label: "MTD spend",
    description: "27% of budget",
  },
  {
    icon: Clock3,
    value: "14m",
    label: "P95 run age",
    description: "last 24 hours",
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
            mobileMeta={<DomainStatus status={coveredBlockedTask.boardPresentationStatus} />}
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
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Status, priority, identity, and metrics
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            These components carry the operational vocabulary of the board: who is acting, what state work is
            in, how urgent it is, and whether capacity or spend needs attention.
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
                  <DomainStatus key={status} status={status} />
                ))}
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Agent statuses</CardTitle>
                <CardDescription>
                  Runtime and governance states shown in org, sidebar, and detail surfaces.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {AGENT_STATUSES.map((status) => (
                  <DomainStatus key={status} status={status} />
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
                  <Badge
                    variant="secondary"
                    aria-label={taskStatusAccessibleLabel(item.status, item.blockerAttention)}
                  >
                    {taskValueLabel(item.status)}
                  </Badge>
                </div>
                <div className="mt-4 rounded-md bg-muted/45 px-2.5 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
                  {item.expectedCopy}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Tooltip and aria-label copy begin with "Blocked · " for every cell after the first. Covered cells
            show a cyan ring with a small dot, stalled-review cells show an amber ring with a centered dot,
            and the needs-attention cells retain the solid red ring.
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
            Stalled-state copy switches to "stalled in review without a clear next step" and adds a "Stalled
            in review" chip strip beneath the regular blocker chips. The trailing imperative pluralizes when
            multiple stalled leaves are surfaced ("reviews"/"them") to match the chip strip.
          </p>
        </Section>

        <Section eyebrow="Priority" title="Static labels and editable popover trigger">
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className="grid gap-3 sm:grid-cols-2">
              {TASK_PRIORITIES.map((item) => (
                <div
                  key={item}
                  className="flex items-center justify-between rounded-lg border border-border bg-background/70 p-4"
                >
                  <Badge variant="secondary">{taskValueLabel(item)}</Badge>
                  <span className="font-mono text-xs text-muted-foreground">{item}</span>
                </div>
              ))}
            </div>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Editable priority</CardTitle>
                <CardDescription>
                  Click the control to inspect the same popover used in task rows.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger aria-label="Priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_PRIORITIES.map((item) => (
                      <SelectItem key={item} value={item}>
                        {taskValueLabel(item)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                <Avatar size="sm">
                  <AvatarFallback>{deriveInitials("CodexCoder")}</AvatarFallback>
                </Avatar>
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Small</CardTitle>
              </CardHeader>
              <CardContent>
                <Avatar>
                  <AvatarFallback>BU</AvatarFallback>
                </Avatar>
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Default</CardTitle>
              </CardHeader>
              <CardContent>
                <Avatar size="lg">
                  <AvatarFallback>{deriveInitials("DesignSystemCoder")}</AvatarFallback>
                </Avatar>
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Long label</CardTitle>
              </CardHeader>
              <CardContent className="max-w-[220px]">
                <Avatar size="lg">
                  <AvatarFallback>{deriveInitials("Senior Product Engineering Reviewer")}</AvatarFallback>
                </Avatar>
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section eyebrow="Dashboard" title="Metrics, quota bars, empty states, and copy affordances">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {metricExamples.map(({ icon: Icon, value, label, description }) => (
                <Card key={label}>
                  <CardHeader>
                    <CardDescription className="flex items-center gap-2">
                      <Icon className="size-4" />
                      {label}
                    </CardDescription>
                    <CardTitle>{value}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">{description}</CardContent>
                </Card>
              ))}
            </div>
          </div>

          <div className="mt-5 grid gap-5">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Empty state</CardTitle>
                <CardDescription>Used when a list has no meaningful rows yet.</CardDescription>
              </CardHeader>
              <CardContent>
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Inbox />
                    </EmptyMedia>
                    <EmptyTitle>No assigned work</EmptyTitle>
                    <EmptyDescription>No assigned work is waiting in this queue.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button onClick={() => undefined}>Create task</Button>
                  </EmptyContent>
                </Empty>
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
