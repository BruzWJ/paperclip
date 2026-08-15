import { Link } from "@tanstack/react-router";
import { ArchiveRestore, Info } from "lucide-react";

import { AgentIcon } from "@/features/agents/AgentIconPicker";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { timeAgo } from "@/lib/timeAgo";
import { formatDateTime } from "@/lib/utils";
import type { TaskPropertiesController } from "./-TaskProperties";
import { TaskPropertiesSection, TaskPropertyRow } from "./-TaskPropertyPrimitives";

function TaskTimestamp({ value }: { value: Date | string }) {
  const dateTime = typeof value === "string" ? value : value.toISOString();

  return (
    <time
      dateTime={dateTime}
      title={formatDateTime(value)}
      className="min-w-0 pt-1.5 font-mono text-xs text-foreground"
    >
      {timeAgo(value)}
    </time>
  );
}

function OriginatingActorValue(props: TaskPropertiesController) {
  if (!props.originatingActor) return null;
  const { companyId } = props;

  if (props.originatingActor.kind === "agent" && props.originatingAgent) {
    return (
      <Button asChild variant="ghost" size="sm" className="h-auto min-w-0 justify-start px-2">
        <Link
          to="/$companyId/agents/$agentId"
          params={{ companyId, agentId: props.originatingAgent.id }}
          aria-label={`Open ${props.originatingAgent.name} agent`}
        >
          <Avatar className="size-5">
            <AvatarFallback>{props.originatingAgent.name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="truncate">{props.originatingAgent.name}</span>
        </Link>
      </Button>
    );
  }

  if (props.originatingActor.kind === "agent") {
    const name = props.agentName(props.originatingActor.id) ?? props.originatingActor.id;
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 pt-1.5 text-sm">
        <Avatar className="size-5">
          <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="truncate">{name}</span>
      </span>
    );
  }

  const userLabel =
    props.actualUserLabel(props.originatingActor.id) ?? props.originatingUserProfile?.label ?? "User";
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5 pt-1.5 text-sm">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Avatar className="size-5">
          {props.originatingUserProfile?.image ? (
            <AvatarImage src={props.originatingUserProfile.image} alt={userLabel} />
          ) : null}
          <AvatarFallback>{userLabel.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="truncate">{userLabel}</span>
      </span>
      {props.originatingViaAgentName ? (
        <span className="shrink-0 text-xs text-muted-foreground">via {props.originatingViaAgentName}</span>
      ) : null}
    </span>
  );
}

export function TaskPropertiesAbout(props: TaskPropertiesController) {
  const { task } = props;

  return (
    <TaskPropertiesSection value="about" title="About" description="Origin and timestamps" icon={Info}>
      <FieldGroup className="gap-0">
        {props.originatingActor ? (
          <TaskPropertyRow label="Originating">
            <OriginatingActorValue {...props} />
          </TaskPropertyRow>
        ) : null}
        {task.startedAt ? (
          <TaskPropertyRow label="Started">
            <TaskTimestamp value={task.startedAt} />
          </TaskPropertyRow>
        ) : null}
        {task.completedAt ? (
          <TaskPropertyRow label="Completed">
            <TaskTimestamp value={task.completedAt} />
          </TaskPropertyRow>
        ) : null}
        <TaskPropertyRow label="Created">
          <TaskTimestamp value={task.createdAt} />
        </TaskPropertyRow>
        <TaskPropertyRow label="Updated">
          <TaskTimestamp value={task.updatedAt} />
        </TaskPropertyRow>
        {task.archivedAt && task.archivedByActorType === "agent" && task.archivedByAgentId
          ? (() => {
              const archivedByAgent = (props.agents ?? []).find(
                (candidate) => candidate.id === task.archivedByAgentId,
              );
              const archivedByName = props.agentName(task.archivedByAgentId) ?? task.archivedByAgentId;
              return (
                <TaskPropertyRow label="Archived" contentClassName="items-start">
                  <div className="flex min-w-0 max-w-full flex-col items-start gap-1.5 pt-1.5">
                    <span
                      className="flex min-w-0 max-w-full items-center gap-1.5 text-sm"
                      title={`Archived by ${archivedByName} · ${formatDateTime(task.archivedAt)}`}
                    >
                      {archivedByAgent ? (
                        <AgentIcon
                          icon={archivedByAgent.icon}
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      ) : null}
                      <span className="min-w-0 truncate">{archivedByName}</span>
                    </span>
                    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                      <time
                        dateTime={
                          typeof task.archivedAt === "string"
                            ? task.archivedAt
                            : task.archivedAt.toISOString()
                        }
                        className="font-mono text-xs text-muted-foreground"
                      >
                        {timeAgo(task.archivedAt)}
                      </time>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => props.unarchiveFromInbox.mutate()}
                        disabled={props.unarchiveFromInbox.isPending}
                      >
                        <ArchiveRestore  data-icon="inline-start"/>
                        {props.unarchiveFromInbox.isPending ? "Unarchiving…" : "Unarchive"}
                      </Button>
                    </div>
                    {props.state.unarchiveErrorMessage ? (
                      <p className="text-xs text-destructive" role="alert">
                        {props.state.unarchiveErrorMessage}
                      </p>
                    ) : null}
                  </div>
                </TaskPropertyRow>
              );
            })()
          : null}
        {task.requestDepth > 0 ? (
          <TaskPropertyRow label="Depth">
            <span className="pt-1.5 font-mono text-xs">{task.requestDepth}</span>
          </TaskPropertyRow>
        ) : null}
      </FieldGroup>
    </TaskPropertiesSection>
  );
}
