// @vitest-environment jsdom
import type { CompanySecret } from "@paperclipai/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPANY_ID,
  ImportFromVaultDialog,
  awsVault,
  flush,
  makeCandidate,
  makePreview,
  makeWrapper,
  useMockSecretsApiTestState,
} from "./ImportFromVaultDialog.test-support";
const mockSecretsApi = useMockSecretsApiTestState();
describe("ImportFromVaultDialog", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });
  it("loads candidates and selects rows, persisting through pagination", async () => {
    mockSecretsApi.remoteImportPreview
      .mockResolvedValueOnce(
        makePreview(
          [
            makeCandidate({
              externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/stripe-ABC",
              remoteName: "prod/stripe",
              name: "prod/stripe",
              key: "prod-stripe",
            }),
            makeCandidate({
              externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/openai-XYZ",
              remoteName: "prod/openai",
              name: "prod/openai",
              key: "prod-openai",
            }),
          ],
          "page-2",
        ),
      )
      .mockResolvedValueOnce(
        makePreview(
          [
            makeCandidate({
              externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/sendgrid-Q9",
              remoteName: "prod/sendgrid",
              name: "prod/sendgrid",
              key: "prod-sendgrid",
            }),
          ],
          null,
        ),
      );
    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId={COMPANY_ID}
            providerConfigs={[awsVault]}
            existingSecrets={[]}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
    const tableBody = document.querySelector('[data-testid="vault-table-body"]');
    expect(tableBody).not.toBeNull();
    expect(document.body.textContent).toContain("prod/stripe");
    expect(document.body.textContent).toContain("prod/openai");
    // Select stripe via row click
    const stripeRow = document.querySelector(
      '[data-testid="vault-row-arn:aws:secretsmanager:us-east-1:1:secret:prod/stripe-ABC"]',
    ) as HTMLElement | null;
    expect(stripeRow).not.toBeNull();
    await act(async () => {
      stripeRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).toContain("1 selected");
    // Load more page
    const loadMore = document.querySelector('[data-testid="vault-load-more"]') as HTMLButtonElement | null;
    expect(loadMore).not.toBeNull();
    await act(async () => {
      loadMore!.click();
    });
    await flush();
    await flush();
    expect(document.body.textContent).toContain("prod/sendgrid");
    // Selection persisted through pagination.
    expect(document.body.textContent).toContain("1 selected");
    await act(async () => {
      root.unmount();
    });
  });
  it("disables checkboxes for already-imported (duplicate) rows and shows a conflict badge for conflicts", async () => {
    mockSecretsApi.remoteImportPreview.mockResolvedValueOnce(
      makePreview([
        makeCandidate({
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/sendgrid-Q9",
          remoteName: "prod/sendgrid",
          name: "prod/sendgrid",
          key: "prod-sendgrid",
          status: "duplicate",
          importable: false,
          conflicts: [
            {
              type: "exact_reference",
              message: "Already imported",
              existingSecretId: "secret-sg",
            },
          ],
        }),
        makeCandidate({
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/openai-XYZ",
          remoteName: "prod/openai",
          name: "prod/openai",
          key: "prod-openai",
          status: "conflict",
          importable: true,
          conflicts: [{ type: "name", message: "Name already in use" }],
        }),
      ]),
    );
    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId={COMPANY_ID}
            providerConfigs={[awsVault]}
            existingSecrets={[]}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
    const duplicateRow = document.querySelector(
      '[data-testid="vault-row-arn:aws:secretsmanager:us-east-1:1:secret:prod/sendgrid-Q9"]',
    );
    expect(duplicateRow?.getAttribute("data-row-state")).toBe("duplicate");
    const duplicateCheckbox = duplicateRow?.querySelector(
      'button[role="checkbox"]',
    ) as HTMLButtonElement | null;
    expect(duplicateCheckbox?.getAttribute("data-disabled")).not.toBeNull();
    expect(document.body.textContent).toContain("Conflict");
    expect(document.body.textContent).toContain("Name already in use");
    await act(async () => {
      root.unmount();
    });
  });
  it("blocks import when a review row collides with an existing Paperclip secret", async () => {
    const conflictCandidate = makeCandidate({
      externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/openai-XYZ",
      remoteName: "prod/openai",
      name: "OPENAI_API_KEY",
      key: "openai_api_key",
      status: "conflict",
      conflicts: [{ type: "key", message: "Key already in use" }],
    });
    mockSecretsApi.remoteImportPreview.mockResolvedValueOnce(makePreview([conflictCandidate]));
    const existing: CompanySecret[] = [
      {
        id: "secret-existing",
        companyId: COMPANY_ID,
        scope: "company",
        ownerUserId: null,
        userSecretDefinitionId: null,
        key: "openai_api_key",
        name: "OPENAI_API_KEY",
        provider: "aws_secrets_manager",
        status: "active",
        managedMode: "external_reference",
        externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:other-XYZ",
        providerConfigId: awsVault.id,
        providerMetadata: null,
        latestVersion: 1,
        description: null,
        lastResolvedAt: null,
        lastRotatedAt: null,
        deletedAt: null,
        createdByAgentId: null,
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId={COMPANY_ID}
            providerConfigs={[awsVault]}
            existingSecrets={existing}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
    // Select the conflict row
    const row = document.querySelector(
      '[data-testid="vault-row-arn:aws:secretsmanager:us-east-1:1:secret:prod/openai-XYZ"]',
    ) as HTMLElement | null;
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    // Click "Continue → Review" button.
    const continueBtn = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Continue"),
    );
    expect(continueBtn).toBeTruthy();
    await act(async () => {
      continueBtn!.click();
    });
    await flush();
    // Review step: error message visible, Import button disabled.
    expect(document.body.textContent?.toLowerCase()).toContain("a paperclip secret already uses this");
    const importBtn = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.startsWith("Import "),
    ) as HTMLButtonElement | undefined;
    expect(importBtn).toBeTruthy();
    expect(importBtn?.disabled).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });
  it("requires lowercase operator-entered keys during review", async () => {
    const externalRef = "arn:aws:secretsmanager:us-east-1:1:secret:prod/openai-XYZ";
    mockSecretsApi.remoteImportPreview.mockResolvedValueOnce(
      makePreview([
        makeCandidate({
          externalRef,
          remoteName: "prod/openai",
          name: "OpenAI API key",
          key: "openai-api-key",
        }),
      ]),
    );
    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId={COMPANY_ID}
            providerConfigs={[awsVault]}
            existingSecrets={[]}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
    const row = document.querySelector(`[data-testid="vault-row-${externalRef}"]`) as HTMLElement | null;
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const continueBtn = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Continue"),
    );
    await act(async () => {
      continueBtn!.click();
    });
    await flush();
    const keyInput = document.querySelector(
      `[data-testid="review-key-${externalRef}"]`,
    ) as HTMLInputElement | null;
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      valueSetter?.call(keyInput, "MY_KEY");
      keyInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).toContain("lowercase letters");
    const importBtn = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.startsWith("Import "),
    ) as HTMLButtonElement | undefined;
    expect(importBtn?.disabled).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });
  it("submits the operator-entered review description", async () => {
    const externalRef = "arn:aws:secretsmanager:us-east-1:1:secret:prod/openai-XYZ";
    mockSecretsApi.remoteImportPreview.mockResolvedValueOnce(
      makePreview([
        makeCandidate({
          externalRef,
          remoteName: "prod/openai",
          name: "OpenAI API key",
          key: "openai-api-key",
          providerMetadata: {
            description: "Raw AWS description should not seed the review field",
          },
        }),
      ]),
    );
    mockSecretsApi.remoteImport.mockResolvedValueOnce({
      providerConfigId: awsVault.id,
      provider: "aws_secrets_manager",
      importedCount: 1,
      skippedCount: 0,
      errorCount: 0,
      results: [
        {
          externalRef,
          name: "OpenAI API key",
          key: "openai-api-key",
          status: "imported",
          reason: null,
          secretId: "secret-openai",
          conflicts: [],
        },
      ],
    });
    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId={COMPANY_ID}
            providerConfigs={[awsVault]}
            existingSecrets={[]}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
    const row = document.querySelector(`[data-testid="vault-row-${externalRef}"]`) as HTMLElement | null;
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const continueBtn = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Continue"),
    );
    await act(async () => {
      continueBtn!.click();
    });
    await flush();
    const descriptionInput = document.querySelector(
      `[data-testid="review-description-${externalRef}"]`,
    ) as HTMLInputElement | null;
    expect(descriptionInput?.value).toBe("");
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      valueSetter?.call(descriptionInput, "Operator-entered OpenAI key");
      descriptionInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    const importBtn = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.startsWith("Import "),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      importBtn!.click();
    });
    await flush();
    await flush();
    expect(mockSecretsApi.remoteImport).toHaveBeenCalledWith(COMPANY_ID, {
      providerConfigId: awsVault.id,
      secrets: [
        expect.objectContaining({
          externalRef,
          description: "Operator-entered OpenAI key",
          providerMetadata: null,
        }),
      ],
    });
    await act(async () => {
      root.unmount();
    });
  });
});
