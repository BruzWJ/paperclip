import { AgentIcon } from "@/components/AgentIconPicker";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  ORG_CARD_HEIGHT,
  ORG_CARD_WIDTH,
  type OrgLayoutNode,
} from "@/routes/_authenticated/$companyId/org/-org-layout";
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
        <Link
          to="/$companyId/company/export/$"
          params={{ companyId, _splat: "" }}
        >
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
  return (
    <Item
      asChild
      variant="outline"
      size="sm"
      className="absolute cursor-pointer flex-nowrap bg-card text-left shadow-sm hover:bg-accent/50"
      style={{ left: x, top: y, width, minHeight }}
      data-org-card
    >
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-start whitespace-normal p-0 hover:bg-transparent"
        onClick={onClick}
        onClickCapture={onClickCapture}
      >
        <ItemMedia>
          <Avatar>
            <AvatarFallback>
              <AgentIcon icon={agent?.icon} />
            </AvatarFallback>
          </Avatar>
        </ItemMedia>
        <ItemContent className="min-w-0 text-left">
          <ItemTitle className="max-w-full">
            <span className="truncate">{name}</span>
            <Badge variant="secondary" className="shrink-0 capitalize">
              {status.replaceAll("_", " ")}
            </Badge>
          </ItemTitle>
          {agent?.title ? (
            <ItemDescription className="truncate">
              {agent.title}
            </ItemDescription>
          ) : null}
          {agent?.capabilities ? (
            <ItemDescription>{agent.capabilities}</ItemDescription>
          ) : null}
        </ItemContent>
      </Button>
    </Item>
  );
}

export function OrgChartEdges({
  edges,
  pan,
  zoom,
}: {
  edges: Array<{ parent: OrgLayoutNode; child: OrgLayoutNode }>;
  pan: { x: number; y: number };
  zoom: number;
}) {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full"
    >
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
        <Plus />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={onZoomOut}
        title="Zoom out"
        aria-label="Zoom out"
      >
        <Minus />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={onFit}
        title="Fit to screen"
        aria-label="Fit chart to screen"
      >
        <Maximize2 />
      </Button>
    </ButtonGroup>
  );
}
