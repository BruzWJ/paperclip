import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from "@/components/ui/avatar";
import { deriveInitials } from "@/lib/identity";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatUserLabel } from "@/lib/task-owners";
import { cn } from "@/lib/utils";
import { deriveOriginatingActor, type ActivityEvent, type Agent, type Task } from "@paperclipai/shared";

export function ActorIdentity({
  evt,
  agentMap,
  userProfileMap,
}: {
  evt: ActivityEvent;
  agentMap: Map<string, Agent>;
  userProfileMap?: Map<string, import("@/lib/company-members").CompanyUserProfile>;
}) {
  const id = evt.actorId;
  let name: string;
  let avatarUrl: string | null | undefined;
  if (evt.actorType === "agent") {
    name = agentMap.get(id)?.name ?? id.slice(0, 8);
  } else if (evt.actorType === "system") {
    name = "System";
  } else if (evt.actorType === "user") {
    const profile = userProfileMap?.get(id);
    name = profile?.label ?? "Board";
    avatarUrl = profile?.image;
  } else {
    name = id || "Unknown";
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={name}>
      <Avatar size="sm">
        <AvatarImage src={avatarUrl ?? undefined} alt={name} />
        <AvatarFallback>{deriveInitials(name)}</AvatarFallback>
      </Avatar>
      <span className="truncate text-xs">{name}</span>
    </span>
  );
}

export type AttributionActor = {
  kind: "agent" | "user";
  id: string;
  name: string;
  avatarUrl?: string | null;
};

export function AttributionAvatar({
  label,
  actor,
  via,
}: {
  label: "Owner" | "Originating";
  actor: AttributionActor;
  via?: string | null;
}) {
  const accessibleLabel = via ? `${label}: ${actor.name} · via ${via}` : `${label}: ${actor.name}`;
  const testIdLabel = label.toLowerCase();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar
          size="sm"
          className={cn("ring-2 ring-background", actor.kind === "agent" && "rounded-md")}
          aria-label={accessibleLabel}
          data-testid={`task-${testIdLabel}-avatar`}
        >
          {actor.avatarUrl ? <AvatarImage src={actor.avatarUrl} alt="" /> : null}
          <AvatarFallback>{deriveInitials(actor.name)}</AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="px-2 py-1.5">
        <div className="flex items-center gap-2" data-testid={`task-${testIdLabel}-tooltip`}>
          <Avatar
            size="sm"
            className={cn("ring-1 ring-background/30", actor.kind === "agent" && "rounded-md")}
          >
            {actor.avatarUrl ? <AvatarImage src={actor.avatarUrl} alt="" /> : null}
            <AvatarFallback className="bg-background/20 text-background">
              {deriveInitials(actor.name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="text-(length:--text-nano) font-medium uppercase leading-none text-background/70">
              {label}
            </div>
            <div className="max-w-48 truncate text-xs font-medium leading-4 text-background">
              {actor.name}
            </div>
            {via ? (
              <div className="max-w-48 truncate text-(length:--text-nano) leading-3 text-background/60">
                via {via}
              </div>
            ) : null}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function TaskAttributionByline({
  task,
  agentMap,
  userProfileMap,
  userLabelMap,
}: {
  task: Task;
  agentMap: Map<string, Agent>;
  userProfileMap: ReadonlyMap<string, import("@/lib/company-members").CompanyUserProfile>;
  userLabelMap: ReadonlyMap<string, string>;
}) {
  const owner: AttributionActor | null = task.ownerAgentId
    ? {
        kind: "agent",
        id: task.ownerAgentId,
        name: agentMap.get(task.ownerAgentId)?.name ?? task.ownerAgentId.slice(0, 8),
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
  const originator: AttributionActor | null = originatingActor
    ? originatingActor.kind === "agent"
      ? {
          kind: "agent",
          id: originatingActor.id,
          name: agentMap.get(originatingActor.id)?.name ?? originatingActor.id.slice(0, 8),
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
    <AvatarGroup
      className="-space-x-1.5"
      aria-label="Task people"
      data-testid="task-attribution-avatar-stack"
    >
      {owner ? <AttributionAvatar label="Owner" actor={owner} /> : null}
      {originator ? <AttributionAvatar label="Originating" actor={originator} via={originatorVia} /> : null}
    </AvatarGroup>
  );
}
