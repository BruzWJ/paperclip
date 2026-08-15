import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus2 } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { FieldSet } from "@/components/ui/field";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { Spinner } from "@/components/ui/spinner";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { toast } from "sonner";
import { queryKeys } from "@/lib/queryKeys";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";

export const Route = createFileRoute("/_authenticated/$companyId/inbox/requests/")({
  component: JoinRequestQueue,
});

function JoinRequestQueue() {
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"pending_approval" | "approved" | "rejected">("pending_approval");

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

  const approveMutation =   // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  useMutation({
    mutationFn: (requestId: string) => accessApi.approveJoinRequest(companyId, requestId),
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
      toast.success("Join request approved");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(companyId, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.access.joinRequests(companyId, status),
      });
      toast.success("Join request rejected");
    },
  });

  if (requestsQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading join requests…
      </div>
    );
  }

  if (requestsQuery.error) {
    const message =
      requestsQuery.error instanceof ApiError && requestsQuery.error.status === 403
        ? "You do not have permission to review join requests for this company."
        : requestsQuery.error instanceof Error
          ? requestsQuery.error.message
          : "Failed to load join requests.";
    return (
      <Alert variant="destructive">
        <AlertDescription>{message}</AlertDescription>
      </Alert>
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
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {requestStatus ?? "Loading..."}
        </div>
      ) : null}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <UserPlus2 className="h-5 w-5 text-muted-foreground"  data-icon="inline-start"/>
          <h1 className="text-lg font-semibold">Join Request Queue</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Review user join requests outside the mixed inbox feed. This queue uses the same approval mutations
          as the inline inbox cards.
        </p>
      </div>

      <Card className="flex-row flex-wrap gap-3 p-4">
        <LabeledFormField label="Status">
          <Select
            value={status}
            onValueChange={(v) => setStatus(v as "pending_approval" | "approved" | "rejected")}
          >
            <SelectTrigger aria-label="Request filter" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending_approval">Pending approval</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </LabeledFormField>
      </Card>

      <div className="space-y-4">
        {(requestsQuery.data ?? []).length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UserPlus2  data-icon="inline-start"/>
              </EmptyMedia>
              <EmptyTitle>No matching join requests</EmptyTitle>
              <EmptyDescription>No join requests match the current filters.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          requestsQuery.data!.map((request) => (
            <Card key={request.id} className="block p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <DomainStatus status={request.status}>{request.status.replace("_", " ")}</DomainStatus>
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
                  <FieldSet
                    aria-label="Join request approval actions"
                    className="contents"
                    disabled={isPending}
                  >
                    <ButtonGroup className="max-w-sm flex-wrap justify-end">
                      <Button
                        size="sm"
                        onClick={() => approveMutation.mutate(request.id)}
                        disabled={isPending}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => rejectMutation.mutate(request.id)}
                        disabled={isPending}
                      >
                        Reject
                      </Button>
                    </ButtonGroup>
                  </FieldSet>
                ) : null}
              </div>

              <ItemGroup className="mt-4 grid gap-3 md:grid-cols-2">
                <Item variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle>Invite context</ItemTitle>
                    <ItemDescription>
                      {request.invite
                        ? `User invite${request.invite.userRole ? ` • default role ${request.invite.userRole}` : ""}`
                        : "Invite metadata unavailable"}
                    </ItemDescription>
                  </ItemContent>
                </Item>
                <Item variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle>Request details</ItemTitle>
                    <ItemDescription>
                      Submitted {new Date(request.createdAt).toLocaleString()}
                    </ItemDescription>
                    <ItemDescription>Source IP {request.requestIp}</ItemDescription>
                  </ItemContent>
                </Item>
              </ItemGroup>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
