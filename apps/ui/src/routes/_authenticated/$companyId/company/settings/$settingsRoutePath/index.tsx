import { createFileRoute, notFound } from "@tanstack/react-router";
import { PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS } from "@paperclipai/shared";
import { useMemo } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useSettingsBreadcrumbs } from "@/hooks/useSettingsBreadcrumbs";
import { useCompany } from "@/context/CompanyContext";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { PluginRouteBoundary } from "@/components/patterns/PluginRouteBoundary";

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

  useSettingsBreadcrumbs({
    companyId: routeCompanyId,
    enabled: Boolean(pageSlot),
    page: pageSlot?.displayName ?? "Settings",
  });

  return (
    <PluginRouteBoundary
      resolvedCompanyId={resolvedCompanyId}
      requestedCompanyId={routeCompanyId}
      loading={!settingsRoutePath || isLoading}
      errorMessage={errorMessage}
    >
      {pageSlots.length > 1 ? (
        <Alert variant="destructive">
          <AlertDescription>
            Multiple plugins declare the company settings route <code>{settingsRoutePath}</code>. Disable one
            plugin or change its route.
          </AlertDescription>
        </Alert>
      ) : pageSlot && resolvedCompanyId ? (
        <PluginSlotMount
          slot={pageSlot}
          context={{ companyId: resolvedCompanyId }}
          className="min-h-(--sz-200px)"
          missingBehavior="placeholder"
        />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Page not found</EmptyTitle>
            <EmptyDescription>No plugin provides this settings page.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </PluginRouteBoundary>
  );
}
