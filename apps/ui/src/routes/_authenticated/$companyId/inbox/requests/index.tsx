import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus2 } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { JoinRequestApprovalControls } from "@/components/JoinRequestApprovalControls";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";

export const Route = createFileRoute(
  "/_authenticated/$companyId/inbox/requests/",
)({ component: JoinRequestQueue });

function JoinRequestQueue() {
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<
    "pending_approval" | "approved" | "rejected"
  >("pending_approval");

  useEffect(() => {
    setBreadcrumbs([
      {
        label: selectedCompany?.name ?? "Company",
        renderLink: (content) => (
          <Link to="/$companyId/dashboard" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      {
        label: "Inbox",
        renderLink: (content) => (
          <Link to="/$companyId/inbox" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      { label: "Join Requests" },
    ]);
  }, [companyId, selectedCompany?.name, setBreadcrumbs]);

  const requestsQuery = useQuery({
    queryKey: queryKeys.access.joinRequests(companyId, status),
    queryFn: () => accessApi.listJoinRequests(companyId, status),
  });

  const approveMutation = useMutation({
    mutationFn: (requestId: string) =>
      accessApi.approveJoinRequest(companyId, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.access.joinRequests(companyId, status),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.access.companyMembers(companyId),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.access.companyUserDirectory(companyId),
      });
      pushToast({ title: "Join request approved", tone: "success" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) =>
      accessApi.rejectJoinRequest(companyId, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.access.joinRequests(companyId, status),
      });
      pushToast({ title: "Join request rejected", tone: "success" });
    },
  });

  if (requestsQuery.isLoading) {
    return (
      <div className="text-sm text-muted-foreground" role="status">
        Loading join requests…
      </div>
    );
  }

  if (requestsQuery.error) {
    const message =
      requestsQuery.error instanceof ApiError &&
      requestsQuery.error.status === 403
        ? "You do not have permission to review join requests for this company."
        : requestsQuery.error instanceof Error
          ? requestsQuery.error.message
          : "Failed to load join requests.";
    return (
      <div className="text-sm text-destructive" role="alert">
        {message}
      </div>
    );
  }

  const isPending = approveMutation.isPending || rejectMutation.isPending;
  const requestStatus = approveMutation.isPending
    ? "Approving join request…"
    : rejectMutation.isPending
      ? "Rejecting join request…"
      : requestsQuery.isFetching
        ? "Updating join request list…"
        : null;

  return (
    <div className="max-w-6xl space-y-6" aria-busy={isPending}>
      {isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          {requestStatus}
        </p>
      ) : null}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <UserPlus2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Join Request Queue</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Review user join requests outside the mixed inbox feed. This queue
          uses the same approval mutations as the inline inbox cards.
        </p>
      </div>

      <Card className="flex-row flex-wrap gap-3 p-4">
        <label className="space-y-2 text-sm">
          <span className="font-medium">Status</span>
          <Select
            value={status}
            onValueChange={(v) =>
              setStatus(v as "pending_approval" | "approved" | "rejected")
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending_approval">Pending approval</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </Card>

      <div className="space-y-4">
        {(requestsQuery.data ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
            No join requests match the current filters.
          </div>
        ) : (
          requestsQuery.data!.map((request) => (
            <Card key={request.id} className="block p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        request.status === "pending_approval"
                          ? "secondary"
                          : request.status === "approved"
                            ? "outline"
                            : "destructive"
                      }
                    >
                      {request.status.replace("_", " ")}
                    </Badge>
                  </div>
                  <div>
                    <div className="text-base font-medium">
                      {request.requesterUser?.name ||
                        request.requestEmailSnapshot ||
                        request.requestingUserId ||
                        "Unknown user requester"}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {request.requesterUser?.email ||
                        request.requestEmailSnapshot ||
                        request.requestingUserId}
                    </div>
                  </div>
                </div>

                {request.status === "pending_approval" ? (
                  <fieldset
                    aria-label="Join request approval actions"
                    className="contents"
                    disabled={isPending}
                  >
                    <JoinRequestApprovalControls
                      onApprove={() => approveMutation.mutate(request.id)}
                      onReject={() => rejectMutation.mutate(request.id)}
                      isPending={isPending}
                      className="flex max-w-sm flex-wrap items-end justify-end gap-2"
                    />
                  </fieldset>
                ) : null}
              </div>

              <div className="mt-4 grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">
                    Invite context
                  </div>
                  <div className="mt-2">
                    {request.invite
                      ? `User invite${request.invite.userRole ? ` • default role ${request.invite.userRole}` : ""}`
                      : "Invite metadata unavailable"}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">
                    Request details
                  </div>
                  <div className="mt-2">
                    Submitted {new Date(request.createdAt).toLocaleString()}
                  </div>
                  <div>Source IP {request.requestIp}</div>
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
