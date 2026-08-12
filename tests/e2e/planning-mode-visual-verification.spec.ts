import { expect, test } from "./fixtures";
import {
  openCreateCompanyOnboarding,
  prepareOnboardingTestPage,
} from "./onboarding-test-page";

const AGENT_NAME = "Planning coordinator";
const CODEX_MODEL = "gpt-5.6";
const TASK_TITLE = "Prepare planning-mode evidence";
const TASK_REQUEST =
  "  Produce planning-mode visual evidence for this assigned task.\nKeep this request unchanged.  ";

test("captures planning mode UI for desktop and mobile", async ({ page, request }) => {
  const timestamp = Date.now();
  const companyName = `PAP-3413-${timestamp}`;
  const screenshotDir = "test-results/planning-mode";

  await prepareOnboardingTestPage(page);
  await openCreateCompanyOnboarding(page);

  await expect(page.getByRole("heading", { name: "Name your company" })).toBeVisible({ timeout: 15_000 });

  await page.locator('input[placeholder="Acme Corp"]').fill(companyName);
  await page.getByRole("button", { name: /^Next/ }).click();

  await expect(page.getByRole("heading", { name: "Define your mission" })).toBeVisible({ timeout: 30_000 });
  await page
    .getByPlaceholder("What is your team trying to achieve?")
    .fill("Capture planning mode visual evidence for the task UI.");
  await page.getByRole("button", { name: /Confirm mission/ }).click();

  await page.waitForSelector('input[placeholder="Agent name"]', { timeout: 30_000 });
  await page.getByPlaceholder("Agent name").fill(AGENT_NAME);
  await page.getByPlaceholder("Optional title").fill("Visual QA coordinator");
  await page
    .getByPlaceholder(
      "What work can another agent select this agent to handle?",
    )
    .fill("Captures and verifies planning-mode interface evidence.");
  await expect(page.getByPlaceholder("Agent name")).toHaveValue(AGENT_NAME);

  await page.getByRole("button", { name: /^Next/ }).click();
  await page.getByRole("button", { name: /Codex/ }).first().click();
  const modelSelect = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(modelSelect).toBeVisible({ timeout: 15_000 });
  await modelSelect.click();
  await page.getByRole("option", { name: "GPT-5.6", exact: true }).click();
  const createAgentButton = page.getByRole("button", { name: "Create agent" });
  await expect(createAgentButton).toBeEnabled({ timeout: 20_000 });
  await createAgentButton.click();

  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible({ timeout: 30_000 });

  const companyRes = await request.get("/api/companies");
  expect(companyRes.ok()).toBe(true);
  const companies = await companyRes.json();
  const company = companies.find((c: { name: string }) => c.name === companyName);
  expect(company).toBeTruthy();
  const agentsResponse = await request.get(
    `/api/companies/${company.id}/agents`,
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
  const runsBeforeTask = await request.get(
    `/api/companies/${company.id}/runs?agentId=${agent!.id}`,
  );
  expect(runsBeforeTask.ok()).toBe(true);
  expect(await runsBeforeTask.json()).toEqual({
    items: [],
    nextCursor: null,
  });

  await page.getByPlaceholder("Task title (optional)").fill(TASK_TITLE);
  await page
    .getByPlaceholder(/Describe .* first concrete assignment/)
    .fill(TASK_REQUEST);
  await page.getByRole("button", { name: /Get started/ }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

  const taskRes = await request.get(`/api/companies/${company.id}/tasks`);
  expect(taskRes.ok()).toBe(true);
  const tasks = await taskRes.json();
  const planningSeedTask = tasks.find(
    (candidate: {
      id: string;
      identifier?: string;
      taskNumber: number;
      title: string;
      request: string;
      ownerAgentId: string | null;
    }) =>
      candidate.title === TASK_TITLE,
  );
  expect(planningSeedTask).toEqual(
    expect.objectContaining({
      title: TASK_TITLE,
      request: TASK_REQUEST,
      ownerAgentId: agent!.id,
    }),
  );

  const task = planningSeedTask;
  const taskPath = `/${company.id}/tasks/${task.taskNumber}`;
  const companyId = company.id;
  const taskLinkSelector = `a[href$="/tasks/${task.taskNumber}"]`;

  const setMode = async (mode: "standard" | "planning") => {
    const patchRes = await request.patch(`/api/tasks/${task.id}`, {
      data: { workMode: mode },
    });
    expect(patchRes.ok()).toBe(true);
    await expect
      .poll(async () => {
        const currentRes = await request.get(`/api/tasks/${task.id}`);
        expect(currentRes.ok()).toBe(true);
        const current = await currentRes.json();
        return current.workMode;
      }, { timeout: 10_000 })
      .toBe(mode);
  };

  await setMode("planning");

  await page.goto(taskPath);
  await expect(page.getByText("Plan mode").first()).toBeVisible();
  await expect(page.getByTestId("task-chat-composer")).toHaveAttribute("data-pending-work-mode", "planning");

  await page.screenshot({
    path: `${screenshotDir}/desktop-planning-detail-${timestamp}.png`,
    fullPage: true,
  });

  await page.goto(`/${companyId}/tasks`);
  await expect(page.locator(taskLinkSelector)).toBeVisible();
  await expect(page.locator(taskLinkSelector)).not.toContainText("Plan mode");
  await page.screenshot({
    path: `${screenshotDir}/desktop-planning-row-${timestamp}.png`,
    fullPage: true,
  });

  await setMode("standard");
  await page.goto(taskPath);
  await expect(page.getByTestId("task-chat-composer")).toHaveAttribute("data-pending-work-mode", "standard");
  await expect(page.getByText("Plan mode")).toHaveCount(0);
  await page.screenshot({
    path: `${screenshotDir}/desktop-standard-toggle-${timestamp}.png`,
    fullPage: true,
  });

  await setMode("planning");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(taskPath);
  await expect(page.getByText("Plan mode").first()).toBeVisible();
  await expect(page.getByTestId("task-chat-composer")).toHaveAttribute("data-pending-work-mode", "planning");
  await page.screenshot({
    path: `${screenshotDir}/mobile-planning-detail-${timestamp}.png`,
    fullPage: true,
  });

  await page.goto(`/${companyId}/tasks`);
  await expect(page.locator(taskLinkSelector)).toBeVisible();
  await expect(page.locator(taskLinkSelector)).not.toContainText("Plan mode");
  await page.screenshot({
    path: `${screenshotDir}/mobile-planning-row-${timestamp}.png`,
    fullPage: true,
  });
});
