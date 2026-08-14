import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyTitle } from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import type {
  PluginDashboardData,
  PluginDetailDto,
  PluginLogDto,
} from "@paperclipai/shared";
import {
  ActivitySquare,
  CalendarClock,
  CheckCircle,
  Clock,
  Cpu,
  ShieldAlert,
  Webhook,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";

function formatUptime(uptimeMs: number | null): string {
  if (uptimeMs == null) return "—";
  const seconds = Math.floor(uptimeMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatRelativeTime(isoString: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(isoString).getTime()) / 1000,
  );
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const formatTimestamp = (epochMs: number) => new Date(epochMs).toLocaleString();

interface PluginRuntimeStatusProps {
  dashboardData?: PluginDashboardData;
  dashboardLoading: boolean;
  recentLogs?: PluginLogDto[];
  plugin: PluginDetailDto;
  statusVariant: "default" | "destructive" | "secondary";
  displayStatus: string;
  pluginCapabilities: PluginDetailDto["manifestJson"]["capabilities"];
}

export function PluginRuntimeStatus({
  dashboardData,
  dashboardLoading,
  recentLogs,
  plugin,
  statusVariant,
  displayStatus,
  pluginCapabilities,
}: PluginRuntimeStatusProps) {
  const worker = dashboardData?.worker;
  const workerMetrics: Array<{
    label: string;
    value: ReactNode;
    wide?: boolean;
  }> = worker
    ? [
        {
          label: "Status",
          value: (
            <Badge
              variant={worker.status === "running" ? "default" : "secondary"}
            >
              {worker.status}
            </Badge>
          ),
        },
        { label: "PID", value: worker.pid ?? "—" },
        { label: "Uptime", value: formatUptime(worker.uptime) },
        { label: "Pending RPCs", value: worker.pendingRequests },
        ...(worker.totalCrashes > 0
          ? [
              {
                label: "Crashes",
                value: `${worker.consecutiveCrashes} consecutive / ${worker.totalCrashes} total`,
                wide: true,
              },
              ...(worker.lastCrashAt
                ? [
                    {
                      label: "Last crash",
                      value: formatTimestamp(worker.lastCrashAt),
                      wide: true,
                    },
                  ]
                : []),
            ]
          : []),
      ]
    : [];
  const pluginDetails = [
    ["Plugin ID", plugin.id],
    ["Plugin key", plugin.pluginKey],
    ["NPM package", plugin.packageName],
    ["Version", `v${plugin.manifestJson.version}`],
  ];
  return (
    <div className="grid gap-6 xl:grid-cols-(--gtc-39)">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-1.5">
              <Cpu className="h-4 w-4" />
              Runtime Dashboard
            </CardTitle>
            <CardDescription>
              Worker process, scheduled jobs, and webhook deliveries
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {dashboardData ? (
              <>
                <div>
                  <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                    <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                    Worker Process
                  </h3>
                  {worker ? (
                    <ItemGroup className="grid grid-cols-2 gap-2">
                      {workerMetrics.map((metric) => (
                        <Item
                          key={metric.label}
                          variant="muted"
                          size="sm"
                          className={metric.wide ? "col-span-2" : undefined}
                        >
                          <ItemContent>
                            <ItemDescription>{metric.label}</ItemDescription>
                          </ItemContent>
                          <ItemActions>{metric.value}</ItemActions>
                        </Item>
                      ))}
                    </ItemGroup>
                  ) : (
                    <Empty className="border py-6">
                      <EmptyTitle className="text-base">
                        No worker process registered
                      </EmptyTitle>
                    </Empty>
                  )}
                </div>

                <Separator />

                <div>
                  <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                    <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                    Recent Job Runs
                  </h3>
                  {dashboardData.recentJobRuns.length > 0 ? (
                    <ItemGroup className="gap-2">
                      {dashboardData.recentJobRuns.map((run) => (
                        <Item key={run.id} variant="muted" size="sm">
                          <ItemMedia>
                            <Badge
                              variant={
                                ["success", "succeeded"].includes(run.status)
                                  ? "default"
                                  : run.status === "failed"
                                    ? "destructive"
                                    : run.status === "cancelled"
                                      ? "outline"
                                      : "secondary"
                              }
                            >
                              {run.status}
                            </Badge>
                          </ItemMedia>
                          <ItemContent>
                            <ItemTitle
                              className="truncate font-mono text-xs"
                              title={run.jobKey}
                            >
                              {run.jobKey}
                            </ItemTitle>
                          </ItemContent>
                          <Badge variant="outline">{run.trigger}</Badge>
                          <ItemActions className="text-xs text-muted-foreground">
                            {run.durationMs != null ? (
                              <span>{formatDuration(run.durationMs)}</span>
                            ) : null}
                            <span title={run.createdAt}>
                              {formatRelativeTime(run.createdAt)}
                            </span>
                          </ItemActions>
                        </Item>
                      ))}
                    </ItemGroup>
                  ) : (
                    <Empty className="border py-6">
                      <EmptyTitle className="text-base">
                        No job runs recorded yet
                      </EmptyTitle>
                    </Empty>
                  )}
                </div>

                <Separator />

                <div>
                  <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                    <Webhook className="h-3.5 w-3.5 text-muted-foreground" />
                    Recent Webhook Deliveries
                  </h3>
                  {dashboardData.recentWebhookDeliveries.length > 0 ? (
                    <ItemGroup className="gap-2">
                      {dashboardData.recentWebhookDeliveries.map((delivery) => (
                        <Item key={delivery.id} variant="muted" size="sm">
                          <ItemMedia>
                            <Badge
                              variant={
                                ["processed", "success"].includes(
                                  delivery.status,
                                )
                                  ? "default"
                                  : delivery.status === "failed"
                                    ? "destructive"
                                    : "secondary"
                              }
                            >
                              {delivery.status}
                            </Badge>
                          </ItemMedia>
                          <ItemContent>
                            <ItemTitle
                              className="truncate font-mono text-xs"
                              title={delivery.webhookKey}
                            >
                              {delivery.webhookKey}
                            </ItemTitle>
                          </ItemContent>
                          <ItemActions className="text-xs text-muted-foreground">
                            {delivery.durationMs != null ? (
                              <span>{formatDuration(delivery.durationMs)}</span>
                            ) : null}
                            <span title={delivery.createdAt}>
                              {formatRelativeTime(delivery.createdAt)}
                            </span>
                          </ItemActions>
                        </Item>
                      ))}
                    </ItemGroup>
                  ) : (
                    <Empty className="border py-6">
                      <EmptyTitle className="text-base">
                        No webhook deliveries recorded yet
                      </EmptyTitle>
                    </Empty>
                  )}
                </div>

                <div className="flex items-center gap-1.5 border-t border-border/50 pt-2 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  Last checked:{" "}
                  {new Date(dashboardData.checkedAt).toLocaleTimeString()}
                </div>
              </>
            ) : (
              <Empty className="border py-6">
                <EmptyTitle className="text-base">
                  Runtime diagnostics unavailable
                </EmptyTitle>
              </Empty>
            )}
          </CardContent>
        </Card>

        {recentLogs && recentLogs.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-1.5">
                <ActivitySquare className="h-4 w-4" />
                Recent Logs
              </CardTitle>
              <CardDescription>
                Last {recentLogs.length} log entries
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ItemGroup className="max-h-64 gap-1 overflow-y-auto font-mono">
                {recentLogs.map((entry) => (
                  <Item key={entry.id} variant="muted" size="sm">
                    <Badge
                      variant={
                        entry.level === "error"
                          ? "destructive"
                          : entry.level === "warn"
                            ? "secondary"
                            : "outline"
                      }
                    >
                      {entry.level}
                    </Badge>
                    <ItemContent>
                      <ItemTitle
                        className="truncate font-mono text-xs"
                        title={entry.message}
                      >
                        {entry.message}
                      </ItemTitle>
                      <ItemDescription className="font-mono text-xs">
                        {new Date(entry.createdAt).toLocaleTimeString()}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-1.5">
              <ActivitySquare className="h-4 w-4" />
              Health Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dashboardLoading ? (
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <Spinner />
                Checking health...
              </p>
            ) : dashboardData?.health ? (
              <div className="space-y-4 text-sm">
                <Item variant="muted" size="sm">
                  <ItemContent>
                    <ItemDescription>Overall</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Badge
                      variant={
                        dashboardData.health.healthy ? "default" : "destructive"
                      }
                    >
                      {dashboardData.health.status}
                    </Badge>
                  </ItemActions>
                </Item>

                {dashboardData.health.checks.length > 0 ? (
                  <ItemGroup className="gap-1 border-t pt-2">
                    {dashboardData.health.checks.map((check, i) => (
                      <Item key={`${check.name}:${i}`} size="sm">
                        <ItemContent>
                          <ItemDescription title={check.name}>
                            {check.name}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          {check.passed ? (
                            <CheckCircle
                              className="size-4"
                              aria-label="Passed"
                            />
                          ) : (
                            <XCircle
                              className="size-4 text-destructive"
                              aria-label="Failed"
                            />
                          )}
                        </ItemActions>
                      </Item>
                    ))}
                  </ItemGroup>
                ) : null}

                {dashboardData.health.lastError ? (
                  <Alert variant="destructive">
                    <AlertTitle>Latest health-check error</AlertTitle>
                    <AlertDescription className="break-words">
                      {dashboardData.health.lastError}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3 text-sm text-muted-foreground">
                <Item variant="muted" size="sm">
                  <ItemContent>
                    <ItemDescription>Lifecycle</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Badge variant={statusVariant}>{displayStatus}</Badge>
                  </ItemActions>
                </Item>
                <p>Health checks run once the plugin is ready.</p>
                {plugin.lastError ? (
                  <Alert variant="destructive">
                    <AlertTitle>Plugin error</AlertTitle>
                    <AlertDescription className="break-words">
                      {plugin.lastError}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <ItemGroup className="gap-1">
              {pluginDetails.map(([label, value]) => (
                <Item key={label} variant="muted" size="sm">
                  <ItemContent>
                    <ItemDescription>{label}</ItemDescription>
                  </ItemContent>
                  <ItemActions>{value}</ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-1.5">
              <ShieldAlert className="h-4 w-4" />
              Permissions
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pluginCapabilities.length > 0 ? (
              <ItemGroup className="gap-1">
                {pluginCapabilities.map((cap) => (
                  <Item key={cap} variant="muted" size="sm">
                    <ItemContent>
                      <ItemTitle className="font-mono text-xs">{cap}</ItemTitle>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            ) : (
              <Empty className="border py-6">
                <EmptyTitle className="text-base">
                  No special permissions requested
                </EmptyTitle>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
