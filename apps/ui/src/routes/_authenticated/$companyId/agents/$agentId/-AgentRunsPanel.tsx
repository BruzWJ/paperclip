import type { TaskExecutionRunJoinedDetail } from "@/api/runs";
import { AgentRunDetail } from "@/routes/_authenticated/$companyId/agents/$agentId/-run-detail/-AgentRunDetail";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { useSidebar } from "@/context/SidebarContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { queryKeys } from "@/lib/queryKeys";
import { cn, relativeTime } from "@/lib/utils";
import type { Agent, TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

function RunListItem({
  run,
  isSelected,
  agentId,
}: {
  run: TaskExecutionRunEnvelopeRecord;
  isSelected: boolean;
  agentId: string;
}) {
  const companyId = useCompanyRouteId();
  const content = (
    <ItemContent>
      <ItemTitle className="flex-wrap">
        <DomainStatus status={run.status} />
        <Badge variant="outline" className="px-1.5 text-(length:--text-nano) capitalize">
          {run.kind}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
        <span className="ml-auto shrink-0 text-(length:--text-micro) text-muted-foreground">
          {relativeTime(run.createdAt)}
        </span>
      </ItemTitle>
      <ItemDescription className="truncate">
        {run.terminalReasonCode
          ? run.terminalReasonCode.replace(/_/g, " ")
          : run.startedAt
            ? `Started ${relativeTime(run.startedAt)}`
            : "Waiting to start"}
      </ItemDescription>
    </ItemContent>
  );
  return (
    <Item
      asChild
      variant={isSelected ? "muted" : "default"}
      size="sm"
      className={cn(
        "w-full items-stretch border-b text-left text-inherit no-underline last:border-b-0",
        isSelected && "bg-accent",
      )}
    >
      <Link
        to="/$companyId/agents/$agentId/runs/$runId"
        params={{ companyId, agentId, runId: run.id }}
        aria-current={isSelected ? "page" : undefined}
      >
        {content}
      </Link>
    </Item>
  );
}

function orderedRuns(runs: readonly TaskExecutionRunEnvelopeRecord[]) {
  return [...runs].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

export function AgentRunsPanel({
  runs,
  agentRouteId,
  selectedRunId,
  agent,
}: {
  runs: TaskExecutionRunEnvelopeRecord[];
  agentRouteId: string;
  selectedRunId: string | null;
  agent: Agent;
}) {
  const { isMobile } = useSidebar();
  const companyId = useCompanyRouteId();
  const queryClient = useQueryClient();
  const cachedSelected = selectedRunId
    ? queryClient.getQueryData<TaskExecutionRunJoinedDetail>(queryKeys.runDetail(selectedRunId))
    : undefined;
  const merged = new Map(runs.map((run) => [run.id, run]));
  if (cachedSelected) merged.set(cachedSelected.run.id, cachedSelected.run);
  const sorted = orderedRuns([...merged.values()]);
  const effectiveRunId = isMobile ? selectedRunId : (selectedRunId ?? sorted[0]?.id ?? null);
  const selectedRun = sorted.find((run) => run.id === effectiveRunId);

  if (!effectiveRunId && sorted.length === 0) {
    return (
      <Empty>
        <EmptyTitle>No runs yet</EmptyTitle>
        <EmptyDescription>Agent execution history will appear here.</EmptyDescription>
      </Empty>
    );
  }

  if (isMobile && effectiveRunId) {
    return (
      <div className="min-w-0 overflow-x-hidden">
        <AgentRunDetail runId={effectiveRunId} initialRun={selectedRun} agent={agent} companyId={companyId} />
      </div>
    );
  }

  if (isMobile) {
    return (
      <nav aria-label="Agent run history">
        <ItemGroup className="overflow-x-hidden rounded-lg border">
          {sorted.map((run) => (
            <RunListItem key={run.id} run={run} isSelected={false} agentId={agentRouteId} />
          ))}
        </ItemGroup>
      </nav>
    );
  }

  return (
    <div className="flex items-start gap-4">
      <nav
        className="sticky -top-6 w-72 shrink-0 overflow-hidden rounded-lg border"
        aria-label="Agent run history"
      >
        <div className="border-b px-3 py-2">
          <p className="font-medium text-sm">Run history</p>
          <p className="text-xs text-muted-foreground">{sorted.length} recent executions</p>
        </div>
        <ItemGroup className="max-h-(--sz-70vh) overflow-y-auto">
          {sorted.map((run) => (
            <RunListItem
              key={run.id}
              run={run}
              isSelected={run.id === effectiveRunId}
              agentId={agentRouteId}
            />
          ))}
        </ItemGroup>
      </nav>
      {effectiveRunId ? (
        <section className="min-w-0 flex-1" aria-label="Selected run detail">
          <AgentRunDetail
            runId={effectiveRunId}
            initialRun={selectedRun}
            agent={agent}
            companyId={companyId}
          />
        </section>
      ) : null}
    </div>
  );
}
