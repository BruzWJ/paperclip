import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { MembershipAction } from "@/components/MembershipAction";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { formatDate, formatNumber, formatProjectBudget } from "@/lib/utils";
import { statusBadgeVariant } from "@/lib/status-variant";
import { getProjectIcon } from "@/lib/project-icons";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "@/hooks/useResourceMemberships";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowUpDown, Check, Hexagon, Plus, Star } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";

export const Route = createFileRoute("/_authenticated/$companyId/projects/")({
  component: Projects,
});

type ProjectSortField = "name" | "updated" | "created" | "targetDate";

type ProjectSortDir = "asc" | "desc";

const PROJECT_SORT_OPTIONS: Array<{ field: ProjectSortField; label: string }> = [
  { field: "name", label: "Name" },
  { field: "updated", label: "Updated" },
  { field: "created", label: "Created" },
  { field: "targetDate", label: "Target date" },
];

function compareProjectNames(left: Project, right: Project) {
  const nameDiff = left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
  });
  return nameDiff !== 0 ? nameDiff : left.id.localeCompare(right.id);
}

function projectTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function compareOptionalTime(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined,
  sortDir: ProjectSortDir,
) {
  const leftTime = projectTime(left);
  const rightTime = projectTime(right);
  if (leftTime === null && rightTime === null) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return sortDir === "asc" ? leftTime - rightTime : rightTime - leftTime;
}

function sortProjects(projects: Project[], sortField: ProjectSortField, sortDir: ProjectSortDir) {
  return [...projects].sort((left, right) => {
    let comparison = 0;
    if (sortField === "name") {
      comparison = compareProjectNames(left, right);
      return sortDir === "asc" ? comparison : -comparison;
    }

    if (sortField === "updated") comparison = compareOptionalTime(left.updatedAt, right.updatedAt, sortDir);
    else if (sortField === "created")
      comparison = compareOptionalTime(left.createdAt, right.createdAt, sortDir);
    else comparison = compareOptionalTime(left.targetDate, right.targetDate, sortDir);

    if (comparison === 0) comparison = compareProjectNames(left, right);
    return comparison;
  });
}

function Projects() {
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const { openNewProject } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [sortField, setSortField] = useState<ProjectSortField>("name");
  const [sortDir, setSortDir] = useState<ProjectSortDir>("asc");

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const {
    data: allProjects,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const membershipsQuery = useResourceMemberships(companyId);
  const membershipMutation = useResourceMembershipMutation(companyId);
  const projects = useMemo(() => (allProjects ?? []).filter((p) => !p.archivedAt), [allProjects]);
  const sortedProjects = useMemo(
    () => sortProjects(projects, sortField, sortDir),
    [projects, sortDir, sortField],
  );
  const groupedProjects = useMemo(() => {
    const groups = {
      mine: [] as typeof sortedProjects,
      other: [] as typeof sortedProjects,
    };

    for (const project of sortedProjects) {
      const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
      if (state === "left") groups.other.push(project);
      else groups.mine.push(project);
    }

    return groups;
  }, [membershipsQuery.data, sortedProjects]);
  const sortLabel = PROJECT_SORT_OPTIONS.find((option) => option.field === sortField)?.label ?? "Name";

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="w-fit text-xs" title="Sort">
              <ArrowUpDown data-icon="inline-start" className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
              <span>Sort: {sortLabel}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            {PROJECT_SORT_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.field}
                className="justify-between"
                onSelect={() => {
                  if (sortField === option.field) {
                    setSortDir((current) => (current === "asc" ? "desc" : "asc"));
                    return;
                  }
                  setSortField(option.field);
                  setSortDir(option.field === "name" || option.field === "targetDate" ? "asc" : "desc");
                }}
              >
                <span>{option.label}</span>
                {sortField === option.field ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Check className="h-3 w-3" />
                    {sortDir === "asc" ? "Asc" : "Desc"}
                  </span>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="outline" onClick={openNewProject}>
          <Plus data-icon="inline-start" className="h-4 w-4 mr-1" />
          Add Project
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {!isLoading && projects.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Hexagon />
            </EmptyMedia>
            <EmptyTitle>No projects yet.</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={openNewProject}>
              <Plus />
              Add Project
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {projects.length > 0 && (
        <div className="space-y-6">
          {(
            [
              ["My Projects", groupedProjects.mine],
              ["Other Projects", groupedProjects.other],
            ] as const
          ).map(([label, sectionProjects]) => {
            if (sectionProjects.length === 0) return null;

            return (
              <section key={label} className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">{label}</h2>
                  <span className="text-xs text-muted-foreground">
                    {sectionProjects.length} project
                    {sectionProjects.length === 1 ? "" : "s"}
                  </span>
                </div>
                <Card className="block py-0 overflow-hidden divide-y divide-border">
                  {sectionProjects.map((project) => {
                    const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
                    const pending =
                      membershipMutation.isPending &&
                      membershipMutation.variables?.resourceType === "project" &&
                      membershipMutation.variables.resourceId === project.id;
                    const starPending = pending && membershipMutation.variables?.starred !== undefined;
                    const joinLeavePending = pending && membershipMutation.variables?.starred === undefined;
                    const starred = isStarred(membershipsQuery.data, "project", project.id);
                    const ProjectIcon = getProjectIcon(project.icon);
                    return (
                      <Item
                        key={project.id}
                        size="sm"
                        className={state === "left" ? "text-foreground/55" : undefined}
                      >
                        <ItemMedia>
                          <Avatar
                            size="sm"
                            style={{
                              backgroundColor: project.color ?? undefined,
                            }}
                            aria-hidden="true"
                          >
                            <AvatarFallback className={project.color ? "bg-transparent" : undefined}>
                              <ProjectIcon />
                            </AvatarFallback>
                          </Avatar>
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>
                            <Link
                              to="/$companyId/projects/$projectId"
                              params={{ companyId, projectId: project.id }}
                            >
                              {project.name}
                            </Link>
                          </ItemTitle>
                          <ItemDescription>{project.description || "\u00a0"}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <div className="flex items-center gap-3">
                            <span
                              className="hidden text-xs text-muted-foreground tabular-nums sm:inline"
                              title={`${formatNumber(project.taskCount ?? 0)} task${(project.taskCount ?? 0) === 1 ? "" : "s"}`}
                            >
                              {formatNumber(project.taskCount ?? 0)} task
                              {(project.taskCount ?? 0) === 1 ? "" : "s"}
                            </span>
                            {project.budget && selectedCompany && (
                              <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                                {formatProjectBudget(project.budget, selectedCompany.budgetCurrency)}
                              </span>
                            )}
                            {project.targetDate && (
                              <span className="hidden text-xs text-muted-foreground md:inline">
                                {formatDate(project.targetDate)}
                              </span>
                            )}
                            <Badge variant={statusBadgeVariant(project.status)}>
                              {project.status.replace(/[_-]/g, " ")}
                            </Badge>
                            <MembershipAction
                              state={state}
                              pending={joinLeavePending}
                              pendingState={joinLeavePending ? membershipMutation.variables?.state : null}
                              resourceName={project.name}
                              onJoin={() =>
                                membershipMutation.mutate({
                                  resourceType: "project",
                                  resourceId: project.id,
                                  resourceName: project.name,
                                  state: "joined",
                                })
                              }
                              onLeave={() =>
                                membershipMutation.mutate({
                                  resourceType: "project",
                                  resourceId: project.id,
                                  resourceName: project.name,
                                  state: "left",
                                })
                              }
                            />
                            <Toggle
                              size="sm"
                              pressed={starred}
                              aria-label={`${starred ? "Unstar" : "Star"} ${project.name}`}
                              aria-busy={starPending ? "true" : undefined}
                              disabled={starPending}
                              className="h-6 w-6 shrink-0 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                membershipMutation.mutate({
                                  resourceType: "project",
                                  resourceId: project.id,
                                  resourceName: project.name,
                                  starred: !starred,
                                });
                              }}
                            >
                              {starPending ? (
                                <Spinner />
                              ) : (
                                <Star className={starred ? "fill-current" : undefined} />
                              )}
                            </Toggle>
                          </div>
                        </ItemActions>
                      </Item>
                    );
                  })}
                </Card>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
