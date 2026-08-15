// Empty collections render dedicated UI when data.length === 0.
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { TaskExecutionRunEnvelopeRecord, TaskExecutionRunListPageRecord } from "@paperclipai/shared";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { formatDateTime } from "@/lib/utils";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemContent, ItemDescription, ItemFooter, ItemGroup, ItemHeader } from "@/components/ui/item";
import type { TaskScope } from "@/lib/presentation-contracts";

export function LiveRunWidget({ taskId, companyId }: TaskScope) {
  const status = ACTIVE_TASK_EXECUTION_RUN_STATUSES;
  const { data: runPage } = useQuery<TaskExecutionRunListPageRecord>({
    queryKey: queryKeys.tasks.runs(taskId, status),
    queryFn: () => runsApi.listForTask(taskId, { status, limit: 200 }),
    enabled: Boolean(taskId),
  });
  const runs = useMemo(
    () =>
      [...(runPage?.items ?? [])].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      ),
    [runPage?.items],
  );
  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? ""),
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId),
  });
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  if (runs.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active runs</CardTitle>
        <CardDescription>Canonical task sessions currently executing for this task.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ItemGroup className="divide-y">
          {runs.map((run: TaskExecutionRunEnvelopeRecord) => {
            const agentRef = agentById.get(run.targetAgentId)?.id ?? null;
            return (
              <Item key={run.id} className="rounded-none border-0">
                <ItemContent className="gap-3">
                  <ItemHeader>
                    <div className="flex flex-wrap items-center gap-2">
                      <DomainStatus status={run.status} />
                      <span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
                      <span className="text-xs capitalize text-muted-foreground">{run.kind}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(run.startedAt ?? run.createdAt)}
                    </span>
                  </ItemHeader>
                  <ItemDescription className="grid line-clamp-none gap-1 sm:grid-cols-2">
                    <span>
                      Session <span className="font-mono">{run.sessionId.slice(0, 8)}</span>
                    </span>
                    <span>Ownership epoch {run.ownershipEpoch}</span>
                  </ItemDescription>
                  {agentRef ? (
                    <ItemFooter>
                      <Button variant="outline" size="sm" asChild>
                        <Link
                          to="/$companyId/agents/$agentId/runs/$runId"
                          params={{
                            companyId,
                            agentId: agentRef,
                            runId: run.id,
                          }}
                        >
                          Open run
                          <ExternalLink data-icon="inline-end" />
                        </Link>
                      </Button>
                    </ItemFooter>
                  ) : null}
                </ItemContent>
              </Item>
            );
          })}
        </ItemGroup>
      </CardContent>
    </Card>
  );
}
