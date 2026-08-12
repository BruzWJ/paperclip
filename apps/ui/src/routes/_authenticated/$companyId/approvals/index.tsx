import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useQuery } from "@tanstack/react-query";
import { approvalsApi } from "@/api/approvals";
import { agentsApi } from "@/api/agents";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { ShieldCheck } from "lucide-react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { useApprovalMutations } from "@/hooks/useApprovalMutations";

export const Route = createFileRoute("/_authenticated/$companyId/approvals/")({
  component: PendingApprovalsIndexRoute,
});

function PendingApprovalsIndexRoute() {
  return <Approvals statusFilter="pending" />;
}

type StatusFilter = "pending" | "all";

export function Approvals({ statusFilter }: { statusFilter: StatusFilter }) {
  const companyId = useCompanyRouteId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Approvals" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.approvals.list(companyId),
    queryFn: () => approvalsApi.list(companyId),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const { approveMutation, rejectMutation } = useApprovalMutations(
    companyId,
    setActionError,
  );

  const filtered = (data ?? [])
    .filter(
      (a) =>
        statusFilter === "all" ||
        a.status === "pending" ||
        a.status === "revision_requested",
    )
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

  const pendingCount = (data ?? []).filter(
    (a) => a.status === "pending" || a.status === "revision_requested",
  ).length;
  const pendingActionStatus = approveMutation.isPending
    ? "Approving request…"
    : rejectMutation.isPending
      ? "Rejecting request…"
      : null;

  if (isLoading) {
    return (
      <div role="status">
        <span className="sr-only">Loading approvals…</span>
        <PageSkeleton variant="approvals" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Tabs
          value={statusFilter}
          onValueChange={(value) => {
            if (value === "pending") {
              void navigate({
                to: "/$companyId/approvals",
                params: { companyId },
              });
            } else if (value === "all") {
              void navigate({
                to: "/$companyId/approvals/all",
                params: { companyId },
              });
            }
          }}
        >
          <PageTabBar
            items={[
              {
                value: "pending",
                label: (
                  <>
                    Pending
                    {pendingCount > 0 && (
                      <Badge
                        variant="ghost"
                        className={cn(
                          "ml-1.5 px-1.5 text-(length:--text-nano)",
                          "bg-yellow-500/20 text-yellow-500",
                        )}
                      >
                        {pendingCount}
                      </Badge>
                    )}
                  </>
                ),
              },
              { value: "all", label: "All" },
            ]}
          />
        </Tabs>
      </div>

      {pendingActionStatus ? (
        <p role="status" className="sr-only">
          {pendingActionStatus}
        </p>
      ) : null}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}

      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ShieldCheck className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {statusFilter === "pending"
              ? "No pending approvals."
              : "No approvals yet."}
          </p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="grid gap-3">
          {filtered.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              requesterAgent={
                approval.requestedByAgentId
                  ? ((agents ?? []).find(
                      (a) => a.id === approval.requestedByAgentId,
                    ) ?? null)
                  : null
              }
              onApprove={() => approveMutation.mutate(approval.id)}
              onReject={() => rejectMutation.mutate(approval.id)}
              linkToDetails
              isPending={approveMutation.isPending || rejectMutation.isPending}
              pendingAction={
                approveMutation.isPending
                  ? "approve"
                  : rejectMutation.isPending
                    ? "reject"
                    : null
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
