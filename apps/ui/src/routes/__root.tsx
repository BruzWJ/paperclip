import { Suspense, type ReactNode } from "react";
import {
  defaultParseSearch,
  defaultStringifySearch,
  createRootRouteWithContext,
  notFound,
  Outlet,
} from "@tanstack/react-router";
import {
  isCanonicalEncodedFragment,
  isCanonicalEncodedPathname,
  rawFragmentFromHref,
  rawPathnameFromHref,
  rawSearchFromHref,
} from "@paperclipai/shared/canonical-pathname";
import { CompanyProvider, useCompany } from "@/context/CompanyContext";
import { LiveUpdatesProvider } from "@/context/LiveUpdatesProvider";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { PanelProvider } from "@/context/PanelContext";
import { SidebarProvider } from "@/context/SidebarContext";
import { DialogProvider } from "@/context/DialogContext";
import { EditorAutocompleteProvider } from "@/context/EditorAutocompleteContext";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { lazyPage } from "@/lib/lazy-page";
import type { AppRouterContext } from "./-router-context";

const OnboardingWizardVariant = lazyPage(
  () => import("@/features/onboarding/OnboardingWizard"),
  "OnboardingWizardVariant",
);

function isCanonicalTanStackSearch(rawSearch: string): boolean {
  if (rawSearch === "") return true;
  try {
    return defaultStringifySearch(defaultParseSearch(rawSearch)) === rawSearch;
  } catch {
    return false;
  }
}

function browserRawHref(locationHref: string): string {
  if (typeof window === "undefined") return locationHref;
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function CompanyAwareBreadcrumbProvider({ children }: { children: ReactNode }) {
  const { selectedCompany } = useCompany();
  return <BreadcrumbProvider companyName={selectedCompany?.name ?? null}>{children}</BreadcrumbProvider>;
}

function RootComponent() {
  return (
    <CompanyProvider>
      <EditorAutocompleteProvider>
        <LiveUpdatesProvider>
          <TooltipProvider>
            <CompanyAwareBreadcrumbProvider>
              <SidebarProvider>
                <PanelProvider>
                  <PluginLauncherProvider>
                    <DialogProvider>
                      <Suspense
                        fallback={
                          <div className="mx-auto flex max-w-xl items-center gap-2 py-10 text-sm text-muted-foreground">
                            <Spinner />
                            Loading...
                          </div>
                        }
                      >
                        <Outlet />
                      </Suspense>
                      <Suspense
                        fallback={
                          <div className="sr-only" role="status">
                            Loading onboarding
                          </div>
                        }
                      >
                        <OnboardingWizardVariant />
                      </Suspense>
                    </DialogProvider>
                  </PluginLauncherProvider>
                </PanelProvider>
              </SidebarProvider>
            </CompanyAwareBreadcrumbProvider>
          </TooltipProvider>
        </LiveUpdatesProvider>
      </EditorAutocompleteProvider>
    </CompanyProvider>
  );
}

export const Route = createRootRouteWithContext<AppRouterContext>()({
  beforeLoad: ({ location }) => {
    const rawHref = browserRawHref(location.href);
    // TanStack intentionally decodes path params, search, and fragments before
    // route loaders. Read the browser URL at this root boundary so a second
    // encoded spelling is rejected before any decoded selector is consumed.
    if (
      !isCanonicalEncodedPathname(rawPathnameFromHref(rawHref)) ||
      !isCanonicalTanStackSearch(rawSearchFromHref(rawHref)) ||
      !isCanonicalEncodedFragment(rawFragmentFromHref(rawHref))
    ) {
      throw notFound();
    }
  },
  component: RootComponent,
  notFoundComponent: () => (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Page not found</EmptyTitle>
        <EmptyDescription>This route does not exist.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ),
});
