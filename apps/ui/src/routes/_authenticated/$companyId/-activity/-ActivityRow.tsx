import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Item } from "@/components/ui/item";
import { deriveInitials } from "@/lib/identity";
import { TaskReferenceActivitySummary } from "./-TaskReferenceActivitySummary";
import { timeAgo } from "@/lib/timeAgo";
import { cn } from "@/lib/utils";
import { formatActivityVerb } from "@/lib/activity-format";
import type { ActivityEvent, Agent } from "@paperclipai/shared";
import type { CompanyUserProfile } from "@/lib/company-members";

interface ActivityRowProps {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  entityNameMap: Map<string, string>;
  entityTitleMap?: Map<string, string>;
  className?: string;
}

export function ActivityRow({
  event,
  agentMap,
  userProfileMap,
  entityNameMap,
  entityTitleMap,
  className,
}: ActivityRowProps) {
  const companyId = useCompanyRouteId();
  const verb = formatActivityVerb(event.action, event.details, {
    agentMap,
    userProfileMap,
  });

  const isRunEvent = event.entityType === "task_execution_run";
  const runAgentId = isRunEvent
    ? (event.agentId ??
      ((event.details as Record<string, unknown> | null)?.targetAgentId as string | undefined))
    : undefined;

  const name = isRunEvent
    ? runAgentId
      ? entityNameMap.get(`agent:${runAgentId}`)
      : null
    : entityNameMap.get(`${event.entityType}:${event.entityId}`);

  const entityTitle = entityTitleMap?.get(`${event.entityType}:${event.entityId}`);

  const runAgentRef = runAgentId ?? null;
  const entityAgentRef = event.entityType === "agent" ? event.entityId : null;
  const linkable = Boolean(
    runAgentRef || entityAgentRef || event.entityType === "goal" || event.entityType === "approval",
  );

  const actor = event.actorType === "agent" ? agentMap.get(event.actorId) : null;
  const userProfile = event.actorType === "user" ? userProfileMap?.get(event.actorId) : null;
  const actorName =
    actor?.name ??
    (event.actorType === "system"
      ? "System"
      : (userProfile?.label ?? (event.actorType === "user" ? "Board" : event.actorId || "Unknown")));
  const actorAvatarUrl = userProfile?.image ?? null;

  const inner = (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Avatar size="sm">
            {actorAvatarUrl && <AvatarImage src={actorAvatarUrl} alt={actorName} />}
            <AvatarFallback>{deriveInitials(actorName)}</AvatarFallback>
          </Avatar>
          <p className="min-w-0 flex-1 truncate">
            <span>{actorName}</span>
            <span className="text-muted-foreground"> {verb} </span>
            {name && <span className="font-medium">{name}</span>}
            {entityTitle && <span className="text-muted-foreground"> — {entityTitle}</span>}
          </p>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{timeAgo(event.createdAt)}</span>
      </div>
      <TaskReferenceActivitySummary event={event} />
    </div>
  );

  const classes = cn(
    "px-4 py-2 text-sm",
    linkable && "cursor-pointer hover:bg-accent/50 transition-colors",
    className,
  );

  const linkClassName = cn(classes, "no-underline text-inherit block");
  if (isRunEvent && runAgentRef) {
    return (
      <Item asChild className="block rounded-none border-0 p-0">
        <Link
          to="/$companyId/agents/$agentId/runs/$runId"
          params={{ companyId, agentId: runAgentRef, runId: event.entityId }}
          className={linkClassName}
        >
          {inner}
        </Link>
      </Item>
    );
  }
  if (event.entityType === "agent" && entityAgentRef) {
    return (
      <Item asChild className="block rounded-none border-0 p-0">
        <Link
          to="/$companyId/agents/$agentId"
          params={{ companyId, agentId: entityAgentRef }}
          className={linkClassName}
        >
          {inner}
        </Link>
      </Item>
    );
  }
  if (event.entityType === "goal") {
    return (
      <Item asChild className="block rounded-none border-0 p-0">
        <Link
          to="/$companyId/goals/$goalId"
          params={{ companyId, goalId: event.entityId }}
          className={linkClassName}
        >
          {inner}
        </Link>
      </Item>
    );
  }
  if (event.entityType === "approval") {
    return (
      <Item asChild className="block rounded-none border-0 p-0">
        <Link
          to="/$companyId/approvals/$approvalId"
          params={{ companyId, approvalId: event.entityId }}
          className={linkClassName}
        >
          {inner}
        </Link>
      </Item>
    );
  }

  return <Item className={cn("block rounded-none border-0 p-0", classes)}>{inner}</Item>;
}
