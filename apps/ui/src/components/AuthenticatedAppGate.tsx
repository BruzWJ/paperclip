import { Link, Navigate, Outlet, useLocation } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { BOOTSTRAP_ADMIN_COMMAND } from "@/bootstrapSetup";
import { ShieldCheck, Terminal, TriangleAlert } from "lucide-react";

export function AuthenticatedAppGate() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as { bootstrapStatus?: "ready" | "bootstrap_pending" } | undefined;
      return data?.bootstrapStatus === "bootstrap_pending" ? 2000 : false;
    },
    refetchIntervalInBackground: true,
  });

  const isBootstrapPending = healthQuery.data?.bootstrapStatus === "bootstrap_pending";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const boardAccessQuery = useQuery({
    queryKey: sessionQuery.data
      ? queryKeys.access.currentBoardAccess(sessionQuery.data.user.id)
      : (["access", "current-board-access", null] as const),
    queryFn: () => accessApi.getCurrentBoardAccess(sessionQuery.data!.user.id),
    enabled: !isBootstrapPending && !!sessionQuery.data,
    retry: false,
  });
  const claimMutation = useMutation({
    mutationFn: () => accessApi.claimBootstrapAdmin(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all,
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats,
      });
      await queryClient.invalidateQueries({
        queryKey: ["access", "current-board-access"],
      });
    },
  });
  const switchAccountMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({
        queryKey: ["access", "current-board-access"],
      });
    },
  });

  if (
    healthQuery.isLoading ||
    sessionQuery.isLoading ||
    (!isBootstrapPending && !!sessionQuery.data && boardAccessQuery.isLoading)
  ) {
    return (
      <div className="mx-auto flex max-w-xl items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Spinner /> Loading...
      </div>
    );
  }

  if (healthQuery.error || boardAccessQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Alert variant="destructive">
          <AlertDescription>
            {healthQuery.error instanceof Error
              ? healthQuery.error.message
              : boardAccessQuery.error instanceof Error
                ? boardAccessQuery.error.message
                : "Failed to load app state"}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isBootstrapPending) {
    const health = healthQuery.data;
    if (!health) {
      return (
        <div className="mx-auto flex max-w-xl items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Spinner /> Loading...
        </div>
      );
    }
    const claimError =
      claimMutation.error instanceof ApiError
        ? {
            status: claimMutation.error.status,
            message: claimMutation.error.message,
          }
        : claimMutation.error instanceof Error
          ? { message: claimMutation.error.message }
          : null;
    const claimAvailable = health.deploymentExposure === "private";
    const session = sessionQuery.data;
    const errorCopy =
      claimError?.status === 409
        ? {
            title: "Someone else has already claimed this instance.",
            body: "Refresh to sign in, or ask the existing admin to invite you from Instance settings -> Access.",
          }
        : claimError?.status === 401
          ? {
              title: "Your session expired. Sign in again to claim this instance.",
              body: "",
            }
          : {
              title: "We couldn't reach the server. Try again in a moment.",
              body: "",
            };
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card>
          <CardContent>
            {claimMutation.isSuccess ? (
              <>
                <Alert>
                  <ShieldCheck aria-hidden />
                  <AlertTitle>You&apos;re the instance admin</AlertTitle>
                  <AlertDescription>
                    Setup is complete. Taking you to onboarding to create your first company...
                  </AlertDescription>
                </Alert>
                <div className="mt-5 flex items-center gap-3">
                  <Spinner className="size-4" aria-hidden />
                  <span className="text-sm text-muted-foreground">Redirecting...</span>
                </div>
                <Button asChild variant="outline" className="mt-5">
                  <Link to="/">Continue to dashboard</Link>
                </Button>
              </>
            ) : (
              <>
                <h1 className="text-xl font-semibold">
                  {claimAvailable
                    ? "Finish setting up this Paperclip"
                    : "This Paperclip is waiting on its first admin"}
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  {!claimAvailable
                    ? "This instance runs in invite-only mode. The operator must generate a one-time first-admin invite URL from the host. Once you have the link, open it from this browser to finish setup."
                    : session
                      ? "No admin has claimed this instance yet. Claim it now to become the first admin and start onboarding."
                      : "No admin has claimed this instance yet. Sign in or create your Paperclip account to become the first admin from this browser."}
                </p>
                {claimAvailable && !session ? (
                  <Button asChild className="mt-5">
                    <Link to="/auth" search={{ next: "/" }}>
                      Sign in / Create account
                    </Link>
                  </Button>
                ) : null}
                {claimAvailable && session ? (
                  <>
                    <div className="mt-5 flex flex-wrap items-center gap-3">
                      <Button onClick={() => claimMutation.mutate()} disabled={claimMutation.isPending}>
                        {claimMutation.isPending ? <Spinner /> : null}
                        {claimMutation.isPending ? "Claiming..." : "Claim this instance"}
                      </Button>
                      <span className="text-sm text-muted-foreground">
                        Signed in as{" "}
                        <span className="font-medium text-foreground">
                          {session.user.email || session.user.name || session.user.id}
                        </span>
                      </span>
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      Wrong account?{" "}
                      <Link to="/auth" search={{ next: "/" }} className="underline underline-offset-2">
                        Switch account
                      </Link>
                      .
                    </p>
                    {claimError ? (
                      <Alert variant="destructive" className="mt-4">
                        <TriangleAlert aria-hidden />
                        <AlertTitle>{errorCopy.title}</AlertTitle>
                        {errorCopy.body ? <AlertDescription>{errorCopy.body}</AlertDescription> : null}
                      </Alert>
                    ) : null}
                  </>
                ) : null}
                <div className="mt-6 border-t border-border pt-5">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Terminal className="size-4" aria-hidden />
                    <span>Prefer to finish setup from the host?</span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {health.bootstrapInviteActive
                      ? "A bootstrap invite is already active. Check your Paperclip startup logs for the first-admin URL, or run this command on the host to rotate it:"
                      : "Run this command on the host that runs Paperclip to print a one-time first-admin invite URL:"}
                  </p>
                  <pre className="mt-3 overflow-x-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
                    {BOOTSTRAP_ADMIN_COMMAND}
                  </pre>
                </div>
                {!claimAvailable ? (
                  <p className="mt-4 text-xs text-muted-foreground">
                    Browser-based claim is intentionally disabled in public mode so anyone on the network
                    can&apos;t promote themselves.
                  </p>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!sessionQuery.data) {
    const next = `${location.pathname}${location.searchStr}`;
    return <Navigate to="/auth" search={{ next }} replace />;
  }

  if (
    sessionQuery.data &&
    !boardAccessQuery.data?.isInstanceAdmin &&
    (boardAccessQuery.data?.companyIds.length ?? 0) === 0
  ) {
    const switchAccountError =
      switchAccountMutation.error instanceof Error
        ? switchAccountMutation.error.message
        : switchAccountMutation.error
          ? "Failed to switch accounts."
          : null;
    return (
      <div className="mx-auto max-w-xl py-10">
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No company access</EmptyTitle>
            <EmptyDescription>
              This account is signed in, but it does not have an active company membership or instance-admin
              access on this Paperclip instance.
            </EmptyDescription>
            <EmptyDescription>
              Use a company invite or sign in with an account that already belongs to this org.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="outline"
              onClick={() => switchAccountMutation.mutate()}
              disabled={switchAccountMutation.isPending}
            >
              {switchAccountMutation.isPending ? <Spinner /> : null}
              {switchAccountMutation.isPending ? "Signing out…" : "Switch account"}
            </Button>
            {switchAccountError ? (
              <Alert variant="destructive">
                <AlertDescription>{switchAccountError}</AlertDescription>
              </Alert>
            ) : null}
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return <Outlet />;
}
