import { ChevronRight } from "lucide-react";
import type { ActivityEvent } from "@paperclipai/shared";
import { JsonCodeBlock } from "@/components/patterns/JsonCodeBlock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import * as Collapse from "@/components/ui/collapsible";
import * as ItemUI from "@/components/ui/item";

export type RoutineActivityEvent = Pick<ActivityEvent, "id" | "action" | "details" | "createdAt">;

function formatTime(value: string | Date): string {
  try {
    return new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(value);
  }
}

function summarizeDetails(details: Record<string, unknown> | null | undefined): string {
  if (!details) return "";
  const entries = Object.entries(details).slice(0, 3);
  return entries
    .map(([key, value]) => `${key.replaceAll("_", " ")}: ${formatDetailValue(value)}`)
    .join(" · ");
}

function formatDetailValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map(formatDetailValue).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

export function RoutineActivityRow({ event }: { event: RoutineActivityEvent }) {
  const hasPayload = event.details != null && Object.keys(event.details).length > 0;

  return (
    <Collapse.Collapsible className="group border-b border-border/60 last:border-b-0">
      <Collapse.CollapsibleTrigger asChild>
        <ItemUI.Item asChild size="sm">
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start"
            disabled={!hasPayload}
          >
            <ItemUI.ItemMedia className="w-12 font-mono text-muted-foreground">
              {formatTime(event.createdAt)}
            </ItemUI.ItemMedia>
            <ItemUI.ItemContent className="min-w-0 flex-row items-center">
              <Badge variant="outline" className="shrink-0 font-mono">
                {event.action}
              </Badge>
              <ItemUI.ItemDescription className="truncate">
                {summarizeDetails(event.details)}
              </ItemUI.ItemDescription>
            </ItemUI.ItemContent>
            {hasPayload ? <ChevronRight className="size-3.5 group-data-[state=open]:rotate-90"  data-icon="inline-start"/> : null}
          </Button>
        </ItemUI.Item>
      </Collapse.CollapsibleTrigger>
      <Collapse.CollapsibleContent>
        {hasPayload ? (
          <JsonCodeBlock className="mx-1 mb-2" filename="activity-details.json" value={event.details} />
        ) : null}
      </Collapse.CollapsibleContent>
    </Collapse.Collapsible>
  );
}
