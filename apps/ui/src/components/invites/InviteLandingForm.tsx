import { accessApi } from "@/api/access";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatDate } from "@/lib/utils";
import type {
  AuthFeedback,
  AuthMode,
} from "@/routes/invite/$token/-invite-auth";
import type { Dispatch, SetStateAction } from "react";

type Invite = Awaited<ReturnType<typeof accessApi.getInvite>>;
export function InviteLandingForm({
  invite,
  companyDisplayName,
  companyLogoUrl,
  invitedByUserName,
  requestedUserRole,
  sessionLabel,
  signedIn,
  requiresUserAccount,
  authMode,
  setAuthMode,
  name,
  setName,
  email,
  setEmail,
  password,
  setPassword,
  authErrorId,
  authFeedback,
  setAuthFeedback,
  authPending,
  authCanSubmit,
  onAuthSubmit,
  isCurrentMember,
  shouldAutoAcceptUserInvite,
  error,
  acceptPending,
  joinButtonLabel,
  onAccept,
}: {
  invite: Invite;
  companyDisplayName: string;
  companyLogoUrl: string | null;
  invitedByUserName: string | null;
  requestedUserRole: string | null;
  sessionLabel: string;
  signedIn: boolean;
  requiresUserAccount: boolean;
  authMode: AuthMode;
  setAuthMode: Dispatch<SetStateAction<AuthMode>>;
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  email: string;
  setEmail: Dispatch<SetStateAction<string>>;
  password: string;
  setPassword: Dispatch<SetStateAction<string>>;
  authErrorId: string;
  authFeedback: AuthFeedback | null;
  setAuthFeedback: Dispatch<SetStateAction<AuthFeedback | null>>;
  authPending: boolean;
  authCanSubmit: boolean;
  onAuthSubmit: () => void;
  isCurrentMember: boolean;
  shouldAutoAcceptUserInvite: boolean;
  error: string | null;
  acceptPending: boolean;
  joinButtonLabel: string;
  onAccept: () => void;
}) {
  return (
    <div className="min-h-screen bg-background px-6 py-12 text-foreground">
      <div className="mx-auto max-w-5xl">
        <div className="grid gap-6 lg:grid-cols-(--gtc-36)">
          <Card>
            <CardHeader className="flex-row items-start gap-4">
              <Avatar size="lg">
                <AvatarImage
                  src={companyLogoUrl ?? undefined}
                  alt={`${companyDisplayName} logo`}
                />
                <AvatarFallback>
                  {companyDisplayName.trim().charAt(0).toUpperCase() || "?"}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 space-y-2">
                <CardDescription>
                  You&apos;ve been invited to join Paperclip
                </CardDescription>
                <CardTitle className="text-2xl">
                  {invite.inviteType === "bootstrap_admin"
                    ? "Set up Paperclip"
                    : `Join ${companyDisplayName}`}
                </CardTitle>
                <CardDescription className="max-w-2xl">
                  {requiresUserAccount
                    ? "Create your Paperclip account first. If you already have one, switch to sign in and continue the invite with the same email."
                    : "Your account is ready. Review the invite details, then accept it to continue."}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ["Company", companyDisplayName],
                  ["Invited by", invitedByUserName ?? "Paperclip board"],
                  ["Requested access", requestedUserRole ?? "Company access"],
                  ["Invite expires", formatDate(invite.expiresAt)],
                ].map(([label, value]) => (
                  <Card key={label}>
                    <CardHeader>
                      <CardDescription>{label}</CardDescription>
                      <CardTitle className="text-sm">{value}</CardTitle>
                    </CardHeader>
                  </Card>
                ))}
              </div>

              {signedIn ? (
                <Alert>
                  <AlertDescription>
                    Signed in as <strong>{sessionLabel}</strong>.
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>

          <Card className="h-fit">
            <CardContent>
              {requiresUserAccount ? (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-lg font-semibold">
                      {authMode === "sign_up"
                        ? "Create your account"
                        : "Sign in to continue"}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {authMode === "sign_up"
                        ? `Start with a Paperclip account. After that, you'll come right back here to accept the invite for ${companyDisplayName}.`
                        : "Use the Paperclip account that already matches this invite. If you do not have one yet, switch back to create account."}
                    </p>
                  </div>

                  <ToggleGroup
                    type="single"
                    value={authMode}
                    variant="outline"
                    className="w-full"
                    onValueChange={(value) => {
                      if (!value) return;
                      setAuthFeedback(null);
                      setAuthMode(value as AuthMode);
                    }}
                  >
                    <ToggleGroupItem value="sign_up" className="flex-1">
                      Create account
                    </ToggleGroupItem>
                    <ToggleGroupItem value="sign_in" className="flex-1">
                      I already have an account
                    </ToggleGroupItem>
                  </ToggleGroup>

                  <form
                    className="space-y-4"
                    method="post"
                    action={
                      authMode === "sign_up"
                        ? "/api/auth/sign-up/email"
                        : "/api/auth/sign-in/email"
                    }
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (authPending) return;
                      if (!authCanSubmit) {
                        setAuthFeedback({
                          tone: "error",
                          message: "Please fill in all required fields.",
                        });
                        return;
                      }
                      onAuthSubmit();
                    }}
                    data-testid="invite-inline-auth"
                  >
                    {authMode === "sign_up" ? (
                      <Field>
                        <FieldLabel htmlFor="invite-name">Name</FieldLabel>
                        <Input
                          id="invite-name"
                          name="name"
                          value={name}
                          onChange={(event) => {
                            setName(event.target.value);
                            setAuthFeedback(null);
                          }}
                          autoComplete="name"
                          required
                          aria-required="true"
                          aria-invalid={
                            authFeedback?.tone === "error" ? true : undefined
                          }
                          aria-describedby={
                            authFeedback ? authErrorId : undefined
                          }
                          autoFocus
                        />
                      </Field>
                    ) : null}
                    <Field>
                      <FieldLabel htmlFor="invite-email">Email</FieldLabel>
                      <Input
                        id="invite-email"
                        name="email"
                        type="email"
                        value={email}
                        onChange={(event) => {
                          setEmail(event.target.value);
                          setAuthFeedback(null);
                        }}
                        autoComplete="email"
                        required
                        aria-required="true"
                        aria-invalid={
                          authFeedback?.tone === "error" ? true : undefined
                        }
                        aria-describedby={
                          authFeedback ? authErrorId : undefined
                        }
                        autoFocus={authMode === "sign_in"}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="invite-password">
                        Password
                      </FieldLabel>
                      <Input
                        id="invite-password"
                        name="password"
                        type="password"
                        value={password}
                        onChange={(event) => {
                          setPassword(event.target.value);
                          setAuthFeedback(null);
                        }}
                        autoComplete={
                          authMode === "sign_in"
                            ? "current-password"
                            : "new-password"
                        }
                        required
                        aria-required="true"
                        aria-invalid={
                          authFeedback?.tone === "error" ? true : undefined
                        }
                        aria-describedby={
                          authFeedback ? authErrorId : undefined
                        }
                      />
                    </Field>
                    {authFeedback ? (
                      <FieldError id={authErrorId}>
                        {authFeedback.message}
                      </FieldError>
                    ) : null}
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={authPending}
                      aria-disabled={!authCanSubmit || authPending}
                    >
                      {authPending ? <Spinner /> : null}
                      {authPending
                        ? "Working..."
                        : authMode === "sign_in"
                          ? "Sign in and continue"
                          : "Create account and continue"}
                    </Button>
                  </form>

                  <p className="text-xs leading-5 text-muted-foreground">
                    {authMode === "sign_up"
                      ? "Already signed up before? Use the existing-account option instead so the invite lands on the right Paperclip user."
                      : "No account yet? Switch back to create account so you can accept the invite with a new login."}
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-lg font-semibold">
                      {isCurrentMember
                        ? "Already in this company"
                        : shouldAutoAcceptUserInvite
                          ? "Completing company access"
                          : invite.inviteType === "bootstrap_admin"
                            ? "Accept bootstrap invite"
                            : "Accept company invite"}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {shouldAutoAcceptUserInvite
                        ? `Granting your access to ${companyDisplayName}.`
                        : isCurrentMember
                          ? `This account already belongs to ${companyDisplayName}.`
                          : `This will ${
                              invite.inviteType === "bootstrap_admin"
                                ? "finish setting up Paperclip"
                                : `grant or complete your access to ${companyDisplayName}`
                            }.`}
                    </p>
                  </div>
                  {error ? (
                    <Alert variant="destructive">
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  ) : null}
                  {shouldAutoAcceptUserInvite ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      {acceptPending ? <Spinner /> : null}
                      {acceptPending
                        ? "Submitting request..."
                        : "Finishing sign-in..."}
                    </div>
                  ) : (
                    <Button
                      className="w-full"
                      disabled={acceptPending}
                      onClick={onAccept}
                    >
                      {acceptPending ? "Working..." : joinButtonLabel}
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
