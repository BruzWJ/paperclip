import { AgentIcon } from "@/features/agents/AgentIconPicker";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { deriveInitials } from "@/lib/identity";
import { formatUserLabel } from "@/lib/task-owners";
import { cn } from "@/lib/utils";
import { deriveOriginatingActor, type Agent, type Task } from "@paperclipai/shared";

export type AttributionActor = {
  kind: "agent" | "user";
  id: string;
  name: string;
  avatarUrl?: string | null;
  agentIcon?: string | null;
};

export function AttributionAvatar({
  label,
  actor,
  via,
}: {
  label: "Owner" | "Originator";
  actor: AttributionActor;
  via?: string | null;
}) {
  const accessibleLabel = via ? `${label}: ${actor.name}, via ${via}` : `${label}: ${actor.name}`;
  const testIdLabel = label.toLowerCase();

  return (
    <Avatar
      size="sm"
      className="ring-1 ring-border"
      role="img"
      aria-label={accessibleLabel}
      data-testid={`task-${testIdLabel}-avatar`}
    >
      {actor.kind === "agent" ? (
        <AvatarFallback className="bg-secondary text-secondary-foreground">
          <AgentIcon icon={actor.agentIcon} className="size-3" />
        </AvatarFallback>
      ) : (
        <>
          {actor.avatarUrl ? <AvatarImage src={actor.avatarUrl} alt="" /> : null}
          <AvatarFallback>{deriveInitials(actor.name)}</AvatarFallback>
        </>
      )}
    </Avatar>
  );
}

function AttributionIdentity({
  label,
  actor,
  via,
}: {
  label: "Owner" | "Originator";
  actor: AttributionActor;
  via?: string | null;
}) {
  const testIdLabel = label.toLowerCase();

  return (
    <div className="flex min-w-0 items-center gap-1.5" data-testid={`task-${testIdLabel}-attribution`}>
      <span className="text-(length:--text-nano) font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
        {label}
      </span>
      <AttributionAvatar label={label} actor={actor} via={via} />
      <span className="max-w-40 truncate text-xs font-medium text-foreground">{actor.name}</span>
      {via ? (
        <span className="max-w-36 truncate text-(length:--text-micro) text-muted-foreground">via {via}</span>
      ) : null}
    </div>
  );
}

export function TaskAttributionByline({
  task,
  agentMap,
  userProfileMap,
  userLabelMap,
  className,
}: {
  task: Task;
  agentMap: Map<string, Agent>;
  userProfileMap: ReadonlyMap<string, import("@/lib/company-members").CompanyUserProfile>;
  userLabelMap: ReadonlyMap<string, string>;
  className?: string;
}) {
  const ownerAgent = task.ownerAgentId ? agentMap.get(task.ownerAgentId) : null;
  const owner: AttributionActor | null = task.ownerAgentId
    ? {
        kind: "agent",
        id: task.ownerAgentId,
        name: ownerAgent?.name ?? task.ownerAgentId.slice(0, 8),
        agentIcon: ownerAgent?.icon,
      }
    : task.ownerUserId
      ? {
          kind: "user",
          id: task.ownerUserId,
          name:
            formatUserLabel(task.ownerUserId, userLabelMap) ??
            userProfileMap.get(task.ownerUserId)?.label ??
            "User",
          avatarUrl: userProfileMap.get(task.ownerUserId)?.image ?? null,
        }
      : null;
  const originatingActor = deriveOriginatingActor(task);
  const originatorAgent = originatingActor?.kind === "agent" ? agentMap.get(originatingActor.id) : null;
  const originator: AttributionActor | null = originatingActor
    ? originatingActor.kind === "agent"
      ? {
          kind: "agent",
          id: originatingActor.id,
          name: originatorAgent?.name ?? originatingActor.id.slice(0, 8),
          agentIcon: originatorAgent?.icon,
        }
      : {
          kind: "user",
          id: originatingActor.id,
          name:
            formatUserLabel(originatingActor.id, userLabelMap) ??
            userProfileMap.get(originatingActor.id)?.label ??
            "User",
          avatarUrl: userProfileMap.get(originatingActor.id)?.image ?? null,
        }
    : null;
  const originatorVia =
    originatingActor?.kind === "user" && originatingActor.viaAgentId
      ? (agentMap.get(originatingActor.viaAgentId)?.name ?? originatingActor.viaAgentId.slice(0, 8))
      : null;
  if (!owner && !originator) return null;

  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5", className)}
      role="group"
      aria-label="Task attribution"
      data-testid="task-attribution-byline"
    >
      {owner ? <AttributionIdentity label="Owner" actor={owner} /> : null}
      {originator ? <AttributionIdentity label="Originator" actor={originator} via={originatorVia} /> : null}
    </div>
  );
}
