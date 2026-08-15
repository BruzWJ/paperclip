import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ActivityEvent } from "@paperclipai/shared";
import { activityApi } from "@/api/activity";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { ActivityRow } from "@/routes/_authenticated/$companyId/-activity/-ActivityRow";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { History } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { indexEntitiesById } from "@/lib/presentation-contracts";

export const Route = createFileRoute("/_authenticated/$companyId/activity/")({
  component: Activity,
});

const ACTIVITY_PAGE_LIMIT = 200;

function detailString(event: ActivityEvent, ...keys: string[]) {
  const details = event.details;
  for (const key of keys) {
    const value = details?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function activityEntityName(event: ActivityEvent) {
  if (event.entityType === "task") return detailString(event, "identifier", "taskIdentifier");
  if (event.entityType === "project") return detailString(event, "projectName", "name", "title");
  if (event.entityType === "goal") return detailString(event, "goalTitle", "title", "name");
  return detailString(event, "name", "title");
}

function activityEntityTitle(event: ActivityEvent) {
  if (event.entityType === "task") return detailString(event, "taskTitle", "title");
  return null;
}

function Activity() {
  const companyId = useCompanyRouteId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Activity" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKeys.activity(companyId), { limit: ACTIVITY_PAGE_LIMIT }],
    queryFn: () => activityApi.list(companyId, { limit: ACTIVITY_PAGE_LIMIT }),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const agentMap = useMemo(() => indexEntitiesById(agents), [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const event of data ?? []) {
      const name = activityEntityName(event);
      if (name) map.set(`${event.entityType}:${event.entityId}`, name);
    }
    return map;
  }, [data, agents]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of data ?? []) {
      const title = activityEntityTitle(event);
      if (title) map.set(`${event.entityType}:${event.entityId}`, title);
    }
    return map;
  }, [data]);

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  const filtered = data && filter !== "all" ? data.filter((e) => e.entityType === filter) : data;

  const entityTypes = data ? [...new Set(data.map((e) => e.entityType))].sort() : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger aria-label="Filter activity by type" className="w-(--sz-140px) h-8 text-xs">
            <SelectValue placeholder="Filter by type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {entityTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {filtered && filtered.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <History  data-icon="inline-start"/>
            </EmptyMedia>
            <EmptyTitle>No activity yet.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}

      {filtered && filtered.length > 0 && (
        <Card className="block py-0 overflow-hidden divide-y divide-border">
          {filtered.map((event) => (
            <ActivityRow
              key={event.id}
              event={event}
              agentMap={agentMap}
              userProfileMap={userProfileMap}
              entityNameMap={entityNameMap}
              entityTitleMap={entityTitleMap}
            />
          ))}
        </Card>
      )}
    </div>
  );
}
