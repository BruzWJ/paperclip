import { accessApi } from "@/api/access";
import { authApi } from "@/api/auth";
import { companiesListQueryOptions } from "@/api/companies-query";
import { healthApi } from "@/api/health";
import { InviteLandingForm } from "@/routes/invite/$token/-InviteLandingForm";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import * as CardUI from "@/components/ui/card";
import * as EmptyUI from "@/components/ui/empty";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { clearPendingInviteToken, rememberPendingInviteToken } from "@/lib/invite-memory";
import { queryKeys } from "@/lib/queryKeys";
import type { JoinRequest } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  formatUserRole,
  getAuthErrorCode,
  isApprovedUserJoinPayload,
  isBootstrapAcceptancePayload,
  mapInviteAuthFeedback,
  type AuthFeedback,
  type AuthMode,
} from "./-invite-auth";

export const Route = createFileRoute("/invite/$token/")({
  component: InviteLandingPage,
});

type AwaitingJoinApprovalPanelProps = {
  companyDisplayName: string;
  companyLogoUrl: string | null;
  invitedByUserName: string | null;
};

function InviteLoading({ children }: { children: string }) {
  return (
    <EmptyUI.Empty>
      <EmptyUI.EmptyHeader>
        <EmptyUI.EmptyMedia variant="icon">
          <Spinner />
        </EmptyUI.EmptyMedia>
        <EmptyUI.EmptyTitle>{children}</EmptyUI.EmptyTitle>
        <EmptyUI.EmptyDescription>Please wait a moment.</EmptyUI.EmptyDescription>
      </EmptyUI.EmptyHeader>
    </EmptyUI.Empty>
  );
}

function InviteUnavailable({ children }: { children: string }) {
  return (
    <Alert variant="destructive" data-testid="invite-error">
      <AlertTitle>Invite not available</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function AwaitingJoinApprovalPanel({
  companyDisplayName,
  companyLogoUrl,
  invitedByUserName,
}: AwaitingJoinApprovalPanelProps) {
  const approverLabel = invitedByUserName ?? "A company admin";

  return (
    <CardUI.Card data-testid="invite-pending-approval">
      <CardUI.CardHeader className="flex-row items-center">
        <Avatar>
          <AvatarImage src={companyLogoUrl ?? undefined} alt={`${companyDisplayName} logo`} />
          <AvatarFallback>{companyDisplayName.trim().charAt(0).toUpperCase() || "?"}</AvatarFallback>
        </Avatar>
        <CardUI.CardTitle>Request to join {companyDisplayName}</CardUI.CardTitle>
      </CardUI.CardHeader>
      <CardUI.CardContent className="space-y-4">
        <CardUI.CardDescription>
          Your request is still awaiting approval. {approverLabel} must approve your request to join.
        </CardUI.CardDescription>
        <Item variant="outline">
          <ItemContent>
            <ItemDescription>Approval page</ItemDescription>
            <ItemTitle>Company Settings → Members</ItemTitle>
          </ItemContent>
        </Item>
        <CardUI.CardDescription>
          Ask them to visit <span className="font-medium text-foreground">Company Settings → Members</span> to
          approve your request.
        </CardUI.CardDescription>
        <CardUI.CardDescription>
          Refresh this page after you've been approved — you'll be redirected automatically.
        </CardUI.CardDescription>
      </CardUI.CardContent>
    </CardUI.Card>
  );
}

function InviteLandingPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">
        <InviteLandingContent />
      </div>
    </main>
  );
}

function InviteLandingContent() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ from: "/invite/$token/" });
  const token = params.token ?? "";
  const hasToken = /\S/.test(token);
  const [authMode, setAuthMode] = useState<AuthMode>("sign_up");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<{
    kind: "bootstrap" | "join";
    payload: unknown;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authFeedback, setAuthFeedback] = useState<AuthFeedback | null>(null);
  const [autoAcceptStarted, setAutoAcceptStarted] = useState(false);
  const authErrorId = "invite-auth-error";

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const inviteQuery = useQuery({
    queryKey: queryKeys.access.invite(token),
    queryFn: () => accessApi.getInvite(token),
    enabled: hasToken,
    retry: false,
  });

  const companiesQuery = useQuery({
    ...companiesListQueryOptions,
    enabled: !!sessionQuery.data && !!inviteQuery.data?.companyId,
  });
  const companyList = companiesQuery.data?.companies ?? [];

  useEffect(() => {
    if (hasToken) rememberPendingInviteToken(token);
  }, [hasToken, token]);

  useEffect(() => {
    setAutoAcceptStarted(false);
  }, [token]);

  useEffect(() => {
    const list = companiesQuery.data?.companies;
    if (!list || !inviteQuery.data?.companyId) return;
    if (list.some((c) => c.id === inviteQuery.data!.companyId)) {
      clearPendingInviteToken(token);
    }
  }, [companiesQuery.data, inviteQuery.data, token]);

  const invite = inviteQuery.data;
  const isCheckingExistingMembership =
    Boolean(sessionQuery.data) && Boolean(invite?.companyId) && companiesQuery.isLoading;
  const isCurrentMember =
    Boolean(invite?.companyId) && companyList.some((company) => company.id === invite?.companyId);
  const companyName = invite?.companyName?.trim() || null;
  const companyDisplayName = companyName || "this Paperclip company";
  const companyLogoUrl = invite?.companyLogoUrl?.trim() || null;
  const invitedByUserName = invite?.invitedByUserName?.trim() || null;
  const requestedUserRole = formatUserRole(invite?.userRole);
  const inviteJoinRequestStatus = invite?.joinRequestStatus ?? null;
  const canCompleteAcceptedUserInvite =
    inviteJoinRequestStatus === "pending_approval" || inviteJoinRequestStatus === "approved";
  const requiresUserAccount = !sessionQuery.data;
  const shouldAutoAcceptUserInvite =
    Boolean(sessionQuery.data) &&
    invite?.inviteType !== "bootstrap_admin" &&
    (!inviteJoinRequestStatus || canCompleteAcceptedUserInvite) &&
    !isCheckingExistingMembership &&
    !isCurrentMember &&
    !result &&
    error === null;
  const sessionLabel =
    sessionQuery.data?.user.name?.trim() || sessionQuery.data?.user.email?.trim() || "this account";

  const authCanSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (authMode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  const acceptMutation = useMutation({
    mutationFn: async () => {
      if (!invite) throw new Error("Invite not found");
      if (isCheckingExistingMembership) {
        throw new Error("Checking your company access. Try again in a moment.");
      }
      if (isCurrentMember) {
        throw new Error("This account already belongs to the company.");
      }
      return accessApi.acceptInvite(token);
    },
    onSuccess: async (payload) => {
      setError(null);
      clearPendingInviteToken(token);
      const asBootstrap = isBootstrapAcceptancePayload(payload);
      setResult({ kind: asBootstrap ? "bootstrap" : "join", payload });
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({
        queryKey: ["access", "current-board-access"],
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all,
      });
      if (invite?.companyId && isApprovedUserJoinPayload(payload)) {
        void navigate({
          to: "/$companyId/dashboard",
          params: { companyId: invite.companyId },
          replace: true,
        });
      }
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to accept invite");
    },
  });

  useEffect(() => {
    if (!shouldAutoAcceptUserInvite || autoAcceptStarted || acceptMutation.isPending) return;
    setAutoAcceptStarted(true);
    setError(null);
    acceptMutation.mutate();
  }, [acceptMutation, autoAcceptStarted, shouldAutoAcceptUserInvite]);

  const authMutation = useMutation({
    mutationFn: async () => {
      if (authMode === "sign_in") {
        await authApi.signInEmail({ email: email.trim(), password });
        return;
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
    },
    onSuccess: async () => {
      setAuthFeedback(null);
      rememberPendingInviteToken(token);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      await queryClient.invalidateQueries({
        queryKey: ["access", "current-board-access"],
      });
      const { companies: freshCompanies } = await queryClient.fetchQuery(companiesListQueryOptions);

      if (invite?.companyId && freshCompanies.some((company) => company.id === invite.companyId)) {
        clearPendingInviteToken(token);
        void navigate({
          to: "/$companyId/dashboard",
          params: { companyId: invite.companyId },
          replace: true,
        });
        return;
      }

      if (!invite || invite.inviteType !== "bootstrap_admin") {
        return;
      }

      try {
        const payload = await acceptMutation.mutateAsync();
        if (isBootstrapAcceptancePayload(payload)) {
          void navigate({ to: "/", replace: true });
        }
      } catch {
        return;
      }
    },
    onError: (err) => {
      const nextFeedback = mapInviteAuthFeedback(err, authMode, email);
      if (getAuthErrorCode(err) === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
        setAuthMode("sign_in");
        setPassword("");
      }
      setAuthFeedback(nextFeedback);
    },
  });

  const joinButtonLabel = useMemo(() => {
    if (!invite) return "Continue";
    if (isCurrentMember) return "Open company";
    if (invite.inviteType === "bootstrap_admin") return "Accept invite";
    return sessionQuery.data ? "Accept invite" : "Continue";
  }, [invite, isCurrentMember, sessionQuery.data]);

  if (!hasToken) {
    return <InviteUnavailable>Invalid invite token.</InviteUnavailable>;
  }

  if (inviteQuery.isLoading || healthQuery.isLoading || sessionQuery.isLoading) {
    return <InviteLoading>Loading invite...</InviteLoading>;
  }

  if (isCheckingExistingMembership) {
    return <InviteLoading>Checking your access...</InviteLoading>;
  }

  if (inviteQuery.error || !invite) {
    return <InviteUnavailable>This invite may be expired, revoked, or already used.</InviteUnavailable>;
  }

  if (inviteJoinRequestStatus === "approved" && isCurrentMember) {
    return <InviteLoading>Opening company...</InviteLoading>;
  }

  if (inviteJoinRequestStatus === "pending_approval" && !canCompleteAcceptedUserInvite) {
    return (
      <AwaitingJoinApprovalPanel
        companyDisplayName={companyDisplayName}
        companyLogoUrl={companyLogoUrl}
        invitedByUserName={invitedByUserName}
      />
    );
  }

  if (inviteJoinRequestStatus && !canCompleteAcceptedUserInvite) {
    return (
      <InviteUnavailable>
        {inviteJoinRequestStatus === "rejected"
          ? "This join request was not approved."
          : "This invite has already been used."}
      </InviteUnavailable>
    );
  }

  if (result?.kind === "bootstrap") {
    return (
      <CardUI.Card>
        <CardUI.CardHeader>
          <CardUI.CardTitle>Bootstrap complete</CardUI.CardTitle>
        </CardUI.CardHeader>
        <CardUI.CardFooter>
          <Button asChild>
            <Link to="/">Open board</Link>
          </Button>
        </CardUI.CardFooter>
      </CardUI.Card>
    );
  }

  if (result?.kind === "join") {
    const payload = result.payload as JoinRequest;
    const joinedNow = payload.status === "approved";

    return joinedNow ? (
      <CardUI.Card>
        <CardUI.CardHeader className="flex-row items-center">
          <Avatar>
            <AvatarImage src={companyLogoUrl ?? undefined} alt={`${companyDisplayName} logo`} />
            <AvatarFallback>{companyDisplayName.trim().charAt(0).toUpperCase() || "?"}</AvatarFallback>
          </Avatar>
          <CardUI.CardTitle>You joined the company</CardUI.CardTitle>
        </CardUI.CardHeader>
        <CardUI.CardFooter>
          <Button asChild className="w-full">
            <Link to="/">Open board</Link>
          </Button>
        </CardUI.CardFooter>
      </CardUI.Card>
    ) : (
      <AwaitingJoinApprovalPanel
        companyDisplayName={companyDisplayName}
        companyLogoUrl={companyLogoUrl}
        invitedByUserName={invitedByUserName}
      />
    );
  }

  return (
    <InviteLandingForm
      invite={invite}
      companyDisplayName={companyDisplayName}
      companyLogoUrl={companyLogoUrl}
      invitedByUserName={invitedByUserName}
      requestedUserRole={requestedUserRole}
      sessionLabel={sessionLabel}
      signedIn={Boolean(sessionQuery.data)}
      requiresUserAccount={requiresUserAccount}
      authMode={authMode}
      setAuthMode={setAuthMode}
      name={name}
      setName={setName}
      email={email}
      setEmail={setEmail}
      password={password}
      setPassword={setPassword}
      authErrorId={authErrorId}
      authFeedback={authFeedback}
      setAuthFeedback={setAuthFeedback}
      authPending={authMutation.isPending}
      authCanSubmit={authCanSubmit}
      onAuthSubmit={() => authMutation.mutate()}
      isCurrentMember={isCurrentMember}
      shouldAutoAcceptUserInvite={shouldAutoAcceptUserInvite}
      error={error}
      acceptPending={acceptMutation.isPending}
      joinButtonLabel={joinButtonLabel}
      onAccept={() => {
        if (isCurrentMember && invite.companyId) {
          clearPendingInviteToken(token);
          void navigate({
            to: "/$companyId/dashboard",
            params: { companyId: invite.companyId },
            replace: true,
          });
          return;
        }
        acceptMutation.mutate();
      }}
    />
  );
}
