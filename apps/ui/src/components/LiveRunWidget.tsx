import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type {
  TaskExecutionRunEnvelopeRecord,
  TaskExecutionRunListPageRecord,
} from "@paperclipai/shared";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "../api/runs";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime } from "../lib/utils";
import { ExternalLink } from "lucide-react";
import { StatusBadge } from "./StatusBadge";

interface LiveRunWidgetProps {
  taskId: string;
  companyId: string;
}

export function LiveRunWidget({ taskId, companyId }: LiveRunWidgetProps) {
  const status = ACTIVE_TASK_EXECUTION_RUN_STATUSES;
  const { data: runPage } = useQuery<TaskExecutionRunListPageRecord>({
    queryKey: queryKeys.tasks.runs(taskId, status),
    queryFn: () => runsApi.listForTask(taskId, { status, limit: 200 }),
    enabled: Boolean(taskId),
  });
  const runs = useMemo(
    () =>
      [...(runPage?.items ?? [])].sort(
        (left, right) =>
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime(),
      ),
    [runPage?.items],
  );
  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? ""),
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId),
  });
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  if (runs.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-blue-500/25 bg-background/80 shadow-(--shadow-extract-11)">
      <div className="border-b border-border/60 bg-blue-500/[0.04] px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-(--tracking-caps) text-blue-700 dark:text-blue-300">
          Active runs
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Canonical task sessions currently executing for this task.
        </div>
      </div>
      <div className="divide-y divide-border/60">
        {runs.map((run: TaskExecutionRunEnvelopeRecord) => {
          const agentRef = agentById.get(run.targetAgentId)?.id ?? null;
          return (
            <section key={run.id} className="space-y-3 px-4 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={run.status} />
                <span className="font-mono text-xs text-muted-foreground">
                  {run.id.slice(0, 8)}
                </span>
                <span className="text-xs capitalize text-muted-foreground">
                  {run.kind}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatDateTime(run.startedAt ?? run.createdAt)}
                </span>
              </div>
              <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                <span>
                  Session{" "}
                  <span className="font-mono">{run.sessionId.slice(0, 8)}</span>
                </span>
                <span>Ownership epoch {run.ownershipEpoch}</span>
              </div>
              {agentRef ? (
                <Link
                  to="/$companyId/agents/$agentId/runs/$runId"
                  params={{ companyId, agentId: agentRef, runId: run.id }}
                  className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-(length:--text-micro) font-medium text-blue-700 transition-colors hover:border-blue-500/30 hover:text-blue-600 dark:text-blue-300"
                >
                  Open run
                  <ExternalLink className="h-3 w-3" />
                </Link>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
