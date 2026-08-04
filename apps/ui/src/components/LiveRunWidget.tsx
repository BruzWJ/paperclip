import { useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type {
  IssueExecutionRunEnvelopeRecord,
  IssueExecutionRunListPageRecord,
} from "@paperclipai/shared";
import { useVisibilityRefetchInterval } from "@/lib/polling";
import {
  ACTIVE_ISSUE_EXECUTION_RUN_STATUSES,
  runsApi,
} from "../api/runs";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime } from "../lib/utils";
import { ExternalLink } from "lucide-react";
import { StatusBadge } from "./StatusBadge";

interface LiveRunWidgetProps {
  issueId: string;
  companyId?: string | null;
}

export function LiveRunWidget({ issueId }: LiveRunWidgetProps) {
  const refetchInterval = useVisibilityRefetchInterval({ visibleMs: 3000 });
  const status = ACTIVE_ISSUE_EXECUTION_RUN_STATUSES;
  const { data: runPage } = useQuery<IssueExecutionRunListPageRecord>({
    queryKey: queryKeys.issues.runs(issueId, status),
    queryFn: () => runsApi.listForIssue(issueId, { status, limit: 200 }),
    enabled: Boolean(issueId),
    refetchInterval,
  });
  const runs = useMemo(
    () => [...(runPage?.items ?? [])].sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    ),
    [runPage?.items],
  );

  if (runs.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-blue-500/25 bg-background/80 shadow-(--shadow-extract-11)">
      <div className="border-b border-border/60 bg-blue-500/[0.04] px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-(--tracking-caps) text-blue-700 dark:text-blue-300">
          Active runs
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Canonical issue sessions currently executing for this task.
        </div>
      </div>
      <div className="divide-y divide-border/60">
        {runs.map((run: IssueExecutionRunEnvelopeRecord) => (
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
              <span>Session <span className="font-mono">{run.sessionId.slice(0, 8)}</span></span>
              <span>Ownership epoch {run.ownershipEpoch}</span>
            </div>
            <Link
              to={"/agents/" + run.targetAgentId + "/runs/" + run.id}
              className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-(length:--text-micro) font-medium text-blue-700 transition-colors hover:border-blue-500/30 hover:text-blue-600 dark:text-blue-300"
            >
              Open run
              <ExternalLink className="h-3 w-3" />
            </Link>
          </section>
        ))}
      </div>
    </div>
  );
}
