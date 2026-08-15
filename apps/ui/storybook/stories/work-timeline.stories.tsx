import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { Route as TimelineRoute } from "@/routes/_authenticated/$companyId/timeline";
import { getRouteComponent } from "@/test/route-component";
import { WorkTimelineGantt } from "@/routes/_authenticated/$companyId/timeline/-WorkTimelineGantt";
import sampleJson from "../fixtures/workTimeline.sample.json";
import humanSampleJson from "../fixtures/workTimeline.human.sample.json";

const STORYBOOK_USER_AVATAR =
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=96&q=80";
const Timeline = getRouteComponent(TimelineRoute);

function withStorybookUserAvatar(data: WorkTimelineResult): WorkTimelineResult {
  return {
    ...data,
    actors: data.actors.map((actor) =>
      actor.type === "user" ? { ...actor, avatar: STORYBOOK_USER_AVATAR } : actor,
    ),
  };
}

const sample = withStorybookUserAvatar(sampleJson as unknown as WorkTimelineResult);
const humanSample = withStorybookUserAvatar(humanSampleJson as unknown as WorkTimelineResult);

function TimelineHarness({
  initialZoom,
  data = sample,
}: {
  initialZoom?: number;
  data?: WorkTimelineResult;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="overflow-hidden rounded-xl border bg-card">
        <WorkTimelineGantt
          data={data}
          initialZoom={initialZoom}
          selectedRunId={selectedRunId}
          onSelectRun={setSelectedRunId}
        />
        <div className="border-t px-3 py-2">
          <p className="text-xs text-muted-foreground">
            {data.spans.length} runs · {data.actors.length} actors · {data.events.length} activity events ·{" "}
            {data.edges.length} relationships
          </p>
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof TimelineHarness> = {
  title: "Pages/Work Timeline",
  component: TimelineHarness,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof TimelineHarness>;

export const CompactZoom: Story = { args: { initialZoom: 600 } };
export const DefaultZoom: Story = { args: {} };
export const WithHumanActivity: Story = {
  args: {
    data: humanSample,
  },
};

export const FullPageWithMockData: Story = {
  render: () => (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <Timeline />
    </div>
  ),
};
