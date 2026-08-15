import { ProjectDetailScreen } from "@/routes/_authenticated/$companyId/projects/$projectId/-detail/-ProjectDetailScreen";
import { loadCompanyProject } from "@/routes/-company-entity-loader";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/$companyId/projects/$projectId/tasks/")({
  loader: ({ abortController, context, params }) =>
    loadCompanyProject({
      queryClient: context.queryClient,
      companyId: params.companyId,
      entityId: params.projectId,
      signal: abortController.signal,
    }),
  component: ProjectTasksRoute,
});

function ProjectTasksRoute() {
  const { companyId, projectId } = Route.useParams();
  return <ProjectDetailScreen companyId={companyId} projectId={projectId} variant="tasks" />;
}
