import { useQuery } from "@tanstack/react-query";
import { Clock3, FileDiff, GitCommit } from "lucide-react";
import { healthApi, type HealthStatus } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function isValidTimestamp(value: string | null | undefined): value is string {
  return !!value && !Number.isNaN(new Date(value).getTime());
}

function restartTimestamp(health: HealthStatus | undefined): string | null {
  return health?.devServer?.lastRestartAt ?? health?.serverInfo?.processStartedAt ?? null;
}

function commitLabel(health: HealthStatus | undefined): string {
  const git = health?.serverInfo?.git;
  if (!git?.available) return "Commit unavailable";
  return `${git.shortSha} · ${git.subject}`;
}

function localChangesLabel(health: HealthStatus | undefined): string {
  const git = health?.serverInfo?.git;
  if (!git?.available || !git.localChanges?.available) {
    return "Change status unavailable";
  }
  if (!git.localChanges.hasLocalChanges) return "Clean checkout";

  const parts = [
    [git.localChanges.stagedFileCount, "staged"],
    [git.localChanges.unstagedFileCount, "unstaged"],
    [git.localChanges.untrackedFileCount, "untracked"],
  ]
    .filter(([count]) => Number(count) > 0)
    .map(([count, label]) => `${count} ${label}`);

  return parts.length > 0 ? `Local changes present (${parts.join(", ")})` : "Local changes present";
}

export function SidebarServerInfo() {
  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const enabled = generalQuery.data?.enableServerInfoDebugView === true;
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled,
    // The drawer shares Layout's canonical health query. Refetch when the
    // account popover opens without adding a second interval observer.
    refetchOnMount: "always",
  });

  if (!enabled) return null;

  const health = healthQuery.data;
  const isWaitingForHealth = healthQuery.isLoading && !health;
  const healthUnavailable = healthQuery.isError;
  const restartedAt = restartTimestamp(health);
  const restartedAtIsValid = isValidTimestamp(restartedAt);
  const lastRestartedLabel = healthUnavailable
    ? "Health unavailable"
    : isWaitingForHealth
      ? "Loading..."
      : formatTimestamp(restartedAt);
  const commit = healthUnavailable
    ? "Health unavailable"
    : isWaitingForHealth
      ? "Loading..."
      : commitLabel(health);
  const localChanges = healthUnavailable
    ? "Health unavailable"
    : isWaitingForHealth
      ? "Loading..."
      : localChangesLabel(health);
  const rows = [
    {
      icon: Clock3,
      label: "Last restarted",
      value: lastRestartedLabel,
      dateTime: !healthUnavailable && !isWaitingForHealth && restartedAtIsValid ? restartedAt : null,
    },
    { icon: GitCommit, label: "Running commit", value: commit, dateTime: null },
    {
      icon: FileDiff,
      label: "Checkout state",
      value: localChanges,
      dateTime: null,
    },
  ];

  return (
    <div className="mt-2 pt-2">
      <Separator />
      <p className="px-3 pb-1 pt-1 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
        Server
      </p>
      <ItemGroup>
        {rows.map((row) => (
          <Item key={row.label} size="sm">
            <ItemMedia variant="icon">
              <row.icon className="size-4" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{row.label}</ItemTitle>
              {row.dateTime ? (
                <time dateTime={row.dateTime} className="break-words text-xs text-muted-foreground">
                  {row.value}
                </time>
              ) : (
                <ItemDescription className="line-clamp-none break-words text-xs">{row.value}</ItemDescription>
              )}
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
}
