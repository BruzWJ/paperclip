import { useRef, useState, type ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  type AnyRoute,
  type AnyRouter,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";

interface TestRouterProps {
  children: ReactNode;
  initialEntries: string[];
  queryClient?: QueryClient;
  routerRef?: { current: AnyRouter | null };
}

interface TestContentRef {
  current: ReactNode;
}

function createTestRouteComponent(
  getLeafRouteId: () => string,
  contentRef: TestContentRef,
) {
  return function TestRouteComponent() {
    const activeLeafRouteId = useRouterState({
      select: (state) => state.matches.at(-1)?.routeId,
    });

    return activeLeafRouteId === getLeafRouteId() ? (
      <>{contentRef.current}</>
    ) : (
      <Outlet />
    );
  };
}

function TestNotFound() {
  return <div data-testid="test-router-not-found" />;
}

function cloneChildRoute(
  sourceRoute: AnyRoute,
  parentRoute: AnyRoute,
  contentRef: TestContentRef,
): AnyRoute {
  const routeIdentity =
    "path" in sourceRoute.options
      ? { path: sourceRoute.options.path }
      : { id: sourceRoute.options.id };
  const sourceOptions: Record<string, unknown> = { ...sourceRoute.options };
  delete sourceOptions.id;
  delete sourceOptions.path;
  let clonedRoute: AnyRoute;
  clonedRoute = createRoute({
    ...sourceOptions,
    ...routeIdentity,
    getParentRoute: () => parentRoute,
    component: createTestRouteComponent(() => clonedRoute.id, contentRef),
    notFoundComponent: TestNotFound,
  });
  const sourceChildren = Array.isArray(sourceRoute.children)
    ? sourceRoute.children
    : [];

  return clonedRoute.addChildren(
    sourceChildren.map((childRoute) =>
      cloneChildRoute(childRoute, clonedRoute, contentRef),
    ),
  );
}

function cloneProductionRouteTree(contentRef: TestContentRef) {
  let clonedRootRoute: ReturnType<typeof createRootRoute>;
  clonedRootRoute = createRootRoute();
  Object.assign(clonedRootRoute.options, routeTree.options, {
    component: createTestRouteComponent(() => clonedRootRoute.id, contentRef),
    notFoundComponent: TestNotFound,
  });
  const sourceChildren = Array.isArray(routeTree.children)
    ? routeTree.children
    : [];

  return clonedRootRoute.addChildren(
    sourceChildren.map((childRoute) =>
      cloneChildRoute(childRoute, clonedRootRoute, contentRef),
    ),
  );
}

function createNativeTestRouter(
  contentRef: TestContentRef,
  initialEntries: string[],
  queryClient?: QueryClient,
) {
  const rawInitialHref = initialEntries.at(-1) ?? "/";
  const history = createMemoryHistory({ initialEntries });
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", rawInitialHref);
  }
  return createRouter({
    context: { queryClient },
    history,
    routeTree: cloneProductionRouteTree(contentRef),
    caseSensitive: true,
    trailingSlash: "never",
    defaultPendingMs: 0,
  });
}

/**
 * Renders test content at the leaf matched by the generated production route
 * tree. Route matching, params, search validation, loaders, and guards remain
 * the production implementations; only route presentation is replaced.
 */
export function TestRouter({
  children,
  initialEntries,
  queryClient,
  routerRef,
}: TestRouterProps) {
  const contentRef = useRef<ReactNode>(children);
  contentRef.current = children;
  const [router] = useState(() =>
    createNativeTestRouter(contentRef, initialEntries, queryClient),
  );

  if (routerRef) routerRef.current = router;
  return <RouterProvider router={router} />;
}
