import { createRouter } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import type { TaskDetailLocationState } from "./lib/taskDetailBreadcrumb";

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    caseSensitive: true,
    trailingSlash: "never",
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}

declare module "@tanstack/history" {
  interface HistoryState extends TaskDetailLocationState {
    paperclipSidebarScrollReset?: true;
  }
}
