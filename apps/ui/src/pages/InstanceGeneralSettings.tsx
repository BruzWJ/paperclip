import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, LogOut, Play, SlidersHorizontal } from "lucide-react";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Button } from "../components/ui/button";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import {
  getWorktreeInstanceId,
  isWorktreeRuntime,
} from "../lib/worktree-branding";
import { Switch } from "@/components/ui/switch";

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

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
    },
    onError: (error) => {
      setActionError(
        error instanceof Error ? error.message : "Failed to sign out.",
      );
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings" },
      { label: "General" },
    ]);
  }, [setBreadcrumbs]);

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
      setActionError(
        error instanceof Error
          ? error.message
          : "Failed to update general settings.",
      );
    },
  });

  if (generalQuery.isLoading) {
    return (
      <div className="text-sm text-muted-foreground" role="status">
        Loading general settings...
      </div>
    );
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive" role="alert">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : "Failed to load general settings."}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const reconcileWorkspaceBranches =
    generalQuery.data?.enableWorkspaceBranchReconcileForward !== false;
  const repairDirtyWorkspaces =
    generalQuery.data?.enableWorkspaceDirtyQuarantineRepair !== false;
  const serverInfoDebugView =
    generalQuery.data?.enableServerInfoDebugView === true;
  const autoRestartDevServerWhenIdle =
    generalQuery.data?.autoRestartDevServerWhenIdle === true;
  const worktreeRunExecution =
    generalQuery.data?.enableWorktreeRunExecution === true;
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

  return (
    <div className="max-w-4xl space-y-6">
      {pendingSettingsStatus ? <p className="sr-only" role="status">{pendingSettingsStatus}</p> : null}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">General</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure instance-wide preferences including log display and keyboard
          shortcuts.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          {actionError}
        </div>
      )}

      <Card className="block p-5">
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Authentication</h2>
          <div className="text-sm text-muted-foreground">
            Every human uses a Better Auth account. Sign-in is required before
            instance or company authorization is evaluated.
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <StatusBox
              label="Auth readiness"
              value={healthQuery.data?.authReady ? "Ready" : "Not ready"}
            />
            <StatusBox
              label="Bootstrap status"
              value={
                healthQuery.data?.bootstrapStatus === "bootstrap_pending"
                  ? "Setup required"
                  : "Ready"
              }
            />
            <StatusBox
              label="Bootstrap invite"
              value={
                healthQuery.data?.bootstrapInviteActive ? "Active" : "None"
              }
            />
          </div>
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Censor username in logs</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Hide the username segment in home-directory paths and similar
              operator-visible log output. Standalone username mentions outside
              of paths are not yet masked in the live transcript view. This is
              off by default.
            </p>
          </div>
          <Switch
            checked={censorUsernameInLogs}
            onCheckedChange={() =>
              updateGeneralMutation.mutate({
                censorUsernameInLogs: !censorUsernameInLogs,
              })
            }
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle username log censoring"
          />
        </div>
      </Card>

      {inWorktree ? (
        <Card className="block p-5">
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1.5">
                <h2 className="text-sm font-semibold">
                  Run scheduled tasks in this worktree
                </h2>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  Allow automatic schedule and webhook runs in this worktree
                  instance. Only routines created after enabling can run
                  automatically; toggling off and on resets the cutoff.
                </p>
              </div>
              <Switch
                checked={worktreeRunExecution}
                onCheckedChange={() =>
                  updateGeneralMutation.mutate({
                    enableWorktreeRunExecution: !worktreeRunExecution,
                  })
                }
                disabled={updateGeneralMutation.isPending}
                aria-label="Toggle worktree scheduled task execution"
              />
            </div>

            {worktreeRunExecutionState.kind === "armed" ? (
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
                <Play className="h-4 w-4 shrink-0 text-(--status-task-done)" />
                <span>
                  Running routines created after{" "}
                  <span className="font-medium">
                    {formatActivationTimestamp(worktreeRunExecutionState.activatedAt)}
                  </span>
                  .
                </span>
              </div>
            ) : null}

            {worktreeRunExecutionState.kind === "fail_closed" ? (
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-(--status-task-todo)" />
                <div className="space-y-0.5">
                  <p className="font-medium text-foreground">
                    Automatic execution is suppressed.
                  </p>
                  <p className="text-muted-foreground">
                    {worktreeRunExecutionState.reason === "instance_mismatch"
                      ? "This setting was armed in a different instance."
                      : "This setting is missing its activation cutoff for this instance."}{" "}
                    Toggle it off and back on to arm execution here.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Server Info debug view</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show server restart, running commit, and checkout-state details in
              the account menu. This is off by default.
            </p>
          </div>
          <Switch
            checked={serverInfoDebugView}
            onCheckedChange={() =>
              updateGeneralMutation.mutate({
                enableServerInfoDebugView: !serverInfoDebugView,
              })
            }
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle Server Info debug view"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">
              Auto-restart dev server when idle
            </h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Automatically request a dev-server restart after backend changes
              once no issue executions are active. This is off by default.
            </p>
          </div>
          <Switch
            checked={autoRestartDevServerWhenIdle}
            onCheckedChange={() =>
              updateGeneralMutation.mutate({
                autoRestartDevServerWhenIdle: !autoRestartDevServerWhenIdle,
              })
            }
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle automatic idle dev-server restart"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Reconcile workspace branches</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Advance managed workspace branches when it is safe to reconcile
              them with their configured source. Direct project folders are
              never changed. This safeguard is on by default.
            </p>
          </div>
          <Switch
            checked={reconcileWorkspaceBranches}
            onCheckedChange={() =>
              updateGeneralMutation.mutate({
                enableWorkspaceBranchReconcileForward:
                  !reconcileWorkspaceBranches,
              })
            }
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle workspace branch reconciliation"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Repair dirty workspaces</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Quarantine and repair managed workspaces that are left in a dirty
              state before they are reused. Direct project folders are never
              changed. This safeguard is on by default.
            </p>
          </div>
          <Switch
            checked={repairDirtyWorkspaces}
            onCheckedChange={() =>
              updateGeneralMutation.mutate({
                enableWorkspaceDirtyQuarantineRepair: !repairDirtyWorkspaces,
              })
            }
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle dirty workspace repair"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Enable app keyboard shortcuts, including inbox navigation and
              global shortcuts like creating tasks or toggling panels. This is
              off by default.
            </p>
          </div>
          <Switch
            checked={keyboardShortcuts}
            onCheckedChange={() =>
              updateGeneralMutation.mutate({
                keyboardShortcuts: !keyboardShortcuts,
              })
            }
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle keyboard shortcuts"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Sign out</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Sign out of this Paperclip instance. You will be redirected to the
              login page.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={signOutMutation.isPending}
            onClick={() => signOutMutation.mutate()}
          >
            <LogOut className="size-4" />
            {signOutMutation.isPending ? "Signing out..." : "Sign out"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function StatusBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 text-sm font-medium">{value}</div>
    </div>
  );
}
