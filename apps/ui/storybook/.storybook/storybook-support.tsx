import type { WorkTimelineResult } from "@paperclipai/shared";
import { isCanonicalUuid } from "@paperclipai/shared";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
} from "@tanstack/react-router";

import {
  storybookAgents,
  storybookApprovals,
  storybookAuthSession,
  storybookCompanies,
  storybookDashboardSummary,
  storybookProjects,
  storybookSecretAccessEvents,
  storybookSecretBindings,
  storybookSecretProviderConfigs,
  storybookSecretProviderDiscoveryPreview,
  storybookSecretProviderHealth,
  storybookSecretProviders,
  storybookSecrets,
  storybookSidebarBadges,
  storybookTaskRuns,
  storybookTasks,
} from "../fixtures/paperclipData";
import timelineSample from "../fixtures/workTimeline.human.sample.json";

const STORYBOOK_COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const STORYBOOK_USER_AVATAR =
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=96&q=80";

function withStorybookTimelineDetails(data: WorkTimelineResult): WorkTimelineResult {
  return {
    ...data,
    actors: data.actors.map((actor) =>
      actor.type === "user" ? { ...actor, avatar: STORYBOOK_USER_AVATAR } : actor,
    ),
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

/** Installs the deterministic API layer used by every Storybook story. */
export function installStorybookApiFixtures() {
  if (typeof window === "undefined") return;
  const currentWindow = window as typeof window & {
    __paperclipStorybookFetchInstalled?: boolean;
  };
  if (currentWindow.__paperclipStorybookFetchInstalled) return;

  const originalFetch = window.fetch.bind(window);
  currentWindow.__paperclipStorybookFetchInstalled = true;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, window.location.origin);

    if (url.pathname === "/api/auth/get-session") {
      return Response.json(storybookAuthSession);
    }

    if (url.pathname === "/api/companies") {
      return Response.json(storybookCompanies);
    }

    if (url.pathname === `/api/companies/${STORYBOOK_COMPANY_ID}/user-directory`) {
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
      const schemas = (
        window as typeof window & {
          __paperclipStorybookAdapterSchemas?: Record<string, unknown>;
        }
      ).__paperclipStorybookAdapterSchemas;
      const schema = schemas?.[adapterType];
      if (schema) return Response.json(schema);
    }

    const secretsListMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/secrets$/);
    if (secretsListMatch) {
      const [, companyId] = secretsListMatch;
      return Response.json(companyId === STORYBOOK_COMPANY_ID ? storybookSecrets : []);
    }

    if (url.pathname.match(/^\/api\/companies\/([^/]+)\/secret-providers$/)) {
      return Response.json(storybookSecretProviders);
    }

    if (url.pathname.match(/^\/api\/companies\/([^/]+)\/secret-providers\/health$/)) {
      return Response.json(storybookSecretProviderHealth);
    }

    if (url.pathname.match(/^\/api\/companies\/([^/]+)\/secret-provider-configs$/)) {
      return Response.json(storybookSecretProviderConfigs);
    }

    if (
      url.pathname.match(/^\/api\/companies\/([^/]+)\/secret-provider-configs\/discovery\/preview$/) &&
      init?.method?.toUpperCase() === "POST"
    ) {
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
      const isStorybookCompany = companyId === STORYBOOK_COMPANY_ID;

      if (resource === "agents") {
        return Response.json(isStorybookCompany ? storybookAgents : []);
      }
      if (resource === "projects") {
        return Response.json(isStorybookCompany ? storybookProjects : []);
      }
      if (resource === "approvals") {
        return Response.json(isStorybookCompany ? storybookApprovals : []);
      }
      if (resource === "dashboard") {
        return Response.json({ ...storybookDashboardSummary, companyId });
      }
      if (resource === "timeline") {
        return Response.json(
          isStorybookCompany
            ? storybookTimelineSample
            : {
                actors: [],
                spans: [],
                events: [],
                edges: [],
                pagination: {
                  limit: 100,
                  offset: 0,
                  totalTasks: 0,
                  hasMore: false,
                },
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
        const runs = isStorybookCompany ? storybookTaskRuns : [];
        return Response.json({
          items: runs.filter(
            (run) =>
              (requestedStatuses.length === 0 || requestedStatuses.includes(run.status)) &&
              (requestedAgentId === null || run.targetAgentId === requestedAgentId),
          ),
          nextCursor: null,
        });
      }
      if (resource === "inbox-dismissals" || resource === "join-requests") {
        return Response.json([]);
      }
      if (resource === "sidebar-badges") {
        return Response.json(
          isStorybookCompany
            ? storybookSidebarBadges
            : { inbox: 0, approvals: 0, failedRuns: 0, joinRequests: 0 },
        );
      }
      if (resource === "tasks") {
        const query = url.searchParams.get("q")?.trim().toLowerCase();
        const tasks = isStorybookCompany ? storybookTasks : [];
        return Response.json(
          query
            ? tasks.filter((task) =>
                `${task.identifier ?? ""} ${task.title} ${task.description ?? ""}`
                  .toLowerCase()
                  .includes(query),
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

// Module-load installation prevents schema-cache effects from reaching the network.
installStorybookApiFixtures();

export const StorybookRouteContentContext = createContext<ReactNode>(null);
export function StorybookRouteContent() {
  return useContext(StorybookRouteContentContext);
}
export const storybookRootRoute = createRootRoute({ component: Outlet });
export const storybookAuthenticatedRoute = createRoute({
  getParentRoute: () => storybookRootRoute,
  id: "_authenticated",
  component: Outlet,
});
export const storybookCompanyRoute = createRoute({
  getParentRoute: () => storybookAuthenticatedRoute,
  path: "$companyId",
  loader: ({ params }) => {
    if (!isCanonicalUuid(params.companyId)) throw notFound();
  },
  component: Outlet,
});
export const storybookAgentRoute = createRoute({
  getParentRoute: () => storybookCompanyRoute,
  path: "agents/$agentId",
  component: Outlet,
});
export const storybookAgentIndexRoute = createRoute({
  getParentRoute: () => storybookAgentRoute,
  path: "/",
  component: StorybookRouteContent,
});
export const storybookAgentTabRoute = createRoute({
  getParentRoute: () => storybookAgentRoute,
  path: "$tab",
  component: StorybookRouteContent,
});
export const storybookSecretsRoute = createRoute({
  getParentRoute: () => storybookCompanyRoute,
  path: "company/settings/secrets",
  component: StorybookRouteContent,
});
export const storybookUserRoute = createRoute({
  getParentRoute: () => storybookCompanyRoute,
  path: "u/$userId",
  component: StorybookRouteContent,
});
export const storybookCompanyCatchallRoute = createRoute({
  getParentRoute: () => storybookCompanyRoute,
  path: "$",
  component: StorybookRouteContent,
});
export const storybookRouteTree = storybookRootRoute.addChildren([
  storybookAuthenticatedRoute.addChildren([
    storybookCompanyRoute.addChildren([
      storybookAgentRoute.addChildren([storybookAgentIndexRoute, storybookAgentTabRoute]),
      storybookSecretsRoute,
      storybookUserRoute,
      storybookCompanyCatchallRoute,
    ]),
  ]),
]);
export function StorybookMemoryRouter({ children }: { children: ReactNode }) {
  const storybookRouter = useMemo(
    () =>
      createRouter({
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
