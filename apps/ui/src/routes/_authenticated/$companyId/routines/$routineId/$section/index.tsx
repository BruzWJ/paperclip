import { createFileRoute, notFound } from "@tanstack/react-router";
import { RoutineDetail } from "@/routes/_authenticated/$companyId/routines/$routineId";
import { loadCompanyRoutine } from "@/routes/-company-entity-loader";
import {
  ROUTINE_SECTION_KEYS,
  type RoutineSectionKey,
} from "@/components/routine-sections/context";

function isRoutineDetailSection(
  value: string,
): value is Exclude<RoutineSectionKey, "overview"> {
  return ROUTINE_SECTION_KEYS.some(
    (section) => section !== "overview" && section === value,
  );
}

export const Route = createFileRoute(
  "/_authenticated/$companyId/routines/$routineId/$section/",
)({
  loader: async ({ abortController, context, params }) => {
    if (!isRoutineDetailSection(params.section)) {
      throw notFound();
    }
    await loadCompanyRoutine({
      queryClient: context.queryClient,
      companyId: params.companyId,
      entityId: params.routineId,
      signal: abortController.signal,
    });
    return { section: params.section };
  },
  component: RoutineSectionRoute,
});

function RoutineSectionRoute() {
  const { companyId, routineId } = Route.useParams();
  const { section } = Route.useLoaderData();
  return (
    <RoutineDetail
      companyId={companyId}
      routineId={routineId}
      section={section}
    />
  );
}
