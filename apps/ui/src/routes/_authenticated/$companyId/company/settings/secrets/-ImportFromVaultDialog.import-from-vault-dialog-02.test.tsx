// @vitest-environment jsdom
import { ApiError } from "@/api/client";
import type { RemoteSecretImportResult } from "@paperclipai/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPANY_ID,
  ImportFromVaultDialog,
  awsVault,
  flush,
  flushDebounce,
  makeCandidate,
  makePreview,
  makeWrapper,
  useMockSecretsApiTestState,
} from "./-ImportFromVaultDialog.test-support";
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
  it("renders mixed import results (created/skipped/failed) and shows error reason", async () => {
    mockSecretsApi.remoteImportPreview.mockResolvedValueOnce(
      makePreview([
        makeCandidate({
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:a-AAA",
          remoteName: "alpha",
          name: "alpha",
          key: "alpha",
        }),
        makeCandidate({
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:b-BBB",
          remoteName: "beta",
          name: "beta",
          key: "beta",
        }),
        makeCandidate({
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:c-CCC",
          remoteName: "gamma",
          name: "gamma",
          key: "gamma",
        }),
      ]),
    );
    const result: RemoteSecretImportResult = {
      providerConfigId: awsVault.id,
      provider: "aws_secrets_manager",
      importedCount: 1,
      skippedCount: 1,
      errorCount: 1,
      results: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:a-AAA",
          name: "alpha",
          key: "alpha",
          status: "imported",
          reason: null,
          secretId: "secret-alpha",
          conflicts: [],
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:b-BBB",
          name: "beta",
          key: "beta",
          status: "skipped",
          reason: "exact reference already imported",
          secretId: null,
          conflicts: [
            {
              type: "exact_reference",
              message: "exact reference already imported",
            },
          ],
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:c-CCC",
          name: "gamma",
          key: "gamma",
          status: "error",
          reason: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
          secretId: null,
          conflicts: [],
        },
      ],
    };
    mockSecretsApi.remoteImport.mockResolvedValueOnce(result);
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
    // Select all loaded
    const headerCheckbox = document
      .querySelector('[data-testid="vault-table-body"]')
      ?.parentElement?.querySelector('thead button[role="checkbox"]') as HTMLButtonElement | null;
    expect(headerCheckbox).toBeTruthy();
    await act(async () => {
      headerCheckbox!.click();
    });
    await flush();
    // Continue
    const continueBtn = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Continue"),
    );
    await act(async () => {
      continueBtn!.click();
    });
    await flush();
    // Import
    const importBtn = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.startsWith("Import "),
    ) as HTMLButtonElement | undefined;
    expect(importBtn).toBeTruthy();
    await act(async () => {
      importBtn!.click();
    });
    await flush();
    await flush();
    expect(mockSecretsApi.remoteImport).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Import complete");
    expect(document.body.textContent).toContain("1 created");
    expect(document.body.textContent).toContain("1 skipped");
    expect(document.body.textContent).toContain("1 failed");
    expect(document.body.textContent).toContain("AWS Secrets Manager denied the request");
    expect(document.body.textContent).not.toContain("AccessDeniedException");
    expect(document.body.textContent).not.toContain("123456789012");
    await act(async () => {
      root.unmount();
    });
  });
  it("shows an empty state when no AWS vault is configured", async () => {
    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId={COMPANY_ID}
            providerConfigs={[]}
            existingSecrets={[]}
            onManageVaults={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    expect(document.querySelector('[data-testid="select-empty-vaults"]')).not.toBeNull();
    expect(mockSecretsApi.remoteImportPreview).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
  it("shows a permission-error banner when AWS denies ListSecrets", async () => {
    const error = Object.assign(new Error("AccessDeniedException"), {
      name: "ApiError",
      status: 403,
      body: null,
    });
    mockSecretsApi.remoteImportPreview.mockRejectedValueOnce(error);
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
    const banner = document.querySelector('[data-testid="preview-error-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Could not load remote secrets");
    await act(async () => {
      root.unmount();
    });
  });
  it("renders sanitized preview provider errors without raw AWS exception text", async () => {
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized";
    mockSecretsApi.remoteImportPreview.mockRejectedValueOnce(
      new ApiError(
        "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        403,
        {
          error: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
          details: { code: "access_denied" },
        },
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
    const banner = document.querySelector('[data-testid="preview-error-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("AWS denied list access");
    expect(banner?.textContent).toContain("missing secretsmanager:ListSecrets");
    expect(banner?.textContent).not.toContain(rawProviderMessage);
    expect(banner?.textContent).not.toContain("arn:aws");
    expect(banner?.textContent).not.toContain("123456789012");
    await act(async () => {
      root.unmount();
    });
  });
  it("debounces search and uses the new query for the next preview", async () => {
    mockSecretsApi.remoteImportPreview
      .mockResolvedValueOnce(makePreview([makeCandidate()]))
      .mockResolvedValueOnce(
        makePreview([
          makeCandidate({
            externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:stripe-XYZ",
            remoteName: "stripe",
            name: "stripe",
            key: "stripe",
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
    const search = document.querySelector('[data-testid="vault-search"]') as HTMLInputElement;
    expect(search).not.toBeNull();
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      search.focus();
      valueSetter?.call(search, "stripe");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushDebounce();
    await flush();
    expect(mockSecretsApi.remoteImportPreview).toHaveBeenCalledTimes(2);
    const lastCall = mockSecretsApi.remoteImportPreview.mock.calls.at(-1);
    expect(lastCall?.[1]).toMatchObject({ query: "stripe" });
    await act(async () => {
      root.unmount();
    });
  });
});
