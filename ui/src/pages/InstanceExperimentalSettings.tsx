import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FlaskConical, Play } from "lucide-react";
import type {
  InstanceExperimentalSettings,
  PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { getWorktreeInstanceId, isWorktreeRuntime } from "../lib/worktree-branding";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

type WorktreeRunExecutionDisplayState =
  | { kind: "off" }
  | { kind: "armed"; activatedAt: string }
  | { kind: "fail_closed"; reason: "missing_cutoff" | "missing_instance_id" | "instance_mismatch" };

/**
 * Mirror of the server's `resolveWorktreeRunExecutionActivation` fail-closed
 * ladder (server/src/services/instance-settings.ts) so the card never claims a
 * copied/legacy row is arming execution. The derived fields are display-only —
 * the PATCH the toggle sends still writes just the boolean.
 */
function resolveWorktreeRunExecutionDisplayState(
  settings:
    | Pick<
        InstanceExperimentalSettings,
        | "enableWorktreeRunExecution"
        | "worktreeRunExecutionActivatedAt"
        | "worktreeRunExecutionActivationInstanceId"
      >
    | undefined,
  currentInstanceId: string | null,
): WorktreeRunExecutionDisplayState {
  if (settings?.enableWorktreeRunExecution !== true) return { kind: "off" };
  if (!settings.worktreeRunExecutionActivatedAt) return { kind: "fail_closed", reason: "missing_cutoff" };
  if (!currentInstanceId) return { kind: "fail_closed", reason: "missing_instance_id" };
  if (settings.worktreeRunExecutionActivationInstanceId !== currentInstanceId) {
    return { kind: "fail_closed", reason: "instance_mismatch" };
  }
  return { kind: "armed", activatedAt: settings.worktreeRunExecutionActivatedAt };
}

function formatActivationTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// PAP-11233: keep Conference Room code intact, but hide the user-facing opt-in for now.
const SHOW_CONFERENCE_ROOM_EXPERIMENTAL_SETTING = false;

export function InstanceExperimentalSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Experimental" },
    ]);
  }, [setBreadcrumbs]);

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  const toggleMutation = useMutation<
    InstanceExperimentalSettings,
    Error,
    PatchInstanceExperimentalSettings,
    { previousSettings?: InstanceExperimentalSettings }
  >({
    mutationFn: async (patch: PatchInstanceExperimentalSettings) =>
      instanceSettingsApi.updateExperimental(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.instance.experimentalSettings });
      const previousSettings = queryClient.getQueryData<InstanceExperimentalSettings>(
        queryKeys.instance.experimentalSettings,
      );
      if (previousSettings) {
        queryClient.setQueryData<InstanceExperimentalSettings>(
          queryKeys.instance.experimentalSettings,
          { ...previousSettings, ...patch },
        );
      }
      return { previousSettings };
    },
    onSuccess: async (updatedSettings) => {
      setActionError(null);
      queryClient.setQueryData(queryKeys.instance.experimentalSettings, updatedSettings);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]);
    },
    onError: (error, _patch, context) => {
      if (context?.previousSettings) {
        queryClient.setQueryData(queryKeys.instance.experimentalSettings, context.previousSettings);
      }
      setActionError(error instanceof Error ? error.message : "Failed to update experimental settings.");
    },
  });

  if (experimentalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading experimental settings...</div>;
  }

  if (experimentalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {experimentalQuery.error instanceof Error
          ? experimentalQuery.error.message
          : "Failed to load experimental settings."}
      </div>
    );
  }

  const inWorktree = isWorktreeRuntime();
  const enableWorktreeRunExecution = experimentalQuery.data?.enableWorktreeRunExecution === true;
  const worktreeRunExecutionState = resolveWorktreeRunExecutionDisplayState(
    experimentalQuery.data,
    getWorktreeInstanceId(),
  );
  const enableEnvironments = experimentalQuery.data?.enableEnvironments === true;
  const enableIsolatedWorkspaces = experimentalQuery.data?.enableIsolatedWorkspaces === true;
  const enableApps = experimentalQuery.data?.enableApps === true;
  // Streamlined left navigation is now the standard sidebar (PAP-12472); the
  // experimental opt-out was retired, so it no longer surfaces a toggle here.
  const enableConferenceRoomChat = experimentalQuery.data?.enableConferenceRoomChat === true;
  const enableExperimentalFileViewer =
    experimentalQuery.data?.enableExperimentalFileViewer === true;
  const enableIssueWatchdogs = experimentalQuery.data?.enableIssueWatchdogs === true;
  const enableCloudSync = experimentalQuery.data?.enableCloudSync === true;
  const enableExternalObjects = experimentalQuery.data?.enableExternalObjects === true;
  const enableSummaries = experimentalQuery.data?.enableSummaries === true;
  const enableDecisions = experimentalQuery.data?.enableDecisions === true;
  const enableGoalsSidebarLink = experimentalQuery.data?.enableGoalsSidebarLink === true;
  const enableCases = experimentalQuery.data?.enableCases === true;
  const enableServerInfoDebugView = experimentalQuery.data?.enableServerInfoDebugView === true;
  const enableSmokeLab = experimentalQuery.data?.enableSmokeLab === true;
  const autoRestartDevServerWhenIdle = experimentalQuery.data?.autoRestartDevServerWhenIdle === true;

  return (
    <div className="max-w-4xl space-y-6" aria-busy={toggleMutation.isPending}>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Experimental</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Opt into features that are still being evaluated before they become default behavior.
        </p>
        {toggleMutation.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">
            Saving experimental setting…
          </p>
        ) : null}
      </div>

      <div
        role="alert"
        className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">Experimental features may break at any time.</p>
            <p className="text-muted-foreground">
              These features are opt-in and come with no compatibility guarantees. They may change, break, or be
              removed without notice. Avoid relying on them for critical or production workflows.
            </p>
          </div>
        </div>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          {actionError}
        </div>
      )}

      {inWorktree ? (
        <Card className="block p-5">
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1.5">
                <h2 className="text-sm font-semibold">Run tasks in this worktree</h2>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  This is an isolated git-worktree preview instance. Turn this on to let the scheduler execute runs
                  here. Only tasks created after enabling will run automatically — copied/pre-existing tasks stay
                  parked. Toggling off and on resets the cutoff.
                </p>
              </div>
              <ToggleSwitch
                checked={enableWorktreeRunExecution}
                onCheckedChange={(checked) =>
                  toggleMutation.mutate({ enableWorktreeRunExecution: checked })
                }
                disabled={toggleMutation.isPending}
                aria-label="Toggle worktree run execution setting"
              />
            </div>

            {worktreeRunExecutionState.kind === "armed" ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-foreground">
                <Play className="h-4 w-4 shrink-0 text-emerald-600" />
                <span>
                  Running tasks created after{" "}
                  <span className="font-medium">
                    {formatActivationTimestamp(worktreeRunExecutionState.activatedAt)}
                  </span>
                  .
                </span>
              </div>
            ) : null}

            {worktreeRunExecutionState.kind === "fail_closed" ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                <div className="space-y-0.5">
                  <p className="font-medium text-foreground">Execution is suppressed — effectively off.</p>
                  <p className="text-muted-foreground">
                    {worktreeRunExecutionState.reason === "instance_mismatch"
                      ? "This setting was armed in a different instance and copied here, so no tasks run automatically."
                      : "This setting is missing its activation cutoff, so no tasks run automatically."}{" "}
                    Toggle it off and back on to arm execution for tasks created here.
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
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Apps</h2>
              <Badge variant="secondary">Experimental</Badge>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show the Apps navigation and allow access to app connections, gateways, and advanced app tooling.
            </p>
          </div>
          <ToggleSwitch
            checked={enableApps}
            onCheckedChange={() => toggleMutation.mutate({ enableApps: !enableApps })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle apps experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Cases</h2>
              <Badge variant="secondary">Experimental</Badge>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Durable work products (blog posts, tweet storms…) that tasks create and iterate on. Adds the
              Cases tab and the agent case API.
            </p>
            <p className="max-w-2xl text-xs text-muted-foreground">
              Turning Cases off hides the tab and blocks the case API; existing case data is kept.
            </p>
          </div>
          <ToggleSwitch
            checked={enableCases}
            onCheckedChange={() => toggleMutation.mutate({ enableCases: !enableCases })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle cases experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Enable Environments</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show environment management in company settings and allow project and agent environment assignment
              controls.
            </p>
          </div>
          <ToggleSwitch
            checked={enableEnvironments}
            onCheckedChange={() => toggleMutation.mutate({ enableEnvironments: !enableEnvironments })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle environments experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Summaries</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show routine-generated status slots on project and workspace pages, with on-demand refresh,
              scheduling, and revision history. Existing summary data is kept when this is disabled.
            </p>
          </div>
          <ToggleSwitch
            checked={enableSummaries}
            onCheckedChange={() => toggleMutation.mutate({ enableSummaries: !enableSummaries })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle summaries experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Experimental File Viewer</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show task detail controls for browsing and previewing workspace files relative to a task.
            </p>
          </div>
          <ToggleSwitch
            checked={enableExperimentalFileViewer}
            onCheckedChange={() =>
              toggleMutation.mutate({
                enableExperimentalFileViewer: !enableExperimentalFileViewer,
              })
            }
            disabled={toggleMutation.isPending}
            aria-label="Toggle experimental file viewer setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Enable External Objects</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Detect external URLs in issues and show resolved status for pull requests, tickets, and other referenced
              work objects.
            </p>
          </div>
          <ToggleSwitch
            checked={enableExternalObjects}
            onCheckedChange={() => toggleMutation.mutate({ enableExternalObjects: !enableExternalObjects })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle external objects experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Decisions</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show the Decisions item in the main sidebar — the attention home that surfaces the tasks awaiting your
              input — while the surface is still being evaluated.
            </p>
          </div>
          <ToggleSwitch
            checked={enableDecisions}
            onCheckedChange={() => toggleMutation.mutate({ enableDecisions: !enableDecisions })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle decisions experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Goals Sidebar Link</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Restore the Goals item in the main sidebar while the goals surface is being evaluated.
            </p>
          </div>
          <ToggleSwitch
            checked={enableGoalsSidebarLink}
            onCheckedChange={() => toggleMutation.mutate({ enableGoalsSidebarLink: !enableGoalsSidebarLink })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle goals sidebar link experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Enable Isolated Workspaces</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show execution workspace controls in project configuration and allow isolated workspace behavior for new
              and existing task runs.
            </p>
          </div>
          <ToggleSwitch
            checked={enableIsolatedWorkspaces}
            onCheckedChange={() => toggleMutation.mutate({ enableIsolatedWorkspaces: !enableIsolatedWorkspaces })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle isolated workspaces experimental setting"
          />
        </div>
      </Card>

      {SHOW_CONFERENCE_ROOM_EXPERIMENTAL_SETTING ? (
        <Card className="block p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold">Conference Room Chat</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Adds a Conference Room — one chat where you and your whole team work together — plus the live activity
                feed and the redesigned onboarding. Also restyles task threads as chat bubbles. Turn off anytime to
                restore the classic UI.
              </p>
            </div>
            <ToggleSwitch
              checked={enableConferenceRoomChat}
              onCheckedChange={() =>
                toggleMutation.mutate({
                  enableConferenceRoomChat: !enableConferenceRoomChat,
                })
              }
              disabled={toggleMutation.isPending}
              aria-label="Toggle conference room chat experimental setting"
            />
          </div>
        </Card>
      ) : null}

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Task Safeguards</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show task detail controls for enabling a system safeguard that watches stopped task subtrees and nudges
              the current owner when runnable work should continue.
            </p>
          </div>
          <ToggleSwitch
            checked={enableIssueWatchdogs}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({
                enableIssueWatchdogs: checked,
              })
            }
            disabled={toggleMutation.isPending}
            aria-label="Toggle task safeguards experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Cloud Sync</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show local Paperclip Cloud upstream connection, preview, push, retry, and activation review surfaces.
              Saved connections and run history are preserved when this is disabled.
            </p>
          </div>
          <ToggleSwitch
            checked={enableCloudSync}
            onCheckedChange={() => toggleMutation.mutate({ enableCloudSync: !enableCloudSync })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle cloud sync experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Server Info Debug View</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show a "Server" section in the account drawer with the current server restart time and running commit.
            </p>
          </div>
          <ToggleSwitch
            checked={enableServerInfoDebugView}
            onCheckedChange={() =>
              toggleMutation.mutate({
                enableServerInfoDebugView: !enableServerInfoDebugView,
              })
            }
            disabled={toggleMutation.isPending}
            aria-label="Toggle server info debug view experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Smoke Lab</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Add a "Smoke Lab" tab under Apps → Developer and an "Integration smoke" card on the
              dashboard for exercising every integration path against deterministic local fixtures
              (fake OAuth provider + loopback MCP servers). Private (non-public) deployments only.
            </p>
          </div>
          <ToggleSwitch
            checked={enableSmokeLab}
            onCheckedChange={() => toggleMutation.mutate({ enableSmokeLab: !enableSmokeLab })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle smoke lab experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Auto-Restart Dev Server When Idle</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              In `pnpm dev:once`, wait for all queued and running local agent runs to finish, then restart the server
              automatically when backend changes or migrations make the current boot stale.
            </p>
          </div>
          <ToggleSwitch
            checked={autoRestartDevServerWhenIdle}
            onCheckedChange={() => toggleMutation.mutate({ autoRestartDevServerWhenIdle: !autoRestartDevServerWhenIdle })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle guarded dev-server auto-restart"
          />
        </div>
      </Card>

    </div>
  );
}
