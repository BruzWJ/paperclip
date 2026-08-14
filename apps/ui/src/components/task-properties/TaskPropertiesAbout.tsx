import { Link } from "@tanstack/react-router";
import { ArchiveRestore } from "lucide-react";
import { AgentIcon } from "../AgentIconPicker";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldGroup, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { formatDateTime } from "../../lib/utils";
import { timeAgo } from "../../lib/timeAgo";
import type { TaskPropertiesController } from "./TaskProperties";

export function TaskPropertiesAbout(props: TaskPropertiesController) {
  const { task, companyId } = props;
  return (
    <FieldSet>
      <FieldLegend variant="label">About</FieldLegend>
      <FieldGroup>
        {props.originatingActor ? (
          <Field orientation="horizontal" data-property-row="true">
            <FieldTitle data-property-label="Originating" title="Originating">
              Originating
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row items-center">
              {props.originatingActor.kind === "agent" && props.originatingAgent ? (
                <Link
                  to="/$companyId/agents/$agentId"
                  params={{ companyId, agentId: props.originatingAgent.id }}
                  aria-label={`Open ${props.originatingAgent.name} agent`}
                  className="hover:underline"
                >
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <Avatar className="size-5">
                      <AvatarFallback>{props.originatingAgent.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="truncate text-xs">{props.originatingAgent.name}</span>
                  </span>
                </Link>
              ) : props.originatingActor.kind === "agent" ? (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Avatar className="size-5">
                    <AvatarFallback>
                      {(props.agentName(props.originatingActor.id) ?? props.originatingActor.id)
                        .slice(0, 2)
                        .toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate text-xs">
                    {props.agentName(props.originatingActor.id) ?? props.originatingActor.id.slice(0, 8)}
                  </span>
                </span>
              ) : (
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <Avatar className="size-5">
                      {props.originatingUserProfile?.image ? (
                        <AvatarImage
                          src={props.originatingUserProfile.image}
                          alt={props.originatingUserProfile.label}
                        />
                      ) : null}
                      <AvatarFallback>
                        {(
                          props.actualUserLabel(props.originatingActor.id) ??
                          props.originatingUserProfile?.label ??
                          "User"
                        )
                          .slice(0, 2)
                          .toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate text-xs">
                      {props.actualUserLabel(props.originatingActor.id) ??
                        props.originatingUserProfile?.label ??
                        "User"}
                    </span>
                  </span>
                  {props.originatingViaAgentName ? (
                    <span className="shrink-0 truncate text-xs text-muted-foreground">
                      via {props.originatingViaAgentName}
                    </span>
                  ) : null}
                </span>
              )}
            </FieldContent>
          </Field>
        ) : null}
        {task.startedAt && (
          <Field orientation="horizontal" data-property-row="true">
            <FieldTitle data-property-label="Started" title="Started">
              Started
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row items-center">
              <span className="text-sm">{formatDateTime(task.startedAt)}</span>
            </FieldContent>
          </Field>
        )}
        {task.completedAt && (
          <Field orientation="horizontal" data-property-row="true">
            <FieldTitle data-property-label="Completed" title="Completed">
              Completed
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row items-center">
              <span className="text-sm">{formatDateTime(task.completedAt)}</span>
            </FieldContent>
          </Field>
        )}
        <Field orientation="horizontal" data-property-row="true">
          <FieldTitle data-property-label="Created" title="Created">
            Created
          </FieldTitle>
          <FieldContent className="min-w-0 flex-row items-center">
            <span className="text-sm">{formatDateTime(task.createdAt)}</span>
          </FieldContent>
        </Field>
        <Field orientation="horizontal" data-property-row="true">
          <FieldTitle data-property-label="Updated" title="Updated">
            Updated
          </FieldTitle>
          <FieldContent className="min-w-0 flex-row items-center">
            <span className="text-sm">{timeAgo(task.updatedAt)}</span>
          </FieldContent>
        </Field>
        {task.archivedAt && task.archivedByActorType === "agent" && task.archivedByAgentId
          ? (() => {
              const archivedByAgent = (props.agents ?? []).find(
                (candidate) => candidate.id === task.archivedByAgentId,
              );
              const archivedByName = props.agentName(task.archivedByAgentId);
              return (
                <Field orientation="horizontal" data-property-row="true">
                  <FieldTitle data-property-label="Archived" title="Archived">
                    Archived
                  </FieldTitle>
                  <FieldContent className="min-w-0">
                    <div className="flex min-w-0 max-w-full flex-col items-start gap-1">
                      <span
                        className="flex min-w-0 max-w-full items-center gap-1.5 text-sm"
                        title={`Archived by ${archivedByName} · ${formatDateTime(task.archivedAt)}`}
                      >
                        {archivedByAgent ? (
                          <AgentIcon
                            icon={archivedByAgent.icon}
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          />
                        ) : null}
                        <span className="min-w-0 truncate">{archivedByName}</span>
                      </span>
                      <div className="flex min-w-0 max-w-full items-center gap-2">
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {timeAgo(task.archivedAt)}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() => props.unarchiveFromInbox.mutate()}
                          disabled={props.unarchiveFromInbox.isPending}
                        >
                          <ArchiveRestore className="h-3 w-3" />
                          {props.unarchiveFromInbox.isPending ? "Unarchiving…" : "Unarchive"}
                        </Button>
                      </div>
                      {props.state.unarchiveErrorMessage ? (
                        <p className="text-xs text-destructive" role="alert">
                          {props.state.unarchiveErrorMessage}
                        </p>
                      ) : null}
                    </div>
                  </FieldContent>
                </Field>
              );
            })()
          : null}
        {task.requestDepth > 0 && (
          <Field orientation="horizontal" data-property-row="true">
            <FieldTitle data-property-label="Depth" title="Depth">
              Depth
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row items-center">
              <span className="text-sm font-mono">{task.requestDepth}</span>
            </FieldContent>
          </Field>
        )}
      </FieldGroup>
    </FieldSet>
  );
}
