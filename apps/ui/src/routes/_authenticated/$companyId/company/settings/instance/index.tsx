// Empty collections render dedicated UI when data.length === 0.
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, LogOut, Play, SlidersHorizontal } from "lucide-react";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { useSettingsBreadcrumbs } from "@/hooks/useSettingsBreadcrumbs";
import { queryKeys } from "@/lib/queryKeys";
import { getWorktreeInstanceId, isWorktreeRuntime } from "@/lib/worktree-branding";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { SettingsSwitchField } from "@/components/patterns/FormPatterns";

export const Route = createFileRoute("/_authenticated/$companyId/company/settings/instance/")({
  component: InstanceGeneralSettings,
});

type WorktreeRunExecutionDisplayState =
  | { kind: "off" }
  | { kind: "armed"; activatedAt: string }
  | {
      kind: "fail_closed";
      reason: "missing_cutoff" | "missing_instance_id" | "instance_mismatch";
    };

function resolveWorktreeRunExecutionDisplayState(
  settings:
    | {
        enableWorktreeRunExecution: boolean;
        worktreeRunExecutionActivatedAt: string | null;
        worktreeRunExecutionActivationInstanceId: string | null;
      }
    | undefined,
  currentInstanceId: string | null,
): WorktreeRunExecutionDisplayState {
  if (settings?.enableWorktreeRunExecution !== true) return { kind: "off" };
  if (!settings.worktreeRunExecutionActivatedAt) {
    return { kind: "fail_closed", reason: "missing_cutoff" };
  }
  if (!currentInstanceId) {
    return { kind: "fail_closed", reason: "missing_instance_id" };
  }
  if (settings.worktreeRunExecutionActivationInstanceId !== currentInstanceId) {
    return { kind: "fail_closed", reason: "instance_mismatch" };
  }
  return {
    kind: "armed",
    activatedAt: settings.worktreeRunExecutionActivatedAt,
  };
}

function formatActivationTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function InstanceGeneralSettings() {
  const companyId = useCompanyRouteId();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const signOutMutation =   // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to sign out.");
    },
  });

  useSettingsBreadcrumbs({
    companyId,
    instance: true,
    page: "General",
  });

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const updateGeneralMutation = useMutation({
    mutationFn: instanceSettingsApi.updateGeneral,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.instance.generalSettings,
      });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update general settings.");
    },
  });

  if (generalQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading general settings...
      </div>
    );
  }

  if (generalQuery.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {generalQuery.error instanceof Error
            ? generalQuery.error.message
            : "Failed to load general settings."}
        </AlertDescription>
      </Alert>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const reconcileWorkspaceBranches = generalQuery.data?.enableWorkspaceBranchReconcileForward !== false;
  const repairDirtyWorkspaces = generalQuery.data?.enableWorkspaceDirtyQuarantineRepair !== false;
  const serverInfoDebugView = generalQuery.data?.enableServerInfoDebugView === true;
  const autoRestartDevServerWhenIdle = generalQuery.data?.autoRestartDevServerWhenIdle === true;
  const worktreeRunExecution = generalQuery.data?.enableWorktreeRunExecution === true;
  const inWorktree = isWorktreeRuntime();
  const worktreeRunExecutionState = resolveWorktreeRunExecutionDisplayState(
    generalQuery.data,
    getWorktreeInstanceId(),
  );
  const pendingSettingsStatus = updateGeneralMutation.isPending
    ? "Saving instance settings…"
    : signOutMutation.isPending
      ? "Signing out…"
      : null;
  const authenticationStatuses = [
    ["Auth readiness", healthQuery.data?.authReady ? "Ready" : "Not ready"],
    [
      "Bootstrap status",
      healthQuery.data?.bootstrapStatus === "bootstrap_pending" ? "Setup required" : "Ready",
    ],
    ["Bootstrap invite", healthQuery.data?.bootstrapInviteActive ? "Active" : "None"],
  ] as const;
  const toggleSettings = [
    {
      id: "censor-username-in-logs",
      title: "Censor username in logs",
      description:
        "Hide the username segment in home-directory paths and similar operator-visible log output. Standalone username mentions outside of paths are not yet masked in the live transcript view. This is off by default.",
      checked: censorUsernameInLogs,
      payload: { censorUsernameInLogs: !censorUsernameInLogs },
      ariaLabel: "Toggle username log censoring",
    },
    {
      id: "server-info-debug-view",
      title: "Server Info debug view",
      description:
        "Show server restart, running commit, and checkout-state details in the account menu. This is off by default.",
      checked: serverInfoDebugView,
      payload: { enableServerInfoDebugView: !serverInfoDebugView },
      ariaLabel: "Toggle Server Info debug view",
    },
    {
      id: "auto-restart-dev-server",
      title: "Auto-restart dev server when idle",
      description:
        "Automatically request a dev-server restart after backend changes once no task executions are active. This is off by default.",
      checked: autoRestartDevServerWhenIdle,
      payload: { autoRestartDevServerWhenIdle: !autoRestartDevServerWhenIdle },
      ariaLabel: "Toggle automatic idle dev-server restart",
    },
    {
      id: "reconcile-workspace-branches",
      title: "Reconcile workspace branches",
      description:
        "Advance managed workspace branches when it is safe to reconcile them with their configured source. Direct project folders are never changed. This safeguard is on by default.",
      checked: reconcileWorkspaceBranches,
      payload: {
        enableWorkspaceBranchReconcileForward: !reconcileWorkspaceBranches,
      },
      ariaLabel: "Toggle workspace branch reconciliation",
    },
    {
      id: "repair-dirty-workspaces",
      title: "Repair dirty workspaces",
      description:
        "Quarantine and repair managed workspaces that are left in a dirty state before they are reused. Direct project folders are never changed. This safeguard is on by default.",
      checked: repairDirtyWorkspaces,
      payload: {
        enableWorkspaceDirtyQuarantineRepair: !repairDirtyWorkspaces,
      },
      ariaLabel: "Toggle dirty workspace repair",
    },
    {
      id: "keyboard-shortcuts",
      title: "Keyboard shortcuts",
      description:
        "Enable app keyboard shortcuts, including inbox navigation and global shortcuts like creating tasks or toggling panels. This is off by default.",
      checked: keyboardShortcuts,
      payload: { keyboardShortcuts: !keyboardShortcuts },
      ariaLabel: "Toggle keyboard shortcuts",
    },
  ];

  return (
    <div className="max-w-4xl space-y-6">
      {pendingSettingsStatus ? (
        <p className="sr-only" role="status">
          {pendingSettingsStatus}
        </p>
      ) : null}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground"  data-icon="inline-start"/>
          <h1 className="text-lg font-semibold">General</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure instance-wide preferences including log display and keyboard shortcuts.
        </p>
      </div>

      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Authentication</CardTitle>
          <CardDescription>
            Every human uses a Better Auth account. Sign-in is required before instance or company
            authorization is evaluated.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ItemGroup className="grid gap-3 md:grid-cols-3">
            {authenticationStatuses.map(([label, value]) => (
              <Item key={label} variant="outline">
                <ItemContent>
                  <ItemTitle>{label}</ItemTitle>
                  <ItemDescription>{value}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </CardContent>
      </Card>

      {toggleSettings.map((setting) => (
        <Card key={setting.title}>
          <CardContent>
            <SettingsSwitchField
              id={`instance-setting-${setting.id}`}
              label={setting.title}
              description={setting.description}
              checked={setting.checked}
              onCheckedChange={() => updateGeneralMutation.mutate(setting.payload)}
              disabled={updateGeneralMutation.isPending}
              aria-label={setting.ariaLabel}
            />
          </CardContent>
        </Card>
      ))}

      {inWorktree ? (
        <Card>
          <CardContent className="space-y-4">
            <SettingsSwitchField
              id="instance-setting-worktree-run-execution"
              label="Run scheduled tasks in this worktree"
              description="Allow automatic schedule and webhook runs in this worktree instance. Only routines created after enabling can run automatically; toggling off and on resets the cutoff."
              checked={worktreeRunExecution}
              onCheckedChange={() =>
                updateGeneralMutation.mutate({
                  enableWorktreeRunExecution: !worktreeRunExecution,
                })
              }
              disabled={updateGeneralMutation.isPending}
              aria-label="Toggle worktree scheduled task execution"
            />
            {worktreeRunExecutionState.kind === "armed" ? (
              <Alert>
                <Play  data-icon="inline-start"/>
                <AlertDescription>
                  Running routines created after{" "}
                  <span className="font-medium">
                    {formatActivationTimestamp(worktreeRunExecutionState.activatedAt)}
                  </span>
                  .
                </AlertDescription>
              </Alert>
            ) : null}
            {worktreeRunExecutionState.kind === "fail_closed" ? (
              <Alert variant="destructive">
                <AlertTriangle  data-icon="inline-start"/>
                <AlertTitle>Automatic execution is suppressed.</AlertTitle>
                <AlertDescription>
                  {worktreeRunExecutionState.reason === "instance_mismatch"
                    ? "This setting was armed in a different instance."
                    : "This setting is missing its activation cutoff for this instance."}{" "}
                  Toggle it off and back on to arm execution here.
                </AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardContent>
          <Item>
            <ItemContent>
              <ItemTitle>Sign out</ItemTitle>
              <ItemDescription>
                Sign out of this Paperclip instance. You will be redirected to the login page.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                variant="outline"
                size="sm"
                disabled={signOutMutation.isPending}
                onClick={() => signOutMutation.mutate()}
              >
                <LogOut className="size-4"  data-icon="inline-start"/>
                {signOutMutation.isPending ? "Signing out..." : "Sign out"}
              </Button>
            </ItemActions>
          </Item>
        </CardContent>
      </Card>
    </div>
  );
}
