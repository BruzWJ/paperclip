import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
  type Page,
} from "./fixtures";

/**
 * E2E: Sidebar takeover model (PAP-10695).
 *
 * Takeover routes (company settings, plugin `routeSidebar`) no longer *replace*
 * the main app sidebar. Instead the host collapses the app `<Sidebar/>` to its
 * 64px rail (still peek-able) and renders the contextual sidebar in a second
 * pane → `[ app rail ][ secondary ~240px ][ content ]`.
 *
 * These specs assert the rail + secondary pane coexist on a company settings
 * route, and that an explicit user pin (expanded) wins over the route-driven
 * collapse (pin precedence).
 *
 * The plugin `routeSidebar` half of this behavior shares the exact same Layout
 * code path (one `secondarySidebar`/`hasSecondarySidebar` resolver drives both
 * company-settings and plugin routes) and is covered by the unit tests in
 * `apps/ui/src/components/Layout.test.tsx`. A plugin-route browser check requires a
 * dedicated test-owned plugin fixture and is out of scope for this suite;
 * visual QA of both panes is delegated to the QA child task.
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME_PREFIX = "E2E-SidebarTakeover";
const COLLAPSED_STORAGE_KEY = "paperclip.sidebar.collapsed";
const AUTH_STORAGE_STATE = process.env.PAPERCLIP_E2E_STORAGE_STATE_PATH;
const API_ROUTE = new RegExp(
  `^${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/api(?:\/|$)`,
);

// The sidebar header's "Open search" control only renders when the app sidebar
// is expanded (pinned or peeking); in the collapsed rail it is hidden to fit
// the 64px width. Its presence/absence is therefore a stable proxy for the
// app sidebar's collapsed state (see Sidebar.tsx).
const APP_SIDEBAR_EXPANDED_MARKER = "Open search";

function emptyDashboard(companyId: string) {
  return {
    companyId,
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
  };
}

function emptyAttentionFeed(companyId: string) {
  return {
    companyId,
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
  };
}

async function installApiRoute(page: Page, board: APIRequestContext, companyId: string) {
  // The shared fixture's `**/api/**` glob also matches Vite source modules
  // such as `/src/api/tasks.ts`. Scope this spec's mock to the actual API
  // origin so native client modules continue to load as JavaScript.
  await page.unroute("**/api/**");
  await page.route(API_ROUTE, async (route) => {
    const browserRequest = route.request();
    if (new URL(browserRequest.url()).pathname === `/api/companies/${companyId}/dashboard`) {
      await route.fulfill({ json: emptyDashboard(companyId) });
      return;
    }
    if (new URL(browserRequest.url()).pathname === `/api/companies/${companyId}/attention`) {
      await route.fulfill({ json: emptyAttentionFeed(companyId) });
      return;
    }

    let data: unknown;
    try {
      data = browserRequest.postDataJSON();
    } catch {
      data = browserRequest.postData() ?? undefined;
    }

    const response = await board.fetch(browserRequest.url(), {
      method: browserRequest.method(),
      ...(data === undefined ? {} : { data }),
    });
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: await response.body(),
    });
  });
}

async function createCompany(board: APIRequestContext): Promise<string> {
  const healthRes = await board.get(`${BASE_URL}/api/health`);
  expect(healthRes.ok()).toBe(true);

  const companyRes = await board.post(`${BASE_URL}/api/companies`, {
    data: { name: `${COMPANY_NAME_PREFIX}-${Date.now()}` },
  });
  if (!companyRes.ok()) {
    throw new Error(`POST /api/companies → ${companyRes.status()}: ${await companyRes.text()}`);
  }
  const company = await companyRes.json();
  return company.id;
}

test.describe("Sidebar takeover (collapse + secondary pane)", () => {
  let board: APIRequestContext;
  let companyId: string;

  test.beforeAll(async () => {
    board = await pwRequest.newContext({
      baseURL: BASE_URL,
      storageState: AUTH_STORAGE_STATE,
    });
    companyId = await createCompany(board);
  });

  test.afterAll(async () => {
    await board.delete(`${BASE_URL}/api/companies/${companyId}`).catch(() => {});
    await board.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await installApiRoute(page, board, companyId);

    // Start each test from a clean (unpinned) sidebar state so the route-driven
    // collapse is the only thing acting on it.
    await page.addInitScript((key) => {
      window.localStorage.removeItem(key);
    }, COLLAPSED_STORAGE_KEY);
  });

  test("collapses the app sidebar to its rail and shows the settings sidebar beside it", async ({ page }) => {
    await page.goto(`/${companyId}/company/settings`);

    // The contextual (secondary) pane is present...
    const secondary = page.locator("[data-secondary-sidebar]");
    await expect(secondary).toBeVisible();
    await expect(secondary).toHaveCount(1);

    // ...and it is ~240px wide (w-60), distinct from the 64px app rail.
    const secondaryBox = await secondary.boundingBox();
    expect(secondaryBox).not.toBeNull();
    expect(secondaryBox!.width).toBeGreaterThan(180);

    // The app sidebar is NOT replaced — its company nav still renders...
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();

    // ...but it is collapsed to its rail: the expanded-only "Open search"
    // header control is hidden.
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toHaveCount(0);
  });

  test("renders the secondary pane nav labels at full width despite the app rail collapse", async ({ page }) => {
    // Regression (PAP-10700): the secondary pane is 240px wide, but its
    // SidebarNavItem children read the *global* collapsed state and used to
    // render icon-only (label `w-0 text-transparent`), making the settings nav
    // unreadable in the default takeover state. The pane must force full labels.
    await page.goto(`/${companyId}/company/settings`);

    const secondary = page.locator("[data-secondary-sidebar]");
    await expect(secondary).toBeVisible();

    // App sidebar is collapsed to its rail (default unpinned takeover state)...
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toHaveCount(0);

    // ...yet a settings nav label renders at its full text width, not clipped to
    // zero.
    const generalLabel = secondary.getByText("General", { exact: true }).first();
    await expect(generalLabel).toBeVisible();
    const labelBox = await generalLabel.boundingBox();
    expect(labelBox).not.toBeNull();
    expect(labelBox!.width).toBeGreaterThan(20);
  });

  test("settings force-collapse overrides an expanded pin without mutating it", async ({ page }) => {
    // User has pinned the sidebar expanded ("0"). Company settings is a hard
    // secondary-sidebar takeover route, so forceCollapsed wins while the route is
    // active (force > pin > route request > default) but must not mutate the pin.
    await page.addInitScript(
      ({ key }) => {
        window.localStorage.setItem(key, "0");
      },
      { key: COLLAPSED_STORAGE_KEY },
    );

    await page.goto(`/${companyId}/company/settings`);

    // Secondary pane still shows on the takeover route.
    await expect(page.locator("[data-secondary-sidebar]")).toBeVisible();

    // The app sidebar is hard-collapsed despite the stored expanded pin.
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toHaveCount(0);

    await page.goto(`/${companyId}/dashboard`);

    // Leaving the takeover route clears the force and restores the user's
    // persisted expanded pin.
    await expect(page.locator("[data-secondary-sidebar]")).toHaveCount(0);
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toBeVisible();
  });

  test("leaving the takeover route removes the secondary pane and restores the sidebar", async ({ page }) => {
    await page.goto(`/${companyId}/company/settings`);
    await expect(page.locator("[data-secondary-sidebar]")).toBeVisible();
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toHaveCount(0);

    // Navigate to a plain (non-takeover) route.
    await page.goto(`/${companyId}/dashboard`);

    // No secondary pane, and the app sidebar is no longer force-collapsed.
    await expect(page.locator("[data-secondary-sidebar]")).toHaveCount(0);
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toBeVisible();
  });
});
