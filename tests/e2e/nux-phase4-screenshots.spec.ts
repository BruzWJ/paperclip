import { test, expect } from "./fixtures";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * NUX Phase 4 — visual QA screenshot capture.
 *
 * Uses the Vite-only UI server and test-owned API fixture, then captures
 * screenshots of every surface integrated by NUX Phases 1–3:
 *   - "Build a new company" step 1 (company name) + step 2 (mission)
 *   - Ordinary top-level agent identity and declarative ACP configuration
 *   - Board-authored first-issue review
 *   - Onboarding front door (path picker)
 *   - "Add agents to your org" growth intake
 *   - Artifacts page
 *
 * These are structural/rendering checks; provider execution is covered
 * separately on an explicitly configured test instance. Screenshots land in
 * ./nux-phase4-shots for upload as evidence.
 */

// Write under the gitignored test-results dir so re-runs leave no untracked
// noise; screenshots are uploaded to the issue as QA evidence, not committed.
const SHOT_DIR = path.join(__dirname, "test-results", "nux-phase4-shots");
const COMPANY_NAME = "QA Robotics";
const AGENT_NAME = "QA coordinator";
const CODEX_MODEL = "gpt-5.6";
const ISSUE_TITLE = "Verify the onboarding surfaces";
const ISSUE_REQUEST =
  "  Verify the integrated onboarding surfaces and record the visual evidence.\nDo not normalize this request.  ";

function shot(name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, name);
}

async function openWizard(page: import("@playwright/test").Page) {
  await page.goto("/onboarding");
  const startBtn = page.getByRole("button", { name: /Start Onboarding|New Company|Add Agent/ });
  if (await startBtn.count()) {
    await startBtn.first().click();
  }
}

test.describe("NUX Phase 4 visual QA", () => {
  test("captures every integrated surface", async ({ page, request }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push("PAGEERROR: " + err.message));

    // ── Section A: company → mission → ordinary agent → issue ─────────────
    await openWizard(page);
    // Front door shows when the wizard doesn't open directly on the create
    // path (e.g. another spec already created a company on this instance).
    const createCard = page.getByRole("button", { name: /Build a new company/ });
    if (await createCard.count()) {
      await createCard.first().click();
    }
    await expect(
      page.getByRole("heading", { name: "Name your company" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder("Acme Corp").fill(COMPANY_NAME);
    await page.screenshot({ path: shot("02-create-name.png") });

    await page.getByRole("button", { name: /^Next/ }).click();
    await expect(
      page.getByRole("heading", { name: "Define your mission" }),
    ).toBeVisible({ timeout: 10_000 });
    await page
      .getByPlaceholder("What is your team trying to achieve?")
      .fill("Build affordable home robots that handle household chores.");
    await page.screenshot({ path: shot("03-create-mission.png") });

    // Confirming the mission creates the company + goal; step 3 configures an
    // ordinary top-level agent with concrete board-selected controls.
    await page.getByRole("button", { name: /Confirm mission/ }).click();
    await page.waitForSelector('input[placeholder="Agent name"]', {
      timeout: 30_000,
    });
    await page.getByPlaceholder("Agent name").fill(AGENT_NAME);
    await page.getByPlaceholder("Optional title").fill("Interface verifier");
    await page
      .getByPlaceholder(
        "What work can another agent select this agent to handle?",
      )
      .fill("Verifies onboarding, issue, and collaboration interfaces.");
    await page.screenshot({ path: shot("04-configure-agent.png") });
    await page.getByRole("button", { name: /^Next/ }).click();

    await page.getByRole("button", { name: /Codex/ }).first().click();
    const modelField = page.locator("label").filter({ hasText: /^Model$/ }).locator("../..");
    await expect(modelField).toBeVisible({ timeout: 15_000 });
    await modelField.getByRole("button").last().click();
    await page.getByRole("button", { name: "GPT-5.6", exact: true }).click();
    await page.screenshot({ path: shot("05-connect-codex-agent.png") });
    const createAgentButton = page.getByRole("button", {
      name: "Create agent",
    });
    await expect(createAgentButton).toBeEnabled({ timeout: 20_000 });
    await createAgentButton.click();
    await expect(
      page.getByRole("heading", { name: "Review" }),
    ).toBeVisible({ timeout: 30_000 });

    // The company just created anchors the route-scoped sections below.
    const companiesRes = await request.get("/api/companies");
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const qaCompany = (Array.isArray(companies) ? companies : []).find(
      (c: { name: string }) => c.name === COMPANY_NAME,
    );
    expect(
      qaCompany,
      `wizard should have created ${COMPANY_NAME}`,
    ).toBeTruthy();
    const prefix: string = qaCompany.issuePrefix;

    const agentsResponse = await request.get(
      `/api/companies/${qaCompany.id}/agents`,
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
      `/api/companies/${qaCompany.id}/runs?agentId=${agent!.id}`,
    );
    expect(runsBeforeIssue.ok()).toBe(true);
    expect(await runsBeforeIssue.json()).toEqual({
      items: [],
      nextCursor: null,
    });

    await page.getByPlaceholder("Issue title (optional)").fill(ISSUE_TITLE);
    await page
      .getByPlaceholder(/Describe .* first concrete assignment/)
      .fill(ISSUE_REQUEST);
    await page.screenshot({ path: shot("06-review-first-issue.png") });
    await page.getByRole("button", { name: "Get started" }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

    const issuesResponse = await request.get(
      `/api/companies/${qaCompany.id}/issues`,
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
        ownerAgentId: agent!.id,
      }),
    );

    // ── Section B: front door + growth intake ─────────────────────────────
    await page.evaluate(() => window.localStorage.clear());
    await openWizard(page);
    // Reach the full-screen front door (step 0): either it shows directly or
    // "← Back to start" returns to it from the create step.
    if (!(await page.getByRole("heading", { name: "Welcome to Paperclip" }).count())) {
      await page.getByRole("button", { name: /Back to start/ }).click();
    }
    await expect(
      page.getByRole("heading", { name: "Welcome to Paperclip" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("heading", { name: "Build a new company" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Add agents to your org" }),
    ).toBeVisible();
    await page.screenshot({ path: shot("01-front-door.png") });

    await page.getByRole("button", { name: /Add agents to your org/ }).click();
    // The grow path shares step 1 (company name) before its step-2 intake.
    await expect(
      page.getByRole("heading", { name: "Name your company" }),
    ).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder("Acme Corp").fill("QA Robotics Grow");
    await page.getByRole("button", { name: /^Next/ }).click();
    await expect(
      page.getByRole("heading", { name: /Tell us about your team/ }),
    ).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: shot("07-growth-intake.png") });

    // ── Section C: Artifacts ──────────────────────────────────────────────
    await page.goto(`/${prefix}/artifacts`);
    await expect(page).toHaveURL(new RegExp(`/${prefix}/artifacts`));
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: shot("09-artifacts.png") });

    for (const f of [
      "01-front-door.png",
      "02-create-name.png",
      "03-create-mission.png",
      "04-configure-agent.png",
      "05-connect-codex-agent.png",
      "06-review-first-issue.png",
      "07-growth-intake.png",
      "09-artifacts.png",
    ]) {
      const p = shot(f);
      expect(fs.existsSync(p), `missing ${f}`).toBe(true);
      expect(fs.statSync(p).size, `empty ${f}`).toBeGreaterThan(1_000);
    }

    // No React Rules-of-Hooks / render crashes on any surface we visited.
    const hookErrors = consoleErrors.filter(
      (e) => /Rendered more hooks|change in the order of Hooks/i.test(e),
    );
    expect(hookErrors, hookErrors.join("\n")).toHaveLength(0);
  });
});
