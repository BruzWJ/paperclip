import { createFileRoute, notFound } from "@tanstack/react-router";
import { PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS } from "@paperclipai/shared";
import { useEffect, useMemo } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";

const BUILT_IN_SETTINGS_ROUTES = new Set<string>(PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS);

export const Route = createFileRoute("/_authenticated/$companyId/company/settings/$settingsRoutePath/")({
  beforeLoad: ({ params }) => {
    if (BUILT_IN_SETTINGS_ROUTES.has(params.settingsRoutePath)) {
      throw notFound();
    }
  },
  component: CompanySettingsPluginPage,
});

const route = getRouteApi("/_authenticated/$companyId/company/settings/$settingsRoutePath/");

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
          <Link to="/$companyId/company/settings" params={{ companyId: routeCompanyId }}>
            {content}
          </Link>
        ),
      },
      { label: pageSlot.displayName },
    ]);
  }, [pageSlot, routeCompanyId, setBreadcrumbs]);

  if (!resolvedCompanyId) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Company not found</EmptyTitle>
          <EmptyDescription>No company matches UUID &quot;{routeCompanyId}&quot;.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (!settingsRoutePath || isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading...
      </div>
    );
  }

  if (errorMessage) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Plugin extensions unavailable: {errorMessage}</AlertDescription>
      </Alert>
    );
  }

  if (pageSlots.length > 1) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Multiple plugins declare the company settings route <code>{settingsRoutePath}</code>. Disable one
          plugin or change its route.
        </AlertDescription>
      </Alert>
    );
  }

  if (!pageSlot) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Page not found</EmptyTitle>
          <EmptyDescription>No plugin provides this settings page.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
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
