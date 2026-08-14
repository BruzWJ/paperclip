import { ProjectDetailScreen } from "@/components/projects/ProjectDetailScreen";
import { loadCompanyProject } from "@/routes/-company-entity-loader";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/$companyId/projects/$projectId/configuration/")({
  loader: ({ abortController, context, params }) =>
    loadCompanyProject({
      queryClient: context.queryClient,
      companyId: params.companyId,
      entityId: params.projectId,
      signal: abortController.signal,
    }),
  component: ProjectConfigurationRoute,
});

function ProjectConfigurationRoute() {
  const { companyId, projectId } = Route.useParams();
  return <ProjectDetailScreen companyId={companyId} projectId={projectId} variant="configuration" />;
}
