import { isCanonicalUuid } from "@paperclipai/shared";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { assertOnlySearchKeys, exactSearchString } from "../../-search";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { accessApi } from "@/api/access";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import type { ReactNode } from "react";

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
    () => `/cli-auth/${encodeURIComponent(challengeId)}?token=${encodeURIComponent(token)}`,
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
        className="mx-auto flex max-w-xl items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner /> Loading access challenge...
      </div>
    );
  }

  const challenge = challengeQuery.data;
  let cardTitle: ReactNode;
  let cardDescription: ReactNode;
  let cardContent: ReactNode;

  if (challengeQuery.error) {
    cardTitle = "Access challenge unavailable";
    cardContent = (
      <Alert variant="destructive">
        <AlertDescription>
          {challengeQuery.error instanceof Error
            ? challengeQuery.error.message
            : "Challenge is invalid or expired."}
        </AlertDescription>
      </Alert>
    );
  } else if (!challenge) {
    cardTitle = "Access challenge unavailable";
    cardContent = (
      <Alert variant="destructive">
        <AlertDescription>Access challenge unavailable.</AlertDescription>
      </Alert>
    );
  } else {
    const clientName = challenge.clientName ?? "Paperclip CLI";
    if (challenge.status === "approved") {
      cardTitle = "Access approved";
      cardDescription = `${clientName} can now finish authentication on the requesting machine.`;
      cardContent = (
        <p className="text-sm text-muted-foreground">
          Command: <span className="font-mono text-foreground">{challenge.command}</span>
        </p>
      );
    } else if (challenge.status === "cancelled" || challenge.status === "expired") {
      cardTitle = challenge.status === "expired" ? "Access challenge expired" : "Access challenge cancelled";
      cardDescription = "Start the access flow again from your terminal to generate a new approval request.";
    } else if (challenge.requiresSignIn || !sessionQuery.data) {
      cardTitle = "Sign in required";
      cardDescription =
        "Sign in or create an account, then return to this page to approve the access request.";
      cardContent = (
        <Button asChild>
          <Link to="/auth" search={{ next: currentPath }}>
            Sign in / Create account
          </Link>
        </Button>
      );
    } else {
      cardTitle = `Approve ${clientName} access`;
      cardDescription = `A local ${clientName} process is requesting board access to this instance.`;
      cardContent = (
        <>
          <ItemGroup>
            <Item variant="outline">
              <ItemContent>
                <ItemTitle>Command</ItemTitle>
                <ItemDescription className="font-mono">{challenge.command}</ItemDescription>
              </ItemContent>
            </Item>
            <Item variant="outline">
              <ItemContent>
                <ItemTitle>Client</ItemTitle>
                <ItemDescription>{clientName}</ItemDescription>
              </ItemContent>
            </Item>
            <Item variant="outline">
              <ItemContent>
                <ItemTitle>Requested access</ItemTitle>
                <ItemDescription>
                  {challenge.requestedAccess === "instance_admin_required" ? "Instance admin" : "Board"}
                </ItemDescription>
              </ItemContent>
            </Item>
            {challenge.requestedCompanyName && (
              <Item variant="outline">
                <ItemContent>
                  <ItemTitle>Requested company</ItemTitle>
                  <ItemDescription>{challenge.requestedCompanyName}</ItemDescription>
                </ItemContent>
              </Item>
            )}
          </ItemGroup>

          {approveMutation.isPending ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Approving CLI access…
            </div>
          ) : cancelMutation.isPending ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Cancelling CLI access request…
            </div>
          ) : null}

          {(approveMutation.error || cancelMutation.error) && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>
                {(approveMutation.error ?? cancelMutation.error) instanceof Error
                  ? ((approveMutation.error ?? cancelMutation.error) as Error).message
                  : "Failed to update CLI auth challenge"}
              </AlertDescription>
            </Alert>
          )}

          {!challenge.canApprove && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>
                This challenge requires instance-admin access. Sign in with an instance admin account to
                approve it.
              </AlertDescription>
            </Alert>
          )}

          <div className="mt-5 flex gap-3">
            <Button
              onClick={() => approveMutation.mutate()}
              disabled={!challenge.canApprove || approveMutation.isPending || cancelMutation.isPending}
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
        </>
      );
    }
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card>
        <CardHeader>
          <CardTitle>{cardTitle}</CardTitle>
          {cardDescription ? <CardDescription>{cardDescription}</CardDescription> : null}
        </CardHeader>
        {cardContent ? <CardContent>{cardContent}</CardContent> : null}
      </Card>
    </div>
  );
}
