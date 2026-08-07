import { test, expect, type APIRequestContext, type Page } from "./fixtures";

const COMPANY_NAME = `E2E-Test-${Date.now()}`;
const MISSION = "Build affordable home robots that handle household chores.";
const AGENT_NAME = "Robotics coordinator";
const AGENT_TITLE = "Automation lead";
const CODEX_MODEL = "gpt-5.6";
const ISSUE_TITLE = "Plan the household workflow";
const ISSUE_REQUEST =
  "  Map the first household workflow the robot should automate.\nKeep the operator checkpoints explicit.  ";

type CreatedCompany = {
  id: string;
  name: string;
};

type CreatedAgent = {
  id: string;
  name: string;
  title: string | null;
  reportsTo: string | null;
  adapterType: string | null;
  adapterConfig: Record<string, unknown> | null;
};

async function openCreateCompanyPath(page: Page) {
  await page.goto("/onboarding");
  const startButton = page.getByRole("button", {
    name: /Start Onboarding|New Company|Add Agent/,
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
}

async function configureCodexAgent(page: Page) {
  await page.getByRole("button", { name: /Codex/ }).first().click();
  const modelField = page.locator("label").filter({ hasText: /^Model$/ }).locator("../..");
  await expect(modelField).toBeVisible({ timeout: 15_000 });
  await modelField.getByRole("button").last().click();
  await page.getByRole("button", { name: "GPT-5.6", exact: true }).click();

}

async function listRuns(request: APIRequestContext, companyId: string, agentId: string) {
  const response = await request.get(
    `/api/companies/${companyId}/runs?agentId=${agentId}`,
  );
  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as {
    items: Array<{ id: string; status: string }>;
  };
  return payload.items;
}

test.describe("Onboarding wizard", () => {
  test("creates an explicitly configured ordinary agent, then its first issue", async ({
    page,
    request,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await openCreateCompanyPath(page);

    await expect(
      page.getByRole("heading", { name: "Name your company" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder("Acme Corp").fill(COMPANY_NAME);
    await page.getByRole("button", { name: /^Next/ }).click();

    await expect(
      page.getByRole("heading", { name: "Define your mission" }),
    ).toBeVisible({ timeout: 10_000 });
    await page
      .getByPlaceholder("What is your team trying to achieve?")
      .fill(MISSION);
    await page.getByRole("button", { name: /Confirm mission/ }).click();

    await expect(page.getByPlaceholder("Agent name")).toBeVisible({
      timeout: 30_000,
    });
    await page.getByPlaceholder("Agent name").fill(AGENT_NAME);
    await page.getByPlaceholder("Optional title").fill(AGENT_TITLE);
    await page
      .getByPlaceholder(
        "What work can another agent select this agent to handle?",
      )
      .fill("Plans and coordinates home-robotics automation work.");

    const companiesResponse = await request.get("/api/companies");
    expect(companiesResponse.ok()).toBe(true);
    const company = ((await companiesResponse.json()) as CreatedCompany[]).find(
      (candidate) => candidate.name === COMPANY_NAME,
    );
    expect(company).toBeTruthy();

    const goalsResponse = await request.get(
      `/api/companies/${company!.id}/goals`,
    );
    expect(goalsResponse.ok()).toBe(true);
    expect(
      ((await goalsResponse.json()) as Array<{ level?: string }>).some(
        (goal) => goal.level === "company",
      ),
    ).toBe(true);

    const agentsBeforeConfiguration = await request.get(
      `/api/companies/${company!.id}/agents`,
    );
    expect(agentsBeforeConfiguration.ok()).toBe(true);
    expect(await agentsBeforeConfiguration.json()).toEqual([]);

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

    const agentsResponse = await request.get(
      `/api/companies/${company!.id}/agents`,
    );
    expect(agentsResponse.ok()).toBe(true);
    const agents = (await agentsResponse.json()) as CreatedAgent[];
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent).toMatchObject({
      name: AGENT_NAME,
      title: AGENT_TITLE,
      reportsTo: null,
      adapterType: "codex",
    });
    expect(agent.adapterConfig).toMatchObject({
      model: CODEX_MODEL,
    });

    // Creating and configuring an agent alone cannot start provider work.
    expect(await listRuns(request, company!.id, agent.id)).toEqual([]);

    await page.getByPlaceholder("Issue title (optional)").fill(ISSUE_TITLE);
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
    ).find((candidate) => candidate.title === ISSUE_TITLE);
    expect(issue).toEqual(
      expect.objectContaining({
        title: ISSUE_TITLE,
        request: ISSUE_REQUEST,
        ownerAgentId: agent.id,
      }),
    );

    await expect
      .poll(
        async () => (await listRuns(request, company!.id, agent.id)).length,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
  });
});
