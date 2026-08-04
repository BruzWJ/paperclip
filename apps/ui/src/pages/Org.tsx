import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ChevronRight, GitBranch } from "lucide-react";
import { cn } from "../lib/utils";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";

function OrgTree({
  nodes,
  depth = 0,
  hrefFn,
}: {
  nodes: OrgNode[];
  depth?: number;
  hrefFn: (id: string) => string;
}) {
  return (
    <div>
      {nodes.map((node) => (
        <OrgTreeNode key={node.id} node={node} depth={depth} hrefFn={hrefFn} />
      ))}
    </div>
  );
}

function OrgTreeNode({
  node,
  depth,
  hrefFn,
}: {
  node: OrgNode;
  depth: number;
  hrefFn: (id: string) => string;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.reports.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent/50"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="p-0.5"
            onClick={() => setExpanded((current) => !current)}
            aria-label="Toggle direct reports"
            aria-expanded={expanded}
          >
            <ChevronRight
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-4" />
        )}
        <Link
          to={hrefFn(node.id)}
          className="flex min-w-0 flex-1 items-center gap-2 no-underline text-inherit"
        >
          <span
            className={cn(
              "h-2 w-2 rounded-full shrink-0",
              // Gallery feedback r3: route through the canonical agentStatusDot
              // map (identical hues for existing keys; adds the blue running dot).
              agentStatusDot[node.status] ?? agentStatusDotDefault,
            )}
          />
          <span className="font-medium flex-1">{node.name}</span>
          {node.subtitle ? (
            <span className="text-xs text-muted-foreground">{node.subtitle}</span>
          ) : null}
          <StatusBadge status={node.status} />
        </Link>
      </div>
      {hasChildren && expanded && (
        <OrgTree nodes={node.reports} depth={depth + 1} hrefFn={hrefFn} />
      )}
    </div>
  );
}

export function Org() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={GitBranch} message="Select a company to view org chart." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && data.length === 0 && (
        <EmptyState
          icon={GitBranch}
          message="No agents in the organization. Create agents to build your org chart."
        />
      )}

      {data && data.length > 0 && (
        <div className="border border-border py-1">
          <OrgTree nodes={data} hrefFn={(id) => `/agents/${id}`} />
        </div>
      )}
    </div>
  );
}
