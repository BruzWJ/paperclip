"use client";

import { DndContext, MouseSensor, useDraggable, useSensor } from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { useMouse, useThrottle, useWindowScroll } from "@uidotdev/usehooks";
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  differenceInDays,
  differenceInHours,
  differenceInMonths,
  format,
  formatDate,
  getDate,
  getDaysInMonth,
  isSameDay,
  startOfDay,
  startOfMonth,
} from "date-fns";
import { atom, useAtom } from "jotai";
import throttle from "lodash.throttle";
import { PlusIcon, TrashIcon } from "lucide-react";
import type { CSSProperties, FC, KeyboardEventHandler, MouseEventHandler, ReactNode, RefObject } from "react";
import {
  createContext,
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Card } from "@/components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn, formatDurationMs } from "@/lib/utils";

const draggingAtom = atom(false);
const scrollXAtom = atom(0);

export const useGanttDragging = () => useAtom(draggingAtom);
export const useGanttScrollX = () => useAtom(scrollXAtom);

export type GanttStatus = {
  id: string;
  name: string;
  color: string;
};

export type GanttFeature = {
  id: string;
  name: string;
  startAt: Date;
  endAt: Date;
  status: GanttStatus;
};

export type GanttMarkerProps = {
  id: string;
  date: Date;
  label: string;
};

export type Range = "daily" | "monthly" | "quarterly";

export type TimelineData = {
  year: number;
  quarters: {
    months: {
      days: number;
    }[];
  }[];
}[];

export type GanttContextProps = {
  zoom: number;
  range: Range;
  columnWidth: number;
  sidebarWidth: number;
  rowHeight: number;
  onAddItem: ((date: Date) => void) | undefined;
  showDailyHourTicks: boolean;
  timelineData: TimelineData;
  ref: RefObject<HTMLDivElement | null> | null;
  scrollToFeature?: (feature: GanttFeature) => void;
};

const DAILY_HOUR_TICK_HOURS = [6, 12, 18] as const;
const DAILY_HOUR_TICK_MIN_COLUMN_WIDTH = 192;
const GANTT_ROW_HEIGHT = 36;
const GANTT_COARSE_POINTER_ROW_HEIGHT = 44;
const GANTT_COARSE_POINTER_QUERY = "(pointer: coarse)";

const getsDaysIn = (range: Range) => {
  let fn = (_date: Date) => 1;

  if (range === "monthly" || range === "quarterly") {
    fn = getDaysInMonth;
  }

  return fn;
};

const getDifferenceIn = (range: Range) => {
  let fn = differenceInDays;

  if (range === "monthly" || range === "quarterly") {
    fn = differenceInMonths;
  }

  return fn;
};

const getInnerDifferenceIn = (range: Range) => {
  let fn = differenceInHours;

  if (range === "monthly" || range === "quarterly") {
    fn = differenceInDays;
  }

  return fn;
};

const getStartOf = (range: Range) => {
  let fn = startOfDay;

  if (range === "monthly" || range === "quarterly") {
    fn = startOfMonth;
  }

  return fn;
};

const getAddRange = (range: Range) => {
  let fn = addDays;

  if (range === "monthly" || range === "quarterly") {
    fn = addMonths;
  }

  return fn;
};

const getDailyColumnProgress = (date: Date) => {
  const dayStart = startOfDay(date);
  const nextDayStart = addDays(dayStart, 1);
  const dayDuration = nextDayStart.getTime() - dayStart.getTime();

  if (dayDuration <= 0) {
    return 0;
  }

  return (date.getTime() - dayStart.getTime()) / dayDuration;
};

const getDailyColumnPosition = (date: Date, timelineStartDate: Date) =>
  differenceInCalendarDays(startOfDay(date), startOfDay(timelineStartDate)) + getDailyColumnProgress(date);

const getDailyHourTicks = (date: Date) => {
  const dayStart = startOfDay(date);
  const nextDayStart = addDays(dayStart, 1);

  return DAILY_HOUR_TICK_HOURS.flatMap((hour) => {
    const tick = new Date(dayStart);
    tick.setHours(hour, 0, 0, 0);

    if (tick <= dayStart || tick >= nextDayStart) {
      return [];
    }

    return [{ date: tick, offset: getDailyColumnProgress(tick) * 100 }];
  });
};

const getDailyHourTickPath = (startDate: Date, columns: number) =>
  Array.from({ length: columns })
    .flatMap((_, dayIndex) =>
      getDailyHourTicks(addDays(startDate, dayIndex)).map(
        ({ offset }) => `M${(dayIndex + offset / 100).toFixed(6)} 0V1`,
      ),
    )
    .join(" ");

const readGanttRowHeight = () => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return GANTT_ROW_HEIGHT;
  }

  try {
    return window.matchMedia(GANTT_COARSE_POINTER_QUERY).matches
      ? GANTT_COARSE_POINTER_ROW_HEIGHT
      : GANTT_ROW_HEIGHT;
  } catch {
    return GANTT_ROW_HEIGHT;
  }
};

const getDateByMousePosition = (context: GanttContextProps, mouseX: number) => {
  const timelineStartDate = new Date(context.timelineData[0].year, 0, 1);
  const columnWidth = (context.columnWidth * context.zoom) / 100;

  if (context.range === "daily") {
    const columnPosition = mouseX / columnWidth;
    const dayOffset = Math.floor(columnPosition);
    const progress = columnPosition - dayOffset;
    const dayStart = addDays(timelineStartDate, dayOffset);
    const nextDayStart = addDays(dayStart, 1);

    return new Date(dayStart.getTime() + progress * (nextDayStart.getTime() - dayStart.getTime()));
  }

  const offset = Math.floor(mouseX / columnWidth);
  const daysIn = getsDaysIn(context.range);
  const addRange = getAddRange(context.range);
  const month = addRange(timelineStartDate, offset);
  const daysInMonth = daysIn(month);
  const pixelsPerDay = Math.round(columnWidth / daysInMonth);
  const dayOffset = Math.floor((mouseX % columnWidth) / pixelsPerDay);
  const actualDate = addDays(month, dayOffset);

  return actualDate;
};

const createTimelineYear = (year: number): TimelineData[number] => ({
  year,
  quarters: new Array(4).fill(null).map((_, quarterIndex) => ({
    months: new Array(3).fill(null).map((_, monthIndex) => {
      const month = quarterIndex * 3 + monthIndex;
      return {
        days: getDaysInMonth(new Date(year, month, 1)),
      };
    }),
  })),
});

const createInitialTimelineData = (today: Date): TimelineData => [
  createTimelineYear(today.getFullYear() - 1),
  createTimelineYear(today.getFullYear()),
  createTimelineYear(today.getFullYear() + 1),
];

const getTimelineColumnCount = (timelineData: TimelineData, range: Range) =>
  timelineData.reduce(
    (total, year) =>
      total +
      year.quarters.reduce(
        (yearTotal, quarter) =>
          yearTotal +
          quarter.months.reduce(
            (quarterTotal, month) => quarterTotal + (range === "daily" ? month.days : 1),
            0,
          ),
        0,
      ),
    0,
  );

type GanttScale = Pick<GanttContextProps, "zoom" | "range" | "columnWidth">;

const getOffset = (date: Date, timelineStartDate: Date, context: GanttScale) => {
  const parsedColumnWidth = (context.columnWidth * context.zoom) / 100;

  if (context.range === "daily") {
    return parsedColumnWidth * getDailyColumnPosition(date, timelineStartDate);
  }

  const differenceIn = getDifferenceIn(context.range);
  const startOf = getStartOf(context.range);
  const fullColumns = differenceIn(startOf(date), timelineStartDate);

  const partialColumns = date.getDate();
  const daysInMonth = getDaysInMonth(date);
  const pixelsPerDay = parsedColumnWidth / daysInMonth;

  return fullColumns * parsedColumnWidth + partialColumns * pixelsPerDay;
};

const getWidth = (startAt: Date, endAt: Date, context: GanttScale) => {
  const parsedColumnWidth = (context.columnWidth * context.zoom) / 100;
  const differenceIn = getDifferenceIn(context.range);

  if (context.range === "daily") {
    const startPosition = getDailyColumnPosition(startAt, startAt);
    const endPosition = getDailyColumnPosition(endAt, startAt);

    return Math.max(1, parsedColumnWidth * (endPosition - startPosition));
  }

  const daysInStartMonth = getDaysInMonth(startAt);
  const pixelsPerDayInStartMonth = parsedColumnWidth / daysInStartMonth;

  if (isSameDay(startAt, endAt)) {
    return pixelsPerDayInStartMonth;
  }

  const innerDifferenceIn = getInnerDifferenceIn(context.range);
  const startOf = getStartOf(context.range);

  if (isSameDay(startOf(startAt), startOf(endAt))) {
    return innerDifferenceIn(endAt, startAt) * pixelsPerDayInStartMonth;
  }

  const startRangeOffset = daysInStartMonth - getDate(startAt);
  const endRangeOffset = getDate(endAt);
  const fullRangeOffset = differenceIn(startOf(endAt), startOf(startAt));
  const daysInEndMonth = getDaysInMonth(endAt);
  const pixelsPerDayInEndMonth = parsedColumnWidth / daysInEndMonth;

  return (
    (fullRangeOffset - 1) * parsedColumnWidth +
    startRangeOffset * pixelsPerDayInStartMonth +
    endRangeOffset * pixelsPerDayInEndMonth
  );
};

const GanttContext = createContext<GanttContextProps>({
  zoom: 100,
  range: "monthly",
  columnWidth: 50,
  sidebarWidth: 300,
  rowHeight: 36,
  onAddItem: undefined,
  showDailyHourTicks: false,
  timelineData: [],
  ref: null,
  scrollToFeature: undefined,
});

export type GanttContentHeaderProps = {
  renderHeaderItem: (index: number) => ReactNode;
  title: string;
  columns: number;
};

export const GanttContentHeader: FC<GanttContentHeaderProps> = ({ title, columns, renderHeaderItem }) => {
  const id = useId();

  return (
    <div
      className="sticky top-0 z-20 grid w-full shrink-0 bg-background/90 backdrop-blur-sm"
      style={{ height: "var(--gantt-header-height)" }}
    >
      <div>
        <div
          className="sticky inline-flex whitespace-nowrap px-3 py-2 text-muted-foreground text-xs"
          style={{
            left: "var(--gantt-sidebar-width)",
          }}
        >
          <p>{title}</p>
        </div>
      </div>
      <div
        className="grid w-full"
        style={{
          gridTemplateColumns: `repeat(${columns}, var(--gantt-column-width))`,
        }}
      >
        {Array.from({ length: columns }).map((_, index) => (
          <div className="shrink-0 border-border/50 border-b py-1 text-center text-xs" key={`${id}-${index}`}>
            {renderHeaderItem(index)}
          </div>
        ))}
      </div>
    </div>
  );
};

type GanttDailyHourLabelsProps = {
  date: Date;
};

const GanttDailyHourLabels: FC<GanttDailyHourLabelsProps> = ({ date }) => {
  const ticks = getDailyHourTicks(date);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-3"
      data-roadmap-ui="gantt-hour-ticks"
    >
      {ticks.map((tick) => (
        <span
          className="-translate-x-1/2 absolute bottom-0 whitespace-nowrap text-[10px] text-muted-foreground tabular-nums"
          data-roadmap-ui="gantt-hour-tick"
          key={tick.date.getTime()}
          style={{ left: `${tick.offset}%` }}
        >
          {format(tick.date, "HH:mm")}
        </span>
      ))}
    </div>
  );
};

const DailyHeader: FC = () => {
  const gantt = useContext(GanttContext);

  return gantt.timelineData.map((year) =>
    year.quarters
      .flatMap((quarter) => quarter.months)
      .map((month, index) => (
        <div className="relative flex flex-col" key={`${year.year}-${index}`}>
          <GanttContentHeader
            columns={month.days}
            renderHeaderItem={(item: number) => {
              const date = addDays(new Date(year.year, index, 1), item);

              return (
                <div
                  className={cn(
                    "flex items-center justify-center gap-1",
                    gantt.showDailyHourTicks && "relative h-full items-start",
                  )}
                >
                  {gantt.showDailyHourTicks ? (
                    <p className="text-muted-foreground">{format(date, "EEE d")}</p>
                  ) : (
                    <>
                      <p>{format(date, "d")}</p>
                      <p className="text-muted-foreground">{format(date, "EEEEE")}</p>
                    </>
                  )}
                  {gantt.showDailyHourTicks ? <GanttDailyHourLabels date={date} /> : null}
                </div>
              );
            }}
            title={format(new Date(year.year, index, 1), "MMMM yyyy")}
          />
          <GanttColumns
            columns={month.days}
            isColumnSecondary={(item: number) =>
              [0, 6].includes(addDays(new Date(year.year, index, 1), item).getDay())
            }
            startDate={new Date(year.year, index, 1)}
          />
        </div>
      )),
  );
};

const MonthlyHeader: FC = () => {
  const gantt = useContext(GanttContext);

  return gantt.timelineData.map((year) => (
    <div className="relative flex flex-col" key={year.year}>
      <GanttContentHeader
        columns={year.quarters.flatMap((quarter) => quarter.months).length}
        renderHeaderItem={(item: number) => <p>{format(new Date(year.year, item, 1), "MMM")}</p>}
        title={`${year.year}`}
      />
      <GanttColumns columns={year.quarters.flatMap((quarter) => quarter.months).length} />
    </div>
  ));
};

const QuarterlyHeader: FC = () => {
  const gantt = useContext(GanttContext);

  return gantt.timelineData.map((year) =>
    year.quarters.map((quarter, quarterIndex) => (
      <div className="relative flex flex-col" key={`${year.year}-${quarterIndex}`}>
        <GanttContentHeader
          columns={quarter.months.length}
          renderHeaderItem={(item: number) => (
            <p>{format(new Date(year.year, quarterIndex * 3 + item, 1), "MMM")}</p>
          )}
          title={`Q${quarterIndex + 1} ${year.year}`}
        />
        <GanttColumns columns={quarter.months.length} />
      </div>
    )),
  );
};

const headers: Record<Range, FC> = {
  daily: DailyHeader,
  monthly: MonthlyHeader,
  quarterly: QuarterlyHeader,
};

export type GanttHeaderProps = {
  className?: string;
};

export const GanttHeader: FC<GanttHeaderProps> = ({ className }) => {
  const gantt = useContext(GanttContext);
  const Header = headers[gantt.range];

  return (
    <div className={cn("-space-x-px flex h-full w-max divide-x divide-border/50", className)}>
      <Header />
    </div>
  );
};

export type GanttSidebarItemProps = {
  feature: GanttFeature;
  onSelectItem?: (id: string) => void;
  className?: string;
};

export const GanttSidebarItem: FC<GanttSidebarItemProps> = ({ feature, onSelectItem, className }) => {
  const gantt = useContext(GanttContext);
  const duration = formatDurationMs(Math.max(0, feature.endAt.getTime() - feature.startAt.getTime()));

  const handleClick: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.target === event.currentTarget) {
      gantt.scrollToFeature?.(feature);
      onSelectItem?.(feature.id);
    }
  };

  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    gantt.scrollToFeature?.(feature);
    onSelectItem?.(feature.id);
  };

  return (
    <div
      className={cn("relative flex items-center gap-2.5 p-2.5 text-xs hover:bg-secondary", className)}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      // biome-ignore lint/a11y/useSemanticElements: "This is a clickable item"
      role="button"
      style={{
        height: "var(--gantt-row-height)",
        minHeight: "var(--gantt-row-height)",
      }}
      tabIndex={0}
    >
      <div
        className="pointer-events-none h-2 w-2 shrink-0 rounded-full"
        style={{
          backgroundColor: feature.status.color,
        }}
      />
      <p className="pointer-events-none flex-1 truncate text-left font-medium">{feature.name}</p>
      <p className="pointer-events-none text-muted-foreground">{duration}</p>
    </div>
  );
};

export type GanttSidebarHeaderProps = {
  itemLabel?: ReactNode;
  durationLabel?: ReactNode;
};

export const GanttSidebarHeader: FC<GanttSidebarHeaderProps> = ({
  itemLabel = "Issues",
  durationLabel = "Duration",
}) => (
  <div
    className="sticky top-0 z-10 flex shrink-0 items-end justify-between gap-2.5 border-border/50 border-b bg-background/90 p-2.5 font-medium text-muted-foreground text-xs backdrop-blur-sm"
    style={{ height: "var(--gantt-header-height)" }}
  >
    <p className="flex-1 truncate text-left">{itemLabel}</p>
    <p className="shrink-0">{durationLabel}</p>
  </div>
);

export type GanttSidebarGroupProps = {
  children: ReactNode;
  name: string;
  className?: string;
};

export const GanttSidebarGroup: FC<GanttSidebarGroupProps> = ({ children, name, className }) => (
  <div className={className}>
    <p
      className="w-full truncate p-2.5 text-left font-medium text-muted-foreground text-xs"
      style={{ height: "var(--gantt-row-height)" }}
    >
      {name}
    </p>
    <div className="divide-y divide-border/50">{children}</div>
  </div>
);

export type GanttSidebarProps = {
  children: ReactNode;
  className?: string;
  itemLabel?: ReactNode;
  durationLabel?: ReactNode;
};

export const GanttSidebar: FC<GanttSidebarProps> = ({ children, className, itemLabel, durationLabel }) => (
  <div
    className={cn(
      "sticky left-0 z-30 h-max min-h-full overflow-clip border-border/50 border-r bg-background/90 backdrop-blur-md",
      className,
    )}
    data-roadmap-ui="gantt-sidebar"
  >
    <GanttSidebarHeader durationLabel={durationLabel} itemLabel={itemLabel} />
    <div className="space-y-4">{children}</div>
  </div>
);

export type GanttAddFeatureHelperProps = {
  top: number;
  className?: string;
};

export const GanttAddFeatureHelper: FC<GanttAddFeatureHelperProps> = ({ top, className }) => {
  const [scrollX] = useGanttScrollX();
  const gantt = useContext(GanttContext);
  const [mousePosition, mouseRef] = useMouse<HTMLDivElement>();

  const handleClick = () => {
    const ganttRect = gantt.ref?.current?.getBoundingClientRect();
    const x = mousePosition.x - (ganttRect?.left ?? 0) + scrollX - gantt.sidebarWidth;
    const currentDate = getDateByMousePosition(gantt, x);

    gantt.onAddItem?.(currentDate);
  };

  return (
    <div
      className={cn("absolute top-0 w-full px-0.5", className)}
      ref={mouseRef}
      style={{
        marginTop: -gantt.rowHeight / 2,
        transform: `translateY(${top}px)`,
      }}
    >
      <button
        aria-label="Add item"
        className="flex h-full w-full items-center justify-center rounded-md border border-dashed p-2"
        onClick={handleClick}
        type="button"
      >
        <PlusIcon
          className="pointer-events-none select-none text-muted-foreground"
          size={16}
          data-icon="inline-start"
        />
      </button>
    </div>
  );
};

export type GanttColumnProps = {
  index: number;
  isColumnSecondary?: (item: number) => boolean;
};

export const GanttColumn: FC<GanttColumnProps> = ({ index, isColumnSecondary }) => {
  const gantt = useContext(GanttContext);
  const [dragging] = useGanttDragging();
  const [mousePosition, mouseRef] = useMouse<HTMLDivElement>();
  const [hovering, setHovering] = useState(false);
  const [windowScroll] = useWindowScroll();

  const handleMouseEnter = () => setHovering(true);
  const handleMouseLeave = () => setHovering(false);

  const top = useThrottle(
    mousePosition.y - (mouseRef.current?.getBoundingClientRect().y ?? 0) - (windowScroll.y ?? 0),
    10,
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: "This is a clickable column"
    // biome-ignore lint/nursery/noNoninteractiveElementInteractions: "This is a clickable column"
    <div
      className={cn(
        "group relative h-full overflow-hidden",
        isColumnSecondary?.(index) ? "bg-secondary" : "",
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      ref={mouseRef}
    >
      {!dragging && hovering && gantt.onAddItem ? <GanttAddFeatureHelper top={top} /> : null}
    </div>
  );
};

export type GanttColumnsProps = {
  columns: number;
  isColumnSecondary?: (item: number) => boolean;
  startDate?: Date;
};

type GanttDailyHourTickOverlayProps = {
  columns: number;
  startDate: Date;
};

const GanttDailyHourTickOverlay: FC<GanttDailyHourTickOverlayProps> = ({ columns, startDate }) => {
  const startTime = startDate.getTime();
  const path = useMemo(() => getDailyHourTickPath(startDate, columns), [columns, startTime]);

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      data-roadmap-ui="gantt-hour-ticks"
      preserveAspectRatio="none"
      viewBox={`0 0 ${columns} 1`}
    >
      <path
        d={path}
        fill="none"
        stroke="var(--border)"
        strokeOpacity="0.5"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

export const GanttColumns: FC<GanttColumnsProps> = ({ columns, isColumnSecondary, startDate }) => {
  const id = useId();
  const gantt = useContext(GanttContext);
  const showDailyHourTicks = gantt.showDailyHourTicks && gantt.range === "daily" && startDate;

  return (
    <div
      className="divide relative grid h-full w-full divide-x divide-border/50"
      style={{
        gridTemplateColumns: `repeat(${columns}, var(--gantt-column-width))`,
      }}
    >
      {Array.from({ length: columns }).map((_, index) =>
        gantt.onAddItem ? (
          <GanttColumn index={index} isColumnSecondary={isColumnSecondary} key={`${id}-${index}`} />
        ) : (
          <div
            className={cn("relative h-full overflow-hidden", isColumnSecondary?.(index) && "bg-secondary")}
            key={`${id}-${index}`}
          />
        ),
      )}
      {showDailyHourTicks ? <GanttDailyHourTickOverlay columns={columns} startDate={startDate} /> : null}
    </div>
  );
};

export type GanttCreateMarkerTriggerProps = {
  onCreateMarker: (date: Date) => void;
  className?: string;
};

export const GanttCreateMarkerTrigger: FC<GanttCreateMarkerTriggerProps> = ({
  onCreateMarker,
  className,
}) => {
  const gantt = useContext(GanttContext);
  const [mousePosition, mouseRef] = useMouse<HTMLDivElement>();
  const [windowScroll] = useWindowScroll();
  const x = useThrottle(
    mousePosition.x - (mouseRef.current?.getBoundingClientRect().x ?? 0) - (windowScroll.x ?? 0),
    10,
  );

  const date = getDateByMousePosition(gantt, x);

  const handleClick = () => onCreateMarker(date);

  return (
    <div
      className={cn(
        "group pointer-events-none absolute top-0 left-0 h-full w-full select-none overflow-visible",
        className,
      )}
      ref={mouseRef}
    >
      <div
        className="-ml-2 pointer-events-auto sticky top-6 z-20 flex w-4 flex-col items-center justify-center gap-1 overflow-visible opacity-0 group-hover:opacity-100"
        style={{ transform: `translateX(${x}px)` }}
      >
        <button
          aria-label="Add marker"
          className="z-50 inline-flex h-4 w-4 items-center justify-center rounded-full bg-card"
          onClick={handleClick}
          type="button"
        >
          <PlusIcon className="text-muted-foreground" size={12} data-icon="inline-start" />
        </button>
        <div className="whitespace-nowrap rounded-full border border-border/50 bg-background/90 px-2 py-1 text-foreground text-xs backdrop-blur-lg">
          {formatDate(date, "MMM dd, yyyy")}
        </div>
      </div>
    </div>
  );
};

export type GanttFeatureDragHelperProps = {
  featureId: GanttFeature["id"];
  direction: "left" | "right";
  date: Date;
};

export const GanttFeatureDragHelper: FC<GanttFeatureDragHelperProps> = ({ direction, featureId, date }) => {
  const [, setDragging] = useGanttDragging();
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `feature-drag-helper-${featureId}`,
  });

  const isPressed = Boolean(attributes["aria-pressed"]);

  useEffect(() => setDragging(isPressed), [isPressed, setDragging]);

  return (
    <div
      className={cn(
        "group -translate-y-1/2 !cursor-col-resize absolute top-1/2 z-[3] h-full w-6 rounded-md outline-none",
        direction === "left" ? "-left-2.5" : "-right-2.5",
      )}
      ref={setNodeRef}
      {...attributes}
      {...listeners}
    >
      <div
        className={cn(
          "-translate-y-1/2 absolute top-1/2 h-[80%] w-1 rounded-sm bg-muted-foreground opacity-0 transition-all",
          direction === "left" ? "left-2.5" : "right-2.5",
          direction === "left" ? "group-hover:left-0" : "group-hover:right-0",
          isPressed && (direction === "left" ? "left-0" : "right-0"),
          "group-hover:opacity-100",
          isPressed && "opacity-100",
        )}
      />
      {date && (
        <div
          className={cn(
            "-translate-x-1/2 absolute top-10 hidden whitespace-nowrap rounded-lg border border-border/50 bg-background/90 px-2 py-1 text-foreground text-xs backdrop-blur-lg group-hover:block",
            isPressed && "block",
          )}
        >
          {format(date, "MMM dd, yyyy")}
        </div>
      )}
    </div>
  );
};

export type GanttFeatureItemCardProps = Pick<GanttFeature, "id"> & {
  children?: ReactNode;
  draggable?: boolean;
};

export const GanttFeatureItemCard: FC<GanttFeatureItemCardProps> = ({ id, children, draggable = true }) => {
  const [, setDragging] = useGanttDragging();
  const { attributes, listeners, setNodeRef } = useDraggable({
    id,
    disabled: !draggable,
  });
  const isPressed = draggable && Boolean(attributes["aria-pressed"]);

  useEffect(() => {
    if (draggable) {
      setDragging(isPressed);
    }
  }, [draggable, isPressed, setDragging]);

  return (
    <Card className="h-full w-full rounded-md bg-background p-2 text-xs shadow-sm">
      <div
        className={cn(
          "flex h-full w-full items-center justify-between gap-2 text-left",
          isPressed && "cursor-grabbing",
        )}
        {...(draggable ? attributes : {})}
        {...(draggable ? listeners : {})}
        ref={draggable ? setNodeRef : undefined}
      >
        {children}
      </div>
    </Card>
  );
};

export type GanttFeatureItemProps = GanttFeature & {
  onMove?: (id: string, startDate: Date, endDate: Date) => void;
  children?: ReactNode;
  className?: string;
  draggable?: boolean;
};

export const GanttFeatureItem: FC<GanttFeatureItemProps> = ({
  onMove,
  children,
  className,
  draggable = true,
  ...feature
}) => {
  const [scrollX] = useGanttScrollX();
  const [dragging] = useGanttDragging();
  const gantt = useContext(GanttContext);
  const timelineStartDate = useMemo(
    () => new Date(gantt.timelineData.at(0)?.year ?? 0, 0, 1),
    [gantt.timelineData],
  );
  const [startAt, setStartAt] = useState<Date>(feature.startAt);
  const [endAt, setEndAt] = useState<Date>(feature.endAt);
  const featureStartTime = feature.startAt.getTime();
  const featureEndTime = feature.endAt.getTime();
  const incomingDatesRef = useRef({ start: featureStartTime, end: featureEndTime });
  const pendingDateSyncRef = useRef(false);

  useEffect(() => {
    const incomingDatesChanged =
      incomingDatesRef.current.start !== featureStartTime || incomingDatesRef.current.end !== featureEndTime;

    if (incomingDatesChanged) {
      incomingDatesRef.current = { start: featureStartTime, end: featureEndTime };
      pendingDateSyncRef.current = true;
    }

    // A background refresh may land during an active drag. Apply it as soon as
    // the gesture ends without undoing an optimistic drag when props are unchanged.
    if (dragging || !pendingDateSyncRef.current) {
      return;
    }

    setStartAt(feature.startAt);
    setEndAt(feature.endAt);
    pendingDateSyncRef.current = false;
  }, [dragging, feature.startAt, feature.endAt, featureStartTime, featureEndTime]);

  const width = useMemo(() => getWidth(startAt, endAt, gantt), [startAt, endAt, gantt]);
  const offset = useMemo(
    () => getOffset(startAt, timelineStartDate, gantt),
    [startAt, timelineStartDate, gantt],
  );

  const [mousePosition] = useMouse<HTMLDivElement>();

  const [previousMouseX, setPreviousMouseX] = useState(0);
  const [previousStartAt, setPreviousStartAt] = useState(startAt);
  const [previousEndAt, setPreviousEndAt] = useState(endAt);

  const mouseSensor = useSensor(MouseSensor, {
    activationConstraint: {
      distance: 10,
    },
  });

  const handleItemDragStart = useCallback(() => {
    setPreviousMouseX(mousePosition.x);
    setPreviousStartAt(startAt);
    setPreviousEndAt(endAt);
  }, [mousePosition.x, startAt, endAt]);

  const handleItemDragMove = useCallback(() => {
    const currentDate = getDateByMousePosition(gantt, mousePosition.x);
    const originalDate = getDateByMousePosition(gantt, previousMouseX);
    const delta =
      gantt.range === "daily"
        ? getDifferenceIn(gantt.range)(currentDate, originalDate)
        : getInnerDifferenceIn(gantt.range)(currentDate, originalDate);
    const newStartDate = addDays(previousStartAt, delta);
    const newEndDate = addDays(previousEndAt, delta);

    setStartAt(newStartDate);
    setEndAt(newEndDate);
  }, [gantt, mousePosition.x, previousMouseX, previousStartAt, previousEndAt]);

  const onDragEnd = useCallback(
    () => onMove?.(feature.id, startAt, endAt),
    [onMove, feature.id, startAt, endAt],
  );

  const handleLeftDragMove = useCallback(() => {
    const ganttRect = gantt.ref?.current?.getBoundingClientRect();
    const x = mousePosition.x - (ganttRect?.left ?? 0) + scrollX - gantt.sidebarWidth;
    const newStartAt = getDateByMousePosition(gantt, x);

    setStartAt(newStartAt);
  }, [gantt, mousePosition.x, scrollX]);

  const handleRightDragMove = useCallback(() => {
    const ganttRect = gantt.ref?.current?.getBoundingClientRect();
    const x = mousePosition.x - (ganttRect?.left ?? 0) + scrollX - gantt.sidebarWidth;
    const newEndAt = getDateByMousePosition(gantt, x);

    setEndAt(newEndAt);
  }, [gantt, mousePosition.x, scrollX]);

  const featureCard = (
    <GanttFeatureItemCard draggable={draggable} id={feature.id}>
      {children ?? <p className="flex-1 truncate text-xs">{feature.name}</p>}
    </GanttFeatureItemCard>
  );

  return (
    <div
      className={cn("relative flex w-max min-w-full py-0.5", className)}
      style={{ height: "var(--gantt-row-height)" }}
    >
      <div
        className="pointer-events-auto absolute top-0.5"
        style={{
          height: "calc(var(--gantt-row-height) - 4px)",
          width,
          left: offset,
        }}
      >
        {draggable && onMove && (
          <DndContext
            modifiers={[restrictToHorizontalAxis]}
            onDragEnd={onDragEnd}
            onDragMove={handleLeftDragMove}
            sensors={[mouseSensor]}
          >
            <GanttFeatureDragHelper date={startAt} direction="left" featureId={feature.id} />
          </DndContext>
        )}
        {draggable ? (
          <DndContext
            modifiers={[restrictToHorizontalAxis]}
            onDragEnd={onDragEnd}
            onDragMove={handleItemDragMove}
            onDragStart={handleItemDragStart}
            sensors={[mouseSensor]}
          >
            {featureCard}
          </DndContext>
        ) : (
          featureCard
        )}
        {draggable && onMove && (
          <DndContext
            modifiers={[restrictToHorizontalAxis]}
            onDragEnd={onDragEnd}
            onDragMove={handleRightDragMove}
            sensors={[mouseSensor]}
          >
            <GanttFeatureDragHelper date={endAt} direction="right" featureId={feature.id} />
          </DndContext>
        )}
      </div>
    </div>
  );
};

export type GanttFeatureListGroupProps = {
  children: ReactNode;
  className?: string;
};

export const GanttFeatureListGroup: FC<GanttFeatureListGroupProps> = ({ children, className }) => (
  <div className={className} style={{ paddingTop: "var(--gantt-row-height)" }}>
    {children}
  </div>
);

export type GanttFeatureRowProps = {
  features: GanttFeature[];
  onMove?: (id: string, startAt: Date, endAt: Date) => void;
  children?: (feature: GanttFeature) => ReactNode;
  className?: string;
};

export const GanttFeatureRow: FC<GanttFeatureRowProps> = ({ features, onMove, children, className }) => {
  const gantt = useContext(GanttContext);
  const sortedFeatures = [...features].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  const featureWithPositions = [];
  const subRowEndTimes: Date[] = [];

  for (const feature of sortedFeatures) {
    let subRow = 0;

    while (subRow < subRowEndTimes.length && subRowEndTimes[subRow] > feature.startAt) {
      subRow++;
    }

    if (subRow === subRowEndTimes.length) {
      subRowEndTimes.push(feature.endAt);
    } else {
      subRowEndTimes[subRow] = feature.endAt;
    }

    featureWithPositions.push({ ...feature, subRow });
  }

  const maxSubRows = Math.max(1, subRowEndTimes.length);
  const subRowHeight = gantt.rowHeight;

  return (
    <div
      className={cn("relative", className)}
      style={{
        height: `${maxSubRows * subRowHeight}px`,
        minHeight: "var(--gantt-row-height)",
      }}
    >
      {featureWithPositions.map((feature) => (
        <div
          className="absolute w-full"
          key={feature.id}
          style={{
            top: `${feature.subRow * subRowHeight}px`,
            height: `${subRowHeight}px`,
          }}
        >
          <GanttFeatureItem {...feature} onMove={onMove}>
            {children ? children(feature) : <p className="flex-1 truncate text-xs">{feature.name}</p>}
          </GanttFeatureItem>
        </div>
      ))}
    </div>
  );
};

export type GanttFeatureListProps = {
  className?: string;
  children: ReactNode;
};

export const GanttFeatureList: FC<GanttFeatureListProps> = ({ className, children }) => (
  <div
    className={cn("absolute top-0 left-0 h-full w-max space-y-4", className)}
    style={{ marginTop: "var(--gantt-header-height)" }}
  >
    {children}
  </div>
);

type GanttIndicatorProps = {
  date: Date;
  className?: string;
  roadmapUi: "gantt-marker" | "gantt-today";
  children: ReactNode;
};

const GanttIndicator: FC<GanttIndicatorProps> = ({ date, className, roadmapUi, children }) => {
  const gantt = useContext(GanttContext);
  const timelineStartDate = useMemo(
    () => new Date(gantt.timelineData.at(0)?.year ?? 0, 0, 1),
    [gantt.timelineData],
  );
  const offset = useMemo(() => getOffset(date, timelineStartDate, gantt), [date, timelineStartDate, gantt]);

  return (
    <div
      className="pointer-events-none absolute top-0 left-0 z-20 flex h-full select-none flex-col items-center justify-center overflow-visible"
      data-roadmap-ui={roadmapUi}
      style={{ width: 0, transform: `translateX(${offset}px)` }}
    >
      {children}
      <div className={cn("h-full w-px bg-card", className)} />
    </div>
  );
};

const GanttIndicatorLabel = forwardRef<HTMLDivElement, { date: Date; label: string; className?: string }>(
  ({ date, label, className }, ref) => {
    const gantt = useContext(GanttContext);

    return (
      <div
        className={cn(
          "group pointer-events-auto sticky top-0 flex select-auto flex-col flex-nowrap items-center justify-center whitespace-nowrap rounded-b-md bg-card px-2 py-1 text-foreground text-xs",
          className,
        )}
        ref={ref}
      >
        {label}
        <span className="max-h-[0] overflow-hidden opacity-80 transition-all group-hover:max-h-[2rem]">
          {formatDate(date, gantt.showDailyHourTicks ? "MMM dd, yyyy HH:mm" : "MMM dd, yyyy")}
        </span>
      </div>
    );
  },
);

GanttIndicatorLabel.displayName = "GanttIndicatorLabel";

export const GanttMarker: FC<
  GanttMarkerProps & {
    onRemove?: (id: string) => void;
    className?: string;
  }
> = memo(({ label, date, id, onRemove, className }) => {
  const handleRemove = useCallback(() => onRemove?.(id), [onRemove, id]);

  return (
    <GanttIndicator className={className} date={date} roadmapUi="gantt-marker">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <GanttIndicatorLabel className={className} date={date} label={label} />
        </ContextMenuTrigger>
        <ContextMenuContent>
          {onRemove ? (
            <ContextMenuItem className="flex items-center gap-2 text-destructive" onClick={handleRemove}>
              <TrashIcon size={16} data-icon="inline-start" />
              Remove marker
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
    </GanttIndicator>
  );
});

GanttMarker.displayName = "GanttMarker";

export type GanttProviderProps = {
  range?: Range;
  zoom?: number;
  onAddItem?: (date: Date) => void;
  showDailyHourTicks?: boolean;
  initialExtent?: {
    from: Date;
    to: Date;
  };
  initialFocusDate?: Date;
  children: ReactNode;
  className?: string;
};

const createInitialTimelineDataForExtent = (initialExtent: GanttProviderProps["initialExtent"]) => {
  if (
    !initialExtent ||
    Number.isNaN(initialExtent.from.getTime()) ||
    Number.isNaN(initialExtent.to.getTime())
  ) {
    return createInitialTimelineData(new Date());
  }

  const startYear = Math.min(initialExtent.from.getFullYear(), initialExtent.to.getFullYear());
  const endYear = Math.max(initialExtent.from.getFullYear(), initialExtent.to.getFullYear());
  const data: TimelineData = [];

  for (let year = startYear; year <= endYear; year += 1) {
    data.push(createTimelineYear(year));
  }

  return data;
};

export const GanttProvider: FC<GanttProviderProps> = ({
  zoom = 100,
  range = "monthly",
  onAddItem,
  showDailyHourTicks = false,
  initialExtent,
  initialFocusDate,
  children,
  className,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [timelineData, setTimelineData] = useState<TimelineData>(() =>
    createInitialTimelineDataForExtent(initialExtent),
  );
  const [, setScrollX] = useGanttScrollX();
  const [sidebarWidth, setSidebarWidth] = useState(0);
  const [rowHeight, setRowHeight] = useState(readGanttRowHeight);

  let columnWidth = 50;

  if (range === "monthly") {
    columnWidth = 150;
  } else if (range === "quarterly") {
    columnWidth = 100;
  }

  const parsedColumnWidth = (zoom / 100) * columnWidth;
  const dailyHourTicksVisible =
    showDailyHourTicks && range === "daily" && parsedColumnWidth >= DAILY_HOUR_TICK_MIN_COLUMN_WIDTH;
  const headerHeight = dailyHourTicksVisible ? 72 : 60;
  const previousTimelineScale = useRef({ range, columnWidth: parsedColumnWidth });
  const initialFocusHandledRef = useRef(false);
  const initialFocusExpansionRef = useRef({ past: false, future: false });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const media = window.matchMedia(GANTT_COARSE_POINTER_QUERY);
    const updateRowHeight = () => {
      setRowHeight(media.matches ? GANTT_COARSE_POINTER_ROW_HEIGHT : GANTT_ROW_HEIGHT);
    };

    updateRowHeight();
    media.addEventListener("change", updateRowHeight);
    return () => media.removeEventListener("change", updateRowHeight);
  }, []);

  const cssVariables = useMemo(
    () =>
      ({
        "--gantt-zoom": `${zoom}`,
        "--gantt-column-width": `${(zoom / 100) * columnWidth}px`,
        "--gantt-header-height": `${headerHeight}px`,
        "--gantt-row-height": `${rowHeight}px`,
        "--gantt-sidebar-width": `${sidebarWidth}px`,
      }) as CSSProperties,
    [zoom, columnWidth, headerHeight, rowHeight, sidebarWidth],
  );

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || initialFocusHandledRef.current) {
      return;
    }

    const hasValidInitialFocusDate = initialFocusDate && !Number.isNaN(initialFocusDate.getTime());

    if (hasValidInitialFocusDate) {
      const initialSidebarWidth = scrollElement.querySelector('[data-roadmap-ui="gantt-sidebar"]') ? 300 : 0;
      const timelineStartDate = new Date(timelineData[0].year, 0, 1);
      const focusOffset = getOffset(initialFocusDate, timelineStartDate, {
        zoom,
        range,
        columnWidth,
      });
      const timelineViewportWidth = Math.max(0, scrollElement.clientWidth - initialSidebarWidth);
      const halfViewportWidth = timelineViewportWidth / 2;
      const timelineWidth = getTimelineColumnCount(timelineData, range) * parsedColumnWidth;

      if (
        halfViewportWidth > 0 &&
        focusOffset < halfViewportWidth &&
        !initialFocusExpansionRef.current.past
      ) {
        initialFocusExpansionRef.current.past = true;
        setTimelineData((current) => [createTimelineYear((current[0]?.year ?? 0) - 1), ...current]);
        return;
      }

      if (
        halfViewportWidth > 0 &&
        timelineWidth - focusOffset < halfViewportWidth &&
        !initialFocusExpansionRef.current.future
      ) {
        initialFocusExpansionRef.current.future = true;
        setTimelineData((current) => [...current, createTimelineYear((current.at(-1)?.year ?? 0) + 1)]);
        return;
      }

      scrollElement.scrollLeft = Math.max(0, focusOffset - timelineViewportWidth / 2);
    } else {
      scrollElement.scrollLeft = scrollElement.scrollWidth / 2 - scrollElement.clientWidth / 2;
    }

    initialFocusHandledRef.current = true;
    setScrollX(scrollElement.scrollLeft);
  }, [columnWidth, initialFocusDate, parsedColumnWidth, range, setScrollX, timelineData, zoom]);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    const previousScale = previousTimelineScale.current;
    previousTimelineScale.current = { range, columnWidth: parsedColumnWidth };

    if (
      !scrollElement ||
      previousScale.range !== range ||
      previousScale.columnWidth <= 0 ||
      previousScale.columnWidth === parsedColumnWidth
    ) {
      return;
    }

    const timelineViewportWidth = Math.max(0, scrollElement.clientWidth - sidebarWidth);
    const focalOffset = scrollElement.scrollLeft + timelineViewportWidth / 2;
    const scale = parsedColumnWidth / previousScale.columnWidth;
    scrollElement.scrollLeft = Math.max(0, focalOffset * scale - timelineViewportWidth / 2);
    setScrollX(scrollElement.scrollLeft);
  }, [parsedColumnWidth, range, setScrollX, sidebarWidth]);

  useEffect(() => {
    const updateSidebarWidth = () => {
      const sidebarElement = scrollRef.current?.querySelector('[data-roadmap-ui="gantt-sidebar"]');
      const newWidth = sidebarElement ? 300 : 0;
      setSidebarWidth(newWidth);
    };

    updateSidebarWidth();

    const observer = new MutationObserver(updateSidebarWidth);
    if (scrollRef.current) {
      observer.observe(scrollRef.current, {
        childList: true,
        subtree: true,
      });
    }

    return () => {
      observer.disconnect();
    };
  }, []);

  const handleScroll = useMemo(
    () =>
      throttle(() => {
        const scrollElement = scrollRef.current;
        if (!scrollElement) {
          return;
        }

        const { scrollLeft, scrollWidth, clientWidth } = scrollElement;
        setScrollX(scrollLeft);

        if (scrollLeft === 0) {
          setTimelineData((current) => {
            const firstYear = current[0]?.year;
            return firstYear === undefined ? current : [createTimelineYear(firstYear - 1), ...current];
          });
          scrollElement.scrollLeft = scrollElement.clientWidth;
          setScrollX(scrollElement.scrollLeft);
        } else if (scrollLeft + clientWidth >= scrollWidth) {
          setTimelineData((current) => {
            const lastYear = current.at(-1)?.year;
            return lastYear === undefined ? current : [...current, createTimelineYear(lastYear + 1)];
          });
          scrollElement.scrollLeft = scrollElement.scrollWidth - scrollElement.clientWidth;
          setScrollX(scrollElement.scrollLeft);
        }
      }, 100),
    [setScrollX],
  );

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (scrollElement) {
      scrollElement.addEventListener("scroll", handleScroll);
    }

    return () => {
      scrollElement?.removeEventListener("scroll", handleScroll);
      handleScroll.cancel();
    };
  }, [handleScroll]);

  const scrollToFeature = useCallback(
    (feature: GanttFeature) => {
      const scrollElement = scrollRef.current;
      if (!scrollElement) {
        return;
      }

      const timelineStartDate = new Date(timelineData[0].year, 0, 1);

      const offset = getOffset(feature.startAt, timelineStartDate, {
        zoom,
        range,
        columnWidth,
      });

      const targetScrollLeft = Math.max(0, offset);

      scrollElement.scrollTo({
        left: targetScrollLeft,
        behavior: "smooth",
      });
    },
    [timelineData, zoom, range, columnWidth],
  );

  return (
    <GanttContext.Provider
      value={{
        zoom,
        range,
        columnWidth,
        sidebarWidth,
        rowHeight,
        onAddItem,
        timelineData,
        showDailyHourTicks: dailyHourTicksVisible,
        ref: scrollRef,
        scrollToFeature,
      }}
    >
      <div
        className={cn(
          "gantt relative isolate grid h-full w-full flex-none select-none overflow-auto rounded-sm bg-secondary",
          range,
          className,
        )}
        ref={scrollRef}
        style={{
          ...cssVariables,
          gridTemplateColumns: "var(--gantt-sidebar-width) 1fr",
        }}
      >
        {children}
      </div>
    </GanttContext.Provider>
  );
};

export type GanttTimelineProps = {
  children: ReactNode;
  className?: string;
};

export const GanttTimeline: FC<GanttTimelineProps> = ({ children, className }) => (
  <div className={cn("relative flex h-full w-max flex-none overflow-clip", className)}>{children}</div>
);

export type GanttTodayProps = {
  className?: string;
};

export const GanttToday: FC<GanttTodayProps> = ({ className }) => {
  const date = useMemo(() => new Date(), []);

  return (
    <GanttIndicator className={className} date={date} roadmapUi="gantt-today">
      <GanttIndicatorLabel className={className} date={date} label="Today" />
    </GanttIndicator>
  );
};
