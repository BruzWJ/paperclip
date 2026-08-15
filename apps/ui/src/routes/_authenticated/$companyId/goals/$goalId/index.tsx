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
import { GoalProperties } from "@/routes/_authenticated/$companyId/goals/$goalId/-GoalProperties";
import { GoalTree } from "@/routes/_authenticated/$companyId/goals/-GoalTree";
import { InlineEditor } from "@/routes/_authenticated/$companyId/-markdown/-InlineEditor";
import { Skeleton } from "@/components/ui/skeleton";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, SlidersHorizontal } from "lucide-react";

export const Route = createFileRoute("/_authenticated/$companyId/goals/$goalId/")({
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
    mutationFn: (data: Record<string, unknown>) => goalsApi.update(goalId!, data),
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
      return assetsApi.uploadImage(companyId, file, `goals/${goalId ?? "draft"}`);
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

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (error)
    return (
      <Alert variant="destructive">
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  if (!goal) return null;

  return (
    <div className="space-y-6">
      <div className="space-y-3" aria-busy={isPending}>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase text-muted-foreground">{goal.level}</span>
          <DomainStatus status={goal.status} />
          <div className="ml-auto">
            <Button
              variant="ghost"
              size="icon-xs"
              className={`hidden shrink-0 overflow-hidden transition-opacity duration-200 md:inline-flex ${panelVisible ? "pointer-events-none w-0 opacity-0" : "opacity-100"}`}
              onClick={() => setPanelVisible(true)}
              title="Show properties"
            >
              <SlidersHorizontal className="h-4 w-4"  data-icon="inline-start"/>
            </Button>
          </div>
        </div>

        <FieldSet className="contents" disabled={isPending}>
          <FieldLegend className="sr-only">Goal details</FieldLegend>
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
        </FieldSet>
        {isPending ? (
          <p className="text-xs text-muted-foreground" role="status">
            {uploadImage.isPending ? "Uploading goal image…" : "Saving goal changes…"}
          </p>
        ) : null}
      </div>

      <Tabs defaultValue="children">
        <TabsList>
          <TabsTrigger value="children">Sub-Goals ({childGoals.length})</TabsTrigger>
          <TabsTrigger value="projects">Projects ({linkedProjects.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="children" className="mt-4 space-y-3">
          <div className="flex items-center justify-start">
            <Button size="sm" variant="outline" onClick={() => openNewGoal({ parentId: goalId })}>
              <Plus data-icon="inline-start" className="h-3.5 w-3.5 mr-1.5" />
              Sub Goal
            </Button>
          </div>
          {childGoals.length === 0 ? (
            <Empty className="border-0 p-4 md:p-4">
              <EmptyDescription>No sub-goals.</EmptyDescription>
            </Empty>
          ) : (
            <GoalTree goals={childGoals} linkGoals />
          )}
        </TabsContent>

        <TabsContent value="projects" className="mt-4">
          {linkedProjects.length === 0 ? (
            <Empty className="border-0 p-4 md:p-4">
              <EmptyDescription>No linked projects.</EmptyDescription>
            </Empty>
          ) : (
            <ItemGroup className="overflow-hidden rounded-md border">
              {linkedProjects.map((project) => (
                <Item key={project.id} asChild size="sm">
                  <Link
                    to="/$companyId/projects/$projectId"
                    params={{ companyId, projectId: project.id }}
                    className="no-underline"
                  >
                    <ItemContent>
                      <ItemTitle>{project.name}</ItemTitle>
                      {project.description ? <ItemDescription>{project.description}</ItemDescription> : null}
                    </ItemContent>
                    <ItemActions>
                      <DomainStatus status={project.status} />
                    </ItemActions>
                  </Link>
                </Item>
              ))}
            </ItemGroup>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
