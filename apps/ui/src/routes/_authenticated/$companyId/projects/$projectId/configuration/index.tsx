import { createFileRoute } from "@tanstack/react-router";
import { ProjectDetail } from "@/routes/_authenticated/$companyId/projects/$projectId";
import { loadCompanyProject } from "@/routes/-company-entity-loader";

export const Route = createFileRoute(
  "/_authenticated/$companyId/projects/$projectId/configuration/",
)({
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
  return (
    <ProjectDetail
      companyId={companyId}
      projectId={projectId}
      variant="configuration"
    />
  );
}
