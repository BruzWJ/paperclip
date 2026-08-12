import type { Page } from "@playwright/test";

const codexAdapterCatalog = [
  {
    type: "codex",
    label: "Codex",
    modelsCount: 1,
    loaded: true,
    configOptions: [
      {
        id: "model",
        label: "Model",
        type: "select",
        values: [{ label: "GPT-5.6", value: "gpt-5.6" }],
      },
    ],
    capabilities: {
      contractVersion: "acpx-runtime/v1",
      runtimeControls: ["session/status", "session/set_config_option"],
    },
  },
] as const;

const emptyResourceMemberships = {
  projectMemberships: {},
  agentMemberships: {},
  starredProjectIds: [],
  starredAgentIds: [],
  projectStarredAt: {},
  agentStarredAt: {},
  updatedAt: null,
} as const;

const emptyDashboard = {
  agents: { active: 0, running: 0, paused: 0, error: 0 },
  tasks: { open: 0, inProgress: 0, blocked: 0, done: 0 },
  costs: {
    budgetCurrency: "USD",
    monthKnownSpendAmount: "0",
    monthBudgetAmount: "0",
    monthRemainingAmount: "0",
    monthUtilizationPercent: 0,
    unpricedPromptCount: 0,
  },
  pendingApprovals: 0,
  budgets: {
    activeIncidents: 0,
    pendingApprovals: 0,
    pausedAgents: 0,
    pausedProjects: 0,
  },
  runActivity: [],
} as const;

const canonicalCompanyResourceMembershipsUrl =
  /\/api\/companies\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/users\/[^/?#]+\/resource-memberships(?:\?.*)?$/i;
const canonicalCompanyDashboardUrl =
  /\/api\/companies\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/dashboard(?:\?.*)?$/i;
const canonicalCompanyAttentionUrl =
  /\/api\/companies\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/attention(?:\?.*)?$/i;
const canonicalAdapterTestUrl =
  /\/api\/companies\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/adapters\/[^/?#]+\/test-configuration$/i;
const canonicalTaskCommentsUrl =
  /\/api\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/comments(?:\?.*)?$/i;

/**
 * Keep the mocked backend boundary distinct from Vite's native source-module
 * URLs, then expose the exact server-admitted local-agent catalog used by
 * these onboarding flows.
 */
export async function prepareOnboardingTestPage(page: Page): Promise<void> {
  await page.route("**/src/api/**", (route) => route.continue());
  await page.route(/\/api\/adapters(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(codexAdapterCatalog),
    }),
  );
  await page.route(canonicalCompanyResourceMembershipsUrl, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyResourceMemberships),
    }),
  );
  await page.route(canonicalCompanyDashboardUrl, (route) => {
    const match = canonicalCompanyDashboardUrl.exec(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...emptyDashboard, companyId: match?.[1] }),
    });
  });
  await page.route(canonicalCompanyAttentionUrl, (route) => {
    const match = canonicalCompanyAttentionUrl.exec(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        companyId: match?.[1],
        generatedAt: new Date(0).toISOString(),
        totalCount: 0,
        countsBySourceKind: {
          approval: 0,
          join_request: 0,
          review: 0,
          budget_alert: 0,
          mention_board: 0,
        },
        items: [],
      }),
    });
  });
  await page.route(canonicalAdapterTestUrl, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ready",
        message: "Configuration accepted",
      }),
    }),
  );
  await page.route(canonicalTaskCommentsUrl, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ groups: [], nextCursor: null }),
    }),
  );
}

export async function openCreateCompanyOnboarding(page: Page): Promise<void> {
  await page.goto("/onboarding");
}
