import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useQuery } from "@tanstack/react-query";
import { approvalsApi } from "@/api/approvals";
import { agentsApi } from "@/api/agents";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ShieldCheck } from "lucide-react";
import { ApprovalCard } from "@/routes/_authenticated/$companyId/approvals/-ApprovalCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
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

  const { approveMutation, rejectMutation, isPending: mutationPending } = useApprovalMutations(companyId);

  const filtered = (data ?? [])
    .filter((a) => statusFilter === "all" || a.status === "pending" || a.status === "revision_requested")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const pendingCount = (data ?? []).filter(
    (a) => a.status === "pending" || a.status === "revision_requested",
  ).length;
  const pendingActionStatus = mutationPending
    ? approveMutation.isPending
      ? "Approving request…"
      : "Rejecting request…"
    : null;

  if (isLoading) {
    return (
      <div role="status">
        <span className="sr-only">Loading approvals…</span>
        <Skeleton className="h-32 w-full" />
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
          <TabsList variant="line">
            <TabsTrigger value="pending">
              Pending
              {pendingCount > 0 ? (
                <Badge variant="ghost" className="ml-1.5 px-1.5 text-(length:--text-nano)">
                  {pendingCount}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {pendingActionStatus ? (
        <p role="status" className="sr-only">
          {pendingActionStatus}
        </p>
      ) : null}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {filtered.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldCheck  data-icon="inline-start"/>
            </EmptyMedia>
            <EmptyTitle>
              {statusFilter === "pending" ? "No pending approvals" : "No approvals yet"}
            </EmptyTitle>
            <EmptyDescription>
              {statusFilter === "pending"
                ? "New approval requests will appear here."
                : "Approval history will appear here."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {filtered.length > 0 && (
        <div className="grid gap-3">
          {filtered.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              requesterAgent={
                approval.requestedByAgentId
                  ? ((agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null)
                  : null
              }
              onApprove={() => approveMutation.mutate(approval.id)}
              onReject={() => rejectMutation.mutate(approval.id)}
              linkToDetails
              isPending={approveMutation.isPending || rejectMutation.isPending}
              pendingAction={
                approveMutation.isPending ? "approve" : rejectMutation.isPending ? "reject" : null
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
