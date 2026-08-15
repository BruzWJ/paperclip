import { AgentIcon } from "@/routes/_authenticated/$companyId/-AgentIconPicker";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  ORG_CARD_HEIGHT,
  ORG_CARD_WIDTH,
  type OrgLayoutEdge,
} from "@/routes/_authenticated/$companyId/agents/-org-layout";
import type { Point2D } from "@/lib/presentation-contracts";
import type { Agent } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { Download, Maximize2, Minus, Plus, Upload } from "lucide-react";
import type { MouseEventHandler } from "react";

export function OrgChartActions({ companyId }: { companyId: string }) {
  return (
    <ButtonGroup className="mb-2">
      <Button variant="outline" size="sm" asChild>
        <Link to="/$companyId/company/import" params={{ companyId }}>
          <Upload data-icon="inline-start" />
          Import company
        </Link>
      </Button>
      <Button variant="outline" size="sm" asChild>
        <Link to="/$companyId/company/export/$" params={{ companyId, _splat: "" }}>
          <Download data-icon="inline-start" />
          Export company
        </Link>
      </Button>
    </ButtonGroup>
  );
}

export function OrgChartAgentCard({
  agent,
  name,
  status,
  x,
  y,
  width,
  minHeight,
  onClick,
  onClickCapture,
}: {
  agent: Agent | undefined;
  name: string;
  status: string;
  x: number;
  y: number;
  width: number;
  minHeight: number;
  onClick: () => void;
  onClickCapture: MouseEventHandler;
}) {
  const statusLabel = status.replaceAll("_", " ");

  return (
    <Button
      type="button"
      variant="ghost"
      className="absolute h-auto w-full cursor-pointer items-stretch justify-start gap-0 overflow-hidden rounded-lg bg-card p-0 text-left text-foreground shadow-sm transition-[background-color,border-color,box-shadow] duration-200 hover:border-primary/50 hover:bg-accent/40 hover:text-foreground hover:shadow-md focus-visible:z-10 motion-reduce:transition-none"
      style={{ left: x, top: y, width, minHeight }}
      data-org-card
      onClick={onClick}
      onClickCapture={onClickCapture}
    >
      <span className="flex min-w-0 flex-1 flex-col justify-between gap-2 px-3 py-2.5">
        <span className="flex min-w-0 items-start gap-2.5">
          <Avatar size="lg" className="bg-muted/80 ring-1 ring-border/80">
            <AvatarFallback className="bg-muted/80 text-muted-foreground">
              <AgentIcon icon={agent?.icon} className="size-5" />
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 pt-0.5">
            <span className="block truncate text-sm leading-snug font-semibold">{name}</span>
            {agent?.title ? (
              <span className="mt-0.5 block truncate text-(length:--text-micro) text-muted-foreground">
                {agent.title}
              </span>
            ) : null}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2 border-t border-border/70 pt-1.5">
          <DomainStatus
            status={status}
            className="shrink-0 border-0 bg-transparent px-0 py-0 text-(length:--text-micro) capitalize"
          >
            {statusLabel}
          </DomainStatus>
          {agent?.capabilities ? (
            <span className="min-w-0 truncate text-(length:--text-micro) text-muted-foreground">
              {agent.capabilities}
            </span>
          ) : null}
        </span>
      </span>
    </Button>
  );
}

export function OrgChartEdges({ edges, pan, zoom }: { edges: OrgLayoutEdge[]; pan: Point2D; zoom: number }) {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full">
      <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
        {edges.map(({ parent, child }) => {
          const x1 = parent.x + ORG_CARD_WIDTH / 2;
          const y1 = parent.y + ORG_CARD_HEIGHT;
          const x2 = child.x + ORG_CARD_WIDTH / 2;
          const y2 = child.y;
          const midY = (y1 + y2) / 2;
          return (
            <path
              key={`${parent.id}-${child.id}`}
              d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
              className="fill-none stroke-border stroke-1"
            />
          );
        })}
      </g>
    </svg>
  );
}

export function OrgChartZoomControls({
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  return (
    <ButtonGroup orientation="vertical" className="absolute top-3 right-3 z-10">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={onZoomIn}
        title="Zoom in"
        aria-label="Zoom in"
      >
        <Plus data-icon="inline-start" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={onZoomOut}
        title="Zoom out"
        aria-label="Zoom out"
      >
        <Minus data-icon="inline-start" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={onFit}
        title="Fit to screen"
        aria-label="Fit chart to screen"
      >
        <Maximize2 data-icon="inline-start" />
      </Button>
    </ButtonGroup>
  );
}
