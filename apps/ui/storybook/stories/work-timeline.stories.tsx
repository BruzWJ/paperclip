import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { Route as TimelineRoute } from "@/routes/_authenticated/$companyId/timeline";
import { getRouteComponent } from "@/test/route-component";
import { WorkTimelineGantt } from "@/routes/_authenticated/$companyId/timeline/-WorkTimelineGantt";
import { Button } from "@/components/ui/button";
import sampleJson from "../fixtures/workTimeline.sample.json";
import humanSampleJson from "../fixtures/workTimeline.human.sample.json";

const STORYBOOK_USER_AVATAR =
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=96&q=80";
const Timeline = getRouteComponent(TimelineRoute);

function withStorybookTimelineDetails(data: WorkTimelineResult): WorkTimelineResult {
  return {
    ...data,
    actors: data.actors.map((actor) =>
      actor.type === "user" ? { ...actor, avatar: STORYBOOK_USER_AVATAR } : actor,
    ),
    spans: data.spans,
  };
}

const sample = withStorybookTimelineDetails(sampleJson as unknown as WorkTimelineResult);
// A second real slice (2026-07-02 14:00–16:00Z) captured straight from the live
// `/timeline` endpoint that DOES carry human events — Dotta's created / commented /
// approved / delegated actions provide human participation and kickoff context.
const humanSample = withStorybookTimelineDetails(humanSampleJson as unknown as WorkTimelineResult);
function FullPageTimelineHarness() {
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <Timeline />
    </div>
  );
}

function TimelineHarness({
  initialZoom = 100,
  data = sample,
}: {
  initialZoom?: number;
  data?: WorkTimelineResult;
}) {
  const [zoom, setZoom] = useState(initialZoom);

  const adjustZoom = (factor: number) => {
    setZoom((current) => Math.max(50, Math.min(200, Math.round(current * factor))));
  };

  const resetZoom = () => {
    setZoom(initialZoom);
  };

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Work Timeline</h1>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-1" aria-label="Timeline zoom controls">
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={() => adjustZoom(0.8)}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <Minus className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={() => adjustZoom(1.25)}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <Plus className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={resetZoom}
            aria-label="Reset zoom"
            title="Reset zoom"
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
        </div>

        <div className="space-y-3">
          <WorkTimelineGantt data={data} zoom={zoom} />
          <p className="text-xs text-muted-foreground">
            {data.spans.length} runs · {data.actors.length} actors · {data.events.length} human/instant events
            · real company data
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

export const CompactZoom: Story = { args: { initialZoom: 75 } };
export const DefaultZoom: Story = { args: { initialZoom: 100 } };
// Live slice that carries human-originated activity and delegation context.
export const WithHumanActivity: Story = {
  args: {
    initialZoom: 125,
    data: humanSample,
  },
};

export const FullPageWithMockData: Story = {
  render: () => <FullPageTimelineHarness />,
};
