import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { timeAgo } from "@/lib/timeAgo";
import { statusBadgeVariant } from "@/lib/status-variant";
import type { Task, TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { X, XCircle } from "lucide-react";

import { InboxRowUnreadSlot, NonTaskUnreadState } from "./-InboxRowShared";

import { readTaskIdFromRun, runFailureMessage } from "./-inbox-row-model";

export function FailedRunInboxRow({
  run,
  taskById,
  agentName: linkedAgentName,
  agentId,
  onDismiss,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  selected = false,
  className,
}: {
  run: TaskExecutionRunEnvelopeRecord;
  taskById: Map<string, Task>;
  agentName: string | null;
  agentId: string | null;
  onDismiss: () => void;
  unreadState?: NonTaskUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  selected?: boolean;
  className?: string;
}) {
  const companyId = useCompanyRouteId();
  const taskId = readTaskIdFromRun(run);
  const task = taskId ? (taskById.get(taskId) ?? null) : null;
  const displayError = runFailureMessage(run);
  const showUnreadSlot = unreadState !== null;
  const content = (
    <>
      <ItemTitle>
        {task ? (
          <>
            <span className="font-mono text-muted-foreground">{task.identifier}</span>
            {task.title}
          </>
        ) : (
          <>Failed run{linkedAgentName ? ` — ${linkedAgentName}` : ""}</>
        )}
      </ItemTitle>
      <ItemDescription>
        <Badge variant={statusBadgeVariant(run.status)}>{run.status.replace(/[_-]/g, " ")}</Badge>
        {linkedAgentName && task ? ` · ${linkedAgentName}` : ""}
        {` · ${displayError} · ${timeAgo(run.createdAt)}`}
      </ItemDescription>
    </>
  );

  return (
    <Item variant={selected ? "muted" : "default"} size="sm" className={className}>
      {showUnreadSlot ? (
        <InboxRowUnreadSlot
          unreadState={unreadState}
          onMarkRead={onMarkRead}
          onArchive={onArchive}
          archiveDisabled={archiveDisabled}
        />
      ) : null}
      <ItemMedia variant="icon">
        <XCircle />
      </ItemMedia>
      <ItemContent>
        {agentId ? (
          <Link to="/$companyId/agents/$agentId/runs/$runId" params={{ companyId, agentId, runId: run.id }}>
            {content}
          </Link>
        ) : (
          content
        )}
      </ItemContent>
      {!showUnreadSlot ? (
        <ItemActions>
          <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="Dismiss">
            <X />
          </Button>
        </ItemActions>
      ) : null}
    </Item>
  );
}
