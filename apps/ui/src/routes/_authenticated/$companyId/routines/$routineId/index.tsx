import { RoutineDetailScreen } from "@/routes/_authenticated/$companyId/routines/$routineId/-detail/-RoutineDetailScreen";
import { loadCompanyRoutine } from "@/routes/-company-entity-loader";
import { createFileRoute } from "@tanstack/react-router";

export { RoutineDetailScreen as RoutineDetail } from "@/routes/_authenticated/$companyId/routines/$routineId/-detail/-RoutineDetailScreen";

export const Route = createFileRoute("/_authenticated/$companyId/routines/$routineId/")({
  loader: ({ abortController, context, params }) =>
    loadCompanyRoutine({
      queryClient: context.queryClient,
      companyId: params.companyId,
      entityId: params.routineId,
      signal: abortController.signal,
    }),
  component: RoutineOverviewRoute,
});

function RoutineOverviewRoute() {
  const { companyId, routineId } = Route.useParams();
  return <RoutineDetailScreen companyId={companyId} routineId={routineId} />;
}
