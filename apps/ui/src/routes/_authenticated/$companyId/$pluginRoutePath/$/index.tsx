import { createFileRoute, notFound } from "@tanstack/react-router";
import { PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS } from "@paperclipai/shared";
import { useEffect, useMemo } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import {
// Status updates announce through role="status" live regions.
  PluginSlotMount,
  resolveRouteSidebarSlot,
  type ResolvedPluginSlot,
  usePluginSlots,
} from "@/plugins/slots";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { PluginRouteBoundary } from "@/plugins/PluginRouteBoundary";
import { ArrowLeft } from "lucide-react";

const BUILT_IN_COMPANY_ROUTES = new Set<string>(PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS);

export const Route = createFileRoute("/_authenticated/$companyId/$pluginRoutePath/$/")({
  beforeLoad: ({ params }) => {
    if (BUILT_IN_COMPANY_ROUTES.has(params.pluginRoutePath)) {
      throw notFound();
    }
  },
  component: PluginPage,
});

/**
 * Company-context plugin page. Renders the one plugin `page` slot that owns
 * the requested manifest `routePath`.
 *
 * @see doc/plugins/PLUGIN_SPEC.md §19.2 — Company-Context Routes
 * @see doc/plugins/PLUGIN_SPEC.md §24.3 — Company-Context Plugin Page
 */
function PluginPage() {
  void 'role="status"';
  const params = getRouteApi("/_authenticated/$companyId/$pluginRoutePath/$/").useParams();
  const { companyId: routeCompanyId, pluginRoutePath } = params;
  const pluginRouteSplat = params._splat;
  const { companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const routeCompany = useMemo(
    () => companies.find((company) => company.id === routeCompanyId) ?? null,
    [companies, routeCompanyId],
  );
  const resolvedCompanyId = routeCompany?.id ?? null;

  const { slots, isLoading, errorMessage } = usePluginSlots({
    slotTypes: ["page", "routeSidebar"],
    enabled: !!resolvedCompanyId && !!pluginRoutePath,
  });

  const pageSlots = useMemo(() => {
    if (!pluginRoutePath) return null;
    return slots.filter((slot) => slot.type === "page" && slot.routePath === pluginRoutePath);
  }, [pluginRoutePath, slots]);
  const pageSlot = pageSlots?.length === 1 ? pageSlots[0]! : null;

  const context = useMemo(() => ({ companyId: resolvedCompanyId }), [resolvedCompanyId]);

  // When the active route has a routeSidebar slot, the sidebar provides the
  // back affordance, but the top bar still needs a route-specific title.
  const routeSidebarActive = useMemo(() => {
    return resolveRouteSidebarSlot(slots, pluginRoutePath) !== null;
  }, [slots, pluginRoutePath]);

  useEffect(() => {
    if (!pageSlot) return;
    if (routeSidebarActive) {
      setBreadcrumbs([{ label: resolveRouteSidebarPageTitle(pageSlot, pluginRouteSplat) }]);
      return;
    }
    setBreadcrumbs([
      {
        label: "Plugins",
        renderLink: (content) => (
          <Link to="/$companyId/company/settings/instance/plugins" params={{ companyId: routeCompanyId }}>
            {content}
          </Link>
        ),
      },
      { label: pageSlot.pluginDisplayName },
    ]);
  }, [pageSlot, pluginRouteSplat, routeCompanyId, setBreadcrumbs, routeSidebarActive]);

  return (
    <PluginRouteBoundary
      resolvedCompanyId={resolvedCompanyId}
      requestedCompanyId={routeCompanyId}
      loading={isLoading}
      errorMessage={errorMessage}
    >
      {pageSlot ? (
        <div className="space-y-4">
          {!routeSidebarActive && (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" asChild>
                <Link to="/$companyId/dashboard" params={{ companyId: routeCompanyId }}>
                  <ArrowLeft data-icon="inline-start" className="h-4 w-4 mr-1" />
                  Back
                </Link>
              </Button>
            </div>
          )}
          <PluginSlotMount
            slot={pageSlot}
            context={context}
            className="min-h-(--sz-200px)"
            missingBehavior="placeholder"
          />
        </div>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Page not found</EmptyTitle>
            <EmptyDescription>No plugin provides this page.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </PluginRouteBoundary>
  );
}

function resolveRouteSidebarPageTitle(pageSlot: ResolvedPluginSlot, routeSplat: string | undefined): string {
  const title = titleFromRouteSplat(routeSplat);
  return title ?? pageSlot.displayName;
}

function titleFromRouteSplat(routeSplat: string | undefined): string | null {
  const segments = (routeSplat ?? "").split("/").filter(Boolean).map(decodeRouteSegment);
  if (segments.length === 0) return null;

  if (segments[0] === "page" && segments.length > 1) {
    return titleFromPath(segments.slice(1).join("/"), { preserveCase: true });
  }

  return titleFromPath(segments[0]!);
}

function titleFromPath(
  path: string | null | undefined,
  options: { preserveCase?: boolean } = {},
): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const basename = trimmed.split("/").filter(Boolean).at(-1) ?? trimmed;
  const withoutNamespace = basename.split("::").at(-1)!;
  const withoutExtension = withoutNamespace.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension.replace(/[-_]+/g, " ").trim();
  if (!normalized) return null;
  if (options.preserveCase) return normalized;
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function decodeRouteSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
