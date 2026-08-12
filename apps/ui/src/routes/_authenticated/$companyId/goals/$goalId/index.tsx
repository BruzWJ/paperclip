import { createFileRoute } from "@tanstack/react-router";
import { loadCompanyGoal } from "@/routes/-company-entity-loader";
import { useEffect, useRef } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { goalsApi } from "@/api/goals";
import { projectsApi } from "@/api/projects";
import { assetsApi } from "@/api/assets";
import { usePanel } from "@/context/PanelContext";
import { useDialogActions } from "@/context/DialogContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { GoalProperties } from "@/components/GoalProperties";
import { GoalTree } from "@/components/GoalTree";
import { StatusBadge } from "@/components/StatusBadge";
import { InlineEditor } from "@/components/InlineEditor";
import { EntityRow } from "@/components/EntityRow";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, SlidersHorizontal } from "lucide-react";

export const Route = createFileRoute(
  "/_authenticated/$companyId/goals/$goalId/",
)({
  loader: ({ abortController, context, params }) =>
    loadCompanyGoal({
      queryClient: context.queryClient,
      companyId: params.companyId,
      entityId: params.goalId,
      signal: abortController.signal,
    }),
  component: GoalDetail,
});

const route = getRouteApi("/_authenticated/$companyId/goals/$goalId/");

interface GoalPropertiesToggleButtonProps {
  panelVisible: boolean;
  onShowProperties: () => void;
}

export function GoalPropertiesToggleButton({
  panelVisible,
  onShowProperties,
}: GoalPropertiesToggleButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn(
        "hidden md:inline-flex shrink-0 transition-opacity duration-200",
        panelVisible
          ? "opacity-0 pointer-events-none w-0 overflow-hidden"
          : "opacity-100",
      )}
      onClick={onShowProperties}
      title="Show properties"
    >
      <SlidersHorizontal className="h-4 w-4" />
    </Button>
  );
}

function GoalDetail() {
  const { companyId, goalId } = route.useParams();
  const { openNewGoal } = useDialogActions();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const goalPropertyUpdateInFlightRef = useRef(false);

  const {
    data: goal,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.goals.detail(goalId),
    queryFn: () => goalsApi.get(goalId),
  });
  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
  });

  const { data: allProjects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });

  const updateGoal = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      goalsApi.update(goalId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.detail(goalId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.list(companyId),
      });
    },
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      return assetsApi.uploadImage(
        companyId,
        file,
        `goals/${goalId ?? "draft"}`,
      );
    },
  });
  const isPending = updateGoal.isPending || uploadImage.isPending;

  const childGoals = (allGoals ?? []).filter((g) => g.parentId === goalId);
  const linkedProjects = (allProjects ?? []).filter((p) => {
    if (!goalId) return false;
    if (p.goalIds.includes(goalId)) return true;
    return p.goals.some((goalRef) => goalRef.id === goalId);
  });

  useEffect(() => {
    setBreadcrumbs([
      {
        label: "Goals",
        renderLink: (content) => (
          <Link to="/$companyId/goals" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      { label: goal?.title ?? goalId ?? "Goal" },
    ]);
  }, [companyId, setBreadcrumbs, goal, goalId]);

  useEffect(() => {
    if (goal) {
      openPanel(
        <GoalProperties
          goal={goal}
          onUpdate={(data) => {
            if (goalPropertyUpdateInFlightRef.current) return;
            goalPropertyUpdateInFlightRef.current = true;
            updateGoal.mutate(data, {
              onSettled: () => {
                goalPropertyUpdateInFlightRef.current = false;
              },
            });
          }}
        />,
      );
    }
    return () => closePanel();
  }, [goal]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!goal) return null;

  return (
    <div className="space-y-6">
      <div className="space-y-3" aria-busy={isPending}>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase text-muted-foreground">
            {goal.level}
          </span>
          <StatusBadge status={goal.status} />
          <div className="ml-auto">
            <GoalPropertiesToggleButton
              panelVisible={panelVisible}
              onShowProperties={() => setPanelVisible(true)}
            />
          </div>
        </div>

        <fieldset className="contents" disabled={isPending}>
          <legend className="sr-only">Goal details</legend>
          <InlineEditor
            value={goal.title}
            onSave={(title) => updateGoal.mutateAsync({ title })}
            as="h2"
            className="text-xl font-bold"
          />

          <InlineEditor
            value={goal.description ?? ""}
            onSave={(description) => updateGoal.mutateAsync({ description })}
            as="p"
            className="text-sm text-muted-foreground"
            placeholder="Add a description..."
            multiline
            imageUploadHandler={async (file) => {
              const asset = await uploadImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
        </fieldset>
        {isPending ? (
          <p className="text-xs text-muted-foreground" role="status">
            {uploadImage.isPending
              ? "Uploading goal image…"
              : "Saving goal changes…"}
          </p>
        ) : null}
      </div>

      <Tabs defaultValue="children">
        <TabsList>
          <TabsTrigger value="children">
            Sub-Goals ({childGoals.length})
          </TabsTrigger>
          <TabsTrigger value="projects">
            Projects ({linkedProjects.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="children" className="mt-4 space-y-3">
          <div className="flex items-center justify-start">
            <Button
              size="sm"
              variant="outline"
              onClick={() => openNewGoal({ parentId: goalId })}
            >
              <Plus data-icon="inline-start" className="h-3.5 w-3.5 mr-1.5" />
              Sub Goal
            </Button>
          </div>
          {childGoals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sub-goals.</p>
          ) : (
            <GoalTree goals={childGoals} linkGoals />
          )}
        </TabsContent>

        <TabsContent value="projects" className="mt-4">
          {linkedProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground">No linked projects.</p>
          ) : (
            <div className="border border-border">
              {linkedProjects.map((project) => (
                <EntityRow
                  key={project.id}
                  title={project.name}
                  subtitle={project.description ?? undefined}
                  linkOptions={{
                    to: "/$companyId/projects/$projectId",
                    params: { companyId, projectId: project.id },
                  }}
                  trailing={<StatusBadge status={project.status} />}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
