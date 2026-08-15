import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { ActiveAgentsPanel } from "@/routes/_authenticated/$companyId/dashboard/-ActiveAgentsPanel";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";

export const Route = createFileRoute(
  "/_authenticated/$companyId/dashboard/live/",
)({ component: DashboardLive });

const DASHBOARD_LIVE_RUN_LIMIT = 50;

function DashboardLive() {
  const companyId = useCompanyRouteId();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      {
        label: "Dashboard",
        renderLink: (content) => (
          <Link to="/$companyId/dashboard" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      { label: "Live runs" },
    ]);
  }, [companyId, setBreadcrumbs]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            to="/$companyId/dashboard"
            params={{ companyId }}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Dashboard
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">
            Live agent runs
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Active runs first, followed by the most recent completed runs.
          </p>
        </div>
        <div className="text-sm text-muted-foreground">
          Showing up to {DASHBOARD_LIVE_RUN_LIMIT}
        </div>
      </div>

      <ActiveAgentsPanel
        companyId={companyId}
        title="Active / recent"
        minRunCount={DASHBOARD_LIVE_RUN_LIMIT}
        fetchLimit={DASHBOARD_LIVE_RUN_LIMIT}
        cardLimit={DASHBOARD_LIVE_RUN_LIMIT}
        gridClassName="gap-3 md:grid-cols-2 2xl:grid-cols-3"
        cardClassName="h-(--sz-420px)"
        emptyMessage="No active or recent agent runs."
        queryScope="dashboard-live"
        showMoreLink={false}
      />
    </div>
  );
}
