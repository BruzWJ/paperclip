import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import {
  PriorityChart,
  RunActivityChart,
  SuccessRateChart,
  TaskStatusChart,
} from "@/routes/_authenticated/$companyId/-activity/-ActivityCharts";
import { createTaskExecutionRun } from "../fixtures/paperclipData";
import { StorySection as Section, StoryShell } from "./story-layout";
import { useEffect, useState } from "react";
import { Archive, Play } from "lucide-react";
import { OnboardingWizard } from "@/routes/-onboarding/-OnboardingWizard";
import { SwipeToArchive } from "@/routes/_authenticated/$companyId/inbox/-SwipeToArchive";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { deriveInitials } from "@/lib/identity";
import { useDialog } from "@/context/DialogContext";

function daysAgo(days: number, hour = 12): Date {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date;
}

function makeRun(overrides: Partial<TaskExecutionRunEnvelopeRecord>): TaskExecutionRunEnvelopeRecord {
  const createdAt = overrides.createdAt ?? daysAgo(1).toISOString();
  return createTaskExecutionRun({
    status: "succeeded",
    currentAttemptId: null,
    currentLeaseId: null,
    terminalClassification: "succeeded",
    terminalFinalizationId: "93000000-0000-4000-8000-000000000001",
    startedAt: createdAt,
    finishedAt: new Date(new Date(createdAt).getTime() + 11 * 60_000).toISOString(),
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
}

const activityRuns: TaskExecutionRunEnvelopeRecord[] = [
  makeRun({
    id: "90000000-0000-4000-8000-000000000007",
    createdAt: daysAgo(13).toISOString(),
    startedAt: daysAgo(13).toISOString(),
  }),
  makeRun({
    id: "90000000-0000-4000-8000-000000000008",
    createdAt: daysAgo(10).toISOString(),
    startedAt: daysAgo(10).toISOString(),
  }),
  makeRun({
    id: "90000000-0000-4000-8000-000000000009",
    status: "failed",
    terminalClassification: "failed",
    terminalReasonCode: "process_exit",
    createdAt: daysAgo(10).toISOString(),
    startedAt: daysAgo(10, 15).toISOString(),
  }),
  makeRun({
    id: "90000000-0000-4000-8000-00000000000a",
    status: "running",
    terminalClassification: null,
    terminalFinalizationId: null,
    currentAttemptId: "91000000-0000-4000-8000-000000000001",
    currentLeaseId: "92000000-0000-4000-8000-000000000001",
    createdAt: daysAgo(7).toISOString(),
    startedAt: daysAgo(7).toISOString(),
    finishedAt: null,
  }),
  makeRun({
    id: "90000000-0000-4000-8000-00000000000b",
    createdAt: daysAgo(5).toISOString(),
    startedAt: daysAgo(5).toISOString(),
  }),
  makeRun({
    id: "90000000-0000-4000-8000-00000000000c",
    status: "timed_out",
    terminalClassification: "timed_out",
    terminalReasonCode: "timeout",
    createdAt: daysAgo(3).toISOString(),
    startedAt: daysAgo(3).toISOString(),
  }),
  makeRun({
    id: "90000000-0000-4000-8000-00000000000d",
    createdAt: daysAgo(1).toISOString(),
    startedAt: daysAgo(1).toISOString(),
  }),
  makeRun({
    id: "90000000-0000-4000-8000-00000000000e",
    createdAt: daysAgo(1, 16).toISOString(),
    startedAt: daysAgo(1, 16).toISOString(),
  }),
];

const activityTasks = [
  {
    priority: "high",
    boardPresentationStatus: "in_progress",
    createdAt: daysAgo(13),
  },
  {
    priority: "critical",
    boardPresentationStatus: "blocked",
    createdAt: daysAgo(11),
  },
  {
    priority: "medium",
    boardPresentationStatus: "todo",
    createdAt: daysAgo(9),
  },
  {
    priority: "medium",
    boardPresentationStatus: "in_review",
    createdAt: daysAgo(9, 16),
  },
  { priority: "low", boardPresentationStatus: "done", createdAt: daysAgo(6) },
  { priority: "high", boardPresentationStatus: "todo", createdAt: daysAgo(4) },
  {
    priority: "critical",
    boardPresentationStatus: "in_progress",
    createdAt: daysAgo(2),
  },
  {
    priority: "medium",
    boardPresentationStatus: "done",
    createdAt: daysAgo(1),
  },
];

function ActivityChartsMatrix({ empty = false }: { empty?: boolean }) {
  const runs = empty ? [] : activityRuns;
  const tasks = empty ? [] : activityTasks;

  return (
    <StoryShell>
      <Section
        eyebrow="ActivityCharts"
        title={empty ? "Empty activity timelines" : "Two-week activity timelines"}
      >
        <div className="grid gap-4 md:grid-cols-2">
          {[
            ["Run activity", "Succeeded, failed, and in-flight executions", <RunActivityChart runs={runs} />],
            ["Success rate", "Daily completion ratio", <SuccessRateChart runs={runs} />],
            ["Task priority", "Created tasks by urgency", <PriorityChart tasks={tasks} />],
            ["Task status", "Created tasks by workflow state", <TaskStatusChart tasks={tasks} />],
          ].map(([title, description, chart]) => (
            <Card key={title as string}>
              <CardHeader>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
              <CardContent>{chart}</CardContent>
            </Card>
          ))}
        </div>
      </Section>
    </StoryShell>
  );
}

const meta = {
  title: "Product/Data Visualization & Misc",
  parameters: {
    docs: {
      description: {
        component:
          "Fixture-backed stories for charting, board, filtering, live run, onboarding, package preview, entity row, mobile gesture, generated icons, and skeleton states.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const ActivityChartsPopulated: Story = {
  name: "ActivityCharts / Populated",
  render: () => <ActivityChartsMatrix />,
};

export const ActivityChartsEmpty: Story = {
  name: "ActivityCharts / Empty",
  render: () => <ActivityChartsMatrix empty />,
};

function OpenOnboardingOnMount() {
  const { openOnboarding } = useDialog();

  useEffect(() => {
    openOnboarding();
  }, [openOnboarding]);

  return <OnboardingWizard />;
}

function SwipeToArchiveDemo({ disabled = false }: { disabled?: boolean }) {
  const [archived, setArchived] = useState(false);

  return (
    <StoryShell>
      <Section
        eyebrow="SwipeToArchive"
        title={disabled ? "Disabled mobile gesture" : "Mobile archive gesture"}
      >
        <div className="mx-auto w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
          <div className="border-b border-border px-4 py-3 text-xs uppercase tracking-wide text-muted-foreground">
            Inbox
          </div>
          {archived ? (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
              <Archive className="h-4 w-4" />
              Archived
            </div>
          ) : (
            <SwipeToArchive selected disabled={disabled} onArchive={() => setArchived(true)}>
              <Item>
                <ItemMedia variant="icon">
                  <Play />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    <span className="font-mono text-xs text-muted-foreground">PAP-1677</span>
                    Storybook: Data Visualization & Misc stories
                  </ItemTitle>
                  <ItemDescription>
                    {disabled
                      ? "Gesture disabled while review is locked"
                      : "Swipe left on touch devices to archive"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge variant="outline">mobile</Badge>
                </ItemActions>
              </Item>
            </SwipeToArchive>
          )}
          <Button variant="ghost" size="sm" className="m-3" onClick={() => setArchived(false)}>
            Reset
          </Button>
        </div>
      </Section>
    </StoryShell>
  );
}

function CompanyPatternIconMatrix() {
  const companies = ["Paperclip Storybook", "Research Bureau", "Launch Ops", "Atlas Finance"];
  const sizes = ["h-8 w-8 text-xs", "h-11 w-11 text-base", "h-16 w-16 text-xl", "h-24 w-24 text-3xl"];

  return (
    <StoryShell>
      <Section eyebrow="CompanyPatternIcon" title="Generated company pattern icons by size">
        <div className="grid gap-4 md:grid-cols-2">
          {companies.map((company) => (
            <Card key={company} className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">{company}</CardTitle>
                <CardDescription>Generic avatar fallback</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-end gap-4">
                {sizes.map((size) => (
                  <Avatar key={size} className={size}>
                    <AvatarFallback>{deriveInitials(company)}</AvatarFallback>
                  </Avatar>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>
    </StoryShell>
  );
}

function PageSkeletonMatrix() {
  const variants = [
    "list",
    "tasks-list",
    "detail",
    "dashboard",
    "approvals",
    "costs",
    "inbox",
    "org-chart",
  ] as const;

  return (
    <StoryShell>
      <Section eyebrow="PageSkeleton" title="Loading skeletons for page layouts">
        <div className="grid gap-5 xl:grid-cols-2">
          {variants.map((variant) => (
            <Card key={variant} className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">{variant}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-[420px] overflow-hidden">
                  <Skeleton className="h-32 w-full" aria-label={variant} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>
    </StoryShell>
  );
}

export const OnboardingWizardCompanyStep: Story = {
  name: "OnboardingWizard / Company Step",
  render: () => <OpenOnboardingOnMount />,
};

export const SwipeToArchiveMobile: Story = {
  name: "SwipeToArchive / Mobile",
  render: () => <SwipeToArchiveDemo />,
};

export const SwipeToArchiveDisabled: Story = {
  name: "SwipeToArchive / Disabled",
  render: () => <SwipeToArchiveDemo disabled />,
};

export const CompanyPatternIconSizes: Story = {
  name: "CompanyPatternIcon / Sizes",
  render: () => <CompanyPatternIconMatrix />,
};

export const PageSkeletonLayouts: Story = {
  name: "PageSkeleton / Layouts",
  render: () => <PageSkeletonMatrix />,
};
