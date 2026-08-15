import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { type RoutineRevision } from "@paperclipai/shared";
import { RotateCcw, Search } from "lucide-react";
import { relativeTime } from "@/lib/utils";
import type { NamedEntityLookup } from "@/lib/presentation-contracts";
import { MarkdownBody } from "../../../../../../features/markdown/MarkdownBody";

import {
  formatVariableDefault,
  getActorLabel,
  normalizeEnv,
  resolveAgentName,
  resolveProjectName,
  summarizeEnv,
  summarizeTriggerSnapshot,
} from "./-RoutineRevisionDiff";

export function RevisionPreview({
  revision,
  currentRevision,
  isHistorical,
  agents,
  projects,
  onCompare,
  onRestore,
  restorePending,
  highlighted,
}: {
  revision: RoutineRevision;
  currentRevision: RoutineRevision | null;
  isHistorical: boolean;
  agents: NamedEntityLookup;
  projects: NamedEntityLookup;
  onCompare: () => void;
  onRestore: () => void;
  restorePending: boolean;
  highlighted: boolean;
}) {
  const snapshot = revision.snapshot.routine;
  const triggers = revision.snapshot.triggers;
  const currentSnapshot = currentRevision?.snapshot.routine ?? null;
  const restoreLabel = "Restore this revision";
  const cardClassName = highlighted ? "ring-2 ring-ring" : undefined;

  const envSummary = summarizeEnv(snapshot.env ?? null);
  const envDiffers =
    !!currentSnapshot &&
    JSON.stringify(normalizeEnv(currentSnapshot.env ?? null)) !==
      JSON.stringify(normalizeEnv(snapshot.env ?? null));
  const fieldRows: Array<{
    key: string;
    label: string;
    value: string;
    differs: boolean;
  }> = [
    {
      key: "title",
      label: "Title",
      value: snapshot.title,
      differs: !!currentSnapshot && currentSnapshot.title !== snapshot.title,
    },
    {
      key: "priority",
      label: "Priority",
      value: snapshot.priority,
      differs: !!currentSnapshot && currentSnapshot.priority !== snapshot.priority,
    },
    {
      key: "status",
      label: "Status",
      value: snapshot.status,
      differs: !!currentSnapshot && currentSnapshot.status !== snapshot.status,
    },
    {
      key: "assigneeAgentId",
      label: "Default agent",
      value: resolveAgentName(snapshot.assigneeAgentId, agents),
      differs: !!currentSnapshot && currentSnapshot.assigneeAgentId !== snapshot.assigneeAgentId,
    },
    {
      key: "projectId",
      label: "Project",
      value: resolveProjectName(snapshot.projectId, projects),
      differs: !!currentSnapshot && currentSnapshot.projectId !== snapshot.projectId,
    },
    {
      key: "concurrencyPolicy",
      label: "Concurrency",
      value: snapshot.concurrencyPolicy.replaceAll("_", " "),
      differs: !!currentSnapshot && currentSnapshot.concurrencyPolicy !== snapshot.concurrencyPolicy,
    },
    {
      key: "catchUpPolicy",
      label: "Catch-up",
      value: snapshot.catchUpPolicy.replaceAll("_", " "),
      differs: !!currentSnapshot && currentSnapshot.catchUpPolicy !== snapshot.catchUpPolicy,
    },
    {
      key: "env",
      label: "Env",
      value: envSummary,
      differs: envDiffers,
    },
  ];

  return (
    <div className="space-y-4">
      <Card className={cardClassName}>
        <CardHeader>
          <CardTitle>rev {revision.revisionNumber}</CardTitle>
          <CardDescription>
            Saved {relativeTime(revision.createdAt)} by {getActorLabel(revision)}
            {revision.changeSummary ? ` · ${revision.changeSummary}` : ""}
          </CardDescription>
          <CardAction className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onCompare}>
              <Search data-icon="inline-start" className="mr-1.5 h-3.5 w-3.5" />
              Compare with current
            </Button>
            <Button
              size="sm"
              onClick={onRestore}
              disabled={!isHistorical || restorePending}
              aria-label={restoreLabel}
              className={!isHistorical ? "text-muted-foreground/60" : undefined}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {restoreLabel}
            </Button>
          </CardAction>
        </CardHeader>
      </Card>

      <Card className={cardClassName}>
        <CardHeader>
          <CardTitle>Structured fields</CardTitle>
        </CardHeader>
        <CardContent>
          <ItemGroup className="grid gap-2 md:grid-cols-2">
            {fieldRows.map((row) => (
              <Item key={row.key} variant="muted" size="sm">
                <ItemContent>
                  <ItemTitle>{row.label}</ItemTitle>
                  <ItemDescription>{row.value || "—"}</ItemDescription>
                </ItemContent>
                {row.differs && (
                  <ItemActions>
                    <Badge variant="secondary">differs from current</Badge>
                  </ItemActions>
                )}
              </Item>
            ))}
          </ItemGroup>
        </CardContent>
      </Card>

      <Card className={cardClassName}>
        <CardHeader>
          <CardTitle>Description</CardTitle>
        </CardHeader>
        <CardContent className="text-sm leading-7">
          {snapshot.description ? (
            <MarkdownBody>{snapshot.description}</MarkdownBody>
          ) : (
            <span className="text-muted-foreground">No description</span>
          )}
        </CardContent>
      </Card>

      <Card className={cardClassName}>
        <CardHeader>
          <CardTitle>Triggers ({triggers.length})</CardTitle>
          <CardDescription>
            Webhook secrets are not stored in revisions. If a restored webhook trigger needs re-creation,
            Paperclip mints fresh secret material at restore time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {triggers.length === 0 ? (
            <Empty className="p-4">
              <EmptyDescription>No triggers in this revision.</EmptyDescription>
            </Empty>
          ) : (
            <ItemGroup>
              {triggers.map((trigger) => (
                <Item key={trigger.id} size="sm">
                  <Badge variant="outline">{trigger.kind}</Badge>
                  <ItemContent>
                    <ItemTitle>{trigger.label ?? trigger.kind}</ItemTitle>
                    <ItemDescription>{summarizeTriggerSnapshot(trigger)}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <DomainStatus status={trigger.enabled ? "active" : "disabled"}>
                      {trigger.enabled ? "enabled" : "disabled"}
                    </DomainStatus>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>

      {snapshot.variables.length > 0 && (
        <Card className={cardClassName}>
          <CardHeader>
            <CardTitle>Variables ({snapshot.variables.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <ItemGroup>
              {snapshot.variables.map((variable) => (
                <Item key={variable.name} size="sm">
                  <ItemContent>
                    <ItemTitle className="font-mono">{variable.name}</ItemTitle>
                    <ItemDescription>default: {formatVariableDefault(variable)}</ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
