import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import type { ThreadMessage } from "@assistant-ui/react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ClipboardList } from "lucide-react";
import { useContext, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { formatOwnerUserLabel } from "../../lib/task-owners";
import { type TaskTimelineOwner } from "../../lib/task-timeline-events";
import { timeAgo } from "../../lib/timeAgo";
import { cn } from "../../lib/utils";
import { AgentIcon } from "../AgentIconPicker";
import {
  OwnerChip,
  OwnerDispatchRow,
  RunStatusBadge,
  type OwnerChipResolvers,
} from "../owner-transition/OwnerTransitionViews";

import { TaskChatCtx } from "./TaskChatShared";

import { SystemNoticeCommentRow } from "./SystemNoticeCommentRow";
import { humanizeValue } from "./TaskChatMessageUtils";

// Non-comment timeline items (run/status events, "updated this task",
// "worked for N minutes") render as quiet, subordinate metadata rows hung off a
// left rail — visually distinct from the bubbles used for genuine comments.
// Virtualized rows are absolutely positioned, so each row carries its own rail
// segment; stacked rows read as one continuous rail. See PAP-95 mockup rev 5.
export function TaskChatMetadataRow({
  anchorId,
  icon,
  children,
  testid = "task-chat-metadata-row",
}: {
  anchorId?: string;
  icon: ReactNode;
  children: ReactNode;
  testid?: string;
}) {
  return (
    <div id={anchorId} data-testid={testid}>
      <div className="ml-3 flex items-start gap-2.5 border-l-2 border-border/50 py-0.5 pl-3">
        <span className="mt-px flex size-(--sz-18px) shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/30 text-muted-foreground/60">
          {icon}
        </span>
        <div className="min-w-0 flex-1 space-y-1">{children}</div>
      </div>
    </div>
  );
}

export function TaskChatSystemMessage({ message }: { message: ThreadMessage }) {
  const companyId = useCompanyRouteId();
  const { agentMap, currentUserId, userLabelMap } = useContext(TaskChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId =
    typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runAgent = runAgentId ? (agentMap?.get(runAgentId) ?? null) : null;
  const runAgentRef = runAgent?.id ?? null;
  const runAgentName =
    typeof custom.runAgentName === "string" ? custom.runAgentName : null;
  const runStatus =
    typeof custom.runStatus === "string" ? custom.runStatus : null;
  const actorName =
    typeof custom.actorName === "string" ? custom.actorName : null;
  const actorType =
    typeof custom.actorType === "string" ? custom.actorType : null;
  const actorId = typeof custom.actorId === "string" ? custom.actorId : null;
  const lifecycleStatusChange =
    typeof custom.lifecycleStatusChange === "object" &&
    custom.lifecycleStatusChange
      ? (custom.lifecycleStatusChange as {
          from: string | null;
          to: string | null;
        })
      : null;
  const ownerChange =
    typeof custom.ownerChange === "object" && custom.ownerChange
      ? (custom.ownerChange as {
          from: TaskTimelineOwner;
          to: TaskTimelineOwner;
        })
      : null;
  if (custom.kind === "system_notice") {
    return <SystemNoticeCommentRow message={message} anchorId={anchorId} />;
  }

  if (custom.kind === "event" && actorName) {
    const isAgent = actorType === "agent";
    const agentIcon =
      isAgent && actorId ? agentMap?.get(actorId)?.icon : undefined;
    const isCurrentUser =
      actorType === "user" && !!currentUserId && actorId === currentUserId;
    const rowIcon = agentIcon ? (
      <AgentIcon icon={agentIcon} className="h-3 w-3" />
    ) : (
      <ClipboardList className="h-3 w-3" />
    );
    const ownerResolvers: OwnerChipResolvers = {
      agentMap,
      currentUserId,
      resolveUserLabel: (userId) =>
        formatOwnerUserLabel(userId, null, userLabelMap),
    };

    return (
      <TaskChatMetadataRow anchorId={anchorId} icon={rowIcon}>
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
          <span className="font-medium text-foreground">{actorName}</span>
          <span className="text-muted-foreground">
            {custom.followUpRequested === true
              ? "requested follow-up"
              : "updated this task"}
          </span>
          <a
            href={anchorId ? `#${anchorId}` : undefined}
            className="text-xs text-muted-foreground/70 transition-colors hover:text-foreground hover:underline"
          >
            {timeAgo(message.createdAt)}
          </a>
        </div>

        {lifecycleStatusChange ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-(length:--text-nano) font-medium uppercase tracking-wider text-muted-foreground/70">
              Lifecycle
            </span>
            <span className="text-muted-foreground">
              {humanizeValue(lifecycleStatusChange.from)}
            </span>
            <ArrowRight className="h-3 w-3 text-muted-foreground/70" />
            <span className="font-medium text-foreground">
              {humanizeValue(lifecycleStatusChange.to)}
            </span>
          </div>
        ) : null}

        {ownerChange ? (
          <div className="space-y-1">
            <div
              className={cn(
                "flex flex-wrap items-center gap-1.5 text-xs",
                isCurrentUser && "justify-end",
              )}
            >
              <span className="text-(length:--text-nano) font-medium uppercase tracking-wider text-muted-foreground/70">
                Owner
              </span>
              <OwnerChip owner={ownerChange.from} resolvers={ownerResolvers} />
              <ArrowRight className="h-3 w-3 text-muted-foreground/70" />
              <OwnerChip owner={ownerChange.to} resolvers={ownerResolvers} />
            </div>
            <div className={cn(isCurrentUser && "flex justify-end")}>
              <OwnerDispatchRow
                to={ownerChange.to}
                resolvers={ownerResolvers}
                interruptedRunAttached={custom.interruptedRunId != null}
              />
            </div>
          </div>
        ) : null}
      </TaskChatMetadataRow>
    );
  }

  const displayedRunAgentName =
    runAgentName ??
    (runAgent ? runAgent.name : runAgentId ? runAgentId.slice(0, 8) : null);
  const runAgentIcon = runAgent?.icon;
  if (
    custom.kind === "run" &&
    runId &&
    runAgentId &&
    displayedRunAgentName &&
    runStatus
  ) {
    const rowIcon = runAgentIcon ? (
      <AgentIcon icon={runAgentIcon} className="h-3 w-3" />
    ) : (
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
    );

    return (
      <TaskChatMetadataRow anchorId={anchorId} icon={rowIcon}>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          {runAgentRef ? (
            <Link
              to="/$companyId/agents/$agentId"
              params={{ companyId, agentId: runAgentRef }}
              className="font-medium text-foreground transition-colors hover:underline"
            >
              {displayedRunAgentName}
            </Link>
          ) : (
            <span className="font-medium text-foreground">
              {displayedRunAgentName}
            </span>
          )}
          <span className="text-muted-foreground">run</span>
          {runAgentRef ? (
            <Badge asChild variant="outline" className="font-mono">
              <Link
                to="/$companyId/agents/$agentId/runs/$runId"
                params={{ companyId, agentId: runAgentRef, runId }}
              >
                {runId.slice(0, 8)}
              </Link>
            </Badge>
          ) : (
            <Badge variant="outline" className="font-mono">
              {runId.slice(0, 8)}
            </Badge>
          )}
          <RunStatusBadge
            status={runStatus}
            operatorInterrupted={custom.runOperatorInterrupted === true}
          />
          <a
            href={anchorId ? `#${anchorId}` : undefined}
            className="text-xs text-muted-foreground/70 transition-colors hover:text-foreground hover:underline"
          >
            {timeAgo(message.createdAt)}
          </a>
        </div>
      </TaskChatMetadataRow>
    );
  }

  return null;
}
