// @vitest-environment jsdom
import type { CompanySecretProviderConfig } from "@paperclipai/shared";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderVaultsTab,
  act,
  flushReact,
  providerConfigs,
  providers,
  renderSecretsPage,
  setupSecretsPageTest,
  useMockSecretsApiTestState,
  makeCompanySecret,
  makeUserSecretDefinition,
  setInputValue,
  setTextareaValue,
  waitForReact,
} from "./-Secrets-render-test-support";

const mockSecretsApi = useMockSecretsApiTestState();
describe("Secrets page layout", () => {
  let container: HTMLDivElement;
  let cleanup: () => void;
  beforeEach(() => {
    ({ container, cleanup } = setupSecretsPageTest());
  });
  afterEach(() => {
    cleanup();
  });
  it("uses the shared search/filter/tab affordances and keeps vault sections quiet", async () => {
    const { root } = await renderSecretsPage(container);
    expect(
      container.querySelector('input[data-page-search-target="true"][aria-label="Search secrets"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Use secrets by binding them to runtime environment variables.");
    expect(container.textContent).toContain("GH_TOKEN");
    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.textContent).not.toContain("Provider warnings detected");
    expect(container.textContent).not.toContain("2/2 active");
    await act(async () => {
      root.unmount();
    });
    const vaultRoot = createRoot(container);
    await act(async () => {
      vaultRoot.render(
        <ProviderVaultsTab
          providers={providers}
          providerConfigs={providerConfigs as CompanySecretProviderConfig[]}
          loading={false}
          error={null}
          onRetry={vi.fn()}
          onCreate={vi.fn()}
          onEdit={vi.fn()}
          onDisable={vi.fn()}
          onRemove={vi.fn()}
          onSetDefault={vi.fn()}
          onHealthCheck={vi.fn()}
          onImportSecrets={vi.fn()}
          pendingActionId={null}
        />,
      );
    });
    await flushReact();
    expect(container.querySelector('a[href="#provider-vaults-local_encrypted"]')).not.toBeNull();
    expect(container.textContent).toContain("AWS production");
    expect(container.textContent).not.toContain("Managed writes");
    expect(container.textContent).not.toContain("External refs");
    await act(async () => {
      vaultRoot.unmount();
    });
  });
  it("refreshes existing AWS secrets from a provider vault card", async () => {
    const { root } = await renderSecretsPage(container);
    const vaultTabButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Provider vaults"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      vaultTabButton?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      vaultTabButton?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      vaultTabButton?.click();
    });
    await flushReact();
    const refreshButton = document.querySelector(
      '[data-testid="provider-vault-refresh-secrets-vault-aws"]',
    ) as HTMLButtonElement | null;
    expect(refreshButton).not.toBeNull();
    await act(async () => {
      refreshButton?.click();
    });
    await flushReact();
    await flushReact();
    expect(document.body.textContent).toContain("Import from AWS Secrets Manager");
    expect(mockSecretsApi.remoteImportPreview).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      providerConfigId: "vault-aws",
      query: null,
      nextToken: null,
      pageSize: 50,
    });
    await act(async () => {
      root.unmount();
    });
  });
  it("warns that removing a provider vault only removes Paperclip config", async () => {
    mockSecretsApi.removeProviderConfig.mockResolvedValueOnce(providerConfigs[1]);
    const { root } = await renderSecretsPage(container);
    const vaultTabButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Provider vaults"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      vaultTabButton?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      vaultTabButton?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      vaultTabButton?.click();
    });
    await flushReact();
    const removeButtons = [...document.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "Remove",
    ) as HTMLButtonElement[];
    await act(async () => {
      removeButtons[1]?.click();
    });
    await flushReact();
    expect(document.body.textContent).toContain("Remove provider vault");
    expect(document.body.textContent).toContain("from Paperclip only");
    expect(document.body.textContent).toContain("does not delete");
    expect(document.body.textContent).toContain("AWS Secrets Manager");
    const confirmButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Remove from Paperclip"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      confirmButton?.click();
    });
    await flushReact();
    expect(mockSecretsApi.removeProviderConfig).toHaveBeenCalledWith("vault-aws");
    expect(mockSecretsApi.disableProviderConfig).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
});

describe("Secrets page layout", () => {
  let container: HTMLDivElement;
  let cleanup: () => void;
  beforeEach(() => {
    ({ container, cleanup } = setupSecretsPageTest());
  });
  afterEach(() => {
    cleanup();
  });
  it("keeps references reachable from the compact secrets row and detail drawer", async () => {
    mockSecretsApi.list.mockResolvedValue([makeCompanySecret()]);
    mockSecretsApi.usage.mockResolvedValue({
      secretId: "secret-openai",
      bindings: [
        {
          id: "binding-agent",
          companyId: "11111111-1111-4111-8111-111111111111",
          secretId: "secret-openai",
          targetType: "agent",
          targetId: "22222222-2222-4222-8222-222222222222",
          configPath: "env.OPENAI_API_KEY",
          versionSelector: "latest",
          required: true,
          label: null,
          target: {
            type: "agent",
            id: "22222222-2222-4222-8222-222222222222",
            label: "CodexCoder",
            routeTarget: {
              kind: "agent",
              id: "22222222-2222-4222-8222-222222222222",
            },
            status: "idle",
          },
          createdAt: new Date("2026-05-06T00:00:00.000Z"),
          updatedAt: new Date("2026-05-06T00:00:00.000Z"),
        },
      ],
    });
    const { root } = await renderSecretsPage(container);
    const referencesButton = container.querySelector(
      'button[aria-label="Actions for OPENAI_API_KEY"]',
    ) as HTMLButtonElement | null;
    expect(referencesButton).not.toBeNull();
    const companyRowOpen = container.querySelector<HTMLButtonElement>(
      '[data-testid="secrets-card-view"] button[aria-label="Open secret OPENAI_API_KEY"]',
    );
    expect(companyRowOpen).not.toBeNull();
    await act(async () => {
      companyRowOpen?.click();
    });
    await flushReact();
    const viewUsageButton = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("View in Usage"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      viewUsageButton?.click();
    });
    await flushReact();
    expect(mockSecretsApi.usage).toHaveBeenCalledWith("secret-openai");
    expect(document.body.textContent).toContain("CodexCoder");
    expect(document.body.textContent).toContain("env.OPENAI_API_KEY");
    await act(async () => {
      root.unmount();
    });
  });
  it("merges company secrets and each-user definitions into the Secrets list", async () => {
    mockSecretsApi.list.mockResolvedValue([makeCompanySecret()]);
    mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([makeUserSecretDefinition()]);
    const { root } = await renderSecretsPage(container);
    expect(container.textContent).toContain("OPENAI_API_KEY");
    expect(container.textContent).toContain("Personal GitHub token");
    expect(container.textContent).toContain("Company");
    expect(container.textContent).toContain("Each user");
    await waitForReact(() => container.textContent?.includes("3/5 set") ?? false);
    expect(container.textContent).toContain("3/5 set");
    expect(container.textContent).not.toContain("User secret definitions");
    const listContainer = container.querySelector('[data-testid="secrets-list-container"]');
    const tableView = container.querySelector('[data-testid="secrets-table-view"]');
    const cardView = container.querySelector('[data-testid="secrets-card-view"]');
    expect(listContainer?.className).toContain("@container");
    expect(tableView?.className).toContain("@min-[40rem]:block");
    expect(tableView?.className).not.toContain("md:block");
    expect(tableView?.querySelector('[data-slot="table"]')).toBeTruthy();
    expect(tableView?.querySelectorAll('[data-slot="table-head"]')).toHaveLength(5);
    expect(cardView?.className).toContain("@min-[40rem]:hidden");
    expect(cardView?.className).not.toContain("md:hidden");
    expect(mockSecretsApi.list).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(mockSecretsApi.listUserSecretDefinitions).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    await act(async () => {
      root.unmount();
    });
  });
  it("creates an each-user secret from the unified New secret dialog", async () => {
    const definition = makeUserSecretDefinition({
      name: "Personal GitHub token",
    });
    mockSecretsApi.createUserSecretDefinition.mockResolvedValueOnce(definition);
    const { root } = await renderSecretsPage(container);
    const newSecretButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New secret"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      newSecretButton?.click();
    });
    await flushReact();
    const companyKeyInput = document.getElementById("new-secret-key") as HTMLInputElement;
    expect(companyKeyInput.readOnly).toBe(true);
    const editKeyButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Edit",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      editKeyButton?.click();
    });
    await flushReact();
    expect(companyKeyInput.readOnly).toBe(false);
    const eachUserButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Each user",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      eachUserButton?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      eachUserButton?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      eachUserButton?.click();
    });
    await flushReact();
    const nameInput = document.getElementById("new-secret-name") as HTMLInputElement;
    const keyInput = document.getElementById("new-secret-key") as HTMLInputElement;
    const usageGuidance = document.getElementById("new-secret-usage-guidance") as HTMLTextAreaElement;
    expect(keyInput.readOnly).toBe(true);
    expect(
      Array.from(document.body.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Edit",
      ),
    ).toBe(true);
    expect(document.getElementById("new-secret-provider")).toBeNull();
    expect(document.getElementById("new-secret-vault")).toBeNull();
    expect(document.getElementById("new-secret-value")).toBeNull();
    await act(async () => {
      setInputValue(nameInput, "Personal GitHub token");
      setTextareaValue(usageGuidance, "Create a fine-grained PAT with repo read access.");
    });
    await flushReact();
    expect(keyInput.value).toBe("PERSONAL_GITHUB_TOKEN");
    const createButton = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Create user-provided secret"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      createButton?.click();
    });
    await flushReact();
    expect(mockSecretsApi.createUserSecretDefinition).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      {
        name: "Personal GitHub token",
        description: null,
        usageGuidance: "Create a fine-grained PAT with repo read access.",
        key: "PERSONAL_GITHUB_TOKEN",
        status: "active",
      },
    );
    expect(mockSecretsApi.create).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
});
