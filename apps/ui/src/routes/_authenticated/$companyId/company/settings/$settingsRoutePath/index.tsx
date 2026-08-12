import { createFileRoute, notFound } from "@tanstack/react-router";
import { PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS } from "@paperclipai/shared";
import { useEffect, useMemo } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { NotFoundPage } from "@/components/NotFoundPage";

const BUILT_IN_SETTINGS_ROUTES = new Set<string>(
  PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS,
);

export const Route = createFileRoute(
  "/_authenticated/$companyId/company/settings/$settingsRoutePath/",
)({
  beforeLoad: ({ params }) => {
    if (BUILT_IN_SETTINGS_ROUTES.has(params.settingsRoutePath)) {
      throw notFound();
    }
  },
  component: CompanySettingsPluginPage,
});

const route = getRouteApi(
  "/_authenticated/$companyId/company/settings/$settingsRoutePath/",
);

function CompanySettingsPluginPage() {
  const { companyId: routeCompanyId, settingsRoutePath } = route.useParams();
  const { companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const routeCompany = useMemo(
    () => companies.find((company) => company.id === routeCompanyId) ?? null,
    [companies, routeCompanyId],
  );
  const resolvedCompanyId = routeCompany?.id ?? null;

  const { slots, isLoading, errorMessage } = usePluginSlots({
    slotTypes: ["companySettingsPage"],
    enabled: Boolean(resolvedCompanyId && settingsRoutePath),
  });

  const pageSlots = useMemo(() => {
    if (!settingsRoutePath) return [];
    return slots.filter((slot) => slot.routePath === settingsRoutePath);
  }, [settingsRoutePath, slots]);

  const pageSlot = pageSlots.length === 1 ? pageSlots[0]! : null;

  useEffect(() => {
    if (!pageSlot) return;
    setBreadcrumbs([
      {
        label: "Settings",
        renderLink: (content) => (
          <Link
            to="/$companyId/company/settings"
            params={{ companyId: routeCompanyId }}
          >
            {content}
          </Link>
        ),
      },
      { label: pageSlot.displayName },
    ]);
  }, [pageSlot, routeCompanyId, setBreadcrumbs]);

  if (!resolvedCompanyId) {
    return (
      <NotFoundPage
        scope="invalid_company_id"
        requestedCompanyId={routeCompanyId}
      />
    );
  }

  if (!settingsRoutePath || isLoading) {
    return (
      <div className="text-sm text-muted-foreground" role="status">
        Loading...
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div
        className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        role="alert"
      >
        Plugin extensions unavailable: {errorMessage}
      </div>
    );
  }

  if (pageSlots.length > 1) {
    return (
      <div
        className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        role="alert"
      >
        Multiple plugins declare the company settings route{" "}
        <code>{settingsRoutePath}</code>. Disable one plugin or change its
        route.
      </div>
    );
  }

  if (!pageSlot) {
    return <NotFoundPage scope="board" />;
  }

  return (
    <PluginSlotMount
      slot={pageSlot}
      context={{ companyId: resolvedCompanyId }}
      className="min-h-(--sz-200px)"
      missingBehavior="placeholder"
    />
  );
}
