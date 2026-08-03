import { test, expect, type Page } from "./fixtures";

/**
 * E2E: post-wizard dashboard launch.
 *
 * The wizard persists a fully configured ordinary agent before the board
 * creates its first issue. Only that issue creation may enqueue provider work.
 */

const COMPANY_NAME = `E2E-DashboardLaunch-${Date.now()}`;
const MISSION = "Verify the dashboard launch survives the wizard transition.";
const AGENT_NAME = "Operations planner";
const CODEX_MODEL = "gpt-5.6";
const ISSUE_REQUEST =
  "  Create a concrete hiring plan for the first engineering position.\nPreserve these request bytes.  ";

async function configureCodexAgent(page: Page) {
  await page.getByRole("button", { name: /Codex/ }).first().click();
  const modelField = page.locator("label").filter({ hasText: /^Model$/ }).locator("../..");
  await expect(modelField).toBeVisible({ timeout: 15_000 });
  await modelField.getByRole("button").last().click();
  await page.getByRole("button", { name: "GPT-5.6", exact: true }).click();

  const environmentSelect = page
    .locator("select")
    .filter({ hasText: "Local · local" });
  await expect(environmentSelect).toBeVisible({ timeout: 15_000 });
  await environmentSelect.selectOption({ label: "Local · local" });
}

test.describe("Dashboard launch after onboarding wizard", () => {
  test("creates the first ordinary issue and opens the dashboard", async ({
    page,
    request,
  }) => {
    const flagResponse = await request.patch(
      "/api/instance/settings/experimental",
      { data: { enableEnvironments: true } },
    );
    expect(flagResponse.ok()).toBe(true);

    await page.goto("/onboarding");
    const startButton = page.getByRole("button", {
      name: /Start Onboarding|New Company|Add Agent/i,
    });
    if (await startButton.count()) {
      await startButton.first().click();
    }
    const createCard = page.getByRole("button", {
      name: /Build a new company/,
    });
    if (await createCard.count()) {
      await createCard.first().click();
    }

    await page.getByPlaceholder("Acme Corp").fill(COMPANY_NAME);
    await page.getByRole("button", { name: /^Next/ }).click();
    await page
      .getByPlaceholder("What is your team trying to achieve?")
      .fill(MISSION);
    await page.getByRole("button", { name: /Confirm mission/ }).click();

    await expect(page.getByPlaceholder("Agent name")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByPlaceholder("Agent name").fill(AGENT_NAME);
    await page.getByPlaceholder("Optional title").fill("Planning coordinator");
    await page
      .getByPlaceholder(
        "What work can another agent select this agent to handle?",
      )
      .fill("Turns board requests into concrete operating plans.");
    await page.getByRole("button", { name: /^Next/ }).click();

    await configureCodexAgent(page);
    const createAgentButton = page.getByRole("button", {
      name: "Create agent",
    });
    await expect(createAgentButton).toBeEnabled({ timeout: 20_000 });
    await createAgentButton.click();
    await expect(
      page.getByRole("heading", { name: "Review" }),
    ).toBeVisible({ timeout: 30_000 });

    const companiesResponse = await request.get("/api/companies");
    expect(companiesResponse.ok()).toBe(true);
    const company = (
      (await companiesResponse.json()) as Array<{ id: string; name: string }>
    ).find((candidate) => candidate.name === COMPANY_NAME);
    expect(company).toBeTruthy();

    const agentsResponse = await request.get(
      `/api/companies/${company!.id}/agents`,
    );
    expect(agentsResponse.ok()).toBe(true);
    const agent = (
      (await agentsResponse.json()) as Array<{
        id: string;
        name: string;
        reportsTo: string | null;
        adapterType: string | null;
        adapterConfig: Record<string, unknown> | null;
      }>
    ).find((candidate) => candidate.name === AGENT_NAME);
    expect(agent).toMatchObject({
      name: AGENT_NAME,
      reportsTo: null,
      adapterType: "codex",
      adapterConfig: {
        model: CODEX_MODEL,
      },
    });

    const runsBeforeIssue = await request.get(
      `/api/companies/${company!.id}/runs?agentId=${agent!.id}`,
    );
    expect(runsBeforeIssue.ok()).toBe(true);
    expect(await runsBeforeIssue.json()).toEqual({
      items: [],
      nextCursor: null,
    });

    await expect(page.getByPlaceholder("Issue title (optional)")).toHaveValue(
      "",
    );
    await page
      .getByPlaceholder(/Describe .* first concrete assignment/)
      .fill(ISSUE_REQUEST);
    await page.getByRole("button", { name: "Get started" }).click();

    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

    const issuesResponse = await request.get(
      `/api/companies/${company!.id}/issues`,
    );
    expect(issuesResponse.ok()).toBe(true);
    const issue = (
      (await issuesResponse.json()) as Array<{
        title: string | null;
        request: string;
        ownerAgentId: string | null;
      }>
    ).find((candidate) => candidate.request === ISSUE_REQUEST);
    expect(issue).toEqual(
      expect.objectContaining({
        title: null,
        request: ISSUE_REQUEST,
        ownerAgentId: agent!.id,
      }),
    );
    await expect(
      page.getByText(/Create a concrete hiring plan/).first(),
    ).toBeVisible({
      timeout: 15_000,
    });
  });
});
