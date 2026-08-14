import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { toast } from "sonner";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Copy, ExternalLink, MailPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  formatInviteAudience,
  formatInviteState,
  INVITE_HISTORY_PAGE_SIZE,
  inviteRoleOptions,
  isInviteHistoryRow,
} from "./-invite-presentation";

export const Route = createFileRoute("/_authenticated/$companyId/company/settings/invites/")({
  component: CompanyInvites,
});

function CompanyInvites() {
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
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
        label: "Settings",
        renderLink: (content) => (
          <Link to="/$companyId/company/settings" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      { label: "Invites" },
    ]);
  }, [companyId, selectedCompany?.name, setBreadcrumbs]);

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
            <RadioGroup
              value={userRole}
              onValueChange={(value) => setUserRole(value as "owner" | "admin" | "operator" | "viewer")}
            >
              {inviteRoleOptions.map((option) => (
                <FieldLabel key={option.value} htmlFor={`invite-role-${option.value}`}>
                  <Field orientation="horizontal">
                    <RadioGroupItem id={`invite-role-${option.value}`} value={option.value} />
                    <FieldContent>
                      <FieldTitle>
                        {option.label}
                        {option.value === "operator" ? <Badge variant="outline">Default</Badge> : null}
                      </FieldTitle>
                      <FieldDescription>{option.description}</FieldDescription>
                    </FieldContent>
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
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
                    <Badge variant="secondary" role="status">
                      <Check />
                      Copied
                    </Badge>
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>State</TableHead>
                    <TableHead>For</TableHead>
                    <TableHead>Invited by</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Join request</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inviteHistory.map((invite) => (
                    <TableRow key={invite.id}>
                      <TableCell>
                        <Badge variant="outline">{formatInviteState(invite.state)}</Badge>
                      </TableCell>
                      <TableCell>{formatInviteAudience(invite)}</TableCell>
                      <TableCell>
                        <div>
                          {invite.invitedByUser?.name || invite.invitedByUser?.email || "Unknown inviter"}
                        </div>
                        {invite.invitedByUser?.email && invite.invitedByUser.name ? (
                          <div className="text-xs text-muted-foreground">{invite.invitedByUser.email}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(invite.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {invite.relatedJoinRequestId ? (
                          <Link
                            to="/$companyId/inbox/requests"
                            params={{ companyId }}
                            className="underline underline-offset-4"
                          >
                            Review request
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {invite.state === "active" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => revokeMutation.mutate(invite.id)}
                            disabled={revokeMutation.isPending}
                          >
                            Revoke
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">Inactive</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
