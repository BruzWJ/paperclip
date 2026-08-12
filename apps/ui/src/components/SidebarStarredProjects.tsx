import { useCallback, useMemo } from "react";
import { Link, useMatches } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useQuery } from "@tanstack/react-query";
import { Loader2, LogOut, MoreHorizontal, Star } from "lucide-react";
import { useSidebar } from "../context/SidebarContext";
import { projectsApi } from "../api/projects";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import {
  isStarred,
  starredResourceIds,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { ProjectTile } from "./ProjectTile";
import { StarToggle } from "./StarToggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Project } from "@paperclipai/shared";

// Sidebar star reveals with the row's own group, not the shared unnamed group.
const STAR_ROW_REVEAL =
  "opacity-0 transition-opacity group-hover/starred-project:opacity-100 group-focus-within/starred-project:opacity-100";

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
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      );
  }, [membershipsQuery.data, membershipsQuery.isSuccess, projects]);

  const unstar = useCallback(
    (project: Project) => membershipMutation.mutate({
      resourceType: "project",
      resourceId: project.id,
      resourceName: project.name,
      starred: false,
    }),
    [membershipMutation],
  );
  const leave = useCallback(
    (project: Project) => membershipMutation.mutate({
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
    <div className="flex flex-col gap-0.5" aria-label="Starred projects">
      {starredProjects.map((project) => {
        const projectId = project.id;
        const isActive = activeProjectId === projectId;
        const pending = pendingFor(project);
        const unstarPending = pending && membershipMutation.variables?.starred === false;
        const leavePending = pending && membershipMutation.variables?.state === "left";
        const starred = isStarred(membershipsQuery.data, "project", project.id);

        const link = (
          <Link
            to="/$companyId/projects/$projectId/tasks"
            params={{ companyId, projectId }}
            state={SIDEBAR_SCROLL_RESET_STATE}
            onClick={() => {
              if (isMobile) setSidebarOpen(false);
            }}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 pr-8 text-(length:--text-compact) font-medium transition-colors",
              !rail && "pl-6",
              isActive
                ? "bg-accent text-foreground"
                : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <ProjectTile color={project.color ?? null} icon={project.icon ?? null} size="xs" />
            <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "flex-1 truncate"}>{project.name}</span>
            {!rail && project.pauseReason === "budget" ? (
              <BudgetSidebarMarker title="Project paused by budget" />
            ) : null}
          </Link>
        );

        return (
          <div key={project.id} className="group/starred-project relative flex items-center">
            {rail ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="min-w-0 flex-1">{link}</div>
                </TooltipTrigger>
                <TooltipContent side="right">{project.name}</TooltipContent>
              </Tooltip>
            ) : (
              link
            )}

            {!rail && !isMobile ? (
              // Desktop: quiet inline unstar revealed on hover/focus.
              <span className="absolute right-3 top-1/2 -translate-y-1/2">
                <StarToggle
                  size="row"
                  quiet
                  starred={starred}
                  pending={unstarPending}
                  resourceName={project.name}
                  onToggle={() => unstar(project)}
                  revealClassName={STAR_ROW_REVEAL}
                />
              </span>
            ) : null}

            {!rail && isMobile ? (
              // Touch: explicit ⋯ menu (no hover). Star action + separated Leave.
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="absolute right-3 top-1/2 h-6 w-6 -translate-y-1/2 opacity-100"
                    aria-label={`Open actions for ${project.name}`}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
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
                      <Loader2 className="size-4 motion-safe:animate-spin" />
                    ) : (
                      <Star className="size-4 fill-amber-500 text-amber-500" />
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
                    {leavePending ? (
                      <Loader2 className="size-4 motion-safe:animate-spin" />
                    ) : (
                      <LogOut className="size-4" />
                    )}
                    <span>Leave project</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
