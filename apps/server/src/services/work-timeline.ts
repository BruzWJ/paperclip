import type { Db } from "@paperclipai/db";

import { createWorkTimelineContext, type WorkTimelineContext } from "./work-timeline-contracts.js";
import { buildWorkTimelineRunQueries } from "./work-timeline-run-queries.js";
import { buildWorkTimelineTaskLens } from "./work-timeline-task-lens.js";
import { buildWorkTimelineProjection } from "./work-timeline-projection.js";

export function createWorkTimelineMethods1(
  scope: WorkTimelineContext &
    ReturnType<typeof buildWorkTimelineRunQueries> &
    ReturnType<typeof buildWorkTimelineTaskLens> &
    ReturnType<typeof buildWorkTimelineProjection>,
) {
  const { getTimeline } = scope;

  return {
    getTimeline,
  };
}

export {
  type WorkTimelineQuery,
  type WorkTimelineTaskAccessInput,
  normalizeTimelineWindow,
} from "./work-timeline-contracts.js";

export function workTimelineService(db: Db) {
  const context = createWorkTimelineContext(db);
  const helpers1 = buildWorkTimelineRunQueries(context);
  const scope1 = { ...context, ...helpers1 };
  const helpers2 = buildWorkTimelineTaskLens(scope1);
  const scope2 = { ...scope1, ...helpers2 };
  const helpers3 = buildWorkTimelineProjection(scope2);
  const scope3 = { ...scope2, ...helpers3 };
  const scope = scope3;
  const methods1 = createWorkTimelineMethods1(scope);
  return { ...methods1 };
}
