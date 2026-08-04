import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "../components/StatusIcon";

import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate } from "../lib/utils";
import { ListTodo } from "lucide-react";
import { issueDisplayTitle } from "../lib/issue-display";

export function MyIssues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "My Tasks" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  if (!selectedCompanyId) {
    return <EmptyState icon={ListTodo} message="Select a company to view your tasks." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  // User ownership is exceptional and only appears for the named creator's
  // withdrawal/escalation path.
  const myIssues = (issues ?? []).filter(
    (issue) =>
      Boolean(currentUserId)
      && issue.ownerKind === "user"
      && issue.ownerUserId === currentUserId
      && !["done", "cancelled"].includes(issue.lifecycleStatus),
  );

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {myIssues.length === 0 && (
        <EmptyState icon={ListTodo} message="No tasks owned by you." />
      )}

      {myIssues.length > 0 && (
        <div className="border border-border">
          {myIssues.map((issue) => (
            <EntityRow
              key={issue.id}
              identifier={issue.identifier ?? issue.id.slice(0, 8)}
              title={issueDisplayTitle(issue)}
              to={`/issues/${issue.identifier ?? issue.id}`}
              leading={
                <StatusIcon status={issue.boardPresentationStatus} blockerAttention={issue.blockerAttention} />
              }
              trailing={
                <span className="text-xs text-muted-foreground">
                  {formatDate(issue.createdAt)}
                </span>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
