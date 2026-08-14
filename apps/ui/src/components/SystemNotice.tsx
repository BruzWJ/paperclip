import { useId, useState, type ReactNode } from "react";
import { ChevronDown, CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export type SystemNoticeTone = "neutral" | "info" | "success" | "warning" | "danger";

export type SystemNoticeMetadataRow =
  | { kind: "text"; label: string; value: string }
  | { kind: "code"; label: string; value: string }
  | {
      kind: "task";
      label: string;
      taskNumber: number;
      identifier: string;
      link?: boolean;
      title?: string;
    }
  | {
      kind: "task";
      label: string;
      taskNumber: null;
      identifier: string | null;
      link?: false;
      title?: string;
    }
  | { kind: "agent"; label: string; name: string; agentId?: string }
  | {
      kind: "run";
      label: string;
      runId: string;
      agentId?: string;
      status?: string;
    };

export type SystemNoticeMetadataSection = {
  title?: string;
  rows: SystemNoticeMetadataRow[];
};

export type SystemNoticeProps = {
  tone?: SystemNoticeTone;
  /** Short label that names the system actor + tone, e.g. "System warning". Required so tone is not color-only. */
  label?: string;
  /** Short visible body — one or two sentences from the system perspective. */
  body: ReactNode;
  /** Optional small chip for the originating run link. */
  source?: { label: string; agentId?: string; runId?: string };
  /** Hidden-by-default metadata. Renders the Details affordance only when present. */
  metadata?: SystemNoticeMetadataSection[];
  /** Force the details panel open initially. Defaults to false (collapsed). */
  detailsDefaultOpen?: boolean;
  /** Optional ISO timestamp shown next to the label. */
  timestamp?: string;
  className?: string;
};

const TONE_ICONS: Record<SystemNoticeTone, LucideIcon> = {
  neutral: Info,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: OctagonAlert,
};

function formatTimestamp(ts: string) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

function MetadataRow({ row }: { row: SystemNoticeMetadataRow }) {
  const companyId = useCompanyRouteId();
  return (
    <div className="grid grid-cols-(--gtc-8) gap-x-3 gap-y-0.5 px-3 py-1.5 text-xs">
      <div className="truncate text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
        {row.label}
      </div>
      <div className="min-w-0 break-words text-foreground/90">
        {(() => {
          switch (row.kind) {
            case "text":
              return <span>{row.value}</span>;
            case "code":
              return (
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-micro) text-foreground/80">
                  {row.value}
                </code>
              );
            case "task": {
              const taskLabel = (
                <>
                  <span>{row.identifier ?? "Task unavailable"}</span>
                  {row.title ? <span className="text-muted-foreground">— {row.title}</span> : null}
                </>
              );
              if (row.link && row.taskNumber != null) {
                return (
                  <Link
                    to="/$companyId/tasks/$taskNumber"
                    params={{ companyId, taskNumber: String(row.taskNumber) }}
                    className="inline-flex items-center gap-1 rounded-sm font-medium underline-offset-2 hover:underline"
                  >
                    {taskLabel}
                  </Link>
                );
              }
              return <span className="inline-flex items-center gap-1 font-medium">{taskLabel}</span>;
            }
            case "agent":
              return row.agentId ? (
                <Link
                  to="/$companyId/agents/$agentId"
                  params={{ companyId, agentId: row.agentId }}
                  className="inline-flex items-center gap-1 rounded-sm font-medium underline-offset-2 hover:underline"
                >
                  {row.name}
                </Link>
              ) : (
                <span className="font-medium">{row.name}</span>
              );
            case "run": {
              const runShort = row.runId.length > 12 ? `${row.runId.slice(0, 8)}…` : row.runId;
              const inner = (
                <>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-foreground/80">{runShort}</code>
                  {row.status ? <span className="font-sans text-muted-foreground">{row.status}</span> : null}
                </>
              );
              if (row.agentId) {
                return (
                  <Link
                    to="/$companyId/agents/$agentId/runs/$runId"
                    params={{
                      companyId,
                      agentId: row.agentId,
                      runId: row.runId,
                    }}
                    className="inline-flex items-center gap-2 rounded-sm font-mono text-(length:--text-micro) underline-offset-2 hover:underline"
                  >
                    {inner}
                  </Link>
                );
              }
              return (
                <span className="inline-flex items-center gap-2 font-mono text-(length:--text-micro)">
                  {inner}
                </span>
              );
            }
          }
        })()}
      </div>
    </div>
  );
}

export function SystemNotice({
  tone = "neutral",
  label,
  body,
  source,
  metadata,
  detailsDefaultOpen = false,
  timestamp,
  className,
}: SystemNoticeProps) {
  const companyId = useCompanyRouteId();
  const ToneIcon = TONE_ICONS[tone];
  const [open, setOpen] = useState(detailsDefaultOpen);
  const detailsId = useId();
  const hasDetails = Boolean(metadata && metadata.length > 0);
  const resolvedLabel =
    label ??
    {
      neutral: "System notice",
      info: "System notice",
      success: "System notice",
      warning: "System warning",
      danger: "System alert",
    }[tone];

  return (
    <Alert
      role="status"
      aria-label={resolvedLabel}
      variant={tone === "danger" ? "destructive" : "default"}
      className={cn("relative block w-full overflow-hidden p-0 text-sm", className)}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <header className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
          <ToneIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow)">
              <AlertTitle>{resolvedLabel}</AlertTitle>
              {source ? (
                <>
                  <span className="text-muted-foreground/60" aria-hidden>
                    ·
                  </span>
                  {source.agentId && source.runId ? (
                    <Link
                      to="/$companyId/agents/$agentId/runs/$runId"
                      params={{
                        companyId,
                        agentId: source.agentId,
                        runId: source.runId,
                      }}
                      className="rounded-sm font-medium normal-case tracking-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {source.label}
                    </Link>
                  ) : (
                    <span className="font-medium normal-case tracking-normal text-muted-foreground">
                      {source.label}
                    </span>
                  )}
                </>
              ) : null}
              {timestamp ? (
                <>
                  <span className="text-muted-foreground/60" aria-hidden>
                    ·
                  </span>
                  <span className="font-medium normal-case tracking-normal text-muted-foreground">
                    {formatTimestamp(timestamp)}
                  </span>
                </>
              ) : null}
            </div>
            <AlertDescription className="mt-1 break-words leading-6">{body}</AlertDescription>
          </div>
          {hasDetails ? (
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-controls={detailsId}
                className="ml-1 h-7 shrink-0 gap-1 px-2 text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground"
              >
                <span>{open ? "Hide details" : "Details"}</span>
                <ChevronDown
                  className={cn("h-3.5 w-3.5 transition-transform duration-150", open && "rotate-180")}
                />
              </Button>
            </CollapsibleTrigger>
          ) : null}
        </header>
        {hasDetails ? (
          <CollapsibleContent id={detailsId} className="border-t bg-background/50 dark:bg-background/30">
            <div className="divide-y divide-border/50 px-1 py-1">
              {metadata!.map((section, sectionIdx) => (
                <div key={sectionIdx} className="py-1.5 first:pt-2 last:pb-2">
                  {section.title ? (
                    <div className="px-3 pb-1 pt-0.5 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
                      {section.title}
                    </div>
                  ) : null}
                  <div>
                    {section.rows.map((row, rowIdx) => (
                      <MetadataRow key={rowIdx} row={row} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </Alert>
  );
}
