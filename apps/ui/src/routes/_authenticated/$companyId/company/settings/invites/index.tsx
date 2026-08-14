import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Choicebox,
  ChoiceboxIndicator,
  ChoiceboxItem,
  ChoiceboxItemDescription,
  ChoiceboxItemHeader,
  ChoiceboxItemTitle,
} from "@/components/kibo-ui/choicebox";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { DataTable, DataTableColumnHeader, type ColumnDef } from "@/components/patterns/DataTable";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { useSettingsBreadcrumbs } from "@/hooks/useSettingsBreadcrumbs";
import { toast } from "sonner";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Copy, ExternalLink, MailPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  formatInviteAudience,
  formatInviteState,
  INVITE_HISTORY_PAGE_SIZE,
  type InviteHistoryRow,
  inviteRoleOptions,
  isInviteHistoryRow,
} from "./-invite-presentation";

export const Route = createFileRoute("/_authenticated/$companyId/company/settings/invites/")({
  component: CompanyInvites,
});

function InviteHistoryTable({
  companyId,
  invites,
  onRevoke,
  revokePending,
}: {
  companyId: string;
  invites: InviteHistoryRow[];
  onRevoke: (inviteId: string) => void;
  revokePending: boolean;
}) {
  const columns = useMemo<ColumnDef<InviteHistoryRow>[]>(
    () => [
      {
        accessorKey: "state",
        header: ({ column }) => <DataTableColumnHeader column={column} title="State" />,
        cell: ({ row }) => (
          <DomainStatus status={row.original.state}>{formatInviteState(row.original.state)}</DomainStatus>
        ),
      },
      {
        id: "audience",
        accessorFn: (invite) => formatInviteAudience(invite),
        header: ({ column }) => <DataTableColumnHeader column={column} title="For" />,
      },
      {
        id: "inviter",
        accessorFn: (invite) =>
          invite.invitedByUser?.name || invite.invitedByUser?.email || "Unknown inviter",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Invited by" />,
        cell: ({ row }) => (
          <div>
            {row.original.invitedByUser?.name || row.original.invitedByUser?.email || "Unknown inviter"}
            {row.original.invitedByUser?.email && row.original.invitedByUser.name ? (
              <div className="text-xs text-muted-foreground">{row.original.invitedByUser.email}</div>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
        cell: ({ row }) => (
          <span className="text-muted-foreground">{new Date(row.original.createdAt).toLocaleString()}</span>
        ),
      },
      {
        accessorKey: "relatedJoinRequestId",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Join request" />,
        cell: ({ row }) =>
          row.original.relatedJoinRequestId ? (
            <Link
              to="/$companyId/inbox/requests"
              params={{ companyId }}
              className="underline underline-offset-4"
            >
              Review request
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "action",
        enableSorting: false,
        header: "Action",
        cell: ({ row }) =>
          row.original.state === "active" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRevoke(row.original.id)}
              disabled={revokePending}
            >
              Revoke
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">Inactive</span>
          ),
      },
    ],
    [companyId, onRevoke, revokePending],
  );

  return (
    <DataTable
      caption="Invite history"
      columns={columns}
      data={invites}
      getHeadClassName={(columnId) => (columnId === "action" ? "text-right" : undefined)}
      getCellClassName={(_invite, columnId) => (columnId === "action" ? "text-right" : undefined)}
    />
  );
}

function CompanyInvites() {
  const companyId = useCompanyRouteId();
  const queryClient = useQueryClient();
  const [userRole, setUserRole] = useState<"owner" | "admin" | "operator" | "viewer">("operator");
  const [latestInviteUrl, setLatestInviteUrl] = useState<string | null>(null);
  const [latestInviteCopied, setLatestInviteCopied] = useState(false);
  const latestInviteInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!latestInviteCopied) return;
    const timeout = window.setTimeout(() => {
      setLatestInviteCopied(false);
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [latestInviteCopied]);

  function selectLatestInviteUrl() {
    latestInviteInputRef.current?.focus();
    latestInviteInputRef.current?.select();
  }

  async function copyText(text: string, unavailableBody: string, onUnavailable?: () => void) {
    try {
      await copyTextToClipboard(text);
      return true;
    } catch {
      onUnavailable?.();
      toast.warning("Clipboard unavailable", { description: unavailableBody });
      return false;
    }
  }

  async function copyInviteUrl(url: string) {
    return copyText(
      url,
      "The invite URL is selected. Copy it manually from the field.",
      selectLatestInviteUrl,
    );
  }

  useSettingsBreadcrumbs({
    companyId,
    page: "Invites",
  });

  const inviteHistoryQueryKey = queryKeys.access.invites(companyId, "all", INVITE_HISTORY_PAGE_SIZE);
  const invitesQuery = useInfiniteQuery({
    queryKey: inviteHistoryQueryKey,
    queryFn: ({ pageParam }) =>
      accessApi.listInvites(companyId, {
        limit: INVITE_HISTORY_PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });
  const inviteHistory = useMemo(
    () =>
      invitesQuery.data?.pages.flatMap((page) =>
        Array.isArray(page?.invites) ? page.invites.filter(isInviteHistoryRow) : [],
      ) ?? [],
    [invitesQuery.data?.pages],
  );

  const createInviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(companyId, {
        userRole,
      }),
    onSuccess: async (invite) => {
      setLatestInviteUrl(invite.inviteUrl);
      setLatestInviteCopied(false);
      const copied = await copyText(invite.inviteUrl, "Copy the invite URL manually from the field below.");

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      toast.success("Invite created", {
        description: copied ? "Invite ready below and copied to clipboard." : "Invite ready below.",
      });
    },
    onError: (error) => {
      toast.error("Failed to create invite", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      toast.success("Invite revoked");
    },
    onError: (error) => {
      toast.error("Failed to revoke invite", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  if (invitesQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading invites…
      </div>
    );
  }

  if (invitesQuery.error) {
    const message =
      invitesQuery.error instanceof ApiError && invitesQuery.error.status === 403
        ? "You do not have permission to manage company invites."
        : invitesQuery.error instanceof Error
          ? invitesQuery.error.message
          : "Failed to load invites.";
    return (
      <Alert variant="destructive">
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    );
  }

  const inviteActionStatus = createInviteMutation.isPending
    ? "Creating invite…"
    : revokeMutation.isPending
      ? "Revoking invite…"
      : null;

  return (
    <div className="max-w-5xl space-y-8">
      {inviteActionStatus ? (
        <p className="sr-only" role="status">
          {inviteActionStatus}
        </p>
      ) : null}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <MailPlus className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Company Invites</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Invite people to request access to this company. New invite links are copied to your clipboard when
          they are generated.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invite a person</CardTitle>
          <CardDescription>
            Generate a user invite link and choose the default access it should request.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FieldSet className="space-y-3">
            <FieldLegend>Choose a role</FieldLegend>
            <Choicebox
              value={userRole}
              onValueChange={(value) => setUserRole(value as "owner" | "admin" | "operator" | "viewer")}
            >
              {inviteRoleOptions.map((option) => (
                <ChoiceboxItem key={option.value} id={`invite-role-${option.value}`} value={option.value}>
                  <ChoiceboxIndicator id={`invite-role-${option.value}`} />
                  <ChoiceboxItemHeader>
                    <ChoiceboxItemTitle>
                      {option.label}
                      {option.value === "operator" ? <Badge variant="outline">Default</Badge> : null}
                    </ChoiceboxItemTitle>
                    <ChoiceboxItemDescription>{option.description}</ChoiceboxItemDescription>
                  </ChoiceboxItemHeader>
                </ChoiceboxItem>
              ))}
            </Choicebox>
          </FieldSet>

          <Alert>
            <AlertDescription>
              Each invite link is single-use. Invitees get the selected role immediately after sign-in.
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => createInviteMutation.mutate()} disabled={createInviteMutation.isPending}>
              {createInviteMutation.isPending ? "Creating…" : "Create invite"}
            </Button>
            <span className="text-sm text-muted-foreground">Invite history below keeps the audit trail.</span>
          </div>

          {latestInviteUrl ? (
            <Card>
              <CardHeader>
                <CardTitle>Latest invite link</CardTitle>
                <CardDescription>
                  This URL includes the current Paperclip domain returned by the server.
                </CardDescription>
                {latestInviteCopied ? (
                  <CardAction>
                    <DomainStatus status="succeeded" role="status">
                      Copied
                    </DomainStatus>
                  </CardAction>
                ) : null}
              </CardHeader>
              <CardContent>
                <InputGroup>
                  <InputGroupInput
                    ref={latestInviteInputRef}
                    readOnly
                    value={latestInviteUrl}
                    onFocus={(event) => event.currentTarget.select()}
                    onClick={(event) => event.currentTarget.select()}
                    aria-label="Latest invite URL"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      onClick={async () => {
                        const copied = await copyInviteUrl(latestInviteUrl);
                        setLatestInviteCopied(copied);
                      }}
                    >
                      <Copy />
                      Copy link
                    </InputGroupButton>
                    <InputGroupButton asChild>
                      <a href={latestInviteUrl} target="_blank" rel="noreferrer">
                        <ExternalLink />
                        Open invite
                      </a>
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </CardContent>
            </Card>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invite history</CardTitle>
          <CardDescription>
            Review invite status, audience, inviter, and any linked join request.
          </CardDescription>
          <CardAction>
            <Button variant="link" asChild>
              <Link to="/$companyId/inbox/requests" params={{ companyId }}>
                Open join request queue
              </Link>
            </Button>
          </CardAction>
        </CardHeader>

        {inviteHistory.length === 0 ? (
          <CardContent>
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No invites yet</EmptyTitle>
                <EmptyDescription>No invites have been created for this company yet.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        ) : (
          <>
            <CardContent>
              <InviteHistoryTable
                companyId={companyId}
                invites={inviteHistory}
                onRevoke={revokeMutation.mutate}
                revokePending={revokeMutation.isPending}
              />
            </CardContent>
            {invitesQuery.hasNextPage ? (
              <CardFooter className="justify-center border-t">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => invitesQuery.fetchNextPage()}
                  disabled={invitesQuery.isFetchingNextPage}
                >
                  {invitesQuery.isFetchingNextPage ? "Loading more…" : "View more"}
                </Button>
              </CardFooter>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
