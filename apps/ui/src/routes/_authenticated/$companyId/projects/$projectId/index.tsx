import { ProjectDetailScreen } from "@/components/projects/ProjectDetailScreen";
import { PROJECT_PLUGIN_TAB_PATTERN } from "@/lib/project-detail-tabs";
import { loadCompanyProject } from "@/routes/-company-entity-loader";
import { assertOnlySearchKeys, optionalSearchPattern } from "@/routes/-search";
import { createFileRoute } from "@tanstack/react-router";

export { ProjectDetailScreen as ProjectDetail } from "@/components/projects/ProjectDetailScreen";

export function validateProjectDetailSearch(search: Record<string, unknown>): {
  tab?: string;
} {
  assertOnlySearchKeys(search, ["tab"]);
  return {
    tab: optionalSearchPattern(
      search.tab,
      "tab",
      PROJECT_PLUGIN_TAB_PATTERN,
      "must be an exact plugin:<plugin-key>:<slot-id> token",
    ),
  };
}

export const Route = createFileRoute("/_authenticated/$companyId/projects/$projectId/")({
  validateSearch: validateProjectDetailSearch,
  loader: ({ abortController, context, params }) =>
    loadCompanyProject({
      queryClient: context.queryClient,
      companyId: params.companyId,
      entityId: params.projectId,
      signal: abortController.signal,
    }),
  component: ProjectIndexRoute,
});

function ProjectIndexRoute() {
  const { companyId, projectId } = Route.useParams();
  const { tab } = Route.useSearch();
  return (
    <ProjectDetailScreen companyId={companyId} projectId={projectId} variant="overview" pluginTab={tab} />
  );
}
