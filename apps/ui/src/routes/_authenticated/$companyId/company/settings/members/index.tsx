import { accessApi, type CompanyMember } from "@/api/access";
import { ApiError } from "@/api/client";
import {
  CompanyMemberEditDialog,
  CompanyMemberRemovalDialog,
  PendingJoinRequestCard,
  type EditableMemberStatus,
} from "@/routes/_authenticated/$companyId/company/settings/members/-CompanyMemberControls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { useSettingsBreadcrumbs } from "@/hooks/useSettingsBreadcrumbs";
import { useCompany } from "@/context/CompanyContext";
import { toast } from "sonner";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { queryKeys } from "@/lib/queryKeys";
import { Spinner } from "@/components/ui/spinner";
import { USER_COMPANY_MEMBERSHIP_ROLE_LABELS } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ShieldCheck, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export const Route = createFileRoute("/_authenticated/$companyId/company/settings/members/")({
  component: CompanyAccess,
});

function CompanyAccess() {
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [draftRole, setDraftRole] = useState<CompanyMember["membershipRole"]>("operator");
  const [draftStatus, setDraftStatus] = useState<EditableMemberStatus>("active");

  useSettingsBreadcrumbs({
    companyId,
    page: "Members",
  });

  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId),
  });

  const joinRequestsQuery = useQuery({
    queryKey: queryKeys.access.joinRequests(companyId, "pending_approval"),
    queryFn: () => accessApi.listJoinRequests(companyId, "pending_approval"),
    enabled: !!membersQuery.data?.access.canApproveJoinRequests,
  });

  const refreshAccessData = async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.access.companyMembers(companyId),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.access.companyUserDirectory(companyId),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.access.joinRequests(companyId, "pending_approval"),
    });
  };

  const updateMemberMutation = useMutation({
    mutationFn: async (input: {
      memberId: string;
      membershipRole: CompanyMember["membershipRole"];
      status: EditableMemberStatus;
    }) => {
      return accessApi.updateMember(companyId, input.memberId, {
        membershipRole: input.membershipRole,
        status: input.status,
      });
    },
    onSuccess: async () => {
      setEditingMemberId(null);
      await refreshAccessData();
      toast.success("Member updated");
    },
    onError: (error) => {
      toast.error("Failed to update member", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const approveJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.approveJoinRequest(companyId, requestId),
    onSuccess: async () => {
      await refreshAccessData();
      toast.success("Join request approved");
    },
    onError: (error) => {
      toast.error("Failed to approve join request", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const rejectJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(companyId, requestId),
    onSuccess: async () => {
      await refreshAccessData();
      toast.success("Join request rejected");
    },
    onError: (error) => {
      toast.error("Failed to reject join request", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const editingMember = useMemo(
    () => membersQuery.data?.members.find((member) => member.id === editingMemberId) ?? null,
    [editingMemberId, membersQuery.data?.members],
  );
  const removingMember = useMemo(
    () => membersQuery.data?.members.find((member) => member.id === removingMemberId) ?? null,
    [removingMemberId, membersQuery.data?.members],
  );

  const archiveMemberMutation = useMutation({
    mutationFn: async (memberId: string) => accessApi.archiveMember(companyId, memberId),
    onSuccess: async () => {
      setRemovingMemberId(null);
      await refreshAccessData();
      await queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.list(companyId),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.listAssignedToMe(companyId),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.listTouchedByMe(companyId),
      });
      toast.success("Member removed");
    },
    onError: (error) => {
      toast.error("Failed to remove member", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  useEffect(() => {
    if (!editingMember) return;
    setDraftRole(editingMember.membershipRole);
    setDraftStatus(isEditableMemberStatus(editingMember.status) ? editingMember.status : "suspended");
  }, [editingMember]);

  if (membersQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading company access…
      </div>
    );
  }

  if (membersQuery.error) {
    const message =
      membersQuery.error instanceof ApiError && membersQuery.error.status === 403
        ? "You do not have permission to manage company members."
        : membersQuery.error instanceof Error
          ? membersQuery.error.message
          : "Failed to load company members.";
    return (
      <Alert variant="destructive">
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    );
  }

  const members = membersQuery.data?.members ?? [];
  const access = membersQuery.data?.access;
  const pendingUserJoinRequests = joinRequestsQuery.data ?? [];
  const joinRequestActionPending =
    approveJoinRequestMutation.isPending || rejectJoinRequestMutation.isPending;
  const pendingAccessStatus = updateMemberMutation.isPending
    ? "Saving member…"
    : archiveMemberMutation.isPending
      ? "Removing member…"
      : approveJoinRequestMutation.isPending
        ? "Approving join request…"
        : rejectJoinRequestMutation.isPending
          ? "Rejecting join request…"
          : null;
  return (
    <div className="max-w-6xl space-y-8">
      {pendingAccessStatus ? (
        <p role="status" className="sr-only">
          {pendingAccessStatus}
        </p>
      ) : null}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Company Members</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Manage the people who can work in {selectedCompany?.name}. Members can collaborate across the
          company by default.
        </p>
        <Alert>
          <AlertDescription>
            Core keeps this page focused on membership, invite approvals, and safe member removal.
          </AlertDescription>
        </Alert>
      </div>

      {access && !access.currentUserRole && (
        <Alert>
          <AlertDescription>
            This account can manage access here through instance-admin privileges, but it does not currently
            hold an active company membership.
          </AlertDescription>
        </Alert>
      )}

      <section className="space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">Humans</h2>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Manage human company memberships and status here.
          </p>
        </div>

        {access?.canApproveJoinRequests && pendingUserJoinRequests.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Pending human joins</CardTitle>
              <CardDescription>
                Review pending join requests before they become active company members.
              </CardDescription>
              <CardAction>
                <Badge variant="outline">{pendingUserJoinRequests.length} pending</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              {pendingUserJoinRequests.map((request) => (
                <PendingJoinRequestCard
                  key={request.id}
                  title={
                    request.requesterUser?.name ||
                    request.requestEmailSnapshot ||
                    request.requestingUserId ||
                    "Unknown human requester"
                  }
                  subtitle={
                    request.requesterUser?.email ||
                    request.requestEmailSnapshot ||
                    request.requestingUserId ||
                    "No email available"
                  }
                  context={
                    request.invite
                      ? `User invite${request.invite.userRole ? ` • default role ${request.invite.userRole}` : ""}`
                      : "Invite metadata unavailable"
                  }
                  detail={`Submitted ${new Date(request.createdAt).toLocaleString()}`}
                  approveLabel="Approve human"
                  rejectLabel="Reject human"
                  disabled={joinRequestActionPending}
                  onApprove={() => approveJoinRequestMutation.mutate(request.id)}
                  onReject={() => rejectJoinRequestMutation.mutate(request.id)}
                />
              ))}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>User accounts</CardTitle>
          </CardHeader>
          {members.length === 0 ? (
            <CardContent>
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No company members</EmptyTitle>
                  <EmptyDescription>No user memberships found for this company yet.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </CardContent>
          ) : (
            <CardContent>
              <ItemGroup className="gap-3">
                {members.map((member) => {
                  const removalReason = member.removal?.reason ?? null;
                  const canArchive = member.removal?.canArchive ?? true;
                  return (
                    <Item key={member.id} variant="outline">
                      <ItemContent>
                        <ItemTitle>
                          {member.user?.name?.trim() || member.user?.email || member.principalId}
                        </ItemTitle>
                        <ItemDescription>{member.user?.email || member.principalId}</ItemDescription>
                      </ItemContent>
                      <DomainStatus status={member.status}>{member.status.replace("_", " ")}</DomainStatus>
                      <ItemActions>
                        <Button size="sm" variant="outline" onClick={() => setEditingMemberId(member.id)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setRemovingMemberId(member.id)}
                          disabled={!canArchive}
                          title={removalReason ?? undefined}
                        >
                          <Trash2 data-icon="inline-start" />
                          Remove
                        </Button>
                      </ItemActions>
                      <ItemFooter>
                        <ItemDescription>
                          {USER_COMPANY_MEMBERSHIP_ROLE_LABELS[member.membershipRole]}
                          {removalReason ? ` · ${removalReason}` : ""}
                        </ItemDescription>
                      </ItemFooter>
                    </Item>
                  );
                })}
              </ItemGroup>
            </CardContent>
          )}
        </Card>
      </section>

      <CompanyMemberEditDialog
        member={editingMember}
        role={draftRole}
        status={draftStatus}
        isSaving={updateMemberMutation.isPending}
        onRoleChange={setDraftRole}
        onStatusChange={setDraftStatus}
        onClose={() => setEditingMemberId(null)}
        onSave={() => {
          if (!editingMember) return;
          updateMemberMutation.mutate({
            memberId: editingMember.id,
            membershipRole: draftRole,
            status: draftStatus,
          });
        }}
      />
      <CompanyMemberRemovalDialog
        member={removingMember}
        isRemoving={archiveMemberMutation.isPending}
        onClose={() => setRemovingMemberId(null)}
        onRemove={() => {
          if (removingMember) archiveMemberMutation.mutate(removingMember.id);
        }}
      />
    </div>
  );
}

function isEditableMemberStatus(status: CompanyMember["status"]): status is EditableMemberStatus {
  return status === "pending" || status === "active" || status === "suspended";
}
