import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Preview } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isCanonicalUuid, type WorkTimelineResult } from "@paperclipai/shared";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
} from "@tanstack/react-router";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { CompanyProvider } from "@/context/CompanyContext";
import { DialogProvider } from "@/context/DialogContext";
import { EditorAutocompleteProvider } from "@/context/EditorAutocompleteContext";
import { PanelProvider } from "@/context/PanelContext";
import { SidebarProvider } from "@/context/SidebarContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { ToastProvider } from "@/context/ToastContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  storybookAgents,
  storybookApprovals,
  storybookAuthSession,
  storybookCompanies,
  storybookDashboardSummary,
  storybookTasks,
  storybookTaskRuns,
  storybookProjects,
  storybookSecretAccessEvents,
  storybookSecretBindings,
  storybookSecretProviderConfigs,
  storybookSecretProviderDiscoveryPreview,
  storybookSecretProviderHealth,
  storybookSecretProviders,
  storybookSecrets,
  storybookSidebarBadges,
} from "../fixtures/paperclipData";
import timelineSample from "../fixtures/workTimeline.human.sample.json";
import "@mdxeditor/editor/style.css";
import "./tailwind-entry.css";
import "./styles.css";

const STORYBOOK_USER_AVATAR =
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=96&q=80";

const StorybookRouteContentContext = createContext<ReactNode>(null);

function StorybookRouteContent() {
  return useContext(StorybookRouteContentContext);
}

const storybookRootRoute = createRootRoute({ component: Outlet });
const storybookAuthenticatedRoute = createRoute({
  getParentRoute: () => storybookRootRoute,
  id: "_authenticated",
  component: Outlet,
});
const storybookCompanyRoute = createRoute({
  getParentRoute: () => storybookAuthenticatedRoute,
  path: "$companyId",
  loader: ({ params }) => {
    if (!isCanonicalUuid(params.companyId)) throw notFound();
  },
  component: Outlet,
});
const storybookAgentRoute = createRoute({
  getParentRoute: () => storybookCompanyRoute,
  path: "agents/$agentId",
  component: Outlet,
});
const storybookAgentIndexRoute = createRoute({
  getParentRoute: () => storybookAgentRoute,
  path: "/",
  component: StorybookRouteContent,
});
const storybookAgentTabRoute = createRoute({
  getParentRoute: () => storybookAgentRoute,
  path: "$tab",
  component: StorybookRouteContent,
});
const storybookSecretsRoute = createRoute({
  getParentRoute: () => storybookCompanyRoute,
  path: "company/settings/secrets",
  component: StorybookRouteContent,
});
const storybookUserRoute = createRoute({
  getParentRoute: () => storybookCompanyRoute,
  path: "u/$userId",
  component: StorybookRouteContent,
});
const storybookCompanyCatchallRoute = createRoute({
  getParentRoute: () => storybookCompanyRoute,
  path: "$",
  component: StorybookRouteContent,
});
const storybookRouteTree = storybookRootRoute.addChildren([
  storybookAuthenticatedRoute.addChildren([
    storybookCompanyRoute.addChildren([
      storybookAgentRoute.addChildren([
        storybookAgentIndexRoute,
        storybookAgentTabRoute,
      ]),
      storybookSecretsRoute,
      storybookUserRoute,
      storybookCompanyCatchallRoute,
    ]),
  ]),
]);

function StorybookMemoryRouter({ children }: { children: ReactNode }) {
  const storybookRouter = useMemo(
    () => createRouter({
      routeTree: storybookRouteTree,
      history: createMemoryHistory({
        initialEntries: ["/11111111-1111-4111-8111-111111111111/storybook"],
      }),
    }),
    [],
  );
  return (
    <StorybookRouteContentContext.Provider value={children}>
      <RouterProvider router={storybookRouter} />
    </StorybookRouteContentContext.Provider>
  );
}

function withStorybookTimelineDetails(data: WorkTimelineResult): WorkTimelineResult {
  return {
    ...data,
    actors: data.actors.map((actor) => (
      actor.type === "user" ? { ...actor, avatar: STORYBOOK_USER_AVATAR } : actor
    )),
    spans: data.spans.map((span, index) => {
      const inputTokens = 42_000 + index * 137;
      const cachedInputTokens = index % 3 === 0 ? 8_000 : 0;
      const outputTokens = 5_400 + index * 29;
      return {
        ...span,
        usage: span.usage ?? {
          inputTokens,
          cachedInputTokens,
          outputTokens,
          totalTokens: inputTokens + cachedInputTokens + outputTokens,
        },
      };
    }),
  };
}

const storybookTimelineSample = withStorybookTimelineDetails(timelineSample as WorkTimelineResult);

// Install fetch monkeypatch eagerly so any module-load-time fetches (e.g. schema
// caches in adapter config renderers) hit our fixtures before they reach the
// network. Some renderers task a fetch from useEffect on first paint, which
// can otherwise race the StorybookProviders mount.
installStorybookApiFixtures();

function installStorybookApiFixtures() {
  if (typeof window === "undefined") return;
  const currentWindow = window as typeof window & {
    __paperclipStorybookFetchInstalled?: boolean;
  };
  if (currentWindow.__paperclipStorybookFetchInstalled) return;

  const originalFetch = window.fetch.bind(window);
  currentWindow.__paperclipStorybookFetchInstalled = true;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(rawUrl, window.location.origin);

    if (url.pathname === "/api/auth/get-session") {
      return Response.json(storybookAuthSession);
    }

    if (url.pathname === "/api/companies") {
      return Response.json(storybookCompanies);
    }

    if (url.pathname === "/api/companies/11111111-1111-4111-8111-111111111111/user-directory") {
      return Response.json({
        users: [
          {
            principalId: "a7000000-0000-4000-8000-000000000002",
            status: "active",
            user: {
              id: "a7000000-0000-4000-8000-000000000002",
              email: "board@paperclip.local",
              name: "Board Operator",
              image: null,
            },
          },
          {
            principalId: "a7000000-0000-4000-8000-000000000004",
            status: "active",
            user: {
              id: "a7000000-0000-4000-8000-000000000004",
              email: "product@paperclip.local",
              name: "Product Lead",
              image: null,
            },
          },
        ],
      });
    }

    if (url.pathname === "/api/adapters") {
      return Response.json([
        {
          type: "claude-code",
          label: "Claude Code",
          source: "acpx",
          modelsCount: 2,
          loaded: true,
          registryName: "claude-code",
          configSchema: { fields: [] },
          capabilities: {
            contractVersion: "acpx-runtime/v1",
            runtimeControls: ["session/status", "session/set_config_option"],
          },
        },
        {
          type: "codex",
          label: "Codex",
          source: "acpx",
          modelsCount: 3,
          loaded: true,
          registryName: "codex",
          configSchema: { fields: [] },
          capabilities: {
            contractVersion: "acpx-runtime/v1",
            runtimeControls: ["session/status", "session/set_config_option"],
          },
        },
      ]);
    }

    if (url.pathname === "/api/plugins/ui-contributions") {
      return Response.json([]);
    }

    const adapterSchemaMatch = url.pathname.match(/^\/api\/adapters\/([^/]+)\/config-schema$/);
    if (adapterSchemaMatch) {
      const [, adapterType] = adapterSchemaMatch;
      const schemas = (window as typeof window & {
        __paperclipStorybookAdapterSchemas?: Record<string, unknown>;
      }).__paperclipStorybookAdapterSchemas;
      const schema = schemas?.[adapterType];
      if (schema) return Response.json(schema);
    }

    const secretsListMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/secrets$/);
    if (secretsListMatch) {
      const [, companyId] = secretsListMatch;
      return Response.json(companyId === "11111111-1111-4111-8111-111111111111" ? storybookSecrets : []);
    }

    const secretProvidersMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/secret-providers$/);
    if (secretProvidersMatch) {
      return Response.json(storybookSecretProviders);
    }

    const secretProviderHealthMatch = url.pathname.match(
      /^\/api\/companies\/([^/]+)\/secret-providers\/health$/,
    );
    if (secretProviderHealthMatch) {
      return Response.json(storybookSecretProviderHealth);
    }

    const secretProviderConfigsMatch = url.pathname.match(
      /^\/api\/companies\/([^/]+)\/secret-provider-configs$/,
    );
    if (secretProviderConfigsMatch) {
      return Response.json(storybookSecretProviderConfigs);
    }

    const secretProviderConfigDiscoveryPreviewMatch = url.pathname.match(
      /^\/api\/companies\/([^/]+)\/secret-provider-configs\/discovery\/preview$/,
    );
    if (secretProviderConfigDiscoveryPreviewMatch && init?.method?.toUpperCase() === "POST") {
      return Response.json(storybookSecretProviderDiscoveryPreview);
    }

    const secretUsageMatch = url.pathname.match(/^\/api\/secrets\/([^/]+)\/usage$/);
    if (secretUsageMatch) {
      const [, secretId] = secretUsageMatch;
      return Response.json({
        secretId,
        bindings: storybookSecretBindings.filter((binding) => binding.secretId === secretId),
      });
    }

    const secretEventsMatch = url.pathname.match(/^\/api\/secrets\/([^/]+)\/access-events$/);
    if (secretEventsMatch) {
      const [, secretId] = secretEventsMatch;
      return Response.json(storybookSecretAccessEvents.filter((event) => event.secretId === secretId));
    }

    const companyResourceMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/([^/]+)$/);
    if (companyResourceMatch) {
      const [, companyId, resource] = companyResourceMatch;
      if (resource === "agents") {
        return Response.json(companyId === "11111111-1111-4111-8111-111111111111" ? storybookAgents : []);
      }
      if (resource === "projects") {
        return Response.json(companyId === "11111111-1111-4111-8111-111111111111" ? storybookProjects : []);
      }
      if (resource === "approvals") {
        return Response.json(companyId === "11111111-1111-4111-8111-111111111111" ? storybookApprovals : []);
      }
      if (resource === "dashboard") {
        return Response.json({
          ...storybookDashboardSummary,
          companyId,
        });
      }
      if (resource === "timeline") {
        return Response.json(
          companyId === "11111111-1111-4111-8111-111111111111"
            ? storybookTimelineSample
            : {
                actors: [],
                spans: [],
                events: [],
                edges: [],
                pagination: { limit: 100, offset: 0, totalTasks: 0, hasMore: false },
                window: {
                  from: url.searchParams.get("from") ?? new Date(0).toISOString(),
                  to: url.searchParams.get("to") ?? new Date(0).toISOString(),
                  capped: false,
                },
              },
        );
      }
      if (resource === "runs") {
        const requestedStatuses = url.searchParams.getAll("status");
        const requestedAgentId = url.searchParams.get("agentId");
        const runs = companyId === "11111111-1111-4111-8111-111111111111" ? storybookTaskRuns : [];
        return Response.json({
          items: runs.filter(
            (run) =>
              (requestedStatuses.length === 0 || requestedStatuses.includes(run.status)) &&
              (requestedAgentId === null || run.targetAgentId === requestedAgentId),
          ),
          nextCursor: null,
        });
      }
      if (resource === "inbox-dismissals") {
        return Response.json([]);
      }
      if (resource === "sidebar-badges") {
        return Response.json(
          companyId === "11111111-1111-4111-8111-111111111111"
            ? storybookSidebarBadges
            : { inbox: 0, approvals: 0, failedRuns: 0, joinRequests: 0 },
        );
      }
      if (resource === "join-requests") {
        return Response.json([]);
      }
      if (resource === "tasks") {
        const query = url.searchParams.get("q")?.trim().toLowerCase();
        const tasks = companyId === "11111111-1111-4111-8111-111111111111" ? storybookTasks : [];
        return Response.json(
          query
            ? tasks.filter((task) =>
                `${task.identifier ?? ""} ${task.title} ${task.description ?? ""}`.toLowerCase().includes(query),
              )
            : tasks,
        );
      }
    }

    if (url.pathname.startsWith("/api/invites/") && url.pathname.endsWith("/logo")) {
      return new Response(null, { status: 204 });
    }

    return originalFetch(input, init);
  };
}

// Install fetch fixtures at module load so React Query never sees a real network failure.
if (typeof window !== "undefined") {
  installStorybookApiFixtures();
}

function applyStorybookTheme(theme: "light" | "dark") {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

function StorybookProviders({
  children,
  theme,
}: {
  children: ReactNode;
  theme: "light" | "dark";
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Number.POSITIVE_INFINITY,
          },
        },
      }),
  );

  if (typeof window !== "undefined") {
    installStorybookApiFixtures();
  }

  useEffect(() => {
    applyStorybookTheme(theme);
  }, [theme]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <StorybookMemoryRouter>
          <CompanyProvider>
            <EditorAutocompleteProvider>
              <ToastProvider>
                <TooltipProvider>
                  <BreadcrumbProvider>
                    <SidebarProvider>
                      <PanelProvider>
                        <DialogProvider>{children}</DialogProvider>
                      </PanelProvider>
                    </SidebarProvider>
                  </BreadcrumbProvider>
                </TooltipProvider>
              </ToastProvider>
            </EditorAutocompleteProvider>
          </CompanyProvider>
        </StorybookMemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

const preview: Preview = {
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme === "light" ? "light" : "dark";
      return (
        <StorybookProviders key={theme} theme={theme}>
          <Story />
        </StorybookProviders>
      );
    },
  ],
  globalTypes: {
    theme: {
      description: "Paperclip color mode",
      defaultValue: "dark",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    actions: { argTypesRegex: "^on[A-Z].*" },
    a11y: {
      test: "error",
    },
    backgrounds: {
      disable: true,
    },
    controls: {
      expanded: true,
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    docs: {
      toc: true,
    },
    layout: "fullscreen",
    viewport: {
      viewports: {
        mobile: {
          name: "Mobile",
          styles: { width: "390px", height: "844px" },
        },
        tablet: {
          name: "Tablet",
          styles: { width: "834px", height: "1112px" },
        },
        desktop: {
          name: "Desktop",
          styles: { width: "1440px", height: "960px" },
        },
      },
    },
  },
};

export default preview;
