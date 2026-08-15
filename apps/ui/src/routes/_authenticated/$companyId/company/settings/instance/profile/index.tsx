// Empty collections render dedicated UI when data.length === 0.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, Trash2, UserRoundPen } from "lucide-react";
import type { AuthSession, CurrentUserProfile, UpdateCurrentUserProfile } from "@paperclipai/shared";
import { authApi } from "@/api/auth";
import { assetsApi } from "@/api/assets";
import { useSettingsBreadcrumbs } from "@/hooks/useSettingsBreadcrumbs";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { InboxAgentPolicyControl } from "@/routes/_authenticated/$companyId/company/settings/instance/profile/-InboxAgentPolicyControl";
import { AccessibleDropzone } from "@/components/patterns/AccessibleDropzone";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";

export const Route = createFileRoute("/_authenticated/$companyId/company/settings/instance/profile/")({
  component: ProfileSettings,
});

function deriveInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function ProfileSettings() {
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  useSettingsBreadcrumbs({
    companyId,
    instance: true,
    page: "Profile",
  });

  useEffect(() => {
    const session = sessionQuery.data;
    if (!session) return;
    setName(session.user.name ?? "");
    setImage(session.user.image ?? "");
  }, [sessionQuery.data]);

  function syncSessionProfile(profile: CurrentUserProfile) {
    queryClient.setQueryData<AuthSession | null>(queryKeys.auth.session, (current) => {
      if (!current) return current;
      return {
        ...current,
        user: {
          ...current.user,
          ...profile,
        },
      };
    });
  }

  async function persistProfile(input: UpdateCurrentUserProfile) {
    const profile = await authApi.updateProfile(input);
    syncSessionProfile(profile);
    return profile;
  }

  const updateMutation = useMutation({
    mutationFn: (input: UpdateCurrentUserProfile) => persistProfile(input),
    onSuccess: (profile) => {
      setActionError(null);
      setName(profile.name ?? "");
      setImage(profile.image ?? "");
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update profile.");
    },
  });

  const uploadAvatarMutation = useMutation({
    mutationFn: async (file: File) => {
      const userId = sessionQuery.data?.user.id;
      if (!userId) {
        throw new Error("An authenticated user is required to upload a profile avatar.");
      }

      const asset = await assetsApi.uploadImage(companyId, file, `profiles/${userId}`);
      return persistProfile({ name, image: asset.contentPath });
    },
    onSuccess: (profile) => {
      setActionError(null);
      setName(profile.name ?? "");
      setImage(profile.image ?? "");
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to upload avatar.");
    },
  });

  const removeAvatarMutation = useMutation({
    mutationFn: () => persistProfile({ name, image: null }),
    onSuccess: (profile) => {
      setActionError(null);
      setName(profile.name ?? "");
      setImage(profile.image ?? "");
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to remove avatar.");
    },
  });

  if (sessionQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading profile...
      </div>
    );
  }

  if (sessionQuery.error || !sessionQuery.data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {sessionQuery.error instanceof Error ? sessionQuery.error.message : "Failed to load profile."}
        </AlertDescription>
      </Alert>
    );
  }

  const currentName = name.length > 0 ? name : "Paperclip User";
  const currentImage = image.length > 0 ? image : null;
  const initials = deriveInitials(currentName);
  const isPending =
    updateMutation.isPending || uploadAvatarMutation.isPending || removeAvatarMutation.isPending;
  const profileActionStatus = updateMutation.isPending
    ? "Saving profile."
    : uploadAvatarMutation.isPending
      ? "Uploading profile photo."
      : removeAvatarMutation.isPending
        ? "Removing profile photo."
        : null;
  const uploadHint = selectedCompany
    ? `Stored in Paperclip file storage for ${selectedCompany.name}.`
    : "Select a company to upload an avatar into Paperclip storage.";

  return (
    <div className="max-w-4xl space-y-6" aria-busy={isPending}>
      {isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          {profileActionStatus}
        </p>
      ) : null}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <UserRoundPen className="h-5 w-5 text-muted-foreground"  data-icon="inline-start"/>
          <h1 className="text-lg font-semibold">Profile</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Control how your account appears in the sidebar and other board surfaces.
        </p>
      </div>

      {actionError ? (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <section className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Profile photo</CardTitle>
            <CardDescription>{uploadHint}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-5">
            <Avatar size="lg">
              {currentImage ? <AvatarImage src={currentImage} alt={currentName} /> : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <h2 className="truncate font-semibold">{currentName}</h2>
                <p className="truncate text-sm text-muted-foreground">
                  {sessionQuery.data.user.email ?? "No email"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {currentImage ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => removeAvatarMutation.mutate()}
                    disabled={isPending}
                  >
                    {removeAvatarMutation.isPending ? <Spinner /> : <Trash2 className="size-4"  data-icon="inline-start"/>}
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
            <AccessibleDropzone
              ariaLabel={currentImage ? "Change profile photo" : "Upload profile photo"}
              accept={{ "image/*": [] }}
              maxFiles={1}
              disabled={isPending}
              className="basis-full"
              onDrop={([file]) => {
                if (file) uploadAvatarMutation.mutate(file);
              }}
            />
          </CardContent>
        </Card>

        <form
          className="grid gap-6 md:grid-cols-2"
          aria-busy={isPending}
          onSubmit={(event) => {
            event.preventDefault();
            updateMutation.mutate({
              name,
              image: image.length > 0 ? image : null,
            });
          }}
        >
          <LabeledFormField
            label="Display name"
            labelFor="profile-name"
            description="Shown in the sidebar account footer and comment author surfaces."
          >
            <Input aria-label="profile name"
              id="profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder="Your name"
              disabled={isPending}
            />
          </LabeledFormField>

          <LabeledFormField
            label="Email"
            labelFor="profile-email"
            description="Email is managed by your auth session and is read-only here."
          >
            <Input aria-label="profile email"
              id="profile-email"
              value={sessionQuery.data.user.email ?? ""}
              autoComplete="email"
              readOnly
              disabled
            />
          </LabeledFormField>

          <div className="md:col-span-2 flex justify-end">
            <Button type="submit" disabled={isPending || !name.trim()}>
              {updateMutation.isPending ? <Spinner /> : <Save className="size-4"  data-icon="inline-start"/>}
              {updateMutation.isPending ? "Saving..." : "Save profile"}
            </Button>
          </div>
        </form>

        <Card>
          <CardContent>
            <InboxAgentPolicyControl companyId={companyId} userId={sessionQuery.data.user.id} />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
