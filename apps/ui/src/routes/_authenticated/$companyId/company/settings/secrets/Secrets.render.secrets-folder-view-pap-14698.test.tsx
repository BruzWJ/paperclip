// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  flushReact,
  makeCompanySecret,
  providerConfigs,
  providers,
  renderSecretsPage,
  setInputValue,
  setTextareaValue,
  setupSecretsPageTest,
  useMockSecretsApiTestState,
  userSecretCoverage,
  waitForReact,
} from "./-Secrets-render-test-support";
const mockSecretsApi = useMockSecretsApiTestState();
describe("Secrets folder view (PAP-14698)", () => {
  let container: HTMLDivElement;
  let cleanup: () => void;
  function seedFolderSecrets() {
    mockSecretsApi.list.mockResolvedValue([
      makeCompanySecret({
        id: "s1",
        key: "dev_github_oauth_clientid",
        name: "dev/github/oauth/clientid",
      }),
      makeCompanySecret({
        id: "s2",
        key: "dev_github_oauth_clientsecret",
        name: "dev/github/oauth/clientsecret",
      }),
      makeCompanySecret({
        id: "s3",
        key: "prod_api_token",
        name: "prod/api/token",
      }),
      makeCompanySecret({ id: "s4", key: "standalone", name: "standalone" }),
    ]);
    mockSecretsApi.providers.mockResolvedValue(providers);
    mockSecretsApi.providerHealth.mockResolvedValue({ providers: [] });
    mockSecretsApi.providerConfigs.mockResolvedValue(providerConfigs);
    mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([]);
    mockSecretsApi.userSecretDefinitionCoverage.mockResolvedValue(userSecretCoverage);
    mockSecretsApi.listUserSecrets.mockResolvedValue([]);
  }
  async function renderAt(path: string) {
    const { root } = await renderSecretsPage(container, path);
    return root;
  }
  beforeEach(() => {
    ({ container, cleanup } = setupSecretsPageTest());
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
    seedFolderSecrets();
  });
  afterEach(() => {
    cleanup();
  });
  it("derives folders at the root with filtered counts and a flat standalone secret", async () => {
    const root = await renderAt("/11111111-1111-4111-8111-111111111111/company/settings/secrets");
    const table = container.querySelector('[data-testid="secrets-table-view"]')!;
    expect(table.textContent).toContain("dev");
    expect(table.textContent).toContain("prod");
    expect(table.textContent).toContain("standalone");
    // dev groups both oauth secrets recursively; github and oauth are descendant folders.
    expect(table.textContent).toContain("2 secrets · 2 folders");
    expect(table.textContent).toContain("1 secret · 1 folder");
    // Folder rows are real links carrying ?path=.
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(links.some((href) => href.includes("path=dev"))).toBe(true);
    await act(async () => root.unmount());
  });
  it("opens a deep ?path= link into the folder with breadcrumb, leaves, and an up affordance", async () => {
    const root = await renderAt(
      "/11111111-1111-4111-8111-111111111111/company/settings/secrets?path=dev%2Fgithub%2Foauth",
    );
    const breadcrumb = container.querySelector('nav[aria-label="Breadcrumb"]');
    expect(breadcrumb).not.toBeNull();
    const current = breadcrumb?.querySelector('span[aria-current="page"]');
    expect(current?.textContent).toContain("oauth");
    const table = container.querySelector('[data-testid="secrets-table-view"]')!;
    expect(table.textContent).toContain("clientid");
    expect(table.textContent).toContain("clientsecret");
    expect(table.textContent).toContain("Up to github");
    // Sibling trees are not shown while drilled in.
    expect(table.textContent).not.toContain("standalone");
    await act(async () => root.unmount());
  });
  it("renders the empty-folder state (breadcrumb intact) for an unknown path", async () => {
    const root = await renderAt(
      "/11111111-1111-4111-8111-111111111111/company/settings/secrets?path=does%2Fnot%2Fexist",
    );
    expect(container.querySelector('nav[aria-label="Breadcrumb"]')).not.toBeNull();
    expect(container.textContent).toContain("No secrets in this folder yet.");
    const cta = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("New secret here"),
    ) as HTMLButtonElement;
    expect(cta).toBeDefined();
    await act(async () => cta.click());
    await flushReact();
    expect(document.body.textContent).toContain("does/not/exist/");
    expect((document.getElementById("new-secret-name") as HTMLInputElement).value).toBe("");
    expect(document.querySelector('button[aria-label="Remove folder prefix"]')).not.toBeNull();
    await act(async () => root.unmount());
  });
  it("distinguishes a filtered-empty folder from a genuinely empty folder", async () => {
    const root = await renderAt(
      "/11111111-1111-4111-8111-111111111111/company/settings/secrets?path=dev%2Fgithub%2Foauth",
    );
    const filterButton = document.querySelector('button[title="Filter"]') as HTMLButtonElement;
    await act(async () => filterButton.click());
    await flushReact();
    const archivedLabel = [...document.querySelectorAll("label")].find(
      (label) => label.textContent?.trim() === "Archived",
    ) as HTMLLabelElement;
    await act(async () => archivedLabel.click());
    await waitForReact(() => container.textContent?.includes("No secrets match your filters.") ?? false);
    expect(container.textContent).toContain("No secrets match your filters.");
    expect(container.textContent).not.toContain("New secret here");
    await act(async () => root.unmount());
  });
  it("creates a company secret from a folder prefix and derives the key from the full name", async () => {
    mockSecretsApi.create.mockResolvedValue(
      makeCompanySecret({
        id: "created",
        name: "dev/github/oauth/clientsecret/deeper",
      }),
    );
    const root = await renderAt(
      "/11111111-1111-4111-8111-111111111111/company/settings/secrets?path=dev%2Fgithub%2Foauth",
    );
    const newSecretButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New secret",
    ) as HTMLButtonElement;
    await act(async () => newSecretButton.click());
    await flushReact();
    expect(document.body.textContent).toContain("dev/github/oauth/");
    const nameInput = document.getElementById("new-secret-name") as HTMLInputElement;
    expect(nameInput.placeholder).toBe("clientsecret");
    expect(nameInput.value).toBe("");
    await act(async () => setInputValue(nameInput, "clientsecret/deeper"));
    await flushReact();
    expect((document.getElementById("new-secret-key") as HTMLInputElement).value).toBe(
      "dev-github-oauth-clientsecret-deeper",
    );
    await act(async () =>
      setTextareaValue(document.getElementById("new-secret-value") as HTMLTextAreaElement, "secret-value"),
    );
    const createButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Create secret",
    ) as HTMLButtonElement;
    await act(async () => createButton.click());
    await flushReact();
    expect(mockSecretsApi.create).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ name: "dev/github/oauth/clientsecret/deeper" }),
    );
    await act(async () => root.unmount());
  });
  it("keeps the folder prefix for Each user and exposes the full name when the chip is removed", async () => {
    const root = await renderAt(
      "/11111111-1111-4111-8111-111111111111/company/settings/secrets?path=dev%2Fgithub%2Foauth",
    );
    const newSecretButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New secret",
    ) as HTMLButtonElement;
    await act(async () => newSecretButton.click());
    await flushReact();
    const eachUserTab = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Each user",
    ) as HTMLButtonElement;
    await act(async () => {
      eachUserTab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      eachUserTab.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      eachUserTab.click();
    });
    await flushReact();
    const nameInput = document.getElementById("new-secret-name") as HTMLInputElement;
    await act(async () => setInputValue(nameInput, "personal-token"));
    await flushReact();
    expect((document.getElementById("new-secret-key") as HTMLInputElement).value).toBe(
      "DEV_GITHUB_OAUTH_PERSONAL_TOKEN",
    );
    const removePrefix = document.querySelector(
      'button[aria-label="Remove folder prefix"]',
    ) as HTMLButtonElement;
    await act(async () => removePrefix.click());
    await flushReact();
    expect((document.getElementById("new-secret-name") as HTMLInputElement).value).toBe(
      "dev/github/oauth/personal-token",
    );
    expect(document.querySelector('button[aria-label="Remove folder prefix"]')).toBeNull();
    await act(async () => root.unmount());
  });
  it("validates New folder inline and stages the trimmed segment in the URL-backed folder view", async () => {
    const root = await renderAt(
      "/11111111-1111-4111-8111-111111111111/company/settings/secrets?path=dev%2Fgithub%2Foauth",
    );
    const newFolderButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New folder",
    ) as HTMLButtonElement;
    await act(async () => newFolderButton.click());
    await flushReact();
    const folderInput = container.querySelector('input[aria-label="Folder name"]') as HTMLInputElement;
    await act(async () => setInputValue(folderInput, "bad/name"));
    const createFolderButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Create folder",
    ) as HTMLButtonElement;
    await act(async () => createFolderButton.click());
    await flushReact();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Folder name cannot contain slashes.",
    );
    await act(async () => setInputValue(folderInput, "  staged  "));
    await flushReact();
    await act(async () => createFolderButton.click());
    await waitForReact(() =>
      [...container.querySelectorAll('[aria-current="page"]')].some((node) =>
        node.textContent?.includes("staged"),
      ),
    );
    expect(
      [...container.querySelectorAll('[aria-current="page"]')].some((node) =>
        node.textContent?.includes("staged"),
      ),
    ).toBe(true);
    expect(container.textContent).toContain("No secrets in this folder yet.");
    expect(container.querySelector('input[aria-label="Folder name"]')).toBeNull();
    await act(async () => root.unmount());
  });
  it("Flat toggle reproduces the raw, ungrouped list", async () => {
    const root = await renderAt("/11111111-1111-4111-8111-111111111111/company/settings/secrets");
    const flatButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim().toLowerCase() === "flat",
    ) as HTMLButtonElement | undefined;
    expect(flatButton).toBeDefined();
    await act(async () => flatButton!.click());
    await flushReact();
    const table = container.querySelector('[data-testid="secrets-table-view"]')!;
    expect(table.textContent).toContain("dev/github/oauth/clientid");
    expect(table.textContent).not.toContain("2 secrets · 1 folder");
    await act(async () => root.unmount());
  });
  it("search is global across folders and shows full muted-path names", async () => {
    const root = await renderAt(
      "/11111111-1111-4111-8111-111111111111/company/settings/secrets?path=dev%2Fgithub%2Foauth",
    );
    const input = container.querySelector('input[aria-label="Search secrets"]') as HTMLInputElement;
    await act(async () => setInputValue(input, "token"));
    await flushReact();
    expect(container.textContent).toContain("Search results");
    expect(container.textContent).toContain("across all folders");
    const table = container.querySelector('[data-testid="secrets-table-view"]')!;
    // prod/api/token lives outside the current folder yet still matches.
    expect(table.textContent).toContain("prod/api/");
    expect(table.textContent).toContain("token");
    await act(async () => root.unmount());
  });
});
