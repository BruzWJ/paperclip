// Empty collections render dedicated UI when data.length === 0.
import { createFileRoute } from "@tanstack/react-router";
import { assertOnlySearchKeys, optionalCanonicalInternalPathSearch } from "../-search";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { authApi, type AuthMode } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { getRememberedInviteToken } from "@/lib/invite-memory";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ThemeSelector } from "@/components/patterns/ThemeSelector";
import { LabeledFormField } from "@/components/patterns/FormPatterns";

export function validateAuthSearch(search: Record<string, unknown>): {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  next?: string;
} {
  assertOnlySearchKeys(search, ["next"]);
  return { next: optionalCanonicalInternalPathSearch(search.next, "next") };
}

export const Route = createFileRoute("/auth/")({
  validateSearch: validateAuthSearch,
  component: AuthPage,
});

function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { next } = getRouteApi("/auth/").useSearch();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const errorId = "auth-error";

  const rememberedInviteToken = useMemo(getRememberedInviteToken, []);
  const navigateAfterAuth = useCallback(() => {
    if (next) {
      void navigate({ to: next, replace: true });
      return;
    }
    if (rememberedInviteToken) {
      void navigate({
        to: "/invite/$token",
        params: { token: rememberedInviteToken },
        replace: true,
      });
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [navigate, next, rememberedInviteToken]);
  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  useEffect(() => {
    if (session) {
      navigateAfterAuth();
    }
  }, [navigateAfterAuth, session]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "sign_in") {
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
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all,
      });
      navigateAfterAuth();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });

  const canSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (mode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" role="status">
        <Spinner />
        <span className="sr-only">Loading authentication</span>
      </div>
    );
  }

  return (
    <main className="fixed inset-0 flex items-center justify-center overflow-y-auto bg-muted/30 p-6">
      <div className="absolute top-4 right-4 z-10">
        <ThemeSelector />
      </div>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardDescription>Paperclip</CardDescription>
          <CardTitle className="text-xl">
            {mode === "sign_in" ? "Sign in to Paperclip" : "Create your Paperclip account"}
          </CardTitle>
          <CardDescription>
            {mode === "sign_in"
              ? "Use your email and password to access this instance."
              : "Create an account for this instance. Email confirmation is not required in v1."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            id="auth-form"
            method="post"
            action={mode === "sign_up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email"}
            onSubmit={(event) => {
              event.preventDefault();
              if (mutation.isPending) return;
              if (!canSubmit) {
                setError("Please fill in all required fields.");
                return;
              }
              mutation.mutate();
            }}
          >
            <FieldGroup className="gap-4">
              {mode === "sign_up" && (
                <LabeledFormField data-invalid={error ? true : undefined} label="Name" labelFor="name">
                  <Input aria-label="name"
                    id="name"
                    name="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="name"
                    required
                    aria-required="true"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    autoFocus
                  />
                </LabeledFormField>
              )}
              <LabeledFormField data-invalid={error ? true : undefined} label="Email" labelFor="email">
                <Input aria-label="email"
                  id="email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                  aria-required="true"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  autoFocus={mode === "sign_in"}
                />
              </LabeledFormField>
              <LabeledFormField data-invalid={error ? true : undefined} label="Password" labelFor="password">
                <Input aria-label="password"
                  id="password"
                  name="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                  required
                  aria-required="true"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                />
              </LabeledFormField>
            </FieldGroup>
            {error && (
              <Alert id={errorId} variant="destructive" className="mt-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button
              type="submit"
              disabled={mutation.isPending}
              aria-disabled={!canSubmit || mutation.isPending}
              className="mt-4 w-full"
            >
              {mutation.isPending ? <Spinner aria-hidden="true" /> : null}
              {mutation.isPending ? "Working…" : mode === "sign_in" ? "Sign In" : "Create Account"}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="flex-col items-start gap-2 text-sm text-muted-foreground">
          <span>{mode === "sign_in" ? "Need an account?" : "Already have an account?"}</span>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => {
              setError(null);
              setMode(mode === "sign_in" ? "sign_up" : "sign_in");
            }}
          >
            {mode === "sign_in" ? "Create one" : "Sign in"}
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
