import { Spinner } from "@/components/ui/spinner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { useCallback, useMemo } from "react";
import { Link, useMatches } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useQuery } from "@tanstack/react-query";
import { LogOut, MoreHorizontal, Star } from "lucide-react";
import { useSidebar } from "../context/SidebarContext";
import { projectsApi } from "../api/projects";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { getProjectIcon } from "../lib/project-icons";
import { cn } from "../lib/utils";
import {
  isStarred,
  starredResourceIds,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import { Toggle } from "@/components/ui/toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import type { Project } from "@paperclipai/shared";

/**
 * Compact starred-project children rendered directly below the top-level
 * `Projects` nav row in the sidebar. Starring/unstarring itself
 * happens from browse/detail surfaces; here we only ever *remove* a star
 * (plus the existing leave affordance). Archived projects are filtered out
 * server-side, so a stale star never resurrects a hidden project.
 */
export function SidebarStarredProjects() {
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const companyId = useCompanyRouteId();
  const activeProjectId = useMatches({
    select: (matches) => {
      for (const match of matches) {
        const projectId = Reflect.get(match.params, "projectId");
        if (typeof projectId === "string") return projectId;
      }
      return null;
    },
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const membershipsQuery = useResourceMemberships(companyId);
  const membershipMutation = useResourceMembershipMutation(companyId);

  const starredProjects = useMemo(() => {
    if (!membershipsQuery.isSuccess) return [];
    const starredIds = new Set(starredResourceIds(membershipsQuery.data, "project"));
    if (starredIds.size === 0) return [];
    const byId = new Map((projects ?? []).map((project: Project) => [project.id, project]));
    return Array.from(starredIds)
      .map((id) => byId.get(id))
      .filter((project): project is Project => !!project && !project.archivedAt)
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  }, [membershipsQuery.data, membershipsQuery.isSuccess, projects]);

  const unstar = useCallback(
    (project: Project) =>
      membershipMutation.mutate({
        resourceType: "project",
        resourceId: project.id,
        resourceName: project.name,
        starred: false,
      }),
    [membershipMutation],
  );
  const leave = useCallback(
    (project: Project) =>
      membershipMutation.mutate({
        resourceType: "project",
        resourceId: project.id,
        resourceName: project.name,
        state: "left",
      }),
    [membershipMutation],
  );
  const pendingFor = useCallback(
    (project: Project) =>
      membershipMutation.isPending &&
      membershipMutation.variables?.resourceType === "project" &&
      membershipMutation.variables.resourceId === project.id,
    [membershipMutation.isPending, membershipMutation.variables],
  );

  // Don't render anything until memberships load — no skeleton flash in the nav.
  if (!membershipsQuery.isSuccess) return null;

  // Empty starred groups should not add a placeholder row or extra sidebar spacing.
  if (starredProjects.length === 0) {
    return null;
  }

  return (
    <SidebarMenu aria-label="Starred projects">
      {starredProjects.map((project) => {
        const projectId = project.id;
        const isActive = activeProjectId === projectId;
        const pending = pendingFor(project);
        const unstarPending = pending && membershipMutation.variables?.starred === false;
        const leavePending = pending && membershipMutation.variables?.state === "left";
        const starred = isStarred(membershipsQuery.data, "project", project.id);
        const ProjectIcon = getProjectIcon(project.icon);

        return (
          <SidebarMenuItem key={project.id} className="group/starred-project flex items-center">
            <SidebarMenuButton
              asChild
              isActive={isActive}
              tooltip={rail ? project.name : undefined}
              className={cn("min-w-0 flex-1", !rail && "pl-6 pr-8")}
            >
              <Link
                to="/$companyId/projects/$projectId/tasks"
                params={{ companyId, projectId }}
                state={SIDEBAR_SCROLL_RESET_STATE}
                onClick={() => {
                  if (isMobile) setSidebarOpen(false);
                }}
              >
                <Avatar size="sm" style={{ backgroundColor: project.color ?? undefined }} aria-hidden="true">
                  <AvatarFallback className={project.color ? "bg-transparent" : undefined}>
                    <ProjectIcon />
                  </AvatarFallback>
                </Avatar>
                <span className="flex-1 truncate">{project.name}</span>
                {!rail && project.pauseReason === "budget" ? (
                  <DomainStatus status="hard_stop" title="Project paused by budget">
                    <span className="sr-only">Project paused by budget</span>
                  </DomainStatus>
                ) : null}
              </Link>
            </SidebarMenuButton>

            {!rail && !isMobile ? (
              // Desktop: quiet inline unstar revealed on hover/focus.
              <span className="absolute right-3 top-1/2 -translate-y-1/2">
                <Toggle
                  size="sm"
                  pressed={starred}
                  disabled={unstarPending}
                  aria-label={`Unstar ${project.name}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    unstar(project);
                  }}
                >
                  {unstarPending ? <Spinner /> : <Star />}
                </Toggle>
              </span>
            ) : null}

            {!rail && isMobile ? (
              // Touch: explicit ⋯ menu (no hover). Star action + separated Leave.
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuAction aria-label={`Open actions for ${project.name}`}>
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </SidebarMenuAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem
                    onClick={() => {
                      if (pending) return;
                      unstar(project);
                    }}
                    disabled={pending}
                  >
                    {unstarPending ? (
                      <Spinner className="size-4" />
                    ) : (
                      <Star className="size-4 fill-current" />
                    )}
                    <span>Remove from starred</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      if (pending) return;
                      leave(project);
                    }}
                    disabled={pending}
                  >
                    {leavePending ? <Spinner className="size-4" /> : <LogOut className="size-4" />}
                    <span>Leave project</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
