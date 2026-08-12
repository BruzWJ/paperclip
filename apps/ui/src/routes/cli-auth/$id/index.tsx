import { isCanonicalUuid } from "@paperclipai/shared";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { assertOnlySearchKeys, exactSearchString } from "../../-search";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { accessApi } from "@/api/access";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";

export function validateCliAuthSearch(search: Record<string, unknown>): {
  token: string;
} {
  assertOnlySearchKeys(search, ["token"]);
  return {
    token: exactSearchString(search.token, "token", {
      minLength: 16,
      maxLength: 256,
    }),
  };
}

export const Route = createFileRoute("/cli-auth/$id/")({
  validateSearch: validateCliAuthSearch,
  loader: ({ params }) => {
    if (!isCanonicalUuid(params.id)) throw notFound();
  },
  component: CliAuthPage,
});

function CliAuthPage() {
  const queryClient = useQueryClient();
  const route = getRouteApi("/cli-auth/$id/");
  const params = route.useParams();
  const search = route.useSearch();
  const challengeId = params.id;
  const token = search.token;
  const currentPath = useMemo(
    () =>
      `/cli-auth/${encodeURIComponent(challengeId)}?token=${encodeURIComponent(token)}`,
    [challengeId, token],
  );

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const challengeQuery = useQuery({
    queryKey: ["cli-auth-challenge", challengeId, token],
    queryFn: () => accessApi.getCliAuthChallenge(challengeId, token),
    retry: false,
  });

  const approveMutation = useMutation({
    mutationFn: () => accessApi.approveCliAuthChallenge(challengeId, token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await challengeQuery.refetch();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => accessApi.cancelCliAuthChallenge(challengeId, token),
    onSuccess: async () => {
      await challengeQuery.refetch();
    },
  });

  if (sessionQuery.isLoading || challengeQuery.isLoading) {
    return (
      <div
        role="status"
        className="mx-auto max-w-xl py-10 text-sm text-muted-foreground"
      >
        Loading access challenge...
      </div>
    );
  }

  if (challengeQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-lg font-semibold">
            Access challenge unavailable
          </h1>
          <p role="alert" className="mt-2 text-sm text-muted-foreground">
            {challengeQuery.error instanceof Error
              ? challengeQuery.error.message
              : "Challenge is invalid or expired."}
          </p>
        </Card>
      </div>
    );
  }

  const challenge = challengeQuery.data;
  if (!challenge) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        Access challenge unavailable.
      </div>
    );
  }

  const clientName = challenge.clientName ?? "Paperclip CLI";

  if (challenge.status === "approved") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-xl font-semibold">Access approved</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {clientName} can now finish authentication on the requesting
            machine.
          </p>
          <p className="mt-4 text-sm text-muted-foreground">
            Command:{" "}
            <span className="font-mono text-foreground">
              {challenge.command}
            </span>
          </p>
        </Card>
      </div>
    );
  }

  if (challenge.status === "cancelled" || challenge.status === "expired") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-xl font-semibold">
            {challenge.status === "expired"
              ? "Access challenge expired"
              : "Access challenge cancelled"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Start the access flow again from your terminal to generate a new
            approval request.
          </p>
        </Card>
      </div>
    );
  }

  if (challenge.requiresSignIn || !sessionQuery.data) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-xl font-semibold">Sign in required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in or create an account, then return to this page to approve
            the access request.
          </p>
          <Button asChild className="mt-4">
            <Link to="/auth" search={{ next: currentPath }}>
              Sign in / Create account
            </Link>
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">Approve {clientName} access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A local {clientName} process is requesting board access to this
          instance.
        </p>

        <div className="mt-5 space-y-3 text-sm">
          <div>
            <div className="text-muted-foreground">Command</div>
            <div className="font-mono text-foreground">{challenge.command}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Client</div>
            <div className="text-foreground">{clientName}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Requested access</div>
            <div className="text-foreground">
              {challenge.requestedAccess === "instance_admin_required"
                ? "Instance admin"
                : "Board"}
            </div>
          </div>
          {challenge.requestedCompanyName && (
            <div>
              <div className="text-muted-foreground">Requested company</div>
              <div className="text-foreground">
                {challenge.requestedCompanyName}
              </div>
            </div>
          )}
        </div>

        {approveMutation.isPending ? (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            Approving CLI access…
          </p>
        ) : cancelMutation.isPending ? (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            Cancelling CLI access request…
          </p>
        ) : null}

        {(approveMutation.error || cancelMutation.error) && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {(approveMutation.error ?? cancelMutation.error) instanceof Error
              ? ((approveMutation.error ?? cancelMutation.error) as Error)
                  .message
              : "Failed to update CLI auth challenge"}
          </p>
        )}

        {!challenge.canApprove && (
          <p className="mt-4 text-sm text-destructive">
            This challenge requires instance-admin access. Sign in with an
            instance admin account to approve it.
          </p>
        )}

        <div className="mt-5 flex gap-3">
          <Button
            onClick={() => approveMutation.mutate()}
            disabled={
              !challenge.canApprove ||
              approveMutation.isPending ||
              cancelMutation.isPending
            }
          >
            {approveMutation.isPending ? "Approving..." : "Approve access"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => cancelMutation.mutate()}
            disabled={approveMutation.isPending || cancelMutation.isPending}
          >
            {cancelMutation.isPending ? "Cancelling..." : "Cancel"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
