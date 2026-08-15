import { agentsApi } from "@/api/agents";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  OrgChartActions,
  OrgChartAgentCard,
  OrgChartEdges,
  OrgChartZoomControls,
} from "@/routes/_authenticated/$companyId/org/-OrgChartParts";
import { Skeleton } from "@/components/ui/skeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { queryKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Network } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { indexEntitiesById, type Point2D } from "@/lib/presentation-contracts";
import {
  ORG_CARD_HEIGHT,
  ORG_CARD_WIDTH,
  ORG_PADDING,
  collectOrgEdges,
  flattenOrgLayout,
  layoutOrgForest,
} from "./-org-layout";

export const Route = createFileRoute("/_authenticated/$companyId/org/")({
  component: OrgChart,
});

const MIN_ZOOM = 0.2;

const MAX_ZOOM = 2;

const TOUCH_MOVE_THRESHOLD = 6;

// ── Tree layout types ───────────────────────────────────────────────────

interface TouchGesture {
  mode: "pan" | "pinch" | null;
  startPoint: Point2D;
  startPan: Point2D;
  startZoom: number;
  startDistance: number;
  startCenter: Point2D;
  moved: boolean;
}

function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

function touchPoint(touch: React.Touch): Point2D {
  return { x: touch.clientX, y: touch.clientY };
}

function touchDistance(a: React.Touch, b: React.Touch): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function touchCenter(a: React.Touch, b: React.Touch, container: HTMLDivElement): Point2D {
  const rect = container.getBoundingClientRect();
  return {
    x: (a.clientX + b.clientX) / 2 - rect.left,
    y: (a.clientY + b.clientY) / 2 - rect.top,
  };
}

// ── Main component ──────────────────────────────────────────────────────

function OrgChart() {
  const companyId = useCompanyRouteId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();

  const { data: orgTree, isLoading } = useQuery({
    queryKey: queryKeys.org(companyId),
    queryFn: () => agentsApi.org(companyId),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const agentMap = useMemo(() => indexEntitiesById(agents), [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  // Layout computation
  const layout = useMemo(() => layoutOrgForest(orgTree ?? []), [orgTree]);
  const allNodes = useMemo(() => flattenOrgLayout(layout), [layout]);
  const edges = useMemo(() => collectOrgEdges(layout), [layout]);

  // Compute SVG bounds
  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 800, height: 600 };
    let maxX = 0,
      maxY = 0;
    for (const n of allNodes) {
      maxX = Math.max(maxX, n.x + ORG_CARD_WIDTH);
      maxY = Math.max(maxY, n.y + ORG_CARD_HEIGHT);
    }
    return { width: maxX + ORG_PADDING, height: maxY + ORG_PADDING };
  }, [allNodes]);

  // Pan & zoom state
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const touchGesture = useRef<TouchGesture>({
    mode: null,
    startPoint: { x: 0, y: 0 },
    startPan: { x: 0, y: 0 },
    startZoom: 1,
    startDistance: 0,
    startCenter: { x: 0, y: 0 },
    moved: false,
  });
  const suppressNextCardClick = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
    };
  }, []);

  // Center the chart on first load
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;
    hasInitialized.current = true;

    const container = containerRef.current;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    // Fit chart to container
    const scaleX = (containerW - 40) / bounds.width;
    const scaleY = (containerH - 40) / bounds.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);

    const chartW = bounds.width * fitZoom;
    const chartH = bounds.height * fitZoom;

    setZoom(fitZoom);
    setPan({
      x: (containerW - chartW) / 2,
      y: (containerH - chartH) / 2,
    });
  }, [allNodes, bounds]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      // Don't drag if clicking a card
      const target = e.target as HTMLElement;
      if (target.closest("[data-org-card]")) return;
      setDragging(true);
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        panX: pan.x,
        panY: pan.y,
      };
    },
    [pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setPan({
        x: dragStart.current.panX + dx,
        y: dragStart.current.panY + dy,
      });
    },
    [dragging],
  );

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = clampZoom(zoom * factor);

      // Zoom toward mouse position
      const scale = newZoom / zoom;
      setPan({
        x: mouseX - scale * (mouseX - pan.x),
        y: mouseY - scale * (mouseY - pan.y),
      });
      setZoom(newZoom);
    },
    [zoom, pan],
  );

  const zoomTowardPoint = useCallback(
    (newZoom: number, point: Point2D) => {
      const clampedZoom = clampZoom(newZoom);
      const scale = clampedZoom / zoom;
      setPan({
        x: point.x - scale * (point.x - pan.x),
        y: point.y - scale * (point.y - pan.y),
      });
      setZoom(clampedZoom);
    },
    [zoom, pan],
  );

  const fitToScreen = useCallback(() => {
    if (!containerRef.current) return;
    const cW = containerRef.current.clientWidth;
    const cH = containerRef.current.clientHeight;
    const scaleX = (cW - 40) / bounds.width;
    const scaleY = (cH - 40) / bounds.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);
    const chartW = bounds.width * fitZoom;
    const chartH = bounds.height * fitZoom;
    setZoom(fitZoom);
    setPan({ x: (cW - chartW) / 2, y: (cH - chartH) / 2 });
  }, [bounds]);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (e.touches.length >= 2 && containerRef.current) {
        const [first, second] = [e.touches[0]!, e.touches[1]!];
        touchGesture.current = {
          mode: "pinch",
          startPoint: { x: 0, y: 0 },
          startPan: pan,
          startZoom: zoom,
          startDistance: touchDistance(first, second),
          startCenter: touchCenter(first, second, containerRef.current),
          moved: false,
        };
        return;
      }

      const touch = e.touches[0];
      if (!touch) return;
      touchGesture.current = {
        mode: "pan",
        startPoint: touchPoint(touch),
        startPan: pan,
        startZoom: zoom,
        startDistance: 0,
        startCenter: { x: 0, y: 0 },
        moved: false,
      };
    },
    [pan, zoom],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container || !touchGesture.current.mode) return;

      if (e.touches.length >= 2) {
        const [first, second] = [e.touches[0]!, e.touches[1]!];
        const distance = touchDistance(first, second);
        const center = touchCenter(first, second, container);

        if (touchGesture.current.mode !== "pinch" || touchGesture.current.startDistance === 0) {
          touchGesture.current = {
            mode: "pinch",
            startPoint: { x: 0, y: 0 },
            startPan: pan,
            startZoom: zoom,
            startDistance: distance,
            startCenter: center,
            moved: false,
          };
          return;
        }

        const gesture = touchGesture.current;
        const nextZoom = clampZoom(gesture.startZoom * (distance / gesture.startDistance));
        const scale = nextZoom / gesture.startZoom;
        const dx = center.x - gesture.startCenter.x;
        const dy = center.y - gesture.startCenter.y;
        gesture.moved =
          gesture.moved ||
          Math.abs(distance - gesture.startDistance) > TOUCH_MOVE_THRESHOLD ||
          Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD;
        setZoom(nextZoom);
        setPan({
          x: center.x - scale * (gesture.startCenter.x - gesture.startPan.x),
          y: center.y - scale * (gesture.startCenter.y - gesture.startPan.y),
        });
        return;
      }

      const touch = e.touches[0];
      if (!touch || touchGesture.current.mode !== "pan") return;
      const dx = touch.clientX - touchGesture.current.startPoint.x;
      const dy = touch.clientY - touchGesture.current.startPoint.y;
      touchGesture.current.moved = touchGesture.current.moved || Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD;
      setPan({
        x: touchGesture.current.startPan.x + dx,
        y: touchGesture.current.startPan.y + dy,
      });
    },
    [pan, zoom],
  );

  const handleTouchEnd = useCallback(() => {
    if (touchGesture.current.moved) {
      suppressNextCardClick.current = true;
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressNextCardClick.current = false;
        suppressClickTimerRef.current = null;
      }, 400);
    }
    touchGesture.current = {
      mode: null,
      startPoint: { x: 0, y: 0 },
      startPan: pan,
      startZoom: zoom,
      startDistance: 0,
      startCenter: { x: 0, y: 0 },
      moved: false,
    };
  }, [pan, zoom]);

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  if (orgTree && orgTree.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Network  data-icon="inline-start"/>
          </EmptyMedia>
          <EmptyTitle>No organizational hierarchy defined.</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex h-(--sz-calc-38) min-h-(--sz-420px) flex-col md:h-full md:min-h-0">
      <OrgChartActions companyId={companyId} />
      <div
        ref={containerRef}
        data-testid="org-chart-viewport"
        className="w-full flex-1 min-h-0 overflow-hidden relative bg-muted/20 border border-border rounded-lg"
        style={{
          cursor: dragging ? "grabbing" : "grab",
          touchAction: "none",
          overscrollBehavior: "contain",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        <OrgChartZoomControls
          onZoomIn={() => {
            const container = containerRef.current;
            if (container) {
              zoomTowardPoint(zoom * 1.2, {
                x: container.clientWidth / 2,
                y: container.clientHeight / 2,
              });
            }
          }}
          onZoomOut={() => {
            const container = containerRef.current;
            if (container) {
              zoomTowardPoint(zoom * 0.8, {
                x: container.clientWidth / 2,
                y: container.clientHeight / 2,
              });
            }
          }}
          onFit={fitToScreen}
        />

        {/* SVG layer for edges */}
        <OrgChartEdges edges={edges} pan={pan} zoom={zoom} />

        {/* Card layer */}
        <div
          data-testid="org-chart-card-layer"
          className="absolute inset-0"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {allNodes.map((node) => {
            const agent = agentMap.get(node.id);
            return (
              <OrgChartAgentCard
                key={node.id}
                agent={agent}
                name={node.name}
                status={node.status}
                x={node.x}
                y={node.y}
                width={ORG_CARD_WIDTH}
                minHeight={ORG_CARD_HEIGHT}
                onClick={() => {
                  if (!agent) return;
                  void navigate({
                    to: "/$companyId/agents/$agentId",
                    params: { companyId, agentId: agent.id },
                  });
                }}
                onClickCapture={(e) => {
                  if (!suppressNextCardClick.current) return;
                  suppressNextCardClick.current = false;
                  e.preventDefault();
                  e.stopPropagation();
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
