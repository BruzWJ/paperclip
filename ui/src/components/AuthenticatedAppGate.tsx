import { Navigate, Outlet, useLocation } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { BootstrapPendingPage } from "@/components/BootstrapPendingPage";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

function NoBoardAccessEmptyState({
  onSwitchAccount,
  switchAccountPending,
  switchAccountError,
}: {
  onSwitchAccount: () => void;
  switchAccountPending: boolean;
  switchAccountError: string | null;
}) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">No company access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This account is signed in, but it does not have an active company
          membership or instance-admin access on this Paperclip instance.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Use a company invite or sign in with an account that already belongs
          to this org.
        </p>
        <div className="mt-5">
          <Button variant="outline" onClick={onSwitchAccount} disabled={switchAccountPending}>
            {switchAccountPending ? "Signing out…" : "Switch account"}
          </Button>
        </div>
        {switchAccountError ? (
          <p className="mt-3 text-sm text-destructive" role="alert">{switchAccountError}</p>
        ) : null}
      </Card>
    </div>
  );
}

export function AuthenticatedAppGate() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as
        { bootstrapStatus?: "ready" | "bootstrap_pending" } | undefined;
      return data?.bootstrapStatus === "bootstrap_pending" ? 2000 : false;
    },
    refetchIntervalInBackground: true,
  });

  const isBootstrapPending =
    healthQuery.data?.bootstrapStatus === "bootstrap_pending";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
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
        queryKey: queryKeys.access.currentBoardAccess,
      });
    },
  });
  const switchAccountMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.access.currentBoardAccess,
      });
    },
  });

  if (
    healthQuery.isLoading ||
    sessionQuery.isLoading ||
    (!isBootstrapPending && !!sessionQuery.data && boardAccessQuery.isLoading)
  ) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (healthQuery.error || boardAccessQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error
          ? healthQuery.error.message
          : boardAccessQuery.error instanceof Error
            ? boardAccessQuery.error.message
            : "Failed to load app state"}
      </div>
    );
  }

  if (isBootstrapPending) {
    const health = healthQuery.data;
    if (!health) {
      return (
        <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
          Loading...
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
    return (
      <BootstrapPendingPage
        claimAvailable={health.deploymentExposure === "private"}
        hasActiveInvite={health.bootstrapInviteActive}
        session={sessionQuery.data}
        claimState={claimMutation.isSuccess ? "success" : "idle"}
        claimPending={claimMutation.isPending}
        claimError={claimError}
        onClaim={() => claimMutation.mutate()}
      />
    );
  }

  if (!sessionQuery.data) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  if (
    sessionQuery.data &&
    !boardAccessQuery.data?.isInstanceAdmin &&
    (boardAccessQuery.data?.companyIds.length ?? 0) === 0
  ) {
    return (
      <NoBoardAccessEmptyState
        onSwitchAccount={() => switchAccountMutation.mutate()}
        switchAccountPending={switchAccountMutation.isPending}
        switchAccountError={
          switchAccountMutation.error instanceof Error
            ? switchAccountMutation.error.message
            : switchAccountMutation.error
              ? "Failed to switch accounts."
              : null
        }
      />
    );
  }

  return <Outlet />;
}
